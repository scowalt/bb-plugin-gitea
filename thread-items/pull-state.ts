import { z } from "zod";
import { parseLifecycle } from "../auto-fixer.js";
import { isDraftTitle } from "../draft-title.js";
import type {
  CiState,
  PullSnapshot,
  ThreadItemsSummary,
  ThreadPull,
} from "./contract.js";

const pullFieldsSchema = z.object({
  title: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string() }).nullish(),
});

type OpenLifecycle = Extract<PullSnapshot["lifecycle"], { state: "open" }>;
type SettledLifecycle = Exclude<PullSnapshot["lifecycle"], OpenLifecycle>;

/** A pull request as `pulls/{n}` describes it, before its CI is known. */
export type PullFacts = Omit<PullSnapshot, "lifecycle"> & {
  lifecycle: Omit<OpenLifecycle, "ci"> | SettledLifecycle;
};

/** Gitea's `pulls/{n}` JSON, or null when it is not a recognisable pull request. */
export function readPull(raw: unknown): PullFacts | null {
  const fields = pullFieldsSchema.safeParse(raw);
  const lifecycle = parseLifecycle(raw);
  if (!fields.success || !lifecycle) return null;
  const { title, html_url: url, created_at: createdAt, draft, head } = fields.data;
  return {
    title,
    url,
    createdAt,
    lifecycle:
      lifecycle.state === "open"
        ? {
            state: "open",
            draft: draft === true || isDraftTitle(title),
            headSha: head?.sha || null,
          }
        : lifecycle,
  };
}

/** The snapshot of `facts`; `ci` is used only when the pull request is open. */
export function snapshotOf(facts: PullFacts, ci: CiState): PullSnapshot {
  return facts.lifecycle.state === "open"
    ? { ...facts, lifecycle: { ...facts.lifecycle, ci } }
    : { ...facts, lifecycle: facts.lifecycle };
}

const finalCi = new Set<CiState>(["passing", "failing"]);

/** The stored CI of an open pull request when its head has not moved and the result was final. */
export function reusableCi(
  previous: PullSnapshot | null,
  headSha: string,
): CiState | null {
  if (previous?.lifecycle.state !== "open") return null;
  const { ci, headSha: previousSha } = previous.lifecycle;
  return previousSha === headSha && finalCi.has(ci) ? ci : null;
}

/** A pull request someone looked at this recently is hot and refreshes on the short interval. */
export const hotForMs = 5 * 60_000;
/** A view records that it looked at a pull request at most this often. */
export const touchThrottleMs = 60_000;

export const isHot = (touchedAt: number | null, now: number) =>
  touchedAt !== null && touchedAt >= now - hotForMs;

const openHotMs = 30_000;
const openColdMs = 10 * 60_000;
const closedHotMs = 5 * 60_000;
const closedColdMs = 6 * 60 * 60_000;
const failureBaseMs = 30_000;
const failureMaxMs = 60 * 60_000;

/**
 * When the refresher should next read a pull request; null means never.
 * `failures` counts consecutive failed reads, including the one just made.
 */
export function nextDueAt(
  snapshot: PullSnapshot | null,
  { hot, failures, now }: { hot: boolean; failures: number; now: number },
): number | null {
  if (failures > 0)
    return now + Math.min(failureBaseMs * 2 ** failures, failureMaxMs);
  if (!snapshot) return now;
  switch (snapshot.lifecycle.state) {
    case "merged":
      return null;
    case "closed":
      return now + (hot ? closedHotMs : closedColdMs);
    case "open":
      return now + (hot ? openHotMs : openColdMs);
    default: {
      const _exhaustive: never = snapshot.lifecycle;
      return _exhaustive;
    }
  }
}

export function summarize(pulls: readonly ThreadPull[]): ThreadItemsSummary {
  const summary: ThreadItemsSummary = {
    total: pulls.length,
    open: 0,
    merged: 0,
    closed: 0,
    checking: 0,
    unreadable: 0,
    ciFailing: 0,
    ciRunning: 0,
  };
  for (const { state, error } of pulls) {
    if (!state) {
      summary[error === null ? "checking" : "unreadable"] += 1;
      continue;
    }
    const { lifecycle } = state;
    summary[lifecycle.state] += 1;
    if (lifecycle.state === "open" && lifecycle.ci === "failing")
      summary.ciFailing += 1;
    if (lifecycle.state === "open" && lifecycle.ci === "running")
      summary.ciRunning += 1;
  }
  return summary;
}
