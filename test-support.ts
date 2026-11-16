import { afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  type FakeSdkOverrides,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

export type TeaCall = {
  args: string[];
  login: string;
  method: string;
  endpoint: string;
  body: unknown;
};
export type TeaReply =
  | { status?: number; json?: unknown; raw?: string }
  | { exitCode: number; stderr: string }
  | { hang: true }
  | { signal: "SIGTERM" };
export type TeaProfile = { name: string; url: string; user: string };

export const fixtureDir = join(import.meta.dirname, "test-fixtures");
export const defaultProfiles: TeaProfile[] = [
  { name: "work", url: "https://gitea.example/prefix", user: "dev" },
];
export const defaultSettings = {
  baseUrl: "https://gitea.example/prefix/",
  teaProfile: "",
  extraRepos: "acme/widgets",
  cacheEntryLimitMiB: 16,
  cacheLimitMiB: 64,
};

export const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

export function isolateTeaEnvironment(path: string) {
  const home = mkdtempSync(join(tmpdir(), "gitea-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PATH", path);
}

export async function startTea(
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

export async function start(
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

export type Host = ReturnType<typeof createFakePluginHost>;
