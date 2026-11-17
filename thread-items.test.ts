import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { giteaRpcContract } from "./server";
import { cleanups, start, type Host, type TeaCall, type TeaReply } from "./test-support";
import { importedKey } from "./thread-items/legacy-import";
import { threadPullsKeyTag, threadPullsTag } from "./thread-items/read-contract";

afterEach(() => {
  vi.useRealTimers();
});

const server = "https://gitea.example/prefix/";
const sha = (char: string) => char.repeat(40);
const minute = 60_000;
const t0 = Date.parse("2026-11-16T12:00:00Z");

type Row = { seq: number; createdAt: number; type: string; data: unknown };
type Child = { id: string; title: string; archived?: boolean };

function url(number: number, repo = "acme/widgets") {
  return `${server}${repo}/pulls/${number}`;
}

/** item/started and item/completed rows of one shell command, at seq and seq + 1. */
function shell(seq: number, at: number, command: string, output: string, exitCode = 0): Row[] {
  const id = `item-${seq}`;
  return [
    { seq, createdAt: at - 2_000, type: "item/started", data: { item: { type: "commandExecution", id } } },
    {
      seq: seq + 1,
      createdAt: at,
      type: "item/completed",
      data: { item: { type: "commandExecution", id, command, aggregatedOutput: output, exitCode } },
    },
  ];
}
const create = (seq: number, at: number, ...numbers: number[]) =>
  shell(seq, at, "tea pr create --title change", numbers.map((n) => `\u001b]8;id=1;${url(n)}\u0007${url(n)}\u001b]8;;\u0007`).join("\n"));
const push = (seq: number, at: number, ...numbers: number[]) =>
  shell(seq, at, "git push -q origin HEAD 2>&1 | tail -2", numbers.map((n) => `remote:   ${url(n)}`).join("\n"));
function filler(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: from + index,
    createdAt: t0,
    type: "item/completed",
    data: { item: { type: "agentMessage", id: `message-${from + index}`, text: "" } },
  }));
}

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Change ${number}`,
    html_url: url(number),
    created_at: new Date(t0).toISOString(),
    state: "open",
    merged: false,
    merged_at: null,
    closed_at: null,
    head: { sha: sha("a") },
    ...overrides,
  };
}

async function startItems(options: {
  events?: Record<string, Row[]>;
  children?: Record<string, Child[]>;
  api?: (call: TeaCall) => TeaReply | undefined;
} = {}) {
  const events = new Map(Object.entries(options.events ?? {}));
  const children = new Map(Object.entries(options.children ?? {}));
  const pulls = new Map<number, Record<string, unknown>>();
  const statuses = new Map<string, string>();
  const issues = new Set<number>();
  const closedIssues = new Set<number>();
  const gitea = { pulls, statuses, issues, closedIssues, failing: new Set<number>() };
  const { host, calls } = await start(
    (call) => {
      const custom = options.api?.(call);
      if (custom) return custom;
      const path = call.endpoint.split("?")[0]!;
      const one = path.match(/\/repos\/acme\/widgets\/pulls\/(\d+)$/);
      if (one) {
        const number = Number(one[1]);
        if (gitea.failing.has(number)) return { status: 500 };
        const found = pulls.get(number);
        return found ? { json: found } : { status: 404 };
      }
      const status = path.match(/\/repos\/acme\/widgets\/commits\/([0-9a-f]+)\/status$/);
      if (status)
        return {
          json: { total_count: 1, statuses: [{ context: "build", status: statuses.get(status[1]!) ?? "pending", target_url: "" }] },
        };
      const issue = path.match(/\/repos\/acme\/widgets\/issues\/(\d+)$/);
      if (issue) {
        const number = Number(issue[1]);
        if (pulls.has(number)) return { json: { number, pull_request: { merged: false } } };
        if (!issues.has(number)) return { status: 404 };
        return {
          json: {
            number,
            title: `Issue ${number}`,
            html_url: `${server}acme/widgets/issues/${number}`,
            state: closedIssues.has(number) ? "closed" : "open",
            pull_request: null,
          },
        };
      }
      return { json: [] };
    },
    {
      threads: {
        events: {
          list: async ({ threadId, afterSeq, limit }) => {
            if (Number(limit ?? 100) > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
            return (events.get(threadId) ?? [])
              .filter((row) => row.seq > Number(afterSeq ?? 0))
              .slice(0, Number(limit ?? 100))
              .map((row) => ({ id: `event-${row.seq}`, threadId, scope: { kind: "thread" }, ...row }));
          },
        },
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr-gone") throw Object.assign(new Error("not found"), { code: "thread_not_found" });
          return makeThreadResponse({ id: threadId });
        },
        list: async (args) =>
          (children.get(args?.parentThreadId ?? "") ?? [])
            .filter((child) => Boolean(child.archived) === Boolean(args?.archived))
            .map((child) => ({ id: child.id, title: child.title, titleFallback: null })),
      },
    },
  );
  return { host, calls, events, children, gitea };
}

async function view(host: Host, threadId: string) {
  return giteaRpcContract.threadItems.output.parse(
    await host.harness.behavior.callRpc("threadItems", { threadId }),
  );
}

function shown(items: Awaited<ReturnType<typeof view>>) {
  return items.pulls.map((entry) => ({
    ref: `${entry.repo}#${entry.number}`,
    state: entry.state?.lifecycle.state ?? "checking",
    links: entry.links.map((link) => `${link.own ? "" : `${link.threadTitle}:`}${link.source}`),
  }));
}

async function idle(host: Host, id: string) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id }),
    lastAssistantText: "",
  });
}

function eventReads(host: Host) {
  return host.harness.sdk
    .callsTo("threads.events.list")
    .map(([args]) => args as { threadId: string; afterSeq: string });
}

function signals(host: Host) {
  return host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "thread-items-changed").length;
}

const realNow = () => performance.now();
/** Retries `check` until it stops throwing, in real time, while tea child processes answer. */
async function eventually(check: () => Promise<void> | void) {
  const deadline = realNow() + 30_000;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (realNow() > deadline) throw error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

const pullReads = (calls: TeaCall[]) => calls.filter((call) => /\/pulls\/\d+$/.test(call.endpoint)).length;

function runSweeps(host: Host) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: t0 + 10 * minute });
  const service = host.harness.behavior.runService("thread-items");
  cleanups.push(() => {
    service.controller.abort();
    return service.done;
  });
  return service;
}

it("links the pull requests a thread opened and pushed to when it goes idle", async () => {
  const { host, calls } = await startItems({
    events: { "thr-a": [...create(1, t0, 9), ...push(3, t0 + minute, 10)] },
  });
  await idle(host, "thr-a");
  const items = await view(host, "thr-a");
  expect(shown(items)).toEqual([
    { ref: "acme/widgets#10", state: "checking", links: ["pushed"] },
    { ref: "acme/widgets#9", state: "checking", links: ["opened"] },
  ]);
  expect(items).toMatchObject({ server, scanning: false, summary: { total: 2, checking: 2 } });
  expect(items.pulls[1]!.url).toBe(url(9));
  expect(signals(host)).toBe(1);
  expect(calls).toEqual([]);
});

it("reads each thread event once from its cursor and rescans from the start on request", async () => {
  const { host, events } = await startItems({ events: { "thr-a": create(1, t0, 9) } });
  await idle(host, "thr-a");
  events.set("thr-a", [...events.get("thr-a")!, ...push(3, t0 + minute, 9)]);
  await idle(host, "thr-a");
  expect(eventReads(host).map((args) => args.afterSeq)).toEqual(["0", "2"]);
  const cli = await host.harness.behavior.runCli(["thread", "thr-a", "--scan"]);
  expect(cli).toMatchObject({ exitCode: 0 });
  expect(eventReads(host).map((args) => args.afterSeq).slice(2)).toEqual(["0"]);
  expect(shown(await view(host, "thr-a"))).toEqual([
    { ref: "acme/widgets#9", state: "checking", links: ["opened"] },
  ]);
});

it("keeps each page's links and cursor together when a later page fails", async () => {
  const rows = [...create(1, t0, 9), ...filler(3, 98), ...push(101, t0 + minute, 10)];
  const { host } = await startItems({ events: { "thr-a": rows } });
  let reads = 0;
  host.harness.sdk.stub("threads.events.list", async ({ afterSeq }: { afterSeq: string }) => {
    reads += 1;
    if (afterSeq !== "0") throw new Error("bb restarted");
    return rows.slice(0, 100).map((row) => ({ id: `event-${row.seq}`, threadId: "thr-a", scope: { kind: "thread" }, ...row }));
  });
  const first = await idle(host, "thr-a");
  expect(first.errors).toEqual([]);
  expect(reads).toBe(2);
  host.harness.sdk.stub("threads.events.list", async ({ afterSeq }: { afterSeq: string }) =>
    rows.filter((row) => row.seq > Number(afterSeq)).map((row) => ({ id: `event-${row.seq}`, threadId: "thr-a", scope: { kind: "thread" }, ...row })),
  );
  await idle(host, "thr-a");
  expect(host.harness.sdk.callsTo("threads.events.list").map(([args]) => (args as { afterSeq: string }).afterSeq).at(-1)).toBe("100");
  expect(shown(await view(host, "thr-a")).map((entry) => entry.ref)).toEqual(["acme/widgets#10", "acme/widgets#9"]);
});

it("backfills an old thread on its first view and says so until the history is read", async () => {
  const rows = [...create(1, t0, 9), ...filler(3, 700), ...push(703, t0 + minute, 10)];
  const { host } = await startItems({ events: { "thr-a": rows } });
  expect((await view(host, "thr-a")).scanning).toBe(true);
  await eventually(() => expect(signals(host)).toBeGreaterThanOrEqual(3));
  const done = await view(host, "thr-a");
  expect(done.scanning).toBe(false);
  expect(shown(done).map((entry) => entry.ref)).toEqual(["acme/widgets#10", "acme/widgets#9"]);
  expect(eventReads(host).map((args) => args.afterSeq)).toEqual(["0", "100", "200", "300", "400", "500", "600", "700"]);
});

it("asks bb for a thread's events on a view only when its last scan is 30 seconds old, and at once when it goes idle", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: t0 });
  const { host, events } = await startItems({ events: { "thr-a": create(1, t0, 9) } });
  const reads = () => eventReads(host).map((args) => args.afterSeq);
  await view(host, "thr-a");
  await view(host, "thr-a");
  expect(reads()).toEqual(["0"]);
  events.set("thr-a", [...events.get("thr-a")!, ...push(3, t0, 10)]);
  vi.setSystemTime(t0 + 29_000);
  expect(shown(await view(host, "thr-a")).map((entry) => entry.ref)).toEqual(["acme/widgets#9"]);
  expect(reads()).toEqual(["0"]);
  vi.setSystemTime(t0 + 30_000);
  expect(shown(await view(host, "thr-a")).map((entry) => entry.ref)).toEqual(["acme/widgets#10", "acme/widgets#9"]);
  expect(reads()).toEqual(["0", "2"]);
  events.set("thr-a", [...events.get("thr-a")!, ...push(5, t0, 11)]);
  await idle(host, "thr-a");
  expect(reads()).toEqual(["0", "2", "4"]);
  await view(host, "thr-a");
  expect(reads()).toEqual(["0", "2", "4"]);
});

it("includes pull requests of child and grandchild threads once, without looping on cycles", async () => {
  const { host } = await startItems({
    events: {
      root: push(1, t0, 9),
      child: [...push(1, t0 + minute, 9), ...create(3, t0 + minute, 11)],
      grandchild: push(1, t0 + 2 * minute, 12),
      archived: push(1, t0, 13),
    },
    children: {
      root: [{ id: "child", title: "Fix CI" }, { id: "archived", title: "Old", archived: true }],
      child: [{ id: "grandchild", title: "Deploy" }],
      grandchild: [{ id: "root", title: "Root again" }],
    },
  });
  const items = await view(host, "root");
  expect(shown(items)).toEqual([
    { ref: "acme/widgets#12", state: "checking", links: ["Deploy:pushed"] },
    { ref: "acme/widgets#11", state: "checking", links: ["Fix CI:opened"] },
    { ref: "acme/widgets#9", state: "checking", links: ["Fix CI:pushed", "pushed"] },
    { ref: "acme/widgets#13", state: "checking", links: ["Old:pushed"] },
  ]);
  expect(items.descendantsTruncated).toBe(false);
  expect(items.pulls.map((entry) => entry.via)).toEqual([
    { type: "child", threadId: "grandchild", threadTitle: "Deploy" },
    { type: "child", threadId: "child", threadTitle: "Fix CI" },
    { type: "own", source: "pushed" },
    { type: "child", threadId: "archived", threadTitle: "Old" },
  ]);
  expect(shown(await view(host, "child")).map((entry) => entry.ref)).toEqual([
    "acme/widgets#12", "acme/widgets#11", "acme/widgets#9", "acme/widgets#13",
  ]);
});

it("reads at most 50 threads of a tree and says the rest were left out", async () => {
  const children = Array.from({ length: 60 }, (_, index) => ({ id: `child-${index}`, title: `Child ${index}` }));
  const { host } = await startItems({ children: { root: children } });
  const items = await view(host, "root");
  expect(items.descendantsTruncated).toBe(true);
  expect(new Set(eventReads(host).map((args) => args.threadId)).size).toBe(50);
});

it("keeps a thread's links when it is archived or deleted and forgets only the deleted thread's cursor", async () => {
  const { host } = await startItems({ events: { "thr-a": push(1, t0, 9) } });
  await idle(host, "thr-a");
  const before = shown(await view(host, "thr-a"));
  expect(before).toEqual([{ ref: "acme/widgets#9", state: "checking", links: ["pushed"] }]);
  await host.harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr-a", archivedAt: 1 }) });
  expect(shown(await view(host, "thr-a"))).toEqual(before);
  expect(eventReads(host).map((args) => args.afterSeq)).toEqual(["0"]);
  await host.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr-a", deletedAt: 1 }) });
  expect(shown(await view(host, "thr-a"))).toEqual(before);
  expect(eventReads(host).map((args) => args.afterSeq)).toEqual(["0", "0"]);
});


it("rescans from the start after a scan already in flight, even when another starts meanwhile", async () => {
  const rows = create(1, t0, 9);
  const { host } = await startItems({ events: { "thr-a": rows } });
  await idle(host, "thr-a");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  host.harness.sdk.stub("threads.events.list", async ({ afterSeq }: { afterSeq: string }) => {
    if (afterSeq !== "0") await held;
    return rows.filter((row) => row.seq > Number(afterSeq)).map((row) => ({ id: `event-${row.seq}`, threadId: "thr-a", scope: { kind: "thread" }, ...row }));
  });
  const inFlight = idle(host, "thr-a");
  await eventually(() => expect(eventReads(host).map((args) => args.afterSeq)).toEqual(["0", "2"]));
  const rescan = host.harness.behavior.runCli(["thread", "thr-a", "--scan"]);
  const another = idle(host, "thr-a");
  release();
  await Promise.all([inFlight, another]);
  expect(await rescan).toMatchObject({ exitCode: 0, stdout: "checking  acme/widgets#9  (opened)" });
  const reads = eventReads(host).map((args) => args.afterSeq);
  expect(reads.slice(0, 2)).toEqual(["0", "2"]);
  expect(reads.slice(2)).toContain("0");
});

it("shows a pull request's state once the refresher reads it, and drops one a command named that Gitea has never had", { timeout: 60_000 }, async () => {
  const { host, calls, gitea } = await startItems({
    events: { "thr-a": [...create(1, t0, 9, 8), ...push(3, t0 + minute, 9)] },
  });
  gitea.pulls.set(9, pull(9, { created_at: new Date(t0 - 1_000).toISOString() }));
  gitea.statuses.set(sha("a"), "success");
  runSweeps(host);
  await idle(host, "thr-a");
  await eventually(async () => {
    const items = await view(host, "thr-a");
    expect(items.pulls.map(({ number, via, error, state }) => ({ number, via, error, state: state?.lifecycle.state ?? null }))).toEqual([
      { number: 9, via: { type: "own", source: "opened" }, error: null, state: "open" },
    ]);
    expect(items.summary).toMatchObject({ total: 1, open: 1, unreadable: 0, checking: 0 });
  });
  expect(calls.filter((call) => call.endpoint.endsWith("/pulls/8"))).toHaveLength(1);
  expect((await view(host, "thr-a")).pulls[0]!.state?.lifecycle).toMatchObject({
    review: { kind: "none" },
    ci: { kind: "passing", total: 1 },
  });
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("links the pull requests of creates whose output was cut down to pulls/<n>, from Gitea's search", { timeout: 60_000 }, async () => {
  const fixtures = join(import.meta.dirname, "test-fixtures/created-pr-filtered-output");
  const read = <T,>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
  type Found = { number: number; created_at: string; updated_at: string; repository: { full_name: string } };
  const calls = read<{ thread: string; startedAt: string; command: string; output: string }[]>("calls.json");
  const found = [...read<Found[]>("search-2026-11-17T02-47.json"), ...read<Found[]>("search-2026-11-15T22-41.json")]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const events: Record<string, Row[]> = {};
  for (const call of calls) {
    const rows = (events[call.thread] ??= []);
    const [started, completed] = shell(rows.length + 1, Date.parse(call.startedAt) + 15_000, call.command, call.output);
    rows.push({ ...started!, createdAt: Date.parse(call.startedAt) }, completed!);
  }
  const { host, calls: tea } = await startItems({
    events,
    api: ({ endpoint }) => {
      const [path, query] = endpoint.split("?");
      if (path === "/api/v1/repos/issues/search") {
        const params = new URLSearchParams(query);
        const page = Number(params.get("page"));
        return { json: found.filter((pull) => Date.parse(pull.updated_at) >= Date.parse(params.get("since")!)).slice((page - 1) * 50, page * 50) };
      }
      const one = path!.match(/^\/api\/v1\/repos\/(.+)\/pulls\/(\d+)$/);
      const match = one && found.find((pull) => pull.repository.full_name === one[1] && pull.number === Number(one[2]));
      if (match) return { json: pull(match.number, { html_url: url(match.number, match.repository.full_name), created_at: match.created_at }) };
      return undefined;
    },
  });
  runSweeps(host);
  for (const thread of Object.keys(events)) await idle(host, thread);
  await eventually(async () => {
    // Three searches and four open pull requests take more than one budget window.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shown(await view(host, calls[0]!.thread))).toEqual([
      { ref: "wonderlydotcom/internal-tool-work-compliance#254", state: "open", links: ["opened"] },
      { ref: "wonderlydotcom/internal-tool-work-compliance#253", state: "open", links: ["opened"] },
      { ref: "wonderlydotcom/internal-tool-work-compliance#252", state: "open", links: ["opened"] },
    ]);
    expect(shown(await view(host, calls[2]!.thread))).toEqual([
      { ref: "wonderlydotcom/internal-tool-camp#4105", state: "open", links: ["opened"] },
    ]);
  });
  expect(tea.filter((call) => call.endpoint.startsWith("/api/v1/repos/issues/search?"))).toHaveLength(3);
});

it("reads a pull request again after Refresh or a change the plugin made, and never from a view alone", { timeout: 60_000 }, async () => {
  const { host, calls, gitea } = await startItems({
    api: (call) => (call.method === "POST" ? { json: { id: 5 } } : undefined),
  });
  gitea.pulls.set(9, pull(9));
  gitea.statuses.set(sha("a"), "success");
  await host.harness.behavior.callRpc("linkItem", { repo: "acme/widgets", number: 9, kind: "pr", threadId: "thr-a" });
  const reads = () => pullReads(calls);
  expect(reads()).toBe(1);
  runSweeps(host);
  await eventually(async () => {
    expect((await view(host, "thr-a")).pulls[0]!.state?.lifecycle).toMatchObject({ ci: { kind: "passing" } });
  });
  expect(reads()).toBe(2);
  for (let index = 0; index < 3; index += 1) await view(host, "thr-a");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(reads()).toBe(2);

  gitea.pulls.set(9, pull(9, { title: "Renamed" }));
  await host.harness.behavior.callRpc("threadItems", { threadId: "thr-a", refresh: true });
  await eventually(async () => {
    expect((await view(host, "thr-a")).pulls[0]!.state?.title).toBe("Renamed");
  });
  expect(reads()).toBe(3);

  gitea.pulls.set(9, pull(9, { state: "closed", merged: true, merged_at: "2026-11-16T13:00:00Z" }));
  await host.harness.behavior.callRpc("comment", { repo: "acme/widgets", number: 9, body: "hi" });
  await eventually(async () => {
    expect((await view(host, "thr-a")).pulls[0]!.state?.lifecycle.state).toBe("merged");
  });
  expect(reads()).toBe(4);
});

it("reads only the open and never-read items of a thread and its children again on Refresh, and shows its issues' titles and states", { timeout: 60_000 }, async () => {
  const { host, calls, gitea } = await startItems({
    children: { "thr-a": [{ id: "thr-child", title: "Fix CI" }] },
  });
  gitea.pulls.set(9, pull(9, { state: "closed", merged: true, merged_at: "2026-11-16T13:00:00Z" }));
  gitea.pulls.set(10, pull(10));
  gitea.issues.add(4);
  gitea.issues.add(5);
  const link = (kind: "issue" | "pr", number: number, threadId = "thr-a") =>
    host.harness.behavior.callRpc("linkItem", { repo: "acme/widgets", number, kind, threadId });
  await link("pr", 9);
  await link("pr", 10, "thr-child");
  await link("issue", 4);
  await link("issue", 5);
  gitea.closedIssues.add(5);
  runSweeps(host);
  await eventually(async () => {
    const items = await view(host, "thr-a");
    expect(items.issues.map((entry) => [entry.number, entry.state?.title, entry.state?.state])).toEqual([
      [5, "Issue 5", "closed"],
      [4, "Issue 4", "open"],
    ]);
    expect(items.pulls.map((entry) => [entry.number, entry.state?.lifecycle.state])).toEqual([[10, "open"], [9, "merged"]]);
    expect(items.summary).toMatchObject({ total: 2, open: 1, merged: 1 });
  });
  const reads = () => calls.map((call) => call.endpoint.split("?")[0]!.replace("/api/v1/repos/acme/widgets/", ""));
  const before = reads().length;
  await host.harness.behavior.callRpc("threadItems", { threadId: "thr-a", refresh: true });
  // Rows due at once are read oldest first, so a wrongly expired #9 would be read before #10.
  await eventually(() => expect(reads().slice(before)).toContain("issues/4"));
  expect(reads().slice(before).filter((path) => /^(pulls|issues)\/\d+$/.test(path))).toEqual(["pulls/10", "issues/4"]);
});

it("copies the old kv link stores into the table, keeps the keys, and marks the import done only when every key was read", { timeout: 60_000 }, async () => {
  let orphanReadable = false;
  const { host, calls } = await startItems({
    api: ({ endpoint }) => {
      if (endpoint.endsWith("/issues/9")) return { json: { number: 9, pull_request: { merged: false } } };
      if (endpoint.endsWith("/issues/50")) return orphanReadable ? { json: { number: 50 } } : { status: 500 };
      return undefined;
    },
  });
  const account = '["https://gitea.example/prefix/","work","dev"]';
  const sent = { repo: "acme/widgets", number: 42, kind: "pr", threadId: "thread-1", createdAt: "2026-10-12T12:00:00.000Z" };
  const { kv } = host.bb.storage;
  const legacy: Record<string, unknown> = {
    [`link:${account}:pr:acme/widgets#42`]: [sent],
    "thread-link:thread-1": { repo: "acme/widgets", number: 42, kind: "pr" },
    "thread-link:fixer-1": [{ repo: "acme/widgets", number: 43, kind: "pr" }],
    "auto-fixer-thread:fixer-1": { repo: "acme/widgets", number: 43 },
    "thread-link:multi": [{ repo: "acme/widgets", number: 44, kind: "pr" }, { repo: "acme/widgets", number: 7, kind: "issue" }],
    "thread-link:broken": "acme/widgets#45",
    "thread:acme/widgets#42": "thread-1",
    "thread:Acme/Widgets:9": "legacy-9",
    "thread:acme/widgets#50": "legacy-50",
  };
  for (const [key, value] of Object.entries(legacy)) await kv.set(key, value);
  await kv.delete(importedKey);
  const restarted = await host.harness.lifecycle.reload(plugin);
  cleanups.push(() => restarted.harness.lifecycle.dispose());

  const links = await restarted.harness.behavior.callRpc("listLinks", null);
  expect(links).toEqual({ account, links: { "pr:acme/widgets#42": [sent] } });
  expect(shown(await view(restarted, "thread-1"))).toEqual([{ ref: "acme/widgets#42", state: "checking", links: ["sent"] }]);
  expect(shown(await view(restarted, "fixer-1"))).toEqual([{ ref: "acme/widgets#43", state: "checking", links: ["auto-fixer"] }]);
  const multi = await view(restarted, "multi");
  expect(shown(multi)).toEqual([{ ref: "acme/widgets#44", state: "checking", links: ["sent"] }]);
  expect([multi.pulls[0]!.links[0]!.linkedAt, multi.issues]).toEqual([
    0,
    [{ repo: "acme/widgets", number: 7, url: `${server}acme/widgets/issues/7`, state: null, error: null, stale: false, source: "sent", linkedAt: 0 }],
  ]);
  expect(shown(await view(restarted, "legacy-9"))).toEqual([{ ref: "Acme/Widgets#9", state: "checking", links: ["sent"] }]);
  expect(restarted.harness.inspection.logEntries.map((entry) => entry.message)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("thread-link:broken"),
      expect.stringContaining("thread:acme/widgets#50"),
    ]),
  );
  const kept = async (target: Host) => Object.fromEntries(
    await Promise.all(Object.keys(legacy).map(async (key) => [key, await target.bb.storage.kv.get(key)])),
  );
  expect(await kept(restarted)).toEqual(legacy);
  expect(await restarted.bb.storage.kv.get(importedKey)).toBeUndefined();
  const kindReads = () => calls.filter((call) => /\/issues\/\d+$/.test(call.endpoint)).map((call) => call.endpoint);
  expect(kindReads().sort()).toEqual(["/api/v1/repos/Acme/Widgets/issues/9", "/api/v1/repos/acme/widgets/issues/50"]);

  orphanReadable = true;
  const again = await restarted.harness.lifecycle.reload(plugin);
  cleanups.push(() => again.harness.lifecycle.dispose());
  expect(kindReads().slice(2).sort()).toEqual(["/api/v1/repos/Acme/Widgets/issues/9", "/api/v1/repos/acme/widgets/issues/50"]);
  expect(await again.bb.storage.kv.get(importedKey)).toEqual(expect.any(Number));
  expect((await view(again, "legacy-50")).issues.map((issue) => issue.number)).toEqual([50]);
  expect(await again.harness.behavior.callRpc("listLinks", null)).toEqual(links);

  const last = await again.harness.lifecycle.reload(plugin);
  cleanups.push(() => last.harness.lifecycle.dispose());
  expect(kindReads()).toHaveLength(4);
  expect(await kept(last)).toEqual(legacy);
});

it("links, lists, and unlinks issues and pull requests from the CLI for this thread or another", async () => {
  const { host, calls, gitea } = await startItems();
  gitea.pulls.set(9, pull(9, { state: "closed", merged: true, merged_at: "2026-11-16T13:00:00Z" }));
  gitea.pulls.set(10, pull(10));
  gitea.issues.add(4);
  gitea.statuses.set(sha("a"), "success");
  const cli = (argv: string[], threadId?: string) =>
    host.harness.behavior.runCli(argv, threadId ? { threadId } : {});

  await expect(cli(["link", "pr", "acme/widgets", "9"], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "Linked pr acme/widgets#9 to thr-a." });
  expect(calls.map((call) => call.endpoint)).toEqual(["/api/v1/repos/acme/widgets/pulls/9"]);
  await expect(cli(["link", url(10), "--thread", "thr-b"])).resolves.toMatchObject({ exitCode: 0, stdout: "Linked pr acme/widgets#10 to thr-b." });
  expect(calls.map((call) => call.endpoint)).toEqual(["/api/v1/repos/acme/widgets/pulls/9", "/api/v1/repos/acme/widgets/pulls/10"]);
  await expect(cli(["link", "pr", "acme/widgets", "9"], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "pr acme/widgets#9 was already linked to thr-a." });
  await expect(cli(["link", "issue", "acme/widgets", "4"], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "Linked issue acme/widgets#4 to thr-a." });
  await expect(cli(["link", `${server}acme/widgets/issues/4`], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "issue acme/widgets#4 was already linked to thr-a." });
  await expect(cli(["link", "issue", "acme/widgets", "10"], "thr-a")).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("is a pull request; link it as pr") });
  await expect(cli(["link", "pr", "acme/widgets", "9"])).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("--thread") });
  await expect(cli(["link", "pr", "acme/widgets", "9", "--thread", "thr-gone"])).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("BB thread thr-gone was not found.") });
  await expect(cli(["thread"])).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("--thread") });
  await expect(cli(["link", "pr", "acme/widgets", "77"], "thr-a")).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("acme/widgets#77") });
  await expect(cli(["link", "https://other.example/acme/widgets/pulls/9"], "thr-a")).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining("is not an issue or pull request on") });

  const reads = calls.length;
  await expect(cli(["thread"], "thr-a")).resolves.toMatchObject({
    exitCode: 0,
    stdout: "merged    acme/widgets#9  Change 9  (linked)\nissue     acme/widgets#4  (linked)",
  });
  const json = await cli(["thread", "thr-b", "--json"]);
  expect(giteaRpcContract.threadItems.output.parse(JSON.parse(json.stdout ?? "")).pulls[0]).toMatchObject({
    number: 10,
    state: null,
    error: null,
    via: { type: "own", source: "linked" },
  });
  expect(calls).toHaveLength(reads);
  const badges = giteaRpcContract.listLinks.output.parse(await host.harness.behavior.callRpc("listLinks", null));
  expect(Object.fromEntries(Object.entries(badges.links).map(([key, entries]) => [key, entries.map((entry) => entry.threadId)]))).toEqual({
    "pr:acme/widgets#9": ["thr-a"],
    "pr:acme/widgets#10": ["thr-b"],
    "issue:acme/widgets#4": ["thr-a"],
  });

  const badgeSignals = () => host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "links-changed").length;
  const before = badgeSignals();
  await expect(cli(["unlink", "pr", "acme/widgets", "9"], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "Unlinked pr acme/widgets#9 from thr-a." });
  expect(badgeSignals()).toBe(before + 1);
  await expect(cli(["unlink", "pr", "acme/widgets", "9"], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "pr acme/widgets#9 was not linked to thr-a." });
  await expect(cli(["unlink", "pr", "acme/widgets", "4"], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "pr acme/widgets#4 was not linked to thr-a." });
  await expect(cli(["unlink", `${server}acme/widgets/issues/4`], "thr-a")).resolves.toMatchObject({ exitCode: 0, stdout: "Unlinked issue acme/widgets#4 from thr-a." });
  await expect(cli(["thread"], "thr-a")).resolves.toMatchObject({ stdout: "No Gitea pull requests are linked to this thread." });
});

async function threadPulls(host: Host, keys: string[]) {
  return giteaRpcContract.threadPulls.output.parse(await host.harness.behavior.callRpc("threadPulls", { keys }));
}

const pullInvalidations = (host: Host) =>
  host.harness.inspection.experimental_rpcInvalidations.filter((tags) => tags?.includes(threadPullsTag)).length;

it("answers a keyed read of many threads from the stored links and states, reading no events and no Gitea", async () => {
  const { host, calls } = await startItems({
    events: { root: push(1, t0, 9), child: create(1, t0 + minute, 11), other: push(1, t0, 12) },
    children: { root: [{ id: "child", title: "Fix CI" }] },
  });
  for (const id of ["root", "child", "other"]) await idle(host, id);
  const events = eventReads(host).length;
  const tea = calls.length;
  const rows = await threadPulls(host, ["root", "other", "quiet"]);
  expect(Object.keys(rows).sort()).toEqual(["other", "quiet", "root"]);
  expect(rows.root!.pulls.map((entry) => [entry.number, entry.via.type])).toEqual([[11, "child"], [9, "own"]]);
  expect(rows.root!.summary).toMatchObject({ total: 2, checking: 2 });
  expect(rows.other!.pulls.map((entry) => entry.number)).toEqual([12]);
  expect(rows.quiet).toEqual({ pulls: [], summary: expect.objectContaining({ total: 0 }) });
  expect(eventReads(host)).toHaveLength(events);
  expect(calls).toHaveLength(tea);
});

it("marks the keyed reads stale when a thread gains a pull request and when a refresh stores a new state", { timeout: 60_000 }, async () => {
  const { host, gitea } = await startItems({ events: { "thr-a": create(1, t0, 9) } });
  gitea.pulls.set(9, pull(9));
  gitea.statuses.set(sha("a"), "success");
  expect(pullInvalidations(host)).toBe(0);
  await idle(host, "thr-a");
  expect(pullInvalidations(host)).toBe(1);
  runSweeps(host);
  await eventually(async () => {
    expect((await threadPulls(host, ["thr-a"]))["thr-a"]!.pulls[0]!.state?.lifecycle).toMatchObject({ ci: { kind: "passing" } });
  });
  expect(pullInvalidations(host)).toBeGreaterThanOrEqual(2);
});

it("reads a watched thread's new commands every 30 seconds and keeps its open pull requests fresh until the last client leaves", { timeout: 60_000 }, async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: t0 });
  const { host, calls, events, gitea } = await startItems({ events: { "thr-a": create(1, t0, 9) } });
  gitea.pulls.set(9, pull(9));
  gitea.statuses.set(sha("a"), "pending");
  const shownPulls = async () =>
    (await threadPulls(host, ["thr-a"]))["thr-a"]!.pulls.map((entry) => {
      const lifecycle = entry.state?.lifecycle;
      return `${entry.number}:${lifecycle?.state === "open" ? lifecycle.ci.kind : "checking"}`;
    });
  await idle(host, "thr-a");
  runSweeps(host);
  await eventually(async () => expect(await shownPulls()).toEqual(["9:running"]));
  gitea.statuses.set(sha("a"), "success");
  await vi.advanceTimersByTimeAsync(5 * minute);
  expect(pullReads(calls)).toBe(1);

  const stop = host.harness.behavior.experimental_watchRpc("threadPulls", { key: "thr-a" });
  await eventually(async () => expect(await shownPulls()).toEqual(["9:passing"]));
  expect(pullReads(calls)).toBe(2);
  gitea.statuses.set(sha("a"), "failure");
  gitea.pulls.set(10, pull(10, { head: { sha: sha("b") } }));
  events.set("thr-a", [...events.get("thr-a")!, ...push(3, t0, 10)]);
  await vi.advanceTimersByTimeAsync(30_000);
  await eventually(async () => expect(await shownPulls()).toEqual(["10:running", "9:failing"]));

  stop();
  const watched = eventReads(host).length;
  await vi.advanceTimersByTimeAsync(2 * minute);
  expect(eventReads(host)).toHaveLength(watched);
});

it("marks a watched thread's rows stale when its next look finds a new child thread's pull request, which publishes nothing", async () => {
  const { host, children } = await startItems({ events: { root: push(1, t0, 9), child: create(1, t0, 11) } });
  for (const id of ["root", "child"]) await idle(host, id);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: t0 + 10 * minute });
  const rootInvalidations = () =>
    host.harness.inspection.experimental_rpcInvalidations.filter((tags) => tags?.includes(threadPullsKeyTag("root"))).length;
  const published = pullInvalidations(host);
  cleanups.push(host.harness.behavior.experimental_watchRpc("threadPulls", { key: "root" }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(rootInvalidations()).toBe(0);

  children.set("root", [{ id: "child", title: "Fix CI" }]);
  await vi.advanceTimersByTimeAsync(30_000);
  await eventually(() => expect(rootInvalidations()).toBe(1));
  expect(pullInvalidations(host)).toBe(published);
  expect((await threadPulls(host, ["root"])).root!.pulls.map((entry) => entry.number)).toEqual([11, 9]);
});
