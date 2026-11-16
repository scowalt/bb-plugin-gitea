import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { CiState, LinkSource } from "./contract";
import { createRefresher, teaBudget } from "./refresher";
import type { GiteaReads } from "./service";
import { openStore } from "./store";

const server = "https://gitea.example/";
const minute = 60_000;
const t0 = Date.parse("2026-11-16T12:00:00Z");
const sha = (char: string) => char.repeat(40);
const item = (number: number) => ({ repoKey: "acme/widgets", number });

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Change ${number}`,
    html_url: `${server}acme/widgets/pulls/${number}`,
    created_at: new Date(t0).toISOString(),
    state: "open",
    merged: false,
    merged_at: null,
    closed_at: null,
    head: { sha: sha("a") },
    ...overrides,
  };
}
const merged = { state: "closed", merged: true, merged_at: "2026-11-16T13:00:00Z" };

function setup() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: t0 + 10 * minute });
  const host = createFakePluginHost({ pluginId: "gitea" });
  hosts.push(host);
  const store = openStore(host.bb.storage);
  const pulls = new Map<number, Record<string, unknown>>();
  const statuses = new Map<string, CiState>();
  const failing = new Set<number>();
  const reads: { at: number; what: string }[] = [];
  const hooks: { duringRead: ((number: number) => void) | null } = { duringRead: null };
  const gitea: GiteaReads = {
    server: () => server,
    account: async () => "account",
    async pull(_repo, number) {
      reads.push({ at: Date.now(), what: `pull ${number}` });
      const found = pulls.get(number);
      hooks.duringRead?.(number);
      if (failing.has(number)) throw new Error("Gitea answered 500");
      if (!found) throw new Error("Gitea answered 404");
      return found;
    },
    async ci(_repo, headSha) {
      reads.push({ at: Date.now(), what: `ci ${headSha.slice(0, 1)}` });
      return statuses.get(headSha) ?? "running";
    },
    kind: async () => "pr",
  };
  let published = 0;
  const refresher = createRefresher({ store, gitea, publish: () => (published += 1), log: { warn: () => undefined } });
  const link = (number: number, source: LinkSource = "pushed", window: { from: number; to: number } | null = null) =>
    store.addLinks(server, [{
      ...item(number), threadId: "thr-a", repo: "acme/widgets", kind: "pr", source,
      account: null, linkedAt: t0, window,
    }]);
  const shown = () =>
    store.linksOf(server, ["thr-a"]).map((row) => `${row.number} ${row.source} ${row.state?.snapshot?.lifecycle.state ?? "checking"}`).sort();
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const readsSince = (count: number) => reads.slice(count).map((read) => read.what);
  return { store, refresher, pulls, statuses, failing, reads, hooks, link, shown, later, readsSince, published: () => published };
}

it("reads each due pull request once, reuses final CI until the head moves, and never reads a merged one again", async () => {
  const { refresher, pulls, statuses, link, later, readsSince, shown, published } = setup();
  pulls.set(9, pull(9, merged));
  pulls.set(10, pull(10));
  statuses.set(sha("a"), "passing");
  link(9);
  link(10);
  await refresher.sweep();
  expect(readsSince(0).sort()).toEqual(["ci a", "pull 10", "pull 9"]);
  expect(shown()).toEqual(["10 pushed open", "9 pushed merged"]);
  expect(published()).toBe(1);
  later(9 * minute);
  await refresher.sweep();
  expect(readsSince(3)).toEqual([]);
  later(minute);
  await refresher.sweep();
  expect(readsSince(3)).toEqual(["pull 10"]);
  expect(published()).toBe(1);
  pulls.set(10, pull(10, { head: { sha: sha("b") } }));
  later(10 * minute);
  await refresher.sweep();
  expect(readsSince(4)).toEqual(["pull 10", "ci b"]);
});

it("re-reads an open pull request every 30 seconds while someone looks at it and every 10 minutes otherwise", async () => {
  const { store, refresher, pulls, statuses, link, later, reads } = setup();
  pulls.set(9, pull(9));
  statuses.set(sha("a"), "passing");
  link(9);
  await refresher.sweep();
  expect(store.touch(server, [item(9)], Date.now())).toBe(true);
  await refresher.sweep();
  expect(reads.filter((read) => read.what === "pull 9")).toHaveLength(2);
  for (let step = 1; step <= 11; step += 1) {
    later(30_000);
    await refresher.sweep();
    expect(reads.filter((read) => read.what === "pull 9")).toHaveLength(2 + step);
  }
  later(9 * minute);
  await refresher.sweep();
  expect(reads.filter((read) => read.what === "pull 9")).toHaveLength(13);
  later(minute + 30_000);
  await refresher.sweep();
  expect(reads.filter((read) => read.what === "pull 9")).toHaveLength(14);
});

it("keeps an opened candidate created during its command, drops one created before it, and keeps what else linked it", async () => {
  const { refresher, pulls, link, shown } = setup();
  const window = { from: t0 - minute, to: t0 + minute };
  pulls.set(9, pull(9, { created_at: new Date(t0 - 1_000).toISOString() }));
  pulls.set(413, pull(413, { created_at: "2026-09-28T23:50:50Z", ...merged }));
  pulls.set(83, pull(83, { created_at: "2026-09-28T23:50:50Z", ...merged }));
  link(9, "opened", window);
  link(9, "pushed");
  link(413, "opened", window);
  link(83, "opened", window);
  link(83, "pushed");
  expect(shown()).toEqual(["413 opened checking", "83 opened checking", "9 opened checking"]);
  await refresher.sweep();
  expect(shown()).toEqual(["83 pushed merged", "9 opened open"]);
});

it("keeps the last good state when a read fails, keeps the error of one never read, and backs off", async () => {
  const { store, refresher, pulls, statuses, failing, link, later, readsSince } = setup();
  pulls.set(9, pull(9));
  statuses.set(sha("a"), "failing");
  link(9);
  link(10);
  await refresher.sweep();
  failing.add(9);
  later(10 * minute);
  await refresher.sweep();
  expect(readsSince(0).sort()).toEqual(["ci a", "pull 10", "pull 10", "pull 9", "pull 9"]);
  expect(store.readState(server, item(9))).toMatchObject({
    failures: 1,
    snapshot: { lifecycle: { state: "open", ci: "failing" } },
  });
  expect(store.readState(server, item(10))).toMatchObject({ failures: 2, snapshot: null, error: "Gitea answered 404" });
  failing.clear();
  later(30_000);
  await refresher.sweep();
  expect(readsSince(5)).toEqual([]);
  later(30_000);
  await refresher.sweep();
  expect(readsSince(5)).toEqual(["pull 9"]);
  expect(store.readState(server, item(9))).toMatchObject({ failures: 0, error: null });
});

it("reads a pull request again when the plugin changed it while a read was in flight", async () => {
  const { store, refresher, pulls, hooks, link, readsSince } = setup();
  pulls.set(9, pull(9));
  link(9);
  let expired = false;
  hooks.duringRead = (number) => {
    if (expired) return;
    expired = true;
    store.expire(server, item(number));
    pulls.set(number, pull(number, merged));
  };
  await refresher.sweep();
  expect(readsSince(0)).toEqual(["pull 9", "ci a", "pull 9"]);
  expect(store.readState(server, item(9))?.snapshot?.lifecycle.state).toBe("merged");
});

it("starts at most 12 tea calls in any 30 seconds, however often views wake it", async () => {
  const { refresher, pulls, link, reads } = setup();
  const numbers = Array.from({ length: 40 }, (_, index) => index + 1);
  for (const number of numbers) {
    pulls.set(number, pull(number));
    link(number);
  }
  const controller = new AbortController();
  const running = refresher.start(controller.signal);
  for (let second = 0; second < 4 * 60; second += 1) {
    refresher.wake();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  controller.abort();
  await running;
  const busiest = Math.max(
    ...reads.map(({ at }) => reads.filter((read) => read.at >= at && read.at < at + teaBudget.windowMs).length),
  );
  expect(busiest).toBe(teaBudget.calls);
  const read = new Set(reads.filter((entry) => entry.what.startsWith("pull ")).map((entry) => entry.what));
  expect(read.size).toBe(numbers.length);
});
