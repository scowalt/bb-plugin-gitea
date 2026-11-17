import { z } from "zod";
import { ciStatusSchema, reviewStatusSchema } from "../item-status.js";
import { repositorySchema } from "../repository.js";

export const linkSources = ["sent", "auto-fixer", "opened", "pushed", "linked"] as const;
export type LinkSource = (typeof linkSources)[number];
const linkSourceSchema = z.enum(linkSources);

const itemNumber = z.number().int().positive();

export const itemRefSchema = z.object({
  repo: repositorySchema,
  number: itemNumber,
  kind: z.enum(["issue", "pr"]),
});
export type ItemRef = z.infer<typeof itemRefSchema>;
export type ItemKind = ItemRef["kind"];

/** A thread the plugin started for an item or that someone linked to it, as `listLinks` returns it. */
export const threadLinkSchema = itemRefSchema
  .extend({ threadId: z.string().min(1), createdAt: z.string() })
  .strict();
export type ThreadLink = z.infer<typeof threadLinkSchema>;

export const pullSnapshotSchema = z.object({
  kind: z.literal("pr"),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  lifecycle: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("open"),
      draft: z.boolean(),
      headSha: z.string().nullable(),
      ci: ciStatusSchema,
      review: reviewStatusSchema,
    }),
    z.object({ state: z.literal("merged"), mergedAt: z.string() }),
    z.object({ state: z.literal("closed"), closedAt: z.string() }),
  ]),
});
export type PullSnapshot = z.infer<typeof pullSnapshotSchema>;

export const issueSnapshotSchema = z.object({
  kind: z.literal("issue"),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
});
export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;

/** What the refresher last read of a linked item. */
export const itemSnapshotSchema = z.discriminatedUnion("kind", [pullSnapshotSchema, issueSnapshotSchema]);
export type ItemSnapshot = z.infer<typeof itemSnapshotSchema>;

export const threadPullSchema = z.object({
  repo: z.string(),
  number: itemNumber,
  url: z.string(),
  state: pullSnapshotSchema.nullable(),
  /** Why the last read failed, while reads are failing. */
  error: z.string().nullable(),
  /** The last read failed, so `state` is the last one read. */
  stale: z.boolean(),
  /** How the thread got this pull request: by itself, or only through a child thread. */
  via: z.discriminatedUnion("type", [
    z.object({ type: z.literal("own"), source: linkSourceSchema }),
    z.object({ type: z.literal("child"), threadId: z.string(), threadTitle: z.string().nullable() }),
  ]),
  links: z.array(
    z.object({
      threadId: z.string(),
      threadTitle: z.string().nullable(),
      source: linkSourceSchema,
      linkedAt: z.number(),
      own: z.boolean(),
    }),
  ),
});
export type ThreadPull = z.infer<typeof threadPullSchema>;

export const threadIssueSchema = z.object({
  repo: z.string(),
  number: itemNumber,
  url: z.string(),
  state: issueSnapshotSchema.nullable(),
  /** Why the last read failed, while reads are failing. */
  error: z.string().nullable(),
  /** The last read failed, so `state` is the last one read. */
  stale: z.boolean(),
  source: linkSourceSchema,
  linkedAt: z.number(),
});
export type ThreadIssue = z.infer<typeof threadIssueSchema>;

const count = z.number().int().nonnegative();
export const threadItemsSummarySchema = z.object({
  total: count,
  open: count,
  merged: count,
  closed: count,
  checking: count,
  unreadable: count,
  ciFailing: count,
  ciRunning: count,
});
export type ThreadItemsSummary = z.infer<typeof threadItemsSummarySchema>;

export const threadItemsViewSchema = z.object({
  threadId: z.string(),
  server: z.string(),
  scanning: z.boolean(),
  descendantsTruncated: z.boolean(),
  pulls: z.array(threadPullSchema),
  issues: z.array(threadIssueSchema),
  summary: threadItemsSummarySchema,
});
export type ThreadItemsView = z.infer<typeof threadItemsViewSchema>;

export const threadItemLinkSchema = itemRefSchema.extend({ threadId: z.string().min(1) });

export const threadItemsRpcMethods = {
  threadItems: {
    /** `refresh` reads the view's open and never-read items again on the next sweep. */
    input: z.object({ threadId: z.string().min(1), refresh: z.boolean().default(false) }),
    output: threadItemsViewSchema,
  },
  linkItem: {
    input: threadItemLinkSchema,
    output: z.object({ result: z.enum(["added", "already"]) }),
  },
  unlinkItem: {
    input: threadItemLinkSchema,
    output: z.object({ removed: z.boolean() }),
  },
} as const;
