import { isDeepStrictEqual } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { GiteaNotFoundError } from "../gitea-errors.js";
import { deriveCi, deriveReview, type CiStatus } from "../item-status.js";
import type { IssueSnapshot, ItemSnapshot, PullSnapshot } from "./contract.js";
import { isHot, nextDueAt, readIssue, readPull } from "./pull-state.js";
import type { GiteaReads } from "./service.js";
import type { DueItem, ItemId, openStore } from "./store.js";

const sweepIntervalMs = 30_000;
/** The refresher starts at most `calls` tea processes in any `windowMs`. */
export const teaBudget = { calls: 12, windowMs: 30_000 };
/** An open pull request usually costs three reads: itself, its reviews, and its head's status. An issue costs one. */
const callsPerRead = 3;
const pageSize = 50;
const maxReviewPages = 10;
const maxStatusPages = 4;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Get = GiteaReads["get"];

const pageQuery = (page: number) => `limit=${pageSize}&page=${page}`;

async function readReviews(get: Get, repo: string, number: number, signal?: AbortSignal) {
  const reviews: unknown[] = [];
  for (let page = 1; page <= maxReviewPages; page += 1) {
    const rows = await get(repo, `pulls/${number}/reviews?${pageQuery(page)}`, signal);
    if (!Array.isArray(rows)) throw new Error("Gitea returned an invalid list of reviews.");
    reviews.push(...rows);
    if (rows.length < pageSize) break;
  }
  return reviews;
}

/** A head commit's CI. A failed read is `unavailable` rather than a failed refresh, as the table shows it. */
async function readCi(
  gitea: Pick<GiteaReads, "resolveUrl"> & { get: Get },
  repo: string,
  sha: string,
  signal?: AbortSignal,
): Promise<CiStatus> {
  try {
    const statuses: unknown[] = [];
    for (let page = 1; page <= maxStatusPages; page += 1) {
      const combined = await gitea.get(repo, `commits/${encodeURIComponent(sha)}/status?${pageQuery(page)}`, signal);
      const fields = typeof combined === "object" && combined !== null ? (combined as Record<string, unknown>) : {};
      const rows = Array.isArray(fields.statuses) ? fields.statuses : [];
      statuses.push(...rows);
      if (rows.length === 0 || statuses.length >= (Number(fields.total_count) || 0)) break;
    }
    return deriveCi({ statuses }, gitea.resolveUrl);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unavailable" };
  }
}

/**
 * Reads a pull request and, when it is open, its reviews and its head's CI.
 * Both are read on every refresh: a new review, a re-run, or a check posted
 * later does not move the head.
 */
async function readPullSnapshot(
  gitea: Pick<GiteaReads, "resolveUrl"> & { get: Get },
  repo: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullSnapshot> {
  const facts = readPull(await gitea.get(repo, `pulls/${number}`, signal));
  if (!facts) throw new Error("Gitea returned an unrecognized pull request.");
  if (facts.lifecycle.state !== "open") return { ...facts, lifecycle: facts.lifecycle };
  const { requested, ...open } = facts.lifecycle;
  const review = deriveReview(await readReviews(gitea.get, repo, number, signal), requested);
  const ci: CiStatus =
    open.headSha === null ? { kind: "unavailable" } : await readCi(gitea, repo, open.headSha, signal);
  return { ...facts, lifecycle: { ...open, review, ci } };
}

async function readIssueSnapshot(get: Get, repo: string, number: number, signal?: AbortSignal): Promise<IssueSnapshot> {
  const issue = readIssue(await get(repo, `issues/${number}`, signal));
  if (!issue) throw new Error("Gitea returned an unrecognized issue.");
  return issue;
}

/** Resolves a waiting loop early. A poke while nobody waits makes the next wait return at once. */
function createWakeup() {
  let pending = false;
  let wake: (() => void) | null = null;
  return {
    poke() {
      if (wake) wake();
      else pending = true;
    },
    wait(ms: number, signal: AbortSignal): Promise<void> {
      if (pending || signal.aborted) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          wake = null;
          resolve();
        };
        const timer = setTimeout(done, ms);
        wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    },
  };
}

function createBudget({ calls, windowMs }: typeof teaBudget) {
  const spent: number[] = [];
  const prune = (now: number) => {
    while (spent.length > 0 && spent[0]! <= now - windowMs) spent.shift();
  };
  return {
    spend: (now: number) => spent.push(now),
    /** How long until `count` more calls fit in the window. */
    waitFor(count: number, now: number): number {
      prune(now);
      const over = spent.length + count - calls;
      return over <= 0 ? 0 : spent[over - 1]! + windowMs - now;
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keeps the state of linked issues and pull requests fresh: reads due rows one at a
 * time, within `teaBudget`, and publishes once per sweep that changed a view.
 */
export function createRefresher({
  store,
  gitea,
  publish,
  log,
}: {
  store: ReturnType<typeof openStore>;
  gitea: GiteaReads;
  publish: () => void;
  log: Pick<BbPluginApi["log"], "warn">;
}) {
  const wakeup = createWakeup();
  const budget = createBudget(teaBudget);
  // Every read waits for room in the budget, so a pull request with more
  // pages than `callsPerRead` delays the sweep instead of overspending.
  const counted = {
    resolveUrl: gitea.resolveUrl,
    async get(repo: string, path: string, signal?: AbortSignal) {
      await delay(budget.waitFor(1, Date.now()), signal);
      if (signal?.aborted) throw signal.reason;
      budget.spend(Date.now());
      return gitea.get(repo, path, signal);
    },
  };

  /** Stores a successful read. `resets` is the row's count before the read. Returns whether a link changed. */
  function saveRead(server: string, item: ItemId, snapshot: ItemSnapshot, resets: number): boolean {
    const now = Date.now();
    // A view may have touched the row while the read was in flight.
    const hot = isHot(store.readState(server, item)?.touchedAt ?? null, now);
    return store.saveSnapshot(server, item, {
      snapshot,
      checkedAt: now,
      dueAt: nextDueAt(snapshot, { hot, failures: 0, now }),
      resets,
    });
  }

  /** Reads one due item and stores what it found. Returns whether a view changed. */
  async function refresh(server: string, item: DueItem, signal?: AbortSignal): Promise<boolean> {
    try {
      const snapshot: ItemSnapshot =
        item.kind === "pr"
          ? await readPullSnapshot(counted, item.repoKey, item.number, signal)
          : await readIssueSnapshot(counted.get, item.repoKey, item.number, signal);
      const linksChanged = saveRead(server, item, snapshot, item.resets);
      return linksChanged || item.failures > 0 || !isDeepStrictEqual(snapshot, item.snapshot);
    } catch (error) {
      if (signal?.aborted) throw error;
      const failures = item.failures + 1;
      const now = Date.now();
      store.saveFailure(server, item, {
        failures,
        error: message(error),
        dueAt: nextDueAt(item.snapshot, {
          hot: isHot(store.readState(server, item)?.touchedAt ?? null, now),
          failures,
          now,
        }),
        resets: item.resets,
      });
      // A candidate whose pull request Gitea never had was a command's
      // output naming it, not a thread opening it.
      const rejected =
        error instanceof GiteaNotFoundError && item.snapshot === null && store.rejectCandidates(server, item);
      return rejected || item.failures === 0;
    }
  }

  /** Reads due items, soonest first, until none is due or the budget is spent. */
  async function sweep(signal?: AbortSignal): Promise<void> {
    const server = gitea.server();
    let changed = false;
    while (!signal?.aborted && budget.waitFor(callsPerRead, Date.now()) === 0) {
      const [item] = store.dueItems(server, Date.now(), 1);
      if (!item) break;
      if (await refresh(server, item, signal)) changed = true;
    }
    if (changed) publish();
  }

  return {
    sweep,
    saveRead,
    /** Asks for a sweep before the interval ends; it starts once the budget allows. */
    wake: () => wakeup.poke(),
    async start(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          await sweep(signal);
        } catch (error) {
          if (signal.aborted) break;
          log.warn(`Gitea pull request refresh failed: ${message(error)}`);
        }
        await wakeup.wait(sweepIntervalMs, signal);
        await delay(budget.waitFor(callsPerRead, Date.now()), signal);
      }
    },
  };
}
