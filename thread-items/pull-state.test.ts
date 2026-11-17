import { describe, expect, it } from "vitest";
import type { CiStatus } from "../item-status";
import { itemSnapshotSchema, type IssueSnapshot, type PullSnapshot, type ThreadPull } from "./contract";
import { nextDueAt, readIssue, readPull, summarize } from "./pull-state";

const base = {
  title: "Change",
  html_url: "https://gitea.example/acme/widgets/pulls/9",
  created_at: "2026-11-16T12:00:00Z",
  head: { sha: "a".repeat(40) },
};
const ci = {
  passing: { kind: "passing", total: 2 },
  failing: { kind: "failing", total: 2, failed: [{ name: "lint", url: "" }] },
  running: { kind: "running", total: 2, pending: 1, url: "" },
  none: { kind: "none" },
  unavailable: { kind: "unavailable" },
} satisfies Record<CiStatus["kind"], CiStatus>;
const open = (status: CiStatus, headSha = "a".repeat(40)): PullSnapshot => ({
  kind: "pr",
  title: "Change",
  url: base.html_url,
  createdAt: base.created_at,
  lifecycle: { state: "open", draft: false, headSha, ci: status, review: { kind: "none" } },
});
const merged: PullSnapshot = { ...open(ci.none), lifecycle: { state: "merged", mergedAt: "2026-11-16T13:00:00Z" } };
const closed: PullSnapshot = { ...open(ci.none), lifecycle: { state: "closed", closedAt: "2026-11-16T13:00:00Z" } };
const issue = (state: IssueSnapshot["state"]): IssueSnapshot => ({
  kind: "issue", title: "Bug", url: "https://gitea.example/acme/widgets/issues/4", state,
});

describe("readPull", () => {
  it("reads open, draft, merged, and closed pull requests, and who was asked to review an open one", () => {
    expect(readPull({
      ...base, state: "open", merged: false,
      requested_reviewers: [{ login: "ana" }], requested_reviewers_teams: [{ name: "approvers" }],
    })).toEqual({
      kind: "pr", title: "Change", url: base.html_url, createdAt: base.created_at,
      lifecycle: { state: "open", draft: false, headSha: "a".repeat(40), requested: ["ana", "approvers"] },
    });
    expect(readPull({ ...base, title: "WIP: Change", state: "open", merged: false })?.lifecycle).toMatchObject({ draft: true });
    expect(readPull({ ...base, state: "open", merged: false, draft: true })?.lifecycle).toMatchObject({ draft: true });
    expect(readPull({ ...base, state: "open", merged: false, head: null })?.lifecycle).toMatchObject({ headSha: null });
    expect(readPull({ ...base, state: "closed", merged: true, merged_at: "2026-11-16T13:00:00Z" })).toEqual(merged);
    expect(readPull({ ...base, state: "closed", merged: false, closed_at: "2026-11-16T13:00:00Z" })).toEqual(closed);
  });

  it("rejects answers that are not pull requests", () => {
    expect(readPull(null)).toBeNull();
    expect(readPull({ ...base, state: "open" })).toBeNull();
    expect(readPull({ state: "open", merged: false })).toBeNull();
  });
});

describe("readIssue", () => {
  it("reads an open or closed issue and rejects a pull request", () => {
    const raw = { title: "Bug", html_url: "https://gitea.example/acme/widgets/issues/4", pull_request: null };
    expect(readIssue({ ...raw, state: "open" })).toEqual(issue("open"));
    expect(readIssue({ ...raw, state: "closed" })).toEqual(issue("closed"));
    expect(readIssue({ ...raw, state: "open", pull_request: { merged: false } })).toBeNull();
    expect(readIssue(null)).toBeNull();
  });
});

describe("nextDueAt", () => {
  const now = 1_000_000;
  it.each([
    ["open, hot", open(ci.running), true, 0, now + 30_000],
    ["open, cold", open(ci.passing), false, 0, now + 10 * 60_000],
    ["closed, hot", closed, true, 0, now + 5 * 60_000],
    ["closed, cold", closed, false, 0, now + 6 * 60 * 60_000],
    ["merged", merged, true, 0, null],
    ["open issue, hot", issue("open"), true, 0, now + 30_000],
    ["open issue, cold", issue("open"), false, 0, now + 10 * 60_000],
    ["closed issue, cold", issue("closed"), false, 0, now + 6 * 60 * 60_000],
    ["never read", null, false, 0, now],
    ["first failure", open(ci.passing), true, 1, now + 60_000],
    ["third failure of a merged PR", merged, false, 3, now + 240_000],
    ["many failures", null, false, 20, now + 60 * 60_000],
  ] as const)("%s", (_name, snapshot, hot, failures, due) => {
    expect(nextDueAt(snapshot, { hot, failures, now })).toBe(due);
  });
});

describe("summarize", () => {
  const row = (state: PullSnapshot | null, error: string | null = null): ThreadPull => ({
    repo: "acme/widgets", number: 1, url: "", state, error, stale: false,
    via: { type: "own", source: "opened" },
    links: [{ threadId: "t", threadTitle: null, source: "opened", linkedAt: 0, own: true }],
  });
  it("counts states and open CI", () => {
    expect(summarize([
      row(open(ci.failing)), row(open(ci.running)), row(open(ci.passing)), row(merged), row(merged), row(closed), row(null), row(null, "404"),
    ])).toEqual({
      total: 8, open: 3, merged: 2, closed: 1, checking: 1, unreadable: 1, ciFailing: 1, ciRunning: 1,
    });
  });
});

describe("itemSnapshotSchema", () => {
  it("gives an issue no pull request fields", () => {
    expect(itemSnapshotSchema.parse({ ...issue("open"), lifecycle: merged.lifecycle, createdAt: "x" })).toEqual(issue("open"));
    expect(itemSnapshotSchema.safeParse({ ...merged, kind: "issue" }).success).toBe(false);
  });
});
