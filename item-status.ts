import { z } from "zod";
import { repositorySchema } from "./repository.js";

export const ciStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passing"), total: z.number().int() }),
  z.object({
    kind: z.literal("failing"),
    total: z.number().int(),
    failed: z.array(z.object({ name: z.string(), url: z.string() })).min(1),
  }),
  z.object({
    kind: z.literal("running"),
    total: z.number().int(),
    pending: z.number().int(),
    url: z.string(),
  }),
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("unavailable") }),
]);

export const reviewStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes-requested"), reviewers: z.array(z.string()) }),
  z.object({ kind: z.literal("approved"), reviewers: z.array(z.string()) }),
  z.object({ kind: z.literal("awaiting"), reviewers: z.array(z.string()) }),
  z.object({ kind: z.literal("none") }),
]);

const itemBase = {
  repo: repositorySchema,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
};

export const itemStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    ...itemBase,
    kind: z.literal("issue"),
    state: z.enum(["open", "closed"]),
  }),
  z.object({
    ...itemBase,
    kind: z.literal("pr"),
    lifecycle: z.discriminatedUnion("state", [
      z.object({
        state: z.literal("open"),
        draft: z.boolean(),
        ci: ciStatusSchema,
        review: reviewStatusSchema,
      }),
      z.object({ state: z.literal("merged") }),
      z.object({ state: z.literal("closed") }),
    ]),
  }),
]);

export type CiStatus = z.infer<typeof ciStatusSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type ItemStatus = z.infer<typeof itemStatusSchema>;

export type CheckState = "success" | "failure" | "pending" | "neutral";

export function checkStatus(state: string): CheckState {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  if (state === "pending") return "pending";
  return "neutral";
}

const text = z.string().catch("");
const rows = <T extends z.ZodType>(row: T) =>
  z.array(row).nullish().transform((value) => value ?? []);

const combinedStatusSchema = z.object({
  statuses: rows(
    z.object({
      context: text,
      status: text,
      target_url: z.string().nullish().transform((value) => value ?? ""),
    }),
  ),
});

/** Reads CI from a head commit's combined status; `resolveUrl` makes a check's `target_url` absolute or empty. */
export function deriveCi(
  combined: unknown,
  resolveUrl: (value: string) => string,
): CiStatus {
  const { statuses } = combinedStatusSchema.parse(combined);
  if (statuses.length === 0) return { kind: "none" };
  const checks = statuses.map((entry) => ({
    name: entry.context,
    state: checkStatus(entry.status),
    url: resolveUrl(entry.target_url),
  }));
  const failed = checks.filter((check) => check.state === "failure");
  if (failed.length > 0)
    return {
      kind: "failing",
      total: checks.length,
      failed: failed.map(({ name, url }) => ({ name, url })),
    };
  const pending = checks.filter((check) => check.state === "pending");
  if (pending.length > 0)
    return {
      kind: "running",
      total: checks.length,
      pending: pending.length,
      url: pending[0]!.url,
    };
  return { kind: "passing", total: checks.length };
}

const reviewRowSchema = z.object({
  user: z.object({ login: text }).nullish(),
  state: text,
  dismissed: z.boolean().catch(false),
  submitted_at: text,
});

type Submitted = {
  changesRequested: string[];
  approved: string[];
  /** Everyone who has submitted a review of any kind, dismissed or not. */
  reviewers: Set<string>;
};

const submittedStates = new Set(["APPROVED", "REQUEST_CHANGES", "COMMENT"]);

/** Each reviewer's latest APPROVED or REQUEST_CHANGES review decides; a dismissed one counts for nothing. */
function readReviews(reviews: readonly unknown[]): Submitted {
  const latest = new Map<
    string,
    { state: string; dismissed: boolean; at: number }
  >();
  const reviewers = new Set<string>();
  for (const raw of reviews) {
    const parsed = reviewRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { user, state, dismissed, submitted_at } = parsed.data;
    if (!user?.login || !submittedStates.has(state)) continue;
    reviewers.add(user.login);
    if (state === "COMMENT") continue;
    const at = Date.parse(submitted_at) || 0;
    const previous = latest.get(user.login);
    if (!previous || at >= previous.at)
      latest.set(user.login, { state, dismissed, at });
  }
  const submitted: Submitted = { changesRequested: [], approved: [], reviewers };
  for (const [reviewer, review] of latest) {
    if (review.dismissed) continue;
    (review.state === "APPROVED" ? submitted.approved : submitted.changesRequested).push(reviewer);
  }
  return submitted;
}

/**
 * One verdict, worst first. `requested` names the reviewers and teams still asked to review.
 * Gitea keeps a bot that only comments in the requested list forever, so anyone who has
 * submitted a review is not awaited.
 */
export function deriveReview(
  reviews: readonly unknown[],
  requested: readonly string[],
): ReviewStatus {
  const { changesRequested, approved, reviewers } = readReviews(reviews);
  if (changesRequested.length > 0)
    return { kind: "changes-requested", reviewers: changesRequested };
  if (approved.length > 0) return { kind: "approved", reviewers: approved };
  const awaiting = requested.filter((name) => !reviewers.has(name));
  return awaiting.length > 0
    ? { kind: "awaiting", reviewers: awaiting }
    : { kind: "none" };
}

const pullSchema = z.object({
  title: text,
  html_url: text,
  state: text,
  merged: z.boolean().catch(false),
  head: z.object({ sha: text }).nullish(),
  requested_reviewers: rows(z.object({ login: text })),
  requested_reviewers_teams: rows(z.object({ name: text })),
});

export type PullSummary = {
  title: string;
  url: string;
  headSha: string;
  state: "open" | "merged" | "closed";
  requested: string[];
};

export function parsePull(raw: unknown): PullSummary {
  const pull = pullSchema.parse(raw);
  return {
    title: pull.title,
    url: pull.html_url,
    headSha: pull.head?.sha ?? "",
    state: pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open",
    requested: [
      ...pull.requested_reviewers.map((user) => user.login),
      ...pull.requested_reviewers_teams.map((team) => team.name),
    ].filter(Boolean),
  };
}
