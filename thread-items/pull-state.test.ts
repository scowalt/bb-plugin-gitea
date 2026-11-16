import { describe, expect, it } from "vitest";
import type { CiState, PullSnapshot, ThreadPull } from "./contract";
import { nextDueAt, readPull, reusableCi, snapshotOf, summarize } from "./pull-state";

const base = {
  title: "Change",
  html_url: "https://gitea.example/acme/widgets/pulls/9",
  created_at: "2026-11-16T12:00:00Z",
  head: { sha: "a".repeat(40) },
};
const open = (ci: CiState, headSha = "a".repeat(40)): PullSnapshot => ({
  title: "Change",
  url: base.html_url,
  createdAt: base.created_at,
  lifecycle: { state: "open", draft: false, headSha, ci },
});
const merged: PullSnapshot = { ...open("none"), lifecycle: { state: "merged", mergedAt: "2026-11-16T13:00:00Z" } };
const closed: PullSnapshot = { ...open("none"), lifecycle: { state: "closed", closedAt: "2026-11-16T13:00:00Z" } };

describe("readPull and snapshotOf", () => {
  it("reads open, draft, merged, and closed pull requests", () => {
    expect(snapshotOf(readPull({ ...base, state: "open", merged: false })!, "running")).toEqual(open("running"));
    expect(readPull({ ...base, title: "WIP: Change", state: "open", merged: false })?.lifecycle).toEqual({
      state: "open", draft: true, headSha: "a".repeat(40),
    });
    expect(readPull({ ...base, state: "open", merged: false, draft: true })?.lifecycle).toMatchObject({ draft: true });
    expect(snapshotOf(readPull({ ...base, state: "closed", merged: true, merged_at: "2026-11-16T13:00:00Z" })!, "passing")).toEqual(merged);
    expect(snapshotOf(readPull({ ...base, state: "closed", merged: false, closed_at: "2026-11-16T13:00:00Z" })!, "passing")).toEqual(closed);
  });

  it("rejects answers that are not pull requests", () => {
    expect(readPull(null)).toBeNull();
    expect(readPull({ ...base, state: "open" })).toBeNull();
    expect(readPull({ state: "open", merged: false })).toBeNull();
  });
});

describe("reusableCi", () => {
  it("reuses only a final result on the same head", () => {
    expect(reusableCi(open("passing"), "a".repeat(40))).toBe("passing");
    expect(reusableCi(open("failing"), "a".repeat(40))).toBe("failing");
    expect(reusableCi(open("running"), "a".repeat(40))).toBeNull();
    expect(reusableCi(open("none"), "a".repeat(40))).toBeNull();
    expect(reusableCi(open("passing"), "b".repeat(40))).toBeNull();
    expect(reusableCi(merged, "a".repeat(40))).toBeNull();
    expect(reusableCi(null, "a".repeat(40))).toBeNull();
  });
});

describe("nextDueAt", () => {
  const now = 1_000_000;
  it.each([
    ["open, hot", open("running"), true, 0, now + 30_000],
    ["open, cold", open("passing"), false, 0, now + 10 * 60_000],
    ["closed, hot", closed, true, 0, now + 5 * 60_000],
    ["closed, cold", closed, false, 0, now + 6 * 60 * 60_000],
    ["merged", merged, true, 0, null],
    ["never read", null, false, 0, now],
    ["first failure", open("passing"), true, 1, now + 60_000],
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
      row(open("failing")), row(open("running")), row(open("passing")), row(merged), row(merged), row(closed), row(null), row(null, "404"),
    ])).toEqual({
      total: 8, open: 3, merged: 2, closed: 1, checking: 1, unreadable: 1, ciFailing: 1, ciRunning: 1,
    });
  });
});
