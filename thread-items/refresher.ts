import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PullSnapshot } from "./contract.js";
import { isHot, nextDueAt, readPull, reusableCi, snapshotOf } from "./pull-state.js";
import type { GiteaReads } from "./service.js";
import type { ItemId, PullState, openStore } from "./store.js";

const sweepIntervalMs = 30_000;
/** The refresher starts at most `calls` tea processes in any `windowMs`. */
export const teaBudget = { calls: 12, windowMs: 30_000 };
const callsPerRead = 2;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type PullReads = Pick<GiteaReads, "pull" | "ci">;

/** Reads a pull request and, when it is open and its head moved or CI was not final, its CI. */
async function readSnapshot(
  gitea: PullReads,
  repo: string,
  number: number,
  previous: PullSnapshot | null,
  signal?: AbortSignal,
): Promise<PullSnapshot> {
  const facts = readPull(await gitea.pull(repo, number, signal));
  if (!facts) throw new Error("Gitea returned an unrecognized pull request.");
  if (facts.lifecycle.state !== "open") return snapshotOf(facts, "none");
  const { headSha } = facts.lifecycle;
  if (headSha === null) return snapshotOf(facts, "none");
  const ci = reusableCi(previous, headSha) ?? (await gitea.ci(repo, headSha, signal));
  return snapshotOf(facts, ci);
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keeps the state of linked pull requests fresh: reads due rows one at a
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
  const counted: PullReads = {
    pull(repo, number, signal) {
      budget.spend(Date.now());
      return gitea.pull(repo, number, signal);
    },
    ci(repo, sha, signal) {
      budget.spend(Date.now());
      return gitea.ci(repo, sha, signal);
    },
  };

  /** Stores a successful read. `resets` is the row's count before the read. Returns whether a link changed. */
  function saveRead(server: string, item: ItemId, snapshot: PullSnapshot, resets: number): boolean {
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

  /** Reads one due pull request and stores what it found. Returns whether a view changed. */
  async function refresh(server: string, item: ItemId & PullState, signal?: AbortSignal): Promise<boolean> {
    try {
      const snapshot = await readSnapshot(counted, item.repoKey, item.number, item.snapshot, signal);
      const linksChanged = saveRead(server, item, snapshot, item.resets);
      return linksChanged || item.failures > 0 || JSON.stringify(snapshot) !== JSON.stringify(item.snapshot);
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
      return item.failures === 0;
    }
  }

  /** Reads due pull requests, soonest first, until none is due or the budget is spent. */
  async function sweep(signal?: AbortSignal): Promise<void> {
    const server = gitea.server();
    let changed = false;
    while (!signal?.aborted && budget.waitFor(callsPerRead, Date.now()) === 0) {
      const [item] = store.duePulls(server, Date.now(), 1);
      if (!item) break;
      if (await refresh(server, item, signal)) changed = true;
    }
    if (changed) publish();
  }

  return {
    sweep,
    saveRead,
    /** Reads a pull request now, outside the background budget. */
    read: (repo: string, number: number, previous: PullSnapshot | null) =>
      readSnapshot(gitea, repo, number, previous),
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
