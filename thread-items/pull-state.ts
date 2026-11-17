import { z } from "zod";
import { parseLifecycle } from "../auto-fixer.js";
import { isDraftTitle } from "../draft-title.js";
import { parsePull } from "../item-status.js";
import type {
  IssueSnapshot,
  ItemSnapshot,
  PullSnapshot,
  ThreadItemsSummary,
  ThreadPull,
} from "./contract.js";

const pullFieldsSchema = z.object({
  title: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  draft: z.boolean().optional(),
});

type OpenLifecycle = Extract<PullSnapshot["lifecycle"], { state: "open" }>;
type SettledLifecycle = Exclude<PullSnapshot["lifecycle"], OpenLifecycle>;

/** A pull request as `pulls/{n}` describes it, before its review and CI are read. */
export type PullFacts = Omit<PullSnapshot, "lifecycle"> & {
  lifecycle:
    | (Omit<OpenLifecycle, "ci" | "review"> & { requested: string[] })
    | SettledLifecycle;
};

/** Gitea's `pulls/{n}` JSON, or null when it is not a recognisable pull request. */
export function readPull(raw: unknown): PullFacts | null {
  const fields = pullFieldsSchema.safeParse(raw);
  const lifecycle = parseLifecycle(raw);
  if (!fields.success || !lifecycle) return null;
  const { title, html_url: url, created_at: createdAt, draft } = fields.data;
  if (lifecycle.state !== "open") return { kind: "pr", title, url, createdAt, lifecycle };
  const { headSha, requested } = parsePull(raw);
  return {
    kind: "pr",
    title,
    url,
    createdAt,
    lifecycle: {
      state: "open",
      draft: draft === true || isDraftTitle(title),
      headSha: headSha || null,
      requested,
    },
  };
}

const issueFieldsSchema = z.object({
  title: z.string(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  pull_request: z.null().optional(),
});

/** Gitea's `issues/{n}` JSON, or null when it is not an issue. */
export function readIssue(raw: unknown): IssueSnapshot | null {
  const fields = issueFieldsSchema.safeParse(raw);
  if (!fields.success) return null;
  const { title, html_url: url, state } = fields.data;
  return { kind: "issue", title, url, state };
}

/** An item someone looked at this recently is hot and refreshes on the short interval. */
export const hotForMs = 5 * 60_000;
/** A view records that it looked at an item at most this often. */
export const touchThrottleMs = 60_000;

export const isHot = (touchedAt: number | null, now: number) =>
  touchedAt !== null && touchedAt >= now - hotForMs;

const openHotMs = 30_000;
const openColdMs = 10 * 60_000;
const closedHotMs = 5 * 60_000;
const closedColdMs = 6 * 60 * 60_000;
const failureBaseMs = 30_000;
const failureMaxMs = 60 * 60_000;

/** An issue's or a pull request's state. */
function stateOf(snapshot: ItemSnapshot): "open" | "closed" | "merged" {
  return snapshot.kind === "issue" ? snapshot.state : snapshot.lifecycle.state;
}

/**
 * When the refresher should next read an item; null means never.
 * `failures` counts consecutive failed reads, including the one just made.
 */
export function nextDueAt(
  snapshot: ItemSnapshot | null,
  { hot, failures, now }: { hot: boolean; failures: number; now: number },
): number | null {
  if (failures > 0)
    return now + Math.min(failureBaseMs * 2 ** failures, failureMaxMs);
  if (!snapshot) return now;
  switch (stateOf(snapshot)) {
    case "merged":
      return null;
    case "closed":
      return now + (hot ? closedHotMs : closedColdMs);
    case "open":
      return now + (hot ? openHotMs : openColdMs);
  }
}

/** Whether Refresh should read the item again: it was never read, or it is open. */
export const canChange = (snapshot: ItemSnapshot | null) =>
  snapshot === null || stateOf(snapshot) === "open";

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
    if (lifecycle.state === "open" && lifecycle.ci.kind === "failing")
      summary.ciFailing += 1;
    if (lifecycle.state === "open" && lifecycle.ci.kind === "running")
      summary.ciRunning += 1;
  }
  return summary;
}
