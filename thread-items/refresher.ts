import { isDeepStrictEqual } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { repoKey } from "../auto-fixer.js";
import { GiteaNotFoundError } from "../gitea-errors.js";
import { deriveCi, deriveReview, type CiStatus } from "../item-status.js";
import type { IssueSnapshot, ItemSnapshot, PullSnapshot } from "./contract.js";
import type { CreationWindow } from "./detect.js";
import { isHot, nextDueAt, readIssue, readPull, retryAt } from "./pull-state.js";
import type { GiteaReads } from "./service.js";
import type { DueItem, ItemId, NewLink, openStore, UnresolvedCreate } from "./store.js";

const sweepIntervalMs = 30_000;
/** The refresher starts at most `calls` tea processes in any `windowMs`. */
export const teaBudget = { calls: 12, windowMs: 30_000 };
/** An open pull request usually costs three reads: itself, its reviews, and its head's status. An issue costs one. */
const callsPerRead = 3;
const pageSize = 50;
const maxReviewPages = 10;
const maxStatusPages = 4;
/** How many pages of search results a create's lookup reads before it gives up. */
export const maxSearchPages = 10;

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

const searchRowsSchema = z.array(
  z.object({ number: z.number(), created_at: z.string(), repository: z.object({ full_name: z.string() }) }),
);

/**
 * The pull requests the login created inside `window`, oldest first. The
 * search returns them newest first and `since` filters on the last update, so
 * it pages back until a pull request predates the window. `complete` is false
 * when `maxSearchPages` ran out first.
 */
async function searchCreated(
  search: GiteaReads["search"],
  window: CreationWindow,
  signal?: AbortSignal,
): Promise<{ pulls: { repo: string; number: number }[]; complete: boolean }> {
  const pulls: { repo: string; number: number }[] = [];
  const since = encodeURIComponent(new Date(window.from).toISOString());
  for (let page = 1; page <= maxSearchPages; page += 1) {
    const rows = searchRowsSchema.parse(
      await search(`type=pulls&created=true&state=all&since=${since}&${pageQuery(page)}`, signal),
    );
    for (const row of rows) {
      const createdAt = Date.parse(row.created_at);
      if (createdAt < window.from) return { pulls: pulls.reverse(), complete: true };
      if (createdAt <= window.to) pulls.push({ repo: row.repository.full_name, number: row.number });
    }
    if (rows.length < pageSize) return { pulls: pulls.reverse(), complete: true };
  }
  return { pulls: pulls.reverse(), complete: false };
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
 * Keeps the state of linked issues and pull requests fresh: finds the pull
 * requests of creates whose output named them only by number, reads due rows
 * one at a time, all within `teaBudget`, and publishes once per sweep that
 * changed a view.
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
  // Every call waits for room in the budget, so a pull request with more
  // pages than `callsPerRead` delays the sweep instead of overspending.
  async function budgeted<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await delay(budget.waitFor(1, Date.now()), signal);
    if (signal?.aborted) throw signal.reason;
    budget.spend(Date.now());
    return call();
  }
  const counted = {
    resolveUrl: gitea.resolveUrl,
    get: (repo: string, path: string, signal?: AbortSignal) =>
      budgeted(() => gitea.get(repo, path, signal), signal),
    search: (query: string, signal?: AbortSignal) => budgeted(() => gitea.search(query, signal), signal),
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

  /**
   * Links the pull requests a create named that the login created inside its
   * window, then forgets the create. A failed search keeps it for a later
   * sweep. Returns whether a link changed.
   */
  async function resolve(server: string, create: UnresolvedCreate, signal?: AbortSignal): Promise<boolean> {
    const what = `pull request ${create.numbers.map((number) => `#${number}`).join(" or ")} that a command in BB thread ${create.threadId} created at ${new Date(create.linkedAt).toISOString()}`;
    try {
      const { pulls, complete } = await searchCreated(counted.search, create.window, signal);
      const links: NewLink[] = pulls
        .filter((pull) => create.numbers.includes(pull.number))
        .map((pull) => ({
          threadId: create.threadId,
          repo: pull.repo,
          repoKey: repoKey(pull.repo),
          number: pull.number,
          kind: "pr",
          source: "opened",
          account: null,
          linkedAt: create.linkedAt,
          window: create.window,
        }));
      if (!complete && links.length === 0)
        log.warn(`Stopped looking for ${what}: the newest ${maxSearchPages * pageSize} pull requests in the search were all created after it.`);
      return store.resolveCreate(server, create, links).length > 0;
    } catch (error) {
      if (signal?.aborted) throw error;
      const failures = create.failures + 1;
      store.saveCreateFailure(server, create, { failures, dueAt: retryAt(failures, Date.now()) });
      log.warn(`Could not search Gitea for ${what}: ${message(error)}`);
      return false;
    }
  }

  /**
   * Looks up due creates, then reads due items, soonest first, until none is
   * due or the budget is spent.
   */
  async function sweep(signal?: AbortSignal): Promise<void> {
    const server = gitea.server();
    let changed = false;
    while (!signal?.aborted && budget.waitFor(1, Date.now()) === 0) {
      const create = store.dueCreate(server, Date.now());
      if (!create) break;
      if (await resolve(server, create, signal)) changed = true;
    }
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
