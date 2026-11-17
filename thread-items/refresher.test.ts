import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GiteaNotFoundError } from "../gitea-errors";
import type { ItemKind, LinkSource } from "./contract";
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

type Review = { user: { login: string }; state: string; submitted_at: string };

function setup() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: t0 + 10 * minute });
  const host = createFakePluginHost({ pluginId: "gitea" });
  hosts.push(host);
  const store = openStore(host.bb.storage);
  const pulls = new Map<number, Record<string, unknown>>();
  /** The one check on each head commit: success, failure, or pending (the default). */
  const statuses = new Map<string, string>();
  const reviews = new Map<number, Review[]>();
  const issues = new Map<number, Record<string, unknown>>();
  const failing = new Set<number>();
  const statusFailures = new Set<string>();
  const reads: { at: number; what: string }[] = [];
  const hooks: { duringRead: ((number: number) => void) | null } = { duringRead: null };
  const gitea: GiteaReads = {
    server: () => server,
    account: async () => "account",
    async get(_repo, path) {
      const [route, query] = path.split("?");
      const page = Number(new URLSearchParams(query).get("page") ?? 1);
      const one = route!.match(/^pulls\/(\d+)$/);
      if (one) {
        const number = Number(one[1]);
        reads.push({ at: Date.now(), what: `pull ${number}` });
        const found = pulls.get(number);
        hooks.duringRead?.(number);
        if (failing.has(number)) throw new Error("Gitea answered 500");
        if (!found) throw new GiteaNotFoundError("Gitea answered 404");
        return found;
      }
      const issue = route!.match(/^issues\/(\d+)$/);
      if (issue) {
        const number = Number(issue[1]);
        reads.push({ at: Date.now(), what: `issue ${number}` });
        const found = issues.get(number);
        if (!found) throw new GiteaNotFoundError("Gitea answered 404");
        return found;
      }
      const reviewed = route!.match(/^pulls\/(\d+)\/reviews$/);
      if (reviewed) {
        const number = Number(reviewed[1]);
        reads.push({ at: Date.now(), what: `reviews ${number}${page > 1 ? ` page ${page}` : ""}` });
        return (reviews.get(number) ?? []).slice((page - 1) * 50, page * 50);
      }
      const status = route!.match(/^commits\/([0-9a-f]+)\/status$/);
      if (status) {
        const headSha = status[1]!;
        reads.push({ at: Date.now(), what: `ci ${headSha.slice(0, 1)}` });
        if (statusFailures.has(headSha)) throw new Error("Gitea answered 500");
        return {
          total_count: 1,
          statuses: [{ context: "build", status: statuses.get(headSha) ?? "pending", target_url: "/acme/widgets/actions/runs/1" }],
        };
      }
      throw new Error(`unexpected read ${path}`);
    },
    resolveUrl: (value) => (value ? new URL(value, server).href : ""),
    kind: async () => "pr",
  };
  let published = 0;
  const refresher = createRefresher({ store, gitea, publish: () => (published += 1), log: { warn: () => undefined } });
  const link = (
    number: number,
    source: LinkSource = "pushed",
    window: { from: number; to: number } | null = null,
    kind: ItemKind = "pr",
  ) =>
    store.addLinks(server, [{
      ...item(number), threadId: "thr-a", repo: "acme/widgets", kind, source,
      account: null, linkedAt: t0, window,
    }]);
  const stateOf = (number: number) => {
    const snapshot = store.readState(server, item(number))?.snapshot;
    if (!snapshot) return "checking";
    return snapshot.kind === "pr" ? snapshot.lifecycle.state : `issue ${snapshot.state}`;
  };
  const shown = () => store.linksOf(server, ["thr-a"]).map((row) => `${row.number} ${row.source} ${stateOf(row.number)}`).sort();
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const readsSince = (count: number) => reads.slice(count).map((read) => read.what);
  return { store, refresher, pulls, issues, statuses, reviews, failing, statusFailures, reads, hooks, link, shown, stateOf, later, readsSince, published: () => published };
}

it("reads each due pull request once, reads an open one's reviews and CI every time, and never reads a merged one again", async () => {
  const { store, refresher, pulls, statuses, link, later, readsSince, shown, published } = setup();
  const ci = () => {
    const snapshot = store.readState(server, item(10))?.snapshot;
    return snapshot?.kind === "pr" && snapshot.lifecycle.state === "open" ? snapshot.lifecycle.ci.kind : null;
  };
  pulls.set(9, pull(9, merged));
  pulls.set(10, pull(10));
  statuses.set(sha("a"), "failure");
  link(9);
  link(10);
  await refresher.sweep();
  expect(readsSince(0).sort()).toEqual(["ci a", "pull 10", "pull 9", "reviews 10"]);
  expect(shown()).toEqual(["10 pushed open", "9 pushed merged"]);
  expect(ci()).toBe("failing");
  expect(published()).toBe(1);
  later(9 * minute);
  await refresher.sweep();
  expect(readsSince(4)).toEqual([]);
  later(minute);
  await refresher.sweep();
  expect(readsSince(4)).toEqual(["pull 10", "reviews 10", "ci a"]);
  expect(published()).toBe(1);
  statuses.set(sha("a"), "success");
  later(10 * minute);
  await refresher.sweep();
  expect(readsSince(7)).toEqual(["pull 10", "reviews 10", "ci a"]);
  expect(ci()).toBe("passing");
  expect(published()).toBe(2);
});

it("reads an issue's title and state, on the open interval while it is open and the closed one after", async () => {
  const { store, refresher, issues, link, later, readsSince, shown } = setup();
  const issue = (state: string) => ({ number: 4, title: "Crash on save", html_url: `${server}acme/widgets/issues/4`, state, pull_request: null });
  issues.set(4, issue("open"));
  link(4, "sent", null, "issue");
  await refresher.sweep();
  expect(readsSince(0)).toEqual(["issue 4"]);
  expect(store.readState(server, item(4))?.snapshot).toEqual({
    kind: "issue", title: "Crash on save", url: `${server}acme/widgets/issues/4`, state: "open",
  });
  issues.set(4, issue("closed"));
  later(10 * minute);
  await refresher.sweep();
  expect(readsSince(1)).toEqual(["issue 4"]);
  expect(shown()).toEqual(["4 sent issue closed"]);
  later(5 * 60 * minute);
  await refresher.sweep();
  expect(readsSince(2)).toEqual([]);
  later(60 * minute);
  await refresher.sweep();
  expect(readsSince(2)).toEqual(["issue 4"]);
});

it("drops an opened candidate Gitea has no pull request for, and keeps a linked one that later 404s with its error", async () => {
  const { store, refresher, pulls, link, later, shown } = setup();
  const window = { from: t0 - minute, to: t0 + minute };
  pulls.set(9, pull(9));
  link(8, "opened", window);
  link(9, "linked");
  link(7, "opened", window);
  store.addLinks(server, [{ ...item(7), threadId: "thr-a", repo: "acme/widgets", kind: "pr", source: "pushed", account: null, linkedAt: t0, window: null }]);
  await refresher.sweep();
  expect(shown()).toEqual(["7 pushed checking", "9 linked open"]);
  expect(store.readState(server, item(7))).toMatchObject({ failures: 1, error: "Gitea answered 404" });
  pulls.delete(9);
  later(10 * minute);
  await refresher.sweep();
  expect(shown()).toEqual(["7 pushed checking", "9 linked open"]);
  expect(store.readState(server, item(9))).toMatchObject({ failures: 1, error: "Gitea answered 404" });
});

it("re-reads an open pull request every 30 seconds while someone looks at it and every 10 minutes otherwise", async () => {
  const { store, refresher, pulls, statuses, link, later, reads } = setup();
  pulls.set(9, pull(9));
  statuses.set(sha("a"), "success");
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
  statuses.set(sha("a"), "failure");
  link(9);
  link(10);
  await refresher.sweep();
  failing.add(9);
  later(10 * minute);
  await refresher.sweep();
  expect(readsSince(0).sort()).toEqual(["ci a", "pull 10", "pull 10", "pull 9", "pull 9", "reviews 9"]);
  expect(store.readState(server, item(9))).toMatchObject({
    failures: 1,
    snapshot: { lifecycle: { state: "open", ci: { kind: "failing" } } },
  });
  expect(store.readState(server, item(10))).toMatchObject({ failures: 2, snapshot: null, error: "Gitea answered 404" });
  failing.clear();
  later(30_000);
  await refresher.sweep();
  expect(readsSince(6)).toEqual([]);
  later(30_000);
  await refresher.sweep();
  expect(readsSince(6)).toEqual(["pull 9", "reviews 9", "ci a"]);
  expect(store.readState(server, item(9))).toMatchObject({ failures: 0, error: null });
});

it("reads a pull request again when the plugin changed it while a read was in flight", async () => {
  const { store, refresher, pulls, hooks, link, readsSince, stateOf } = setup();
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
  expect(readsSince(0)).toEqual(["pull 9", "reviews 9", "ci a", "pull 9"]);
  expect(stateOf(9)).toBe("merged");
});

it("derives the review from every page of reviews and the CI from the head's checks", async () => {
  const { store, refresher, pulls, statuses, reviews, statusFailures, link, readsSince } = setup();
  const at = (minutes: number) => new Date(t0 + minutes * minute).toISOString();
  pulls.set(9, pull(9, { requested_reviewers: [{ login: "lore-bot" }, { login: "ana" }] }));
  reviews.set(9, [
    { user: { login: "ana" }, state: "REQUEST_CHANGES", submitted_at: at(1) },
    ...Array.from({ length: 58 }, (_, index) => ({ user: { login: "lore-bot" }, state: "COMMENT", submitted_at: at(2 + index) })),
    { user: { login: "ana" }, state: "APPROVED", submitted_at: at(70) },
  ]);
  statuses.set(sha("a"), "failure");
  pulls.set(10, pull(10, { head: { sha: sha("c") }, requested_reviewers: [{ login: "lore-bot" }, { login: "bo" }] }));
  reviews.set(10, [{ user: { login: "lore-bot" }, state: "COMMENT", submitted_at: at(1) }]);
  statusFailures.add(sha("c"));
  link(9);
  link(10);
  await refresher.sweep();
  expect(readsSince(0).sort()).toEqual(["ci a", "ci c", "pull 10", "pull 9", "reviews 10", "reviews 9", "reviews 9 page 2"]);
  expect(store.readState(server, item(9))?.snapshot).toEqual(expect.objectContaining({ lifecycle: {
    state: "open", draft: false, headSha: sha("a"),
    review: { kind: "approved", reviewers: ["ana"] },
    ci: { kind: "failing", total: 1, failed: [{ name: "build", url: `${server}acme/widgets/actions/runs/1` }] },
  } }));
  expect(store.readState(server, item(10))).toMatchObject({
    failures: 0,
    snapshot: { lifecycle: { review: { kind: "awaiting", reviewers: ["bo"] }, ci: { kind: "unavailable" } } },
  });
});

it("starts at most 12 tea calls in any 30 seconds, however often views wake it and however many pages a pull request has", async () => {
  const { refresher, pulls, reviews, link, reads } = setup();
  const numbers = Array.from({ length: 30 }, (_, index) => index + 1);
  for (const number of numbers) {
    pulls.set(number, pull(number));
    link(number);
  }
  reviews.set(5, Array.from({ length: 120 }, (_, index) => ({
    user: { login: "lore-bot" }, state: "COMMENT", submitted_at: new Date(t0 + index).toISOString(),
  })));
  const controller = new AbortController();
  const running = refresher.start(controller.signal);
  for (let second = 0; second < 5 * 60; second += 1) {
    refresher.wake();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  controller.abort();
  await running;
  const busiest = Math.max(
    ...reads.map(({ at }) => reads.filter((read) => read.at >= at && read.at < at + teaBudget.windowMs).length),
  );
  expect(busiest).toBe(teaBudget.calls);
  expect(reads.filter((entry) => entry.what.startsWith("reviews 5"))[0]).toBeDefined();
  expect(reads.filter((entry) => entry.what.startsWith("reviews 5 page 3"))).not.toHaveLength(0);
  const read = new Set(reads.filter((entry) => entry.what.startsWith("pull ")).map((entry) => entry.what));
  expect(read.size).toBe(numbers.length);
});
