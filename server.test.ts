import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakeSdkOverrides,
} from "@get-bb/plugin-sdk/testing";
import plugin, { giteaRpcContract, pullCiStatus } from "./server";

type TeaCall = {
  args: string[];
  login: string;
  method: string;
  endpoint: string;
  body: unknown;
};
type TeaReply =
  | { status?: number; json?: unknown; raw?: string }
  | { exitCode: number; stderr: string }
  | { hang: true }
  | { signal: "SIGTERM" };
type TeaProfile = { name: string; url: string; user: string };

const fixtureDir = join(import.meta.dirname, "test-fixtures");
const defaultProfiles: TeaProfile[] = [
  { name: "work", url: "https://gitea.example/prefix", user: "dev" },
];
const defaultSettings = {
  baseUrl: "https://gitea.example/prefix/",
  teaProfile: "",
  extraRepos: "acme/widgets",
  cacheEntryLimitMiB: 16,
  cacheLimitMiB: 64,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function isolateTeaEnvironment(path: string) {
  const home = mkdtempSync(join(tmpdir(), "gitea-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PATH", path);
}

async function startTea(
  api: (call: TeaCall) => TeaReply | Promise<TeaReply>,
  profiles: TeaProfile[],
) {
  const calls: TeaCall[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const { args, stdin } = JSON.parse(Buffer.concat(chunks).toString()) as {
        args: string[];
        stdin: string;
      };
      const reply = async (): Promise<unknown> => {
        if (args.join(" ") === "logins list --output json")
          return {
            stdout: JSON.stringify(
              profiles.map((profile) => ({
                ...profile,
                ssh_host: "",
                default: false,
              })),
            ),
          };
        const option = (name: string) => args[args.indexOf(name) + 1] ?? "";
        const call = {
          args,
          login: option("--login"),
          method: option("--method"),
          endpoint: args.at(-1) ?? "",
          body:
            option("--data") === "@-" ? (JSON.parse(stdin) as unknown) : null,
        };
        calls.push(call);
        const result = await api(call);
        if (!("status" in result || "json" in result || "raw" in result))
          return result;
        const status = result.status ?? 200;
        return {
          stderr: `HTTP/1.1 ${status} Fixture\r\nContent-Type: application/json\r\n\r\n`,
          stdout: result.raw ?? JSON.stringify(result.json ?? {}),
        };
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(await reply()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  vi.stubEnv(
    "TEA_FIXTURE_URL",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
  );
  return calls;
}

async function start(
  api: (call: TeaCall) => TeaReply | Promise<TeaReply>,
  options: {
    profiles?: TeaProfile[];
    settings?: Partial<typeof defaultSettings>;
    projects?: Array<{
      id: string;
      sources: Array<{ type: string; path: string; hostId?: string }>;
    }>;
    threads?: FakeSdkOverrides["threads"];
  } = {},
) {
  isolateTeaEnvironment(`${fixtureDir}:${process.env.PATH ?? ""}`);
  const calls = await startTea(api, options.profiles ?? defaultProfiles);
  const host = createFakePluginHost({
    pluginId: "gitea",
    experimental_declaredIconNames: ["teacup"],
    settings: { ...defaultSettings, ...options.settings },
    sdk: {
      projects: { list: async () => options.projects ?? [] },
      ...(options.threads ? { threads: options.threads } : {}),
    },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  return { host, calls };
}

type Host = ReturnType<typeof createFakePluginHost>;

async function status(host: Host) {
  return giteaRpcContract.status.output.parse(
    await host.harness.behavior.callRpc("status", null),
  );
}

async function listItems(host: Host, input: Record<string, unknown>) {
  return giteaRpcContract.listItems.output.parse(
    await host.harness.behavior.callRpc("listItems", {
      kind: "issue",
      state: "open",
      query: "",
      ...input,
    }),
  );
}

function issue(number: number, title = `Issue ${number}`) {
  return {
    number,
    title,
    state: "open",
    user: { login: "dev" },
    labels: [],
    assignees: [],
    html_url: `https://gitea.example/prefix/acme/widgets/issues/${number}`,
    body: "",
    updated_at: "2026-09-01T00:00:00Z",
  };
}

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function page(endpoint: string): number {
  return Number(
    new URL(endpoint, "https://fixture.invalid").searchParams.get("page"),
  );
}

function gitSource(remote: string) {
  const path = mkdtempSync(join(tmpdir(), "gitea-remote-"));
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
  return path;
}

it("discovers only matching Gitea HTTPS and SSH remotes under the configured path prefix", async () => {
  const paths = [
    gitSource("https://github.com/acme/ignored.git"),
    gitSource("https://gitea.example:3000/prefix/acme/widgets.git"),
    gitSource("ssh://git@gitea.example:2222/prefix/ops/api.git"),
    gitSource("git@gitea.example:prefix/docs/manual.git"),
  ];
  cleanups.push(() => {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  });
  const { host } = await start(() => ({ json: { login: "dev" } }), {
    profiles: [
      { name: "work", url: "https://gitea.example:3000/prefix", user: "dev" },
    ],
    settings: {
      baseUrl: "https://gitea.example:3000/prefix/",
      extraRepos: "team/docs",
    },
    projects: paths.map((path, index) => ({
      id: `project-${index}`,
      sources: [{ type: "local_path", path }],
    })),
  });
  const result = await status(host);
  expect(result).toMatchObject({ state: "connected", login: "dev" });
  expect(result.repos).toEqual([
    { repo: "acme/widgets", projectId: "project-1" },
    { repo: "ops/api", projectId: "project-2" },
    { repo: "docs/manual", projectId: "project-3" },
    { repo: "team/docs", projectId: null },
  ]);
});

it("reads a second issue page and reports repository failures without losing accessible results", async () => {
  const { host, calls } = await start(
    ({ endpoint }) => {
      if (endpoint.includes("broken/repo")) return { status: 403 };
      if (page(endpoint) === 1)
        return {
          json: Array.from({ length: 50 }, (_, index) => issue(index + 1)),
        };
      if (page(endpoint) === 2) return { json: [issue(51, "Older issue")] };
      return { json: [] };
    },
    { settings: { extraRepos: "acme/widgets broken/repo" } },
  );
  const result = await listItems(host, {});
  expect(result.items).toHaveLength(51);
  expect(result.items.at(-1)?.title).toBe("Older issue");
  expect(result.errors).toEqual([
    { repo: "broken/repo", message: "Gitea API returned HTTP 403." },
  ]);
  expect(calls.map((call) => call.endpoint)).toEqual(
    expect.arrayContaining([
      "/api/v1/repos/acme/widgets/issues?state=open&type=issues&limit=50&page=1",
      "/api/v1/repos/acme/widgets/issues?state=open&type=issues&limit=50&page=2",
    ]),
  );
});

it("rejects item lists when every configured repository is unreachable", async () => {
  const { host } = await start(
    ({ endpoint }) =>
      endpoint.endsWith("/api/v1/user")
        ? { json: { login: "dev" } }
        : { status: 403 },
    { settings: { extraRepos: "broken/repo" } },
  );
  await expect(listItems(host, {})).rejects.toThrow(
    "Gitea API returned HTTP 403.",
  );
  await expect(
    rpc(host, "listMyIssues", { state: "open", query: "" }),
  ).rejects.toThrow("Gitea API returned HTTP 403.");
  await expect(
    rpc(host, "listMyPullRequests", { state: "open", query: "" }),
  ).rejects.toThrow("Gitea API returned HTTP 403.");
});

it("paginates pull request comments, files, and reviews and stops on a short page", async () => {
  const { host, calls } = await start(({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/9")) return { json: issue(9, "Large change") };
    if (path.endsWith("/pulls/9"))
      return {
        json: {
          head: { ref: "feature", sha: headSha },
          base: { ref: "main", sha: baseSha },
        },
      };
    if (path.endsWith(`/statuses/${headSha}`)) return { json: [] };
    const count = page(endpoint) === 1 ? 50 : 1;
    const rows = (row: (index: number) => unknown) => ({
      json: Array.from({ length: count }, (_, index) => row(index)),
    });
    if (path.endsWith("/comments"))
      return rows((index) => ({
        id: page(endpoint) * 100 + index,
        user: { login: "reviewer" },
        body: `Comment ${index}`,
        created_at: "2026-09-01T00:00:00Z",
      }));
    if (path.endsWith("/files"))
      return rows((index) => ({
        filename: `src/${page(endpoint)}-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-old\n+new",
      }));
    if (path.endsWith("/reviews"))
      return rows((index) => ({
        id: page(endpoint) * 100 + index,
        comments_count: 1,
        user: { login: "reviewer" },
        state: "APPROVED",
        body: `Review ${index}`,
        submitted_at: "2026-09-01T00:00:00Z",
      }));
    return { json: [] };
  });
  const result = giteaRpcContract.detail.output.parse(
    await host.harness.behavior.callRpc("detail", {
      repo: "acme/widgets",
      number: 9,
      kind: "pr",
    }),
  );
  expect(result.comments).toHaveLength(51);
  expect(result.files).toHaveLength(51);
  expect(result.reviews).toHaveLength(51);
  expect(result).toMatchObject({
    headRefName: "feature",
    baseRefName: "main",
    commentsTruncated: false,
    filesTruncated: false,
    reviewsTruncated: true,
  });
  expect(calls.map((call) => call.endpoint)).toContain(
    "/api/v1/repos/acme/widgets/pulls/9/files?limit=50&page=2",
  );
  expect(
    calls.some(
      (call) =>
        !call.endpoint.includes("/files") && call.endpoint.includes("page=3"),
    ),
  ).toBe(false);
});

it("waits for both metadata writes before invalidating lists", async () => {
  let releaseAssignees!: () => void;
  const assigneesGate = new Promise<void>((resolve) => {
    releaseAssignees = resolve;
  });
  const { host } = await start(async ({ endpoint, method }) => {
    if (endpoint.endsWith("/issues/4") && method === "PATCH")
      await assigneesGate;
    if (endpoint.endsWith("/labels") && method === "PUT")
      return { status: 500, json: {} };
    return { json: [] };
  });
  let finished = false;
  const update = host.harness.behavior
    .callRpc("updateMetadata", {
      repo: "acme/widgets",
      number: 4,
      labels: ["bug"],
      assignees: ["dev"],
    })
    .finally(() => {
      finished = true;
    })
    .catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  releaseAssignees();
  await expect(update).resolves.toBeInstanceOf(Error);
});

it("serves mention searches from the cached issue list", async () => {
  const { host, calls } = await start(({ endpoint }) => {
    if (endpoint.includes("/issues?"))
      return { json: [issue(7, "Cached mention")] };
    return { json: [] };
  });
  const provider = host.harness.inspection.registrations.mentionProviders.find(
    ({ id }) => id === "issue",
  )!;
  const context = { query: "", trigger: "@" as const, projectId: null, threadId: null };
  await provider.search(context);
  const before = calls.length;
  await expect(provider.search({ ...context, query: "Cached" })).resolves.toMatchObject([
    { id: "acme/widgets#7", title: "#7 Cached mention" },
  ]);
  expect(calls).toHaveLength(before);
});

it("keeps late repository option results under their original profile key", async () => {
  let releaseLabels!: () => void;
  const labelsGate = new Promise<void>((resolve) => {
    releaseLabels = resolve;
  });
  let held = false;
  const { host, calls } = await start(async ({ endpoint, login }) => {
    if (endpoint.endsWith("/labels") && !held) {
      held = true;
      await labelsGate;
    }
    return { json: endpoint.endsWith("/labels") ? [{ name: login, color: "" }] : [] };
  }, {
    profiles: [
      ...defaultProfiles,
      { name: "bot", url: "https://gitea.example/prefix", user: "bot" },
    ],
  });
  const input = { repo: "acme/widgets" };
  const oldRequest = host.harness.behavior.callRpc("repoOptions", input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.harness.behavior.setSettings({ teaProfile: "bot" });
  releaseLabels();
  await oldRequest;
  const before = calls.length;
  await host.harness.behavior.callRpc("repoOptions", input);
  expect(calls.length).toBeGreaterThan(before);
});

it("drops a cached list after every repository fails with an access error", async () => {
  let denied = false;
  const { host, calls } = await start(({ endpoint }) => {
    if (endpoint.includes("/issues?"))
      return denied ? { status: 403, json: {} } : { json: [issue(3)] };
    return { json: [] };
  });
  await listItems(host, { repo: "acme/widgets" });
  denied = true;
  await expect(
    host.harness.behavior.callRpc("listItems", {
      kind: "issue",
      state: "open",
      query: "",
      repo: "acme/widgets",
      refresh: true,
    }),
  ).rejects.toThrow("HTTP 403");
  const before = calls.length;
  denied = false;
  await listItems(host, { repo: "acme/widgets" });
  expect(calls.length).toBeGreaterThan(before);
});

it("reads a large pull request's files in concurrent page batches after a full first page", async () => {
  let inFlight = 0;
  let peak = 0;
  const { host, calls } = await start(async ({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/9")) return { json: issue(9, "Large change") };
    if (path.endsWith("/pulls/9"))
      return {
        json: {
          head: { ref: "feature", sha: headSha },
          base: { ref: "main", sha: baseSha },
        },
      };
    if (!path.endsWith("/files")) return { json: [] };
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 150));
    inFlight -= 1;
    const offset = (page(endpoint) - 1) * 50;
    return {
      json: Array.from(
        { length: Math.max(0, Math.min(50, 420 - offset)) },
        (_, index) => ({
          filename: `src/${offset + index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-old\n+new",
        }),
      ),
    };
  });
  const result = giteaRpcContract.detail.output.parse(
    await host.harness.behavior.callRpc("detail", {
      repo: "acme/widgets",
      number: 9,
      kind: "pr",
    }),
  );
  expect(result.files.map((file) => file.path)).toEqual(
    Array.from({ length: 420 }, (_, index) => `src/${index}.ts`),
  );
  expect(result.filesTruncated).toBe(false);
  expect(peak).toBe(4);
  expect(
    calls.filter((call) => call.endpoint.includes("/pulls/9/files")).length,
  ).toBe(9);
});

it("edits and deletes a conversation comment by id", async () => {
  const { host, calls } = await start(({ method }) =>
    method === "DELETE" ? { status: 204, raw: "" } : { json: {} },
  );
  await host.harness.behavior.callRpc("editComment", {
    repo: "acme/widgets",
    number: 4,
    id: 77,
    body: "Fixed typo",
  });
  await host.harness.behavior.callRpc("deleteComment", {
    repo: "acme/widgets",
    number: 4,
    id: 77,
  });
  expect(
    calls.map(({ method, endpoint, body }) => ({ method, endpoint, body })),
  ).toEqual([
    {
      method: "PATCH",
      endpoint: "/api/v1/repos/acme/widgets/issues/comments/77",
      body: { body: "Fixed typo" },
    },
    {
      method: "DELETE",
      endpoint: "/api/v1/repos/acme/widgets/issues/comments/77",
      body: null,
    },
  ]);
});

it("lists repository labels across pages and assignable users", async () => {
  const { host, calls } = await start(({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/labels"))
      return {
        json:
          page(endpoint) === 1
            ? Array.from({ length: 50 }, (_, index) => ({
                name: `label-${index}`,
                color: "e11d21",
              }))
            : [{ name: "last", color: "#00ff00" }],
      };
    if (path.endsWith("/assignees"))
      return { json: [{ login: "ann" }, { login: "" }, { login: "bo" }] };
    return { json: [] };
  });
  const result = giteaRpcContract.repoOptions.output.parse(
    await host.harness.behavior.callRpc("repoOptions", {
      repo: "acme/widgets",
    }),
  );
  expect(result.labels).toHaveLength(51);
  expect(result.labels.at(-1)).toEqual({ name: "last", color: "#00ff00" });
  expect(result.assignees).toEqual(["ann", "bo"]);
  const seen = calls.length;
  await host.harness.behavior.callRpc("repoOptions", { repo: "Acme/Widgets" });
  expect(calls).toHaveLength(seen);
});

it("rejects Gitea responses over the configured size limit", async () => {
  const { host } = await start(
    () => ({ json: [{ name: "x".repeat(1_200_000), color: "000000" }] }),
    { settings: { cacheEntryLimitMiB: 1 } },
  );
  await expect(
    host.harness.behavior.callRpc("repoOptions", { repo: "acme/widgets" }),
  ).rejects.toThrow("exceeded the 1 MiB limit");
});

it("reuses repository discovery across list requests", async () => {
  let listed = 0;
  isolateTeaEnvironment(`${fixtureDir}:${process.env.PATH ?? ""}`);
  await startTea(() => ({ json: [] }), defaultProfiles);
  const host = createFakePluginHost({
    pluginId: "gitea",
    experimental_declaredIconNames: ["teacup"],
    settings: defaultSettings,
    sdk: {
      projects: {
        list: async () => {
          listed += 1;
          return [];
        },
      },
    },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  await status(host);
  await listItems(host, {});
  await listItems(host, { state: "closed" });
  expect(listed).toBe(1);
});

it("marks a full bounded issue result window as potentially truncated", async () => {
  const { host } = await start(() => ({
    json: Array.from({ length: 50 }, (_, index) => issue(index + 1)),
  }));
  const result = await listItems(host, { repo: "acme/widgets" });
  expect(result.items).toHaveLength(200);
  expect(result.truncated).toBe(true);
});

it("routes each request through the tea profile for the configured origin and path prefix", async () => {
  const { host, calls } = await start(() => ({ json: [issue(4)] }), {
    profiles: [
      { name: "root", url: "https://gitea.example", user: "dev" },
      { name: "elsewhere", url: "https://other.example/prefix", user: "dev" },
      { name: "work", url: "https://GITEA.example:443/prefix/", user: "dev" },
    ],
  });
  const result = await listItems(host, { repo: "acme/widgets" });
  expect(result.items).toMatchObject([
    { repo: "acme/widgets", number: 4, author: "dev" },
  ]);
  expect(calls).toEqual([
    expect.objectContaining({
      login: "work",
      method: "GET",
      endpoint:
        "/api/v1/repos/acme/widgets/issues?state=open&type=issues&limit=50&page=1",
      body: null,
    }),
  ]);
});

it("coalesces aliases for one account and requires a profile choice when accounts differ", async () => {
  const { host, calls } = await start(() => ({ json: { login: "dev" } }), {
    profiles: [
      { name: "zeta", url: "https://gitea.example/prefix", user: "dev" },
      { name: "alpha", url: "https://gitea.example/prefix", user: "Dev" },
    ],
  });
  await expect(
    host.harness.behavior.callRpc("status", null),
  ).resolves.toMatchObject({ state: "connected", login: "dev" });
  expect(calls.map((call) => call.login)).toEqual(["alpha"]);

  const ambiguous = await start(() => ({ json: { login: "dev" } }), {
    profiles: [
      { name: "work", url: "https://gitea.example/prefix", user: "dev" },
      { name: "bot", url: "https://gitea.example/prefix", user: "ci-bot" },
    ],
  });
  await expect(
    ambiguous.host.harness.behavior.callRpc("status", null),
  ).resolves.toMatchObject({
    state: "unavailable",
    error: expect.stringContaining("belong to different users"),
  });
  expect(ambiguous.calls).toEqual([]);
  await ambiguous.host.harness.behavior.setSettings({ teaProfile: "bot" });
  await expect(
    ambiguous.host.harness.behavior.callRpc("status", null),
  ).resolves.toMatchObject({ state: "connected" });
  expect(ambiguous.calls.map((call) => call.login)).toEqual(["bot"]);
});

it("never routes through an explicitly selected profile for another instance", async () => {
  const { host, calls } = await start(() => ({ json: { login: "dev" } }), {
    profiles: [
      ...defaultProfiles,
      { name: "personal", url: "https://gitea.example", user: "dev" },
    ],
    settings: { teaProfile: "personal" },
  });
  await expect(
    host.harness.behavior.callRpc("status", null),
  ).resolves.toMatchObject({
    state: "unavailable",
    error: expect.stringContaining("different Gitea instance"),
  });
  await host.harness.behavior.setSettings({ teaProfile: "missing" });
  await expect(
    host.harness.behavior.callRpc("status", null),
  ).resolves.toMatchObject({
    state: "unavailable",
    error: expect.stringContaining('"missing" was not found'),
  });
  expect(calls).toEqual([]);
});

it("accepts plain HTTP only for loopback instances", async () => {
  const { host, calls } = await start(() => ({ json: [] }), {
    settings: { baseUrl: "http://remote.example" },
  });
  await expect(listItems(host, { repo: "acme/widgets" })).rejects.toThrow(
    "must use HTTPS",
  );
  expect(calls).toEqual([]);
});

it("lists only issues assigned to the authenticated account and creates from My Issues with self-assignment", async () => {
  const { host, calls } = await start(({ endpoint, method }) => {
    if (endpoint.endsWith("/api/v1/user")) return { json: { login: "dev" } };
    if (method === "POST" && endpoint.endsWith("/issues"))
      return { status: 201, json: issue(9) };
    if (endpoint.includes("/issues?"))
      return { json: [
        { ...issue(1), assignees: [{ login: "dev" }] },
        { ...issue(2), assignees: [{ login: "other" }] },
        { ...issue(3), assignees: [{ login: "dev" }], pull_request: {} },
      ] };
    return { json: [] };
  });
  const mine = giteaRpcContract.listMyIssues.output.parse(
    await host.harness.behavior.callRpc("listMyIssues", {
      repo: "acme/widgets", state: "open", query: "", refresh: true,
    }),
  );
  expect(mine.items.map((item) => item.number)).toEqual([1]);
  await expect(host.harness.behavior.runCli(["my-issues", "acme/widgets", "--json"]))
    .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('"login":"dev"') });
  expect(calls.find(({ endpoint }) => endpoint.includes("/issues?"))?.endpoint)
    .toContain("assigned_by=dev");
  await host.harness.behavior.callRpc("createIssue", {
    repo: "acme/widgets", title: "Mine", body: "", assignToMe: true,
  });
  await host.harness.behavior.callRpc("createIssue", {
    repo: "acme/widgets", title: "Ordinary", body: "",
  });
  expect(calls.filter(({ method, endpoint }) => method === "POST" && endpoint.endsWith("/issues"))
    .map(({ body }) => body)).toEqual([
      { title: "Mine", body: "", assignee: "dev" },
      { title: "Ordinary", body: "" },
    ]);
});

it("sends mutation JSON on stdin to the matching REST endpoints and accepts empty responses", async () => {
  const { host, calls } = await start(({ method, endpoint }) => {
    if (method === "POST" && endpoint.endsWith("/issues"))
      return { status: 201, json: issue(5, "New issue") };
    if (endpoint.endsWith("/comments")) return { status: 204, raw: "" };
    return { json: {} };
  });
  await expect(
    host.harness.behavior.callRpc("createIssue", {
      repo: "acme/widgets",
      title: "New issue",
      body: "Details",
    }),
  ).resolves.toMatchObject({ number: 5, title: "New issue" });
  await expect(
    host.harness.behavior.callRpc("comment", {
      repo: "acme/widgets",
      number: 4,
      body: "Looks good; don't leak me",
    }),
  ).resolves.toEqual({ ok: true });
  await host.harness.behavior.callRpc("setState", {
    repo: "acme/widgets",
    number: 4,
    state: "closed",
  });
  await host.harness.behavior.callRpc("updateMetadata", {
    repo: "acme/widgets",
    number: 4,
    labels: ["bug"],
    assignees: ["dev"],
  });
  await host.harness.behavior.callRpc("review", {
    repo: "acme/widgets",
    number: 4,
    event: "APPROVED",
    body: "Ship it",
  });
  const prefix = "/api/v1/repos/acme/widgets";
  expect(
    calls.map(({ method, endpoint, body }) => ({ method, endpoint, body })),
  ).toEqual(
    expect.arrayContaining([
      {
        method: "POST",
        endpoint: `${prefix}/issues`,
        body: { title: "New issue", body: "Details" },
      },
      {
        method: "POST",
        endpoint: `${prefix}/issues/4/comments`,
        body: { body: "Looks good; don't leak me" },
      },
      {
        method: "PATCH",
        endpoint: `${prefix}/issues/4`,
        body: { state: "closed" },
      },
      {
        method: "PUT",
        endpoint: `${prefix}/issues/4/labels`,
        body: { labels: ["bug"] },
      },
      {
        method: "PATCH",
        endpoint: `${prefix}/issues/4`,
        body: { assignees: ["dev"] },
      },
      {
        method: "POST",
        endpoint: `${prefix}/pulls/4/reviews`,
        body: { event: "APPROVED", body: "Ship it" },
      },
    ]),
  );
  expect(calls).toHaveLength(6);
  for (const call of calls) {
    expect(call.args).toEqual([
      "api",
      "--login",
      "work",
      "--method",
      call.method,
      "--include",
      "--data",
      "@-",
      call.endpoint,
    ]);
  }
});

it.each([
  {
    name: "nonzero exit",
    reply: { exitCode: 1, stderr: "Error: request failed: token=hunter2" },
    message:
      "The tea request to Gitea failed. Check network access and server availability, then try again.",
  },
  {
    name: "process terminated by a signal",
    reply: { signal: "SIGTERM" as const },
    message: "The tea request to Gitea timed out. Try again later.",
  },
  {
    name: "removed login profile",
    reply: { exitCode: 1, stderr: "login name 'work' does not exist" },
    message: expect.stringContaining('"work" is no longer available'),
  },
  {
    name: "rejected credentials",
    reply: { status: 401, json: { message: "token hunter2 is invalid" } },
    message: expect.stringContaining('Gitea rejected tea login profile "work"'),
  },
  {
    name: "invalid JSON",
    reply: { raw: "<html>hunter2</html>" },
    message: "tea returned invalid JSON from Gitea.",
  },
])(
  "reports $name as a safe list failure without tea output",
  async ({ reply, message }) => {
    const { host } = await start(() => reply);
    const failure = await listItems(host, { repo: "acme/widgets" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toEqual(message);
    expect((failure as Error).message).not.toContain("hunter2");
  },
);

it("reports a missing tea executable as a readiness problem", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "gitea-path-"));
  cleanups.push(() => rmSync(emptyDir, { recursive: true, force: true }));
  isolateTeaEnvironment(emptyDir);
  const host = createFakePluginHost({
    pluginId: "gitea",
    experimental_declaredIconNames: ["teacup"],
    settings: defaultSettings,
    sdk: { projects: { list: async () => [] } },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  const result = await host.harness.behavior.callRpc("status", null);
  expect(result).toMatchObject({
    state: "unavailable",
    error: expect.stringContaining("Gitea CLI tea was not found"),
  });
  expect(result).not.toHaveProperty("account");
  expect(result).not.toHaveProperty("login");
});

it("exposes the validated read and write handlers through bb gitea commands", async () => {
  const { host, calls } = await start(({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/4"))
      return { json: { ...issue(4, "Existing"), body: "Description" } };
    if (path.endsWith("/comments") || path.endsWith("/reviews"))
      return { json: [] };
    return { json: {} };
  });
  const detail = await host.harness.behavior.runCli([
    "show",
    "issue",
    "acme/widgets",
    "4",
    "--json",
  ]);
  expect(detail.exitCode).toBe(0);
  expect(detail.stdout).toContain("Description");
  for (const argv of [
    ["comment", "acme/widgets", "4", "CLI", "comment"],
    ["set-state", "acme/widgets", "4", "closed"],
    ["metadata", "acme/widgets", "4", "bug,urgent", "dev"],
    ["review", "acme/widgets", "4", "APPROVED", "Looks", "good"],
  ])
    expect((await host.harness.behavior.runCli(argv)).exitCode).toBe(0);
  const prefix = "/api/v1/repos/acme/widgets";
  expect(
    calls.map(({ method, endpoint, body }) => ({ method, endpoint, body })),
  ).toEqual(
    expect.arrayContaining([
      {
        method: "POST",
        endpoint: `${prefix}/issues/4/comments`,
        body: { body: "CLI comment" },
      },
      {
        method: "PATCH",
        endpoint: `${prefix}/issues/4`,
        body: { state: "closed" },
      },
      {
        method: "PUT",
        endpoint: `${prefix}/issues/4/labels`,
        body: { labels: ["bug", "urgent"] },
      },
      {
        method: "POST",
        endpoint: `${prefix}/pulls/4/reviews`,
        body: { event: "APPROVED", body: "Looks good" },
      },
    ]),
  );
  const invalid = await host.harness.behavior.runCli([
    "review",
    "acme/widgets",
    "4",
    "MERGE",
  ]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr).toContain("Invalid option");
});

function pullJson(head = headSha, base = baseSha) {
  return {
    head: { ref: "feature", sha: head },
    base: { ref: "main", sha: base },
    merged: false,
    state: "open",
  };
}

function diffApi(
  files: unknown[],
  diff: () => TeaReply,
  pull: () => unknown = () => pullJson(),
) {
  return ({ endpoint }: TeaCall): TeaReply => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/9")) return { json: issue(9, "Diff") };
    if (path.endsWith("/pulls/9")) return { json: pull() };
    if (path.endsWith("/pulls/9.diff")) return diff();
    if (path.endsWith("/pulls/9/files"))
      return { json: page(endpoint) === 1 ? files : [] };
    return { json: [] };
  };
}

async function pullDetail(host: Host) {
  return giteaRpcContract.detail.output.parse(
    await host.harness.behavior.callRpc("detail", {
      repo: "acme/widgets",
      number: 9,
      kind: "pr",
    }),
  );
}

it("preserves unavailable checks in pull request detail", async () => {
  const { host } = await start(({ endpoint }) => {
    if (endpoint.includes("/statuses/")) return { status: 500, json: {} };
    return diffApi([], () => ({ json: "" }))({
      args: [], login: "", method: "GET", endpoint, body: null,
    });
  });
  const detail = await pullDetail(host);
  expect(detail.checks).toEqual({ state: "unavailable" });
});

const rawHunk = "@@ -1 +1 @@\n-old\n+new";
const rawDiff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  rawHunk,
  "diff --git a/old name.ts b/new name.ts",
  "rename from old name.ts",
  "rename to new name.ts",
  "--- a/old name.ts",
  "+++ b/new name.ts",
  rawHunk,
  "diff --git a/added.ts b/added.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/added.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/removed.ts b/removed.ts",
  "deleted file mode 100644",
  "--- a/removed.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/huge.ts b/huge.ts",
  "--- a/huge.ts",
  "+++ b/huge.ts",
  `@@ -0,0 +1,30000 @@\n${"+0123456789\n".repeat(30_000)}`,
].join("\n");
const rawFiles = [
  { filename: "src/app.ts", status: "modified", additions: 1, deletions: 1 },
  {
    filename: "new name.ts",
    previous_filename: "old name.ts",
    status: "renamed",
    additions: 1,
    deletions: 1,
  },
  { filename: "added.ts", status: "added", additions: 1, deletions: 0 },
  { filename: "removed.ts", status: "deleted", additions: 0, deletions: 1 },
  { filename: "logo.png", status: "modified", additions: 0, deletions: 0 },
  { filename: "huge.ts", status: "modified", additions: 30000, deletions: 0 },
  { filename: "ghost.ts", status: "modified", additions: 1, deletions: 0 },
];

it("fills omitted file patches from the raw pull request diff through tea", async () => {
  const { host, calls } = await start(
    diffApi(rawFiles, () => ({ raw: rawDiff })),
  );
  const result = await pullDetail(host);
  expect(
    result.files.map(({ path, previousPath, diff }) => ({
      path,
      previousPath,
      kind: diff.kind,
    })),
  ).toEqual([
    { path: "src/app.ts", previousPath: null, kind: "text" },
    { path: "new name.ts", previousPath: "old name.ts", kind: "text" },
    { path: "added.ts", previousPath: null, kind: "text" },
    { path: "removed.ts", previousPath: null, kind: "text" },
    { path: "logo.png", previousPath: null, kind: "binary" },
    { path: "huge.ts", previousPath: null, kind: "too-large" },
    { path: "ghost.ts", previousPath: null, kind: "unavailable" },
  ]);
  const app = result.files[0]!.diff;
  expect(app.kind === "text" && app.patch).toContain("+new");
  expect(app.kind === "text" && app.patch).not.toContain("added.ts");
  expect(result.files[5]!.diff).toEqual({
    kind: "too-large",
    bytes: expect.any(Number),
    limit: 256 * 1024,
  });
  expect(result.files[6]!.diff).toEqual({
    kind: "unavailable",
    reason: "missing",
  });
  const diffCall = calls.find((call) =>
    call.endpoint.endsWith("/pulls/9.diff"),
  );
  expect(diffCall?.args).toEqual([
    "api",
    "--login",
    "work",
    "--method",
    "GET",
    "--include",
    "/api/v1/repos/acme/widgets/pulls/9.diff",
  ]);
});

it("skips the raw diff when Gitea includes every patch", async () => {
  const { host, calls } = await start(
    diffApi([{ filename: "a.ts", status: "modified", patch: rawHunk }], () => ({
      status: 500,
    })),
  );
  expect((await pullDetail(host)).files[0]!.diff).toEqual({
    kind: "text",
    patch: rawHunk,
  });
  expect(calls.some((call) => call.endpoint.endsWith(".diff"))).toBe(false);
});

it("keeps pull request detail when the raw diff fails or exceeds the output limit", async () => {
  for (const [reply, reason] of [
    [{ status: 404 }, "diff-failed"],
    [{ exitCode: 1, stderr: "boom" }, "diff-failed"],
    [{ raw: "x".repeat(17 * 1024 * 1024) }, "diff-too-large"],
  ] as const) {
    const { host } = await start(
      diffApi(
        [
          { filename: "a.ts", status: "modified" },
          { filename: "b.ts", status: "modified", patch: rawHunk },
        ],
        () => reply,
      ),
    );
    const result = await pullDetail(host);
    expect(result.files.map((file) => file.diff)).toEqual([
      { kind: "unavailable", reason },
      { kind: "text", patch: rawHunk },
    ]);
    await host.harness.lifecycle.dispose();
  }
}, 20_000);

it("rereads files once when the head moves and marks diffs stale if it keeps moving", async () => {
  const moved = "c".repeat(40);
  const heads = [headSha, moved, moved];
  const settled = await start(
    diffApi(
      [{ filename: "src/app.ts", status: "modified" }],
      () => ({ raw: rawDiff }),
      () => pullJson(heads.shift() ?? moved),
    ),
  );
  const retried = await pullDetail(settled.host);
  expect(retried.files[0]!.diff.kind).toBe("text");
  expect(
    settled.calls.filter((call) =>
      call.endpoint.endsWith("/pulls/9/files?limit=50&page=1"),
    ),
  ).toHaveLength(2);
  expect(
    settled.calls.some((call) => call.endpoint.includes(`/statuses/${moved}`)),
  ).toBe(true);
  await settled.host.harness.lifecycle.dispose();

  let read = 0;
  const drifting = await start(
    diffApi(
      [{ filename: "src/app.ts", status: "modified" }],
      () => ({ raw: rawDiff }),
      () => pullJson(String(++read).repeat(40)),
    ),
  );
  const stale = await pullDetail(drifting.host);
  expect(stale.files[0]!.diff).toEqual({
    kind: "unavailable",
    reason: "stale",
  });
  expect(read).toBe(3);
});

async function conversation(host: Host, input: Record<string, unknown> = {}) {
  return giteaRpcContract.conversation.output.parse(
    await host.harness.behavior.callRpc("conversation", {
      repo: "acme/widgets",
      number: 9,
      kind: "pr",
      ...input,
    }),
  );
}

async function files(host: Host, input: Record<string, unknown> = {}) {
  return giteaRpcContract.pullFiles.output.parse(
    await host.harness.behavior.callRpc("pullFiles", {
      repo: "acme/widgets",
      number: 9,
      ...input,
    }),
  );
}

function displaySignals(host: Host) {
  return host.harness.inspection.realtimeSignals.filter(
    (signal) => signal.channel === "display-changed",
  );
}

const readsFiles = (call: TeaCall) =>
  call.endpoint.includes("/pulls/9/files") ||
  call.endpoint.endsWith("/pulls/9.diff");

it("finds a legacy thread key when the repository casing differs", async () => {
  const { host } = await start(
    diffApi(rawFiles, () => ({ raw: rawDiff }), () => pullJson()),
  );
  await host.bb.storage.kv.set("thread:Acme/Widgets:9", "legacy-thread");

  await expect(conversation(host)).resolves.toMatchObject({
    threadId: "legacy-thread",
  });
});

it("loads both directions of issue dependencies without hiding the issue when links fail", async () => {
  const { host, calls } = await start(({ endpoint }) => {
    if (endpoint.endsWith("/issues/4")) return { json: issue(4) };
    if (endpoint.includes("/issues/4/comments")) return { json: [] };
    if (endpoint.includes("/issues/4/dependencies")) return { json: [issue(5, "Blocks me")] };
    if (endpoint.includes("/issues/4/blocks")) return { json: [{ ...issue(6, "I block"), html_url: "https://gitea.example/prefix/other/api/issues/6" }] };
    return { status: 404 };
  });
  const result = await conversation(host, { kind: "issue", number: 4 });
  expect(result.conversation).toMatchObject({
    relations: { state: "loaded", blockers: [{ repo: "acme/widgets", number: 5, title: "Blocks me" }], blocking: [{ repo: "other/api", number: 6, title: "I block" }] },
  });
  expect(calls.filter(call => /\/issues\/4\/(dependencies|blocks)/.test(call.endpoint))).toHaveLength(2);
});

it("marks issue dependencies unavailable without losing the conversation", async () => {
  const { host } = await start(({ endpoint }) => {
    if (endpoint.endsWith("/issues/4")) return { json: issue(4) };
    if (endpoint.includes("/issues/4/comments")) return { json: [] };
    return { status: 404 };
  });
  expect((await conversation(host, { kind: "issue", number: 4 })).conversation).toMatchObject({ title: "Issue 4", relations: { state: "unavailable" } });
});

it("reads the pull request conversation without files, loads files on request, and serves repeats from cache", async () => {
  const { host, calls } = await start(
    diffApi(
      rawFiles,
      () => ({ raw: rawDiff }),
      () => ({
        ...pullJson(),
        changed_files: rawFiles.length,
      }),
    ),
  );
  const first = await conversation(host);
  expect(first.freshness.state).toBe("fresh");
  expect(first.conversation).toMatchObject({
    kind: "pr",
    title: "Diff",
    headRefName: "feature",
    revision: { head: headSha, base: baseSha },
    changedFiles: rawFiles.length,
  });
  expect(calls.some(readsFiles)).toBe(false);
  const coldCalls = calls.length;
  expect((await conversation(host)).freshness.state).toBe("fresh");
  expect(calls).toHaveLength(coldCalls);

  const listed = await files(host, {
    revision: { head: headSha, base: baseSha },
  });
  expect(listed.stale).toBe(false);
  expect(listed.files.map((file) => file.diff.kind)).toContain("text");
  expect(
    calls
      .slice(coldCalls)
      .map((call) => call.endpoint.split("?")[0]!.replace(/.*\/pulls\//, "")),
  ).toEqual(["9/files", "9.diff", "9"]);
  const fileCalls = calls.length;
  await files(host, { revision: { head: headSha, base: baseSha } });
  expect(calls).toHaveLength(fileCalls);
});

it("keeps the conversation when statuses fail and normalizes item state and draft once", async () => {
  const { host } = await start(({ endpoint }) => {
    if (endpoint.endsWith("/issues/9"))
      return { json: { ...issue(9, "WIP: Needs review"), state: "unexpected" } };
    if (endpoint.endsWith("/pulls/9")) return { json: pullJson() };
    if (endpoint.includes(`/statuses/${headSha}`)) return { status: 500 };
    if (endpoint.includes("/comments")) return { json: [] };
    return { json: [] };
  });
  const result = await conversation(host);
  expect(result.conversation).toMatchObject({
    kind: "pr",
    state: "closed",
    draft: true,
    checks: { state: "unavailable" },
  });
});

it("keeps revision-bound files cached when a comment changes the conversation", async () => {
  const { host, calls } = await start(
    diffApi(
      rawFiles,
      () => ({ raw: rawDiff }),
      () => ({ ...pullJson(), changed_files: rawFiles.length }),
    ),
  );
  const revision = { head: headSha, base: baseSha };
  await conversation(host);
  await files(host, { revision });
  await host.harness.behavior.callRpc("comment", {
    repo: "acme/widgets",
    number: 9,
    body: "Looks good",
  });
  const afterComment = calls.length;
  await files(host, { revision });
  expect(calls.slice(afterComment).some(readsFiles)).toBe(false);
  await conversation(host);
  expect(calls.length).toBeGreaterThan(afterComment);
});

it("names team reviewers and ghost authors instead of rejecting the response", async () => {
  const { host } = await start(({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/9")) return { json: issue(9, "Team") };
    if (path.endsWith("/pulls/9")) return { json: pullJson() };
    if (path.endsWith("/pulls/9/reviews"))
      return {
        json:
          page(endpoint) === 1
            ? [
                { user: null, team: { name: "core" }, state: "REQUEST_REVIEW" },
                { user: null, team: null, state: "COMMENT" },
              ]
            : [],
      };
    return { json: [] };
  });
  const { conversation: loaded } = await conversation(host);
  expect(loaded.kind === "pr" && loaded.reviews.map((r) => r.author)).toEqual([
    "core",
    "",
  ]);
});

it("places review comments on the diff side Gitea reports and skips pending drafts", async () => {
  const { host, calls } = await start(({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/9")) return { json: issue(9, "Lines") };
    if (path.endsWith("/pulls/9")) return { json: pullJson() };
    if (path.endsWith("/pulls/9/reviews"))
      return {
        json:
          page(endpoint) === 1
            ? [
                {
                  id: 1,
                  user: { login: "ann" },
                  state: "COMMENT",
                  comments_count: 2,
                },
                {
                  id: 2,
                  user: { login: "me" },
                  state: "PENDING",
                  comments_count: 1,
                },
                {
                  id: 3,
                  user: { login: "bo" },
                  state: "APPROVED",
                  comments_count: 0,
                },
              ]
            : [],
      };
    if (path.endsWith("/pulls/9/reviews/1/comments"))
      return {
        json: [
          {
            id: 10,
            user: { login: "ann" },
            body: "new side",
            path: "src/a.ts",
            position: 12,
            original_position: 0,
          },
          {
            id: 11,
            user: { login: "ann" },
            body: "old side",
            path: "src/a.ts",
            position: 0,
            original_position: 4,
          },
          {
            id: 12,
            user: { login: "ann" },
            body: "no line",
            path: "src/a.ts",
            position: 0,
            original_position: 0,
          },
        ],
      };
    return { json: [] };
  });
  const { conversation: loaded } = await conversation(host);
  expect(
    loaded.kind === "pr" &&
      loaded.reviewComments.map(({ id, line, side, body }) => ({
        id,
        line,
        side,
        body,
      })),
  ).toEqual([
    { id: 10, line: 12, side: "additions", body: "new side" },
    { id: 11, line: 4, side: "deletions", body: "old side" },
  ]);
  expect(calls.some((call) => call.endpoint.includes("/reviews/2/"))).toBe(
    false,
  );
  expect(calls.some((call) => call.endpoint.includes("/reviews/3/"))).toBe(
    false,
  );
});

it("posts a line comment as a single-comment review on the given side", async () => {
  const { host, calls } = await start(() => ({ json: {} }));
  await host.harness.behavior.callRpc("reviewComment", {
    repo: "acme/widgets",
    number: 9,
    commitId: headSha,
    path: "src/a.ts",
    line: 4,
    side: "deletions",
    body: "Why remove this?",
  });
  expect(
    calls.map(({ method, endpoint, body }) => ({ method, endpoint, body })),
  ).toEqual([
    {
      method: "POST",
      endpoint: "/api/v1/repos/acme/widgets/pulls/9/reviews",
      body: {
        event: "COMMENT",
        body: "",
        commit_id: headSha,
        comments: [
          {
            path: "src/a.ts",
            body: "Why remove this?",
            new_position: 0,
            old_position: 4,
          },
        ],
      },
    },
  ]);
});

it("invalidates a cached item after a mutation and announces the change without content", async () => {
  let title = "Before";
  const { host, calls } = await start(({ endpoint, method }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/9") && method === "GET")
      return { json: issue(9, title) };
    if (path.endsWith("/pulls/9")) return { json: pullJson() };
    return { json: method === "GET" ? [] : {} };
  });
  await conversation(host);
  title = "After";
  expect((await conversation(host)).conversation.title).toBe("Before");
  await host.harness.behavior.callRpc("comment", {
    repo: "acme/widgets",
    number: 9,
    body: "done",
  });
  expect(displaySignals(host).at(-1)?.payload).toEqual({
    item: "acme/widgets#9",
  });
  const before = calls.length;
  expect((await conversation(host)).conversation.title).toBe("After");
  expect(calls.length).toBeGreaterThan(before);
});

it("serves stale content while a background refresh runs and reports its outcome", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  cleanups.push(() => {
    vi.useRealTimers();
  });
  let title = "First";
  let failing = false;
  const { host } = await start(({ endpoint }) => {
    const path = endpoint.split("?")[0]!;
    if (path.endsWith("/issues/4"))
      return failing ? { status: 500 } : { json: issue(4, title) };
    return { json: [] };
  });
  const read = () => conversation(host, { number: 4, kind: "issue" });
  await read();
  title = "Second";
  vi.setSystemTime(Date.now() + 20_000);
  const stale = await read();
  expect(stale).toMatchObject({
    freshness: { state: "refreshing" },
    conversation: { title: "First" },
  });
  await vi.waitFor(() => expect(displaySignals(host)).toHaveLength(1));
  expect(displaySignals(host)[0]!.payload).toEqual({ item: "acme/widgets#4" });
  expect(await read()).toMatchObject({
    freshness: { state: "fresh" },
    conversation: { title: "Second" },
  });

  failing = true;
  vi.setSystemTime(Date.now() + 20_000);
  expect((await read()).freshness.state).toBe("refreshing");
  await vi.waitFor(() => expect(displaySignals(host)).toHaveLength(2));
  expect(await read()).toMatchObject({
    freshness: { state: "stale-error", error: "Gitea API returned HTTP 500." },
    conversation: { title: "Second" },
  });
});

it("keys cached content by account and clears it when settings change or Gitea rejects the login", async () => {
  let rejected = false;
  const { host, calls } = await start(
    ({ endpoint }) => {
      const path = endpoint.split("?")[0]!;
      if (rejected) return { status: 401 };
      if (path.endsWith("/issues/4")) return { json: issue(4) };
      if (path.endsWith("/issues/5")) return { json: issue(5) };
      return { json: [] };
    },
    {
      profiles: [
        ...defaultProfiles,
        { name: "ops", url: "https://gitea.example/prefix", user: "ops" },
      ],
      settings: { teaProfile: "work" },
    },
  );
  const read = (number: number) =>
    conversation(host, { number, kind: "issue" });
  await read(4);
  await read(5);
  const warm = calls.length;
  await read(4);
  expect(calls).toHaveLength(warm);

  await host.harness.behavior.setSettings({ teaProfile: "ops" });
  expect(displaySignals(host).at(-1)?.payload).toEqual({ item: null });
  await read(4);
  expect(calls.slice(warm).every((call) => call.login === "ops")).toBe(true);
  expect(calls.length).toBeGreaterThan(warm);

  await read(5);
  rejected = true;
  await expect(read(4)).resolves.toBeDefined();
  await expect(
    conversation(host, { number: 4, kind: "issue", refresh: true }),
  ).rejects.toThrow('Gitea rejected tea login profile "ops"');
  const afterRejection = calls.length;
  const announced = displaySignals(host).length;
  await expect(read(5)).rejects.toThrow("rejected");
  expect(calls.length).toBeGreaterThan(afterRejection);
  await expect(read(5)).rejects.toThrow("rejected");
  expect(displaySignals(host)).toHaveLength(announced);
});

async function myPulls(host: Host, input: Record<string, unknown> = {}) {
  return giteaRpcContract.listMyPullRequests.output.parse(
    await host.harness.behavior.callRpc("listMyPullRequests", {
      state: "open",
      query: "",
      ...input,
    }),
  );
}

function listGitea(pulls: () => TeaReply) {
  return ({ endpoint }: TeaCall): TeaReply => {
    const path = endpoint.split("?")[0]!;
    if (path === "/api/v1/user") return { json: { login: "dev" } };
    if (path.endsWith("/issues") && page(endpoint) === 1) return pulls();
    return { json: [] };
  };
}

const readsList = (call: TeaCall) => call.endpoint.includes("type=pulls");

function authoredPull(number: number, title: string, author = "dev") {
  return {
    ...issue(number, title),
    user: { login: author },
    pull_request: { merged: false },
  };
}

it("serves a remembered pull request list without Gitea reads and refreshes a stale one once in the background", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  cleanups.push(() => {
    vi.useRealTimers();
  });
  let title = "First";
  let failing = false;
  const { host, calls } = await start(
    listGitea(() =>
      failing
        ? { status: 502 }
        : {
            json: [authoredPull(4, title), authoredPull(5, "Theirs", "ana")],
          },
    ),
  );
  const cold = await myPulls(host);
  expect(cold.items.map((item) => item.title)).toEqual(["First"]);
  expect(cold.freshness.state).toBe("fresh");
  const warm = calls.length;
  const narrowed = await myPulls(host, { query: "nothing matches" });
  expect(narrowed.items).toEqual([]);
  expect(narrowed.account).toBe(cold.account);
  expect(calls).toHaveLength(warm);

  title = "Second";
  vi.setSystemTime(Date.now() + 20_000);
  const stale = await Promise.all([myPulls(host), myPulls(host)]);
  expect(
    stale.map((list) => [list.freshness.state, list.items[0]?.title]),
  ).toEqual([
    ["refreshing", "First"],
    ["refreshing", "First"],
  ]);
  await vi.waitFor(() =>
    expect(displaySignals(host).at(-1)?.payload).toEqual({ item: "lists" }),
  );
  expect(calls.slice(warm).filter(readsList)).toHaveLength(1);
  expect(await myPulls(host)).toMatchObject({
    freshness: { state: "fresh" },
    items: [{ title: "Second" }],
  });

  failing = true;
  vi.setSystemTime(Date.now() + 20_000);
  expect((await myPulls(host)).freshness.state).toBe("refreshing");
  await vi.waitFor(() => expect(displaySignals(host)).toHaveLength(2));
  expect(await myPulls(host)).toMatchObject({
    freshness: {
      state: "stale-error",
      error: "Gitea API returned HTTP 502.",
    },
    items: [{ title: "Second" }],
  });
  const settled = calls.length;
  await myPulls(host);
  expect(calls).toHaveLength(settled);
});

it("rereads pull request lists after Refresh, list-changing mutations, account changes, and a rejected login", async () => {
  let rejected = false;
  const { host, calls } = await start(
    ({ endpoint, method }) => {
      if (rejected) return { status: 401 };
      if (method !== "GET") return { json: {} };
      return listGitea(() => ({ json: [authoredPull(4, "Mine")] }))({
        endpoint,
      } as TeaCall);
    },
    {
      profiles: [
        ...defaultProfiles,
        { name: "ops", url: "https://gitea.example/prefix", user: "ops" },
      ],
      settings: { teaProfile: "work" },
    },
  );
  const listReads = () => calls.filter(readsList).length;
  const first = await myPulls(host);
  await myPulls(host, { refresh: true });
  expect(listReads()).toBe(2);

  await host.harness.behavior.callRpc("comment", {
    repo: "acme/widgets",
    number: 4,
    body: "noted",
  });
  await myPulls(host);
  expect(listReads()).toBe(2);
  await host.harness.behavior.callRpc("setState", {
    repo: "acme/widgets",
    number: 4,
    state: "closed",
  });
  expect(displaySignals(host).at(-1)?.payload).toEqual({ item: "lists" });
  await myPulls(host);
  expect(listReads()).toBe(3);

  await host.harness.behavior.setSettings({ teaProfile: "ops" });
  const other = await myPulls(host);
  expect(other.account).not.toBe(first.account);
  expect(calls.filter(readsList).at(-1)?.login).toBe("ops");
  await expect(status(host)).resolves.toMatchObject({
    state: "connected",
    account: other.account,
  });

  rejected = true;
  await expect(status(host)).resolves.toMatchObject({
    state: "unavailable",
  });
  await expect(myPulls(host)).rejects.toThrow("Gitea rejected tea login");
});

it("reports a revision change instead of binding old diffs to the conversation", async () => {
  const moved = "c".repeat(40);
  let head = headSha;
  const { host, calls } = await start(
    diffApi(
      [{ filename: "src/app.ts", status: "modified", patch: rawHunk }],
      () => ({ raw: rawDiff }),
      () => pullJson(head),
    ),
  );
  const shown = (await conversation(host)).conversation;
  expect(shown.kind === "pr" && shown.revision.head).toBe(headSha);
  head = moved;
  const listed = await files(host, {
    revision: { head: headSha, base: baseSha },
  });
  expect(listed.revision.head).toBe(moved);
  expect(listed.stale).toBe(false);
  expect(displaySignals(host).at(-1)?.payload).toEqual({
    item: "acme/widgets#9",
  });
  const before = calls.length;
  const reread = (await conversation(host)).conversation;
  expect(reread.kind === "pr" && reread.revision.head).toBe(moved);
  expect(calls.length).toBeGreaterThan(before);
  const cached = calls.length;
  await files(host, { revision: { head: moved, base: baseSha } });
  expect(calls).toHaveLength(cached);
});

it("keeps full detail uncached for the CLI show command", async () => {
  const { host, calls } = await start(
    diffApi([{ filename: "a.ts", status: "modified", patch: rawHunk }], () => ({
      status: 500,
    })),
  );
  await conversation(host);
  const before = calls.length;
  await pullDetail(host);
  const once = calls.length - before;
  await pullDetail(host);
  expect(calls.length - before).toBe(once * 2);
});

type ThreadState = {
  spawned: number;
  archiveFailures: number;
  getFailure: Error | null;
  getGate: Promise<void> | null;
  sendGate: Promise<void> | null;
  queueSends: boolean;
  queued: Map<
    string,
    Array<{ id: string; originPluginId: string; text: string }>
  >;
  withdrawFailures: number;
  onStop: ((threadId: string) => Promise<void>) | null;
  output: string;
  outputGate: Promise<void> | null;
  threads: Map<string, Partial<ReturnType<typeof makeThreadResponse>>>;
};

async function startAutoFixers() {
  const widgets = gitSource("https://gitea.example/prefix/acme/widgets.git");
  cleanups.push(() => rmSync(widgets, { recursive: true, force: true }));
  const pulls = new Map<string, Record<string, unknown>>();
  const gitea = {
    pullFailure: null as number | null,
    listGate: null as Promise<void> | null,
    listRequests: 0,
    pulls,
  };
  const addPull = (repo: string, number: number, author: string) =>
    pulls.set(`${repo}#${number}`, {
      ...issue(number, `Change ${number}`),
      user: { login: author },
      html_url: `https://gitea.example/prefix/${repo}/pulls/${number}`,
      pull_request: { merged: false },
      ...pullJson(),
      merged: false,
      merged_at: null,
      closed_at: null,
    });
  addPull("acme/widgets", 42, "dev");
  addPull("acme/widgets", 43, "someone");
  addPull("acme/widgets", 44, "dev");
  addPull("ops/api", 7, "dev");
  const state: ThreadState = {
    spawned: 0,
    archiveFailures: 0,
    getFailure: null,
    getGate: null,
    sendGate: null,
    queueSends: false,
    queued: new Map(),
    withdrawFailures: 0,
    onStop: null,
    output: "",
    outputGate: null,
    threads: new Map(),
  };
  const patchThread = (
    threadId: string,
    patch: Partial<ReturnType<typeof makeThreadResponse>>,
  ) =>
    state.threads.set(threadId, { ...state.threads.get(threadId), ...patch });
  const threads: FakeSdkOverrides["threads"] = {
    spawn: async () => ({ id: `auto-fixer-${++state.spawned}` }),
    send: async ({ threadId, input }) => {
      await state.sendGate;
      if (!state.queueSends) return { ok: true, delivery: "sent" };
      const entries = state.queued.get(threadId) ?? [];
      const id = `queued-${threadId}-${entries.length + 1}`;
      state.queued.set(threadId, [
        ...entries,
        {
          id,
          originPluginId: "gitea",
          text: input
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(""),
        },
      ]);
      return {
        ok: true,
        delivery: "queued",
        queuedMessage: { id, threadId },
      };
    },
    stop: async ({ threadId }) => {
      await state.onStop?.(threadId);
      return { ok: true };
    },
    archive: async ({ threadId }) => {
      if (state.archiveFailures > 0) {
        state.archiveFailures -= 1;
        throw new Error("host offline");
      }
      patchThread(threadId, { archivedAt: 1 });
      return { ok: true };
    },
    unarchive: async ({ threadId }) => {
      patchThread(threadId, { archivedAt: null });
      return { ok: true };
    },
    get: async ({ threadId }) => {
      const gate = state.getGate;
      state.getGate = null;
      await gate;
      if (state.getFailure) throw state.getFailure;
      if (state.threads.get(threadId)?.deletedAt)
        throw Object.assign(new Error("HTTP 404: Thread not found"), {
          code: "thread_not_found",
        });
      return makeThreadResponse({
        id: threadId,
        status: "active",
        ...state.threads.get(threadId),
      });
    },
    output: async () => {
      const gate = state.outputGate;
      state.outputGate = null;
      await gate;
      return { output: state.output };
    },
    queuedMessages: {
      list: async ({ threadId }) => [
        ...(state.queued.get(threadId) ?? []),
        { id: `user-${threadId}`, originPluginId: null, text: "" },
      ],
      delete: async ({ threadId, queuedMessageId }) => {
        if (state.withdrawFailures > 0) {
          state.withdrawFailures -= 1;
          throw new Error("queue unavailable");
        }
        state.queued.set(
          threadId,
          (state.queued.get(threadId) ?? []).filter(
            (entry) => entry.id !== queuedMessageId,
          ),
        );
        return { ok: true };
      },
    },
  };
  const { host, calls } = await start(
    ({ endpoint }) => {
      const path = endpoint.split("?")[0]!;
      if (path === "/api/v1/user") return { json: { login: "dev" } };
      const list = path.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)\/issues$/);
      if (list) {
        gitea.listRequests += 1;
        const reply = () => ({
          json:
            page(endpoint) === 1
              ? [...pulls]
                  .filter(
                    ([key, pull]) =>
                      key.startsWith(`${list[1]!.toLowerCase()}#`) &&
                      pull.state === "open",
                  )
                  .map(([, pull]) => pull)
              : [],
        });
        return gitea.listGate ? gitea.listGate.then(reply) : reply();
      }
      const shown = path.match(
        /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/,
      );
      if (shown) {
        const pull = pulls.get(`${shown[1]!.toLowerCase()}#${shown[2]}`);
        return pull ? { json: pull } : { status: 404 };
      }
      const one = path.match(
        /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/,
      );
      if (one) {
        if (gitea.pullFailure) return { status: gitea.pullFailure };
        const pull = pulls.get(`${one[1]!.toLowerCase()}#${one[2]}`);
        return pull ? { json: pull } : { status: 404 };
      }
      return { json: [] };
    },
    {
      settings: { extraRepos: "ops/api" },
      projects: [
        {
          id: "project-1",
          sources: [
            { type: "local_path", path: widgets, hostId: "source-host" },
          ],
        },
      ],
      threads,
    },
  );
  const settle = (key: string, merged: boolean) =>
    pulls.set(key, {
      ...pulls.get(key),
      state: "closed",
      merged,
      merged_at: merged ? "2026-09-28T01:00:00Z" : null,
      closed_at: "2026-09-28T01:00:00Z",
    });
  const reopen = (key: string) =>
    pulls.set(key, {
      ...pulls.get(key),
      state: "open",
      merged: false,
      merged_at: null,
      closed_at: null,
    });
  return { host, calls, gitea, state, settle, reopen, patchThread };
}

function rpc(host: Host, method: string, input: unknown = null) {
  return host.harness.behavior.callRpc(method, input);
}

const pr42 = { repo: "acme/widgets", number: 42 };
const off = { fix: false, merge: false };

async function setAutomation(
  host: Host,
  ref: { repo: string; number: number },
  patch: { fix?: boolean; merge?: boolean },
) {
  return giteaRpcContract.setAutomation.output.parse(
    await rpc(host, "setAutomation", { ...ref, ...patch }),
  );
}

function enable(host: Host, ref: { repo: string; number: number }) {
  return setAutomation(host, ref, { fix: true, merge: true });
}

function disable(host: Host, ref: { repo: string; number: number }) {
  return setAutomation(host, ref, off);
}

async function autoFixerStatus(host: Host, ref = pr42) {
  return giteaRpcContract.getAutoFixerStatus.output.parse(
    await rpc(host, "getAutoFixerStatus", ref),
  );
}

async function idle(
  host: Host,
  lastAssistantText: string,
  id = "auto-fixer-1",
) {
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id }),
    lastAssistantText,
  });
}

it("lists authored pull requests and starts one hidden pinned auto-fixer for concurrent requests", async () => {
  const { host, calls } = await startAutoFixers();
  const mine = giteaRpcContract.listMyPullRequests.output.parse(
    await rpc(host, "listMyPullRequests", { state: "open", query: "" }),
  );
  expect(mine.login).toBe("dev");
  expect(
    calls
      .filter(({ endpoint }) => /\/issues\?/.test(endpoint))
      .every(({ endpoint }) => endpoint.includes("created_by=dev")),
  ).toBe(true);
  expect(mine.preferences).toMatchObject({ autoFix: false, autoMerge: false });
  const allPulls = giteaRpcContract.listItems.output.parse(
    await rpc(host, "listItems", { kind: "pr", state: "open", query: "" }),
  );
  expect(
    allPulls.items.find((item) => item.number === 42)?.autoFixer,
  ).toMatchObject({ status: "idle", actions: ["start"] });
  expect(
    allPulls.items.find((item) => item.number === 43)?.autoFixer,
  ).toMatchObject({ status: "idle", actions: ["start"] });
  expect(
    mine.items
      .map((item) => [
        `${item.repo}#${item.number}`,
        item.autoFixer.status,
        item.autoFixer.actions,
      ])
      .sort(),
  ).toEqual([
    ["acme/widgets#42", "idle", ["start"]],
    ["acme/widgets#44", "idle", ["start"]],
    ["ops/api#7", "idle", []],
  ]);

  const starts = await Promise.all([enable(host, pr42), enable(host, pr42)]);
  const updatedAllPulls = giteaRpcContract.listItems.output.parse(
    await rpc(host, "listItems", { kind: "pr", state: "open", query: "" }),
  );
  expect(
    updatedAllPulls.items.find((item) => item.number === 42)?.autoFixer,
  ).toMatchObject({
    status: "watching",
    automation: { fix: true, merge: true },
  });
  expect(starts.map((view) => "threadId" in view && view.threadId)).toEqual([
    "auto-fixer-1",
    "auto-fixer-1",
  ]);
  await expect(enable(host, pr42)).resolves.toMatchObject({
    threadId: "auto-fixer-1",
    automation: { fix: true, merge: true },
  });
  const spawns = host.harness.sdk.callsTo("threads.spawn");
  expect(spawns).toHaveLength(1);
  expect(spawns[0]?.[0]).toMatchObject({
    projectId: "project-1",
    visibility: "hidden",
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "xhigh",
    serviceTier: "default",
    permissionMode: "auto",
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  });
  expect((spawns[0]?.[0] as { prompt: string }).prompt).toContain(
    "tea pulls --login work --repo acme/widgets --comments 42",
  );
  await expect(enable(host, { repo: "ops/api", number: 7 })).rejects.toThrow(
    "no BB project has a checkout",
  );
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
    threadId: "auto-fixer-1",
    actions: ["stop"],
  });
  expect(
    host.harness.inspection.realtimeSignals.some(
      (signal) => signal.channel === "auto-fixer-changed",
    ),
  ).toBe(true);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("keeps automatic auto-fixing off by default and starts only eligible authored pull requests", async () => {
  const { host, calls } = await startAutoFixers();
  const service = host.harness.behavior.runService("auto-fixers");
  await new Promise((resolve) => setTimeout(resolve, 100));
  service.controller.abort();
  await service.done;
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(calls.some((call) => call.endpoint.includes("type=pulls"))).toBe(
    false,
  );

  const sol = {
    providerId: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "medium",
    serviceTier: "fast",
  };
  const [, enabled] = await Promise.all([
    rpc(host, "setAutoFixerExecution", sol),
    rpc(host, "setAutoAutomation", { fix: true }),
  ]);
  expect(enabled).toEqual({ autoFix: true, autoMerge: false, execution: sol });
  await expect(rpc(host, "getAutoFixerPreferences")).resolves.toEqual({
    autoFix: true,
    autoMerge: false,
    execution: sol,
  });
  const spawned = host.harness.sdk
    .callsTo("threads.spawn")
    .map((call) => call[0] as { title: string; model: string });
  expect(spawned.map((call) => call.title).sort()).toEqual([
    "Gitea auto-fixer: acme/widgets#42: Change 42",
    "Gitea auto-fixer: acme/widgets#44: Change 44",
  ]);
  expect(spawned.every((call) => call.model === "gpt-5.6-sol")).toBe(true);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    policy: { fix: true, merge: false },
    automation: { fix: true, merge: false },
  });
  await rpc(host, "setAutoAutomation", { fix: false });
  await rpc(host, "setAutoAutomation", { fix: true, merge: true });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("confirms terminal state with Gitea, cleans up, and refuses to restart a merged pull request", async () => {
  const { host, settle } = await startAutoFixers();
  await enable(host, pr42);
  settle("acme/widgets#42", true);
  await idle(host, "Merged.\nBB_GITEA_AUTO_FIX: MERGED");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "archived", outcome: "merged",
    mergedAt: "2026-09-28T01:00:00Z",
    threadId: "auto-fixer-1",
    actions: [],
  });
  expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(1);
  expect(host.harness.sdk.callsTo("threads.archive")).toHaveLength(1);
  expect(host.harness.sdk.callsTo("plugins.callRpc")[0]?.[0]).toMatchObject({
    pluginId: "supervisor",
    method: "notifyAutoFixer",
    input: { threadId: "auto-fixer-1", event: "idle" },
  });
  await expect(enable(host, pr42)).rejects.toThrow(
    "the pull request is merged",
  );
  await expect(rpc(host, "retryAutoFixer", pr42)).rejects.toThrow(
    "the pull request is merged",
  );
  await expect(disable(host, pr42)).resolves.toMatchObject({
    status: "archived", outcome: "merged",
  });
  await expect(
    rpc(host, "autoFixerThread", { threadId: "auto-fixer-1" }),
  ).resolves.toMatchObject({ status: "archived", outcome: "merged", number: 42 });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("decides auto-fixer lifecycle from live Gitea state rather than cached display content", async () => {
  const { host, settle } = await startAutoFixers();
  await expect(
    conversation(host, { number: 42, kind: "pr" }),
  ).resolves.toMatchObject({ conversation: { state: "open" } });
  settle("acme/widgets#42", true);
  await expect(
    conversation(host, { number: 42, kind: "pr" }),
  ).resolves.toMatchObject({ conversation: { state: "open" } });
  await expect(enable(host, pr42)).rejects.toThrow(
    "the pull request is merged",
  );
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("starts automatic auto-fixers from a live pull request list rather than the remembered display list", async () => {
  const { host, settle } = await startAutoFixers();
  const shown = await myPulls(host);
  expect(shown.items.map((item) => item.number).sort()).toEqual([42, 44, 7]);
  settle("acme/widgets#44", false);
  expect((await myPulls(host)).items.map((item) => item.number)).toContain(44);
  await rpc(host, "setAutoAutomation", { fix: true });
  expect(
    host.harness.sdk
      .callsTo("threads.spawn")
      .map((call) => (call[0] as { title: string }).title),
  ).toEqual(["Gitea auto-fixer: acme/widgets#42: Change 42"]);
  expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    environment: {
      type: "host",
      hostId: "source-host",
      workspace: { type: "managed-worktree" },
    },
  });
});

it("fails an unconfirmed marker and resumes the retained thread on retry", async () => {
  const { host } = await startAutoFixers();
  await enable(host, pr42);
  await idle(host, "BB_GITEA_AUTO_FIX: MERGED");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "failed",
    error:
      "Gitea still reports the pull request open; it did not confirm MERGED.",
    cleanupPending: false,
    actions: ["stop", "retry"],
  });
  await expect(enable(host, pr42)).resolves.toMatchObject({
    threadId: "auto-fixer-1",
    status: "failed",
  });
  await expect(rpc(host, "retryAutoFixer", pr42)).resolves.toEqual({
    threadId: "auto-fixer-1",
  });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(host.harness.sdk.callsTo("threads.unarchive")).toHaveLength(1);
  expect(host.harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
    threadId: "auto-fixer-1",
    mode: "start",
    input: [
      {
        type: "text",
        text: expect.stringContaining(
          "Continue from the preserved transcript and current Gitea state.",
        ),
      },
    ],
  });
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
  });
  await host.harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: "auto-fixer-1" }),
    error: "provider crashed",
  });
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "failed",
    error: "provider crashed",
  });
  await idle(host, "Need approval.\nBB_GITEA_AUTO_FIX: NEEDS_YOU");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "failed",
  });
});

it("replaces a retired auto-fixer workspace before retrying", async () => {
  const { host, patchThread } = await startAutoFixers();
  await enable(host, pr42);
  await idle(host, "BB_GITEA_AUTO_FIX: FAILED");
  patchThread("auto-fixer-1", { canRestoreEnvironment: true });
  await rpc(host, "retryAutoFixer", pr42);
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    threadId: "auto-fixer-2",
    status: "watching",
  });
});

it("replaces a legacy auto-fixer on another host without deleting its thread", async () => {
  const { host } = await startAutoFixers();
  await enable(host, pr42);
  await idle(host, "BB_GITEA_AUTO_FIX: FAILED");
  const old = await autoFixerStatus(host);
  await host.bb.storage.kv.set("auto-fixer:acme/widgets#42", {
    ...old,
    hostId: undefined,
  });
  await rpc(host, "retryAutoFixer", pr42);
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    threadId: "auto-fixer-2",
    hostId: "source-host",
    status: "watching",
  });
});

it("reports cleanup failures and cleans up before resuming or stopping", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.archiveFailures = 1;
  await idle(host, "Stopped unexpectedly.");
  const failed = await autoFixerStatus(host);
  expect(failed).toMatchObject({ status: "failed", cleanupPending: true });
  expect(failed.status === "failed" && failed.error).toMatch(
    /^Cleanup failed: archive: .*host offline.* \(Stopped unexpectedly\.\)$/,
  );

  await rpc(host, "retryAutoFixer", pr42);
  expect(host.harness.sdk.callsTo("threads.archive")).toHaveLength(2);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
  });

  state.archiveFailures = 1;
  await expect(disable(host, pr42)).rejects.toThrow("Cleanup failed");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
    cleanupPending: true,
    actions: ["start"],
    automation: off,
  });
  await expect(rpc(host, "retryAutoFixer", pr42)).rejects.toThrow(
    "has no auto-fixer to retry",
  );
  const service = host.harness.behavior.runService("auto-fixers");
  await vi.waitFor(() =>
    expect(autoFixerStatus(host)).resolves.toMatchObject({
      status: "stopped",
      cleanupPending: false,
      automation: off,
    }),
  );
  service.controller.abort();
  await service.done;
  expect(host.harness.sdk.callsTo("threads.archive")).toHaveLength(4);
  expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
});

it("never lets Retry restore authority that was turned off", async () => {
  const { host } = await startAutoFixers();
  await setAutomation(host, pr42, { merge: true });
  await expect(
    setAutomation(host, pr42, { merge: false }),
  ).resolves.toMatchObject({
    status: "stopped",
    automation: off,
    actions: ["start"],
  });
  await expect(rpc(host, "retryAutoFixer", pr42)).rejects.toThrow(
    "turn on Auto-fix or Auto-merge",
  );
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
    automation: off,
  });
  expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(host.harness.sdk.callsTo("threads.unarchive")).toHaveLength(0);
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("applies a stop requested while a retry is resuming the thread after the retry", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  await idle(host, "Stopped unexpectedly.");
  let release!: () => void;
  state.sendGate = new Promise((resolve) => {
    release = resolve;
  });
  const retry = rpc(host, "retryAutoFixer", pr42);
  await vi.waitFor(() =>
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1),
  );
  const stopping = disable(host, pr42);
  release();
  await expect(retry).resolves.toEqual({ threadId: "auto-fixer-1" });
  await expect(stopping).resolves.toMatchObject({ status: "stopped" });
  expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(2);
  await idle(host, "late idle");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
  });
});

it("retains sessions across a restart and reconciles threads that settled while unloaded", async () => {
  const { host, state, settle } = await startAutoFixers();
  await enable(host, pr42);
  await enable(host, { repo: "acme/widgets", number: 44 });
  settle("acme/widgets#42", false);
  state.output = "BB_GITEA_AUTO_FIX: CLOSED";
  state.threads.set("auto-fixer-1", { status: "idle" });
  state.threads.set("auto-fixer-2", { archivedAt: 1 });

  const restarted = await host.harness.lifecycle.reload(plugin);
  cleanups.push(() => restarted.harness.lifecycle.dispose());
  await expect(rpc(restarted, "listAutoFixerSessions")).resolves.toMatchObject({
    sessions: expect.arrayContaining([
      expect.objectContaining({ number: 42, status: "watching" }),
      expect.objectContaining({ number: 44, status: "watching" }),
    ]),
  });
  const service = restarted.harness.behavior.runService("auto-fixers");
  await vi.waitFor(async () => {
    await expect(autoFixerStatus(restarted)).resolves.toMatchObject({
      status: "archived", outcome: "closed",
      closedAt: "2026-09-28T01:00:00Z",
    });
    await expect(
      autoFixerStatus(restarted, { repo: "acme/widgets", number: 44 }),
    ).resolves.toMatchObject({ status: "stopped" });
  });
  service.controller.abort();
  await service.done;
  expect(restarted.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("reports Gitea API failures without spawning or guessing a terminal state", async () => {
  const { host, gitea } = await startAutoFixers();
  gitea.pullFailure = 500;
  await expect(enable(host, pr42)).rejects.toThrow(
    "Gitea API returned HTTP 500.",
  );
  await expect(autoFixerStatus(host)).resolves.toEqual({
    status: "idle",
    actions: [],
    automation: off,
  });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  gitea.pullFailure = null;
  await enable(host, pr42);
  gitea.pullFailure = 500;
  await idle(host, "BB_GITEA_AUTO_FIX: CLOSED");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "failed",
    error:
      "Could not confirm the Gitea pull request state: Gitea API returned HTTP 500.",
  });
});

it("exposes Auto-fix and Auto-merge through bb gitea commands", async () => {
  const { host } = await startAutoFixers();
  const cli = (argv: string[]) => host.harness.behavior.runCli(argv);
  await expect(cli(["automation-defaults"])).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining(
      "Turn on Auto-fix for my PRs: off\nTurn on Auto-merge for my PRs: off",
    ),
  });
  await expect(cli(["my-prs"])).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining(
      "acme/widgets#42 open fix:off merge:off auto-fixer:idle",
    ),
  });
  await expect(
    cli(["auto-merge", "acme/widgets", "42", "on"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining(
      "acme/widgets#42 watching · Auto-fix off · Auto-merge on thread auto-fixer-1",
    ),
  });
  await expect(
    cli(["auto-fix", "acme/widgets", "42", "on", "--json"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining('"automation":{"fix":true,"merge":true}'),
  });
  await expect(
    cli(["auto-fixer-thread", "auto-fixer-1"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining(
      "acme/widgets#42 watching · Auto-fix on · Auto-merge on",
    ),
  });
  await expect(
    cli(["auto-fix", "acme/widgets", "42", "maybe"]),
  ).resolves.toMatchObject({ exitCode: 1 });
  await cli(["auto-fix", "acme/widgets", "42", "off"]);
  await expect(
    cli(["auto-merge", "acme/widgets", "42", "off"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining(
      "acme/widgets#42 stopped · Auto-fix off · Auto-merge off",
    ),
  });
  await expect(cli(["auto-fixers"])).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("acme/widgets#42 stopped"),
  });
  await expect(
    cli(["automation-defaults", "merge", "off"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("Turn on Auto-merge for my PRs: off"),
  });
  await expect(
    cli(["automation-defaults", "land", "on"]),
  ).resolves.toMatchObject({ exitCode: 1 });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  await expect(
    cli(["auto-fixer-execution", "codex", "gpt-5.6-sol", "medium", "fast"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("Execution: codex gpt-5.6-sol medium fast"),
  });
  await expect(
    cli(["auto-fixer-execution", "codex", "gpt-5.6-sol", "extreme"]),
  ).resolves.toMatchObject({ exitCode: 1 });
  await expect(cli(["auto-fixer-execution", "codex"])).resolves.toMatchObject({
    exitCode: 1,
    stderr:
      "auto-fixer-execution requires: provider model reasoning [fast|default]",
  });
});

it("grants each auto-fixer only the authority its Auto-fix and Auto-merge options give", async () => {
  const { host } = await startAutoFixers();
  const pr44 = { repo: "acme/widgets", number: 44 };
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    { status: "watching", automation: { fix: true, merge: false } },
  );
  await expect(
    setAutomation(host, pr44, { merge: true }),
  ).resolves.toMatchObject({
    status: "watching",
    automation: { fix: false, merge: true },
  });
  const prompts = host.harness.sdk
    .callsTo("threads.spawn")
    .map((call) => (call[0] as { prompt: string }).prompt);
  expect(prompts[0]).toContain("You can fix, commit, push");
  expect(prompts[0]).not.toContain("tea pulls merge");
  expect(prompts[1]).toContain("tea pulls merge");
  expect(prompts[1]).toContain("Auto-fix is off. Do not change code");

  await expect(rpc(host, "setAutomation", { ...pr42 })).rejects.toThrow();
  await expect(
    rpc(host, "setAutomation", { ...pr42, fix: true, land: true }),
  ).rejects.toThrow();
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
});

it("updates a running auto-fixer's authority in place and stops it when both options are off", async () => {
  const { host } = await startAutoFixers();
  await enable(host, pr42);
  await expect(
    setAutomation(host, pr42, { merge: false }),
  ).resolves.toMatchObject({
    status: "watching",
    threadId: "auto-fixer-1",
    policy: { fix: true, merge: false },
  });
  const sends = host.harness.sdk.callsTo("threads.send");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.[0]).toMatchObject({
    threadId: "auto-fixer-1",
    mode: "steer",
    input: [
      {
        type: "text",
        text: expect.stringContaining(
          "Auto-merge is off. Never merge this pull request",
        ),
      },
    ],
  });
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    { status: "watching" },
  );
  expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  await expect(
    setAutomation(host, pr42, { fix: false }),
  ).resolves.toMatchObject({ status: "stopped", automation: off });
  expect(host.harness.sdk.callsTo("threads.archive")).toHaveLength(1);
  await expect(
    setAutomation(host, pr42, { merge: true }),
  ).resolves.toMatchObject({
    status: "watching",
    threadId: "auto-fixer-1",
    policy: { fix: false, merge: true },
  });
  expect(host.harness.sdk.callsTo("threads.send")[1]?.[0]).toMatchObject({
    mode: "start",
    input: [
      { text: expect.stringContaining("Auto-fix is off. Do not change code") },
    ],
  });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("stops a running auto-fixer whose authority change cannot be delivered", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.sendGate = Promise.reject(new Error("host offline"));
  state.sendGate.catch(() => undefined);
  await expect(setAutomation(host, pr42, { merge: false })).rejects.toThrow(
    "Could not deliver the automation change, so the auto-fixer was stopped: host offline",
  );
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
    automation: off,
  });
});

it("withdraws a queued authority change and stops the auto-fixer", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.queueSends = true;
  await expect(setAutomation(host, pr42, { merge: false })).rejects.toThrow(
    "could not take the automation change immediately, so it was stopped",
  );
  expect(host.harness.sdk.callsTo("threads.queuedMessages.delete")).toEqual([
    [{ threadId: "auto-fixer-1", queuedMessageId: "queued-auto-fixer-1-1" }],
  ]);
  expect(state.queued.get("auto-fixer-1")).toEqual([]);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
    cleanupPending: false,
    automation: off,
  });
});

it("keeps Auto-merge running when enabling Auto-fix queues the expanded authority", async () => {
  const { host, state } = await startAutoFixers();
  await setAutomation(host, pr42, { merge: true });
  state.queueSends = true;
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    {
      status: "watching",
      automation: { fix: true, merge: true },
    },
  );
  expect(state.queued.get("auto-fixer-1")?.[0]?.text).toContain(
    "Auto-fix is on. Fix failing CI checks",
  );
  expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(0);
});

it("keeps cleanup pending until a queued authority change is withdrawn", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.queueSends = true;
  state.withdrawFailures = 1;
  await expect(setAutomation(host, pr42, { merge: false })).rejects.toThrow(
    "Cleanup failed: withdraw: ",
  );
  expect(state.queued.get("auto-fixer-1")).toHaveLength(1);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
    cleanupPending: true,
    automation: off,
  });
  state.queueSends = false;
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    { status: "watching", policy: { fix: true, merge: false } },
  );
  expect(state.queued.get("auto-fixer-1")).toEqual([]);
  expect(
    host.harness.sdk.callsTo("threads.queuedMessages.delete"),
  ).toHaveLength(2);
});

it("withdraws a queued resume before the auto-fixer runs under other options", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  await idle(host, "Stopped unexpectedly.");
  state.queueSends = true;
  await expect(rpc(host, "retryAutoFixer", pr42)).resolves.toEqual({
    threadId: "auto-fixer-1",
  });
  expect(state.queued.get("auto-fixer-1")?.[0]?.text).toContain(
    "tea pulls merge",
  );
  await disable(host, pr42);
  expect(state.queued.get("auto-fixer-1")).toEqual([]);
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    { status: "watching", policy: { fix: true, merge: false } },
  );
  const pending = state.queued.get("auto-fixer-1") ?? [];
  expect(pending).toHaveLength(1);
  expect(pending[0]?.text).not.toContain("tea pulls merge");
});

it("lets an explicit enable win over background cleanup that read the session earlier", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.archiveFailures = 1;
  await expect(disable(host, pr42)).rejects.toThrow("Cleanup failed");
  let release!: () => void;
  state.getGate = new Promise((resolve) => {
    release = resolve;
  });
  const reads = host.harness.sdk.callsTo("threads.get").length;
  const service = host.harness.behavior.runService("auto-fixers");
  await vi.waitFor(() =>
    expect(host.harness.sdk.callsTo("threads.get").length).toBeGreaterThan(
      reads,
    ),
  );
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    { status: "watching", policy: { fix: true, merge: false } },
  );
  const stops = host.harness.sdk.callsTo("threads.stop").length;
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  service.controller.abort();
  await service.done;
  expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(stops);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
    policy: { fix: true, merge: false },
  });
});

it("discards an idle observation from before the auto-fixer was turned off and on again", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.output = "BB_GITEA_AUTO_FIX: NEEDS_YOU";
  state.threads.set("auto-fixer-1", { status: "idle" });
  let release!: () => void;
  state.outputGate = new Promise((resolve) => {
    release = resolve;
  });
  const service = host.harness.behavior.runService("auto-fixers");
  await vi.waitFor(() =>
    expect(host.harness.sdk.callsTo("threads.output")).toHaveLength(1),
  );
  await disable(host, pr42);
  await expect(setAutomation(host, pr42, { fix: true })).resolves.toMatchObject(
    { status: "watching", policy: { fix: true, merge: false } },
  );
  state.threads.set("auto-fixer-1", { status: "active" });
  const stops = host.harness.sdk.callsTo("threads.stop").length;
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  service.controller.abort();
  await service.done;
  expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(stops);
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
    policy: { fix: true, merge: false },
  });
});

it("finishes settling an auto-fixer before Retry resumes it", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  let release!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.onStop = async () => {
    state.onStop = null;
    await stopGate;
  };
  const settling = idle(host, "BB_GITEA_AUTO_FIX: NEEDS_YOU");
  await vi.waitFor(() =>
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(1),
  );
  let retried = false;
  const retry = rpc(host, "retryAutoFixer", pr42).then((result) => {
    retried = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(retried).toBe(false);
  release();
  await settling;
  await expect(retry).resolves.toEqual({ threadId: "auto-fixer-1" });
  expect(state.threads.get("auto-fixer-1")?.archivedAt).toBeNull();
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
    policy: { fix: true, merge: true },
  });
});

it("launches automatic auto-fixers under the defaults current at launch time", async () => {
  const { host, gitea } = await startAutoFixers();
  let release!: () => void;
  gitea.listGate = new Promise((resolve) => {
    release = resolve;
  });
  const mergeOnly = rpc(host, "setAutoAutomation", { merge: true });
  await vi.waitFor(() => expect(gitea.listRequests).toBeGreaterThan(0));
  const fixOnly = rpc(host, "setAutoAutomation", { fix: true, merge: false });
  await vi.waitFor(() =>
    expect(rpc(host, "getAutoFixerPreferences")).resolves.toMatchObject({
      autoFix: true,
      autoMerge: false,
    }),
  );
  release();
  await Promise.all([mergeOnly, fixOnly]);
  const prompts = host.harness.sdk
    .callsTo("threads.spawn")
    .map((call) => (call[0] as { prompt: string }).prompt);
  expect(prompts.length).toBeGreaterThan(0);
  for (const prompt of prompts) {
    expect(prompt).toContain("You can fix, commit, push");
    expect(prompt).not.toContain("tea pulls merge");
  }
});

it("launches no automatic auto-fixer once the defaults are turned off", async () => {
  const { host, gitea } = await startAutoFixers();
  let release!: () => void;
  gitea.listGate = new Promise((resolve) => {
    release = resolve;
  });
  const turningOn = rpc(host, "setAutoAutomation", { fix: true });
  await vi.waitFor(() => expect(gitea.listRequests).toBeGreaterThan(0));
  await rpc(host, "setAutoAutomation", { fix: false });
  release();
  await turningOn;
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("replaces a closed auto-fixer once Gitea reports the pull request reopened", async () => {
  const { host, settle, reopen } = await startAutoFixers();
  const pr44 = { repo: "acme/widgets", number: 44 };
  await enable(host, pr42);
  await enable(host, pr44);
  settle("acme/widgets#42", false);
  settle("acme/widgets#44", false);
  await idle(host, "BB_GITEA_AUTO_FIX: CLOSED", "auto-fixer-1");
  await idle(host, "BB_GITEA_AUTO_FIX: CLOSED", "auto-fixer-2");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "archived", outcome: "closed",
    actions: [],
  });
  await expect(enable(host, pr42)).rejects.toThrow(
    "the pull request is closed",
  );
  await expect(rpc(host, "retryAutoFixer", pr42)).rejects.toThrow(
    "has no auto-fixer to retry",
  );

  reopen("acme/widgets#42");
  reopen("acme/widgets#44");
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "archived", outcome: "closed",
    threadId: "auto-fixer-1",
    actions: ["start"],
  });
  const mine = giteaRpcContract.listMyPullRequests.output.parse(
    await rpc(host, "listMyPullRequests", { state: "open", query: "" }),
  );
  expect(
    mine.items.find((item) => item.number === 42)?.autoFixer.actions,
  ).toEqual(["start"]);
  await expect(
    host.harness.behavior.runCli(["auto-fixer-retry", "acme/widgets", "42"]),
  ).resolves.toMatchObject({ exitCode: 1 });
  await expect(
    host.harness.behavior.runCli(["auto-fix", "acme/widgets", "42", "on"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("thread auto-fixer-3"),
  });
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "watching",
    threadId: "auto-fixer-3",
    actions: ["stop"],
  });
  await idle(host, "late", "auto-fixer-1");
  await expect(
    rpc(host, "autoFixerThread", { threadId: "auto-fixer-1" }),
  ).resolves.toBeNull();

  await rpc(host, "setAutoAutomation", { fix: true, merge: true });
  await expect(autoFixerStatus(host, pr44)).resolves.toMatchObject({
    status: "watching",
    threadId: "auto-fixer-4",
  });
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(4);
  expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("forgets a deleted auto-fixer thread and spawns a fresh one without touching the dead thread", async () => {
  const { host, state, patchThread } = await startAutoFixers();
  const pr44 = { repo: "acme/widgets", number: 44 };
  await enable(host, pr42);
  patchThread("auto-fixer-1", { deletedAt: 1 });
  await host.harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "auto-fixer-1" }),
  });
  await expect(autoFixerStatus(host)).resolves.toEqual({
    status: "idle",
    actions: ["start"],
    automation: off,
  });
  await expect(
    rpc(host, "autoFixerThread", { threadId: "auto-fixer-1" }),
  ).resolves.toBeNull();
  await expect(rpc(host, "retryAutoFixer", pr42)).rejects.toThrow(
    "has no auto-fixer to retry",
  );
  await expect(enable(host, pr42)).resolves.toMatchObject({
    threadId: "auto-fixer-2",
  });

  await enable(host, pr44);
  await disable(host, pr44);
  patchThread("auto-fixer-3", { deletedAt: 1 });
  state.getFailure = new Error("server restarting");
  await expect(rpc(host, "retryAutoFixer", pr44)).rejects.toThrow(
    "has no auto-fixer to retry",
  );
  await expect(enable(host, pr44)).rejects.toThrow("server restarting");
  await expect(autoFixerStatus(host, pr44)).resolves.toMatchObject({
    status: "stopped",
    threadId: "auto-fixer-3",
  });
  state.getFailure = null;
  await expect(enable(host, pr44)).resolves.toMatchObject({
    threadId: "auto-fixer-4",
  });
  expect(
    [
      ...host.harness.sdk.callsTo("threads.send"),
      ...host.harness.sdk.callsTo("threads.unarchive"),
    ].map((call) => (call[0] as { threadId: string }).threadId),
  ).toEqual([]);
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(4);
});

it("keeps archived sessions and forgets threads deleted while unloaded only once deletion is confirmed", async () => {
  const { host, state, patchThread } = await startAutoFixers();
  const pr44 = { repo: "acme/widgets", number: 44 };
  await enable(host, pr42);
  await enable(host, pr44);
  await disable(host, pr42);
  await disable(host, pr44);
  patchThread("auto-fixer-2", { deletedAt: 1 });

  const restarted = await host.harness.lifecycle.reload(plugin);
  cleanups.push(() => restarted.harness.lifecycle.dispose());
  state.getFailure = new Error("server restarting");
  const failing = restarted.harness.behavior.runService("auto-fixers");
  await vi.waitFor(() =>
    expect(restarted.harness.sdk.callsTo("threads.get")).toHaveLength(2),
  );
  failing.controller.abort();
  await failing.done;
  await expect(autoFixerStatus(restarted, pr44)).resolves.toMatchObject({
    status: "stopped",
  });

  state.getFailure = null;
  const service = restarted.harness.behavior.runService("auto-fixers");
  await vi.waitFor(async () =>
    expect(autoFixerStatus(restarted, pr44)).resolves.toEqual({
      status: "idle",
      actions: ["start"],
      automation: off,
    }),
  );
  service.controller.abort();
  await service.done;
  await expect(autoFixerStatus(restarted)).resolves.toMatchObject({
    status: "stopped",
    threadId: "auto-fixer-1",
    actions: ["start"],
  });
});

it("treats repository spellings that differ only in case as one auto-fixer", async () => {
  const { host } = await startAutoFixers();
  const upper = { repo: "Acme/Widgets", number: 42 };
  const starts = await Promise.all([
    enable(host, pr42),
    enable(host, upper),
    rpc(host, "retryAutoFixer", { repo: "ACME/widgets", number: 42 }),
  ]);
  expect(starts).toEqual([
    expect.objectContaining({ threadId: "auto-fixer-1" }),
    expect.objectContaining({ threadId: "auto-fixer-1" }),
    { threadId: "auto-fixer-1" },
  ]);
  await expect(autoFixerStatus(host, upper)).resolves.toMatchObject({
    status: "watching",
    threadId: "auto-fixer-1",
  });
  await rpc(host, "setAutoAutomation", { fix: true, merge: true });
  expect(
    host.harness.sdk
      .callsTo("threads.spawn")
      .map((call) => (call[0] as { title: string }).title),
  ).toEqual([
    "Gitea auto-fixer: acme/widgets#42: Change 42",
    "Gitea auto-fixer: acme/widgets#44: Change 44",
  ]);
  await expect(rpc(host, "listAutoFixerSessions")).resolves.toMatchObject({
    sessions: [expect.anything(), expect.anything()],
  });
});

it("commits a manual stop before the stopped thread reports idle", async () => {
  const { host, state } = await startAutoFixers();
  await enable(host, pr42);
  state.onStop = async (threadId) => {
    state.onStop = null;
    await idle(host, "Interrupted without a marker.", threadId);
  };
  await expect(disable(host, pr42)).resolves.toMatchObject({
    status: "stopped",
  });
  await expect(autoFixerStatus(host)).resolves.toMatchObject({
    status: "stopped",
    cleanupPending: false,
    actions: ["start"],
  });
  expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(1);
  expect(host.harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
});

it("toggles draft by rewriting the pull request title prefix", async () => {
  const { host, calls } = await startAutoFixers();
  await rpc(host, "setDraft", { ...pr42, draft: true });
  const patches = () =>
    calls.filter(
      ({ method, endpoint }) =>
        method === "PATCH" &&
        endpoint === "/api/v1/repos/acme/widgets/pulls/42",
    );
  expect(patches().map(({ body }) => body)).toEqual([
    { title: "WIP: Change 42" },
  ]);
  await rpc(host, "setDraft", { ...pr42, draft: false });
  expect(patches()).toHaveLength(1);
});

it("starts send-agent threads with the chosen model or the project default", async () => {
  const { host } = await startAutoFixers();
  const send = () => rpc(host, "sendAgent", { ...pr42, kind: "pr" });
  await send();
  const execution = {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "medium",
    serviceTier: "default",
  };
  await rpc(host, "setAgentExecution", { execution });
  await expect(rpc(host, "getAgentExecution")).resolves.toEqual({ execution });
  await send();
  const spawns = host.harness.sdk
    .callsTo("threads.spawn")
    .map((call) => call[0]);
  expect(spawns[0]).not.toHaveProperty("model");
  expect(spawns[1]).toMatchObject({
    ...execution,
    executionInputSources: { model: "explicit" },
  });
});

it("drafts the agent prompt without starting a thread", async () => {
  const { host } = await startAutoFixers();
  const { prompt } = (await rpc(host, "draftAgent", { ...pr42, kind: "pr" })) as {
    prompt: string;
  };
  expect(prompt).toContain("Review Gitea pull request acme/widgets#42");
  expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("finds send-agent threads when the repository spelling changes case", async () => {
  const { host } = await startAutoFixers();
  await rpc(host, "sendAgent", { repo: "Acme/Widgets", number: 42, kind: "pr" });
  await expect(
    rpc(host, "conversation", {
      repo: "acme/widgets",
      number: 42,
      kind: "pr",
      refresh: false,
    }),
  ).resolves.toMatchObject({ threadId: expect.any(String) });
});

it("waits for cheap pull request change signals with pr-watch", async () => {
  const { host, gitea } = await startAutoFixers();
  const cli = (argv: string[]) => host.harness.behavior.runCli(argv);
  const first = await cli(["pr-watch", "acme/widgets", "42", "--json"]);
  expect(first.exitCode).toBe(0);
  const initial = JSON.parse(first.stdout) as {
    outcome: string;
    token: string;
  };
  expect(initial.outcome).toBe("changed");
  const quiet = await cli([
    "pr-watch",
    "acme/widgets",
    "42",
    "--since",
    initial.token,
    "--timeout",
    "0",
  ]);
  expect(quiet).toMatchObject({
    exitCode: 0,
    stdout: expect.stringMatching(new RegExp(`^unchanged ${initial.token}\\n`)),
  });
  gitea.pulls.set("acme/widgets#42", {
    ...gitea.pulls.get("acme/widgets#42"),
    comments: 1,
  });
  const moved = await cli([
    "pr-watch",
    "acme/widgets",
    "42",
    "--since",
    initial.token,
    "--timeout",
    "0",
  ]);
  expect(moved.stdout).toMatch(/^changed /);
  expect(moved.stdout).not.toContain(initial.token);
  expect(
    (await cli(["pr-watch", "acme/widgets", "42", "--timeout", "601"]))
      .exitCode,
  ).not.toBe(0);
});

it("checks auto-fixer sessions every 30 seconds but refreshes the authored pull request list only every five minutes", async () => {
  const { host, gitea } = await startAutoFixers();
  await enable(host, pr42);
  await rpc(host, "setAutoAutomation", { fix: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const reads = () => host.harness.sdk.callsTo("threads.get").length;
  const service = host.harness.behavior.runService("auto-fixers");
  const pass = async () => {
    const before = reads();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  };
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  const lists = gitea.listRequests;
  for (let tick = 0; tick < 9; tick += 1) await pass();
  expect(gitea.listRequests).toBe(lists);
  await pass();
  expect(gitea.listRequests).toBeGreaterThan(lists);
  service.controller.abort();
  await service.done;
  vi.useRealTimers();
});

it("reports a stopped auto-fixer as inactive even when the pull request changed", async () => {
  const { host, gitea } = await startAutoFixers();
  const cli = (argv: string[]) => host.harness.behavior.runCli(argv);
  await enable(host, pr42);
  const initial = JSON.parse(
    (await cli(["pr-watch", "acme/widgets", "42", "--json"])).stdout,
  ) as { token: string };
  await disable(host, pr42);
  gitea.pulls.set("acme/widgets#42", {
    ...gitea.pulls.get("acme/widgets#42"),
    comments: 1,
  });
  for (const since of [["--since", initial.token], []]) {
    const watched = await cli([
      "pr-watch",
      "acme/widgets",
      "42",
      ...since,
      "--timeout",
      "0",
    ]);
    expect(watched.stdout).toMatch(/^inactive /);
    expect(watched.stdout).toContain("auto-fixer stopped");
  }
});

 it.each([true, false])("archives needs-you sessions after external PR closure (merged=%s), retrying failed cleanup", async (merged) => {
  const { host, settle, state } = await startAutoFixers();
  await enable(host, pr42);
  await idle(host, "Blocked. BB_GITEA_AUTO_FIX: NEEDS_YOU");
  settle("acme/widgets#42", merged);
  state.archiveFailures = 1;
  const service = host.harness.behavior.runService("auto-fixers");
  try {
    await vi.waitFor(async () => expect(await autoFixerStatus(host)).toMatchObject({ status: merged ? "merged" : "closed", automation: off, actions: [] }));
  } finally { service.controller.abort(); await service.done; }
  const retry = host.harness.behavior.runService("auto-fixers");
  try {
    await vi.waitFor(async () => expect(await autoFixerStatus(host)).toMatchObject({ status: "archived", outcome: merged ? "merged" : "closed", automation: off, actions: [] }));
    expect(state.threads.get("auto-fixer-1")?.archivedAt).toBe(1);
  } finally { retry.controller.abort(); await retry.done; }
 });

it("lists a project's Gitea branches with pull request badges and skips fork pull requests", async () => {
  const path = gitSource("https://gitea.example/prefix/acme/widgets.git");
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  const branch = (name: string, timestamp: string, username: string) => ({
    name,
    commit: { timestamp, author: { username } },
  });
  const pull = (
    number: number,
    ref: string,
    extra: Record<string, unknown> = {},
    repo = "acme/widgets",
  ) => ({
    number,
    title: `PR ${number}`,
    state: "open",
    html_url: `https://gitea.example/prefix/acme/widgets/pulls/${number}`,
    user: { login: "dev" },
    updated_at: "2026-09-02T00:00:00Z",
    head: { ref, sha: `sha-${ref}`, repo: { full_name: repo } },
    ...extra,
  });
  const { host, calls } = await start(
    ({ endpoint }) => {
      if (endpoint.includes("/branches?"))
        return {
          json: [
            branch("main", "2026-09-10T00:00:00Z", "ops"),
            branch("mine", "2026-09-05T00:00:00Z", "dev"),
            branch("review", "2026-09-01T00:00:00Z", "dev"),
            branch("wip", "2026-09-03T00:00:00Z", "ops"),
            branch("shipped", "2026-08-01T00:00:00Z", "ops"),
            branch("from-fork", "2026-09-20T00:00:00Z", "ops"),
          ],
        };
      if (endpoint.includes("/pulls?state=open"))
        return {
          json: [
            pull(7, "review"),
            pull(9, "wip", { title: "WIP: not ready", user: { login: "ops" } }),
            pull(8, "from-fork", {}, "dev/widgets"),
          ],
        };
      if (endpoint.includes("/pulls?state=closed"))
        return {
          json: [
            pull(3, "shipped", { state: "closed", merged: true }),
            pull(2, "main", { state: "closed", merged: false }),
          ],
        };
      if (endpoint.includes("/commits/sha-review/status"))
        return { json: { state: "pending", total_count: 2 } };
      return { json: [] };
    },
    { projects: [{ id: "project-1", sources: [{ type: "local_path", path }] }] },
  );
  const result = giteaRpcContract.remoteBranches.output.parse(
    await host.harness.behavior.callRpc("remoteBranches", { projectId: "project-1" }),
  );
  const url = (number: number) => `https://gitea.example/prefix/acme/widgets/pulls/${number}`;
  expect(result).toEqual({
    repo: "acme/widgets",
    truncated: false,
    error: null,
    branches: [
      {
        name: "review",
        group: "pull",
        pull: { number: 7, title: "PR 7", url: url(7), status: "checking" },
        updatedAt: "2026-09-02T00:00:00Z",
      },
      { name: "mine", group: "mine", pull: null, updatedAt: "2026-09-05T00:00:00Z" },
      { name: "from-fork", group: "other", pull: null, updatedAt: "2026-09-20T00:00:00Z" },
      { name: "main", group: "other", pull: null, updatedAt: "2026-09-10T00:00:00Z" },
      {
        name: "wip",
        group: "other",
        pull: { number: 9, title: "not ready", url: url(9), status: "draft" },
        updatedAt: "2026-09-03T00:00:00Z",
      },
      {
        name: "shipped",
        group: "other",
        pull: { number: 3, title: "PR 3", url: url(3), status: "merged" },
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ],
  });
  const endpoints = calls.map((call) => call.endpoint);
  expect(endpoints).toEqual(
    expect.arrayContaining([
      "/api/v1/repos/acme/widgets/branches?limit=50&page=1",
      "/api/v1/repos/acme/widgets/pulls?state=open&limit=50&page=1",
      "/api/v1/repos/acme/widgets/pulls?state=closed&sort=recentupdate&limit=50&page=1",
    ]),
  );
  const statusCalls = () => calls.filter((call) => call.endpoint.endsWith("/status"));
  expect(statusCalls()).toHaveLength(0);

  const statuses = () =>
    host.harness.behavior
      .callRpc("remotePullStatuses", { projectId: "project-1" })
      .then((output) => giteaRpcContract.remotePullStatuses.output.parse(output));
  await expect(statuses()).resolves.toEqual({ statuses: [{ number: 7, status: "running" }] });
  expect(statusCalls().map((call) => call.endpoint)).toEqual([
    "/api/v1/repos/acme/widgets/commits/sha-review/status",
  ]);
  await statuses();
  expect(statusCalls()).toHaveLength(1);
});

it.each([
  [{ state: "success", total_count: 3 }, "passing"],
  [{ state: "failure", total_count: 3 }, "failing"],
  [{ state: "error", total_count: 1 }, "failing"],
  [{ state: "pending", total_count: 1 }, "running"],
  [{ state: "pending", total_count: 0 }, "none"],
  [{ state: "", total_count: 0 }, "none"],
  [{}, "none"],
])("maps the combined commit status %j to the %s badge", (combined, status) => {
  expect(pullCiStatus(combined)).toBe(status);
});
