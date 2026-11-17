import { describe, expect, it } from "vitest";
import {
  deriveCi,
  deriveReview,
  itemStatusSchema,
  parsePull,
} from "./item-status.js";

const base = "https://gitea.example";
const resolveUrl = (value: string) =>
  value ? new URL(value, base).href : "";

const status = (context: string, state: string, target = `/acme/widgets/actions/runs/${context}`) => ({
  context,
  status: state,
  target_url: target,
  created_at: "2026-11-16T10:00:00Z",
});
const combined = (...statuses: ReturnType<typeof status>[]) => ({
  state: "pending",
  total_count: statuses.length,
  statuses,
});

describe("CI status", () => {
  it("lets a failure beat a running check", () => {
    expect(
      deriveCi(combined(status("build", "pending"), status("lint", "failure"), status("test", "error")), resolveUrl),
    ).toEqual({
      kind: "failing",
      total: 3,
      failed: [
        { name: "lint", url: `${base}/acme/widgets/actions/runs/lint` },
        { name: "test", url: `${base}/acme/widgets/actions/runs/test` },
      ],
    });
  });

  it("lets a running check beat a passing one and links the first pending check", () => {
    expect(
      deriveCi(
        combined(status("lint", "success"), status("build", "pending"), status("test", "pending")),
        resolveUrl,
      ),
    ).toEqual({
      kind: "running",
      total: 3,
      pending: 2,
      url: `${base}/acme/widgets/actions/runs/build`,
    });
  });

  it("gives a running check without a link an empty url", () => {
    expect(deriveCi(combined(status("build", "pending", "")), resolveUrl)).toMatchObject({
      kind: "running",
      url: "",
    });
  });

  it("passes when every check succeeded or only warned", () => {
    expect(
      deriveCi(combined(status("lint", "success"), status("docs", "warning")), resolveUrl),
    ).toEqual({ kind: "passing", total: 2 });
  });

  it("reports no CI when the head has no statuses", () => {
    expect(deriveCi({ state: "", total_count: 0, statuses: [] }, resolveUrl)).toEqual({ kind: "none" });
    expect(deriveCi({ state: "", total_count: 0, statuses: null }, resolveUrl)).toEqual({ kind: "none" });
  });

  it("makes a relative target_url absolute", () => {
    const result = deriveCi(
      combined(status("build", "failure", "/wonderlydotcom/internal-tool-camp/actions/runs/701327/jobs/2897491")),
      resolveUrl,
    );
    expect(result).toMatchObject({
      failed: [{ url: `${base}/wonderlydotcom/internal-tool-camp/actions/runs/701327/jobs/2897491` }],
    });
  });

  it("derives from the statuses, not the top-level state", () => {
    expect(
      deriveCi({ state: "success", total_count: 1, statuses: [status("build", "failure")] }, resolveUrl),
    ).toMatchObject({ kind: "failing" });
  });
});

const review = (login: string, state: string, at: string, extra: Record<string, unknown> = {}) => ({
  user: { login },
  state,
  dismissed: false,
  stale: false,
  commit_id: "abc",
  submitted_at: at,
  ...extra,
});

describe("review status", () => {
  const at = (hour: number) => `2026-11-16T${String(hour).padStart(2, "0")}:00:00Z`;

  it("counts a reviewer who requested changes and then approved as approved", () => {
    expect(
      deriveReview(
        [review("ana", "REQUEST_CHANGES", at(10)), review("ana", "APPROVED", at(12))],
        [],
      ),
    ).toEqual({ kind: "approved", reviewers: ["ana"] });
  });

  it("lets the latest decisive review win even when listed first", () => {
    expect(
      deriveReview(
        [review("ana", "REQUEST_CHANGES", at(12)), review("ana", "APPROVED", at(10))],
        [],
      ),
    ).toEqual({ kind: "changes-requested", reviewers: ["ana"] });
  });

  it("puts one reviewer's requested changes ahead of another's approval", () => {
    expect(
      deriveReview(
        [
          review("ana", "APPROVED", at(10)),
          review("bo", "REQUEST_CHANGES", at(11)),
          review("cy", "APPROVED", at(12)),
        ],
        ["dee"],
      ),
    ).toEqual({ kind: "changes-requested", reviewers: ["bo"] });
  });

  it("lists every approver when nobody requested changes", () => {
    expect(
      deriveReview([review("ana", "APPROVED", at(10)), review("cy", "APPROVED", at(12))], ["dee"]),
    ).toEqual({ kind: "approved", reviewers: ["ana", "cy"] });
  });

  it("ignores comments, pending reviews and requests for review", () => {
    expect(
      deriveReview(
        [
          review("review-bot", "COMMENT", at(10)),
          review("ana", "PENDING", at(10)),
          review("bo", "REQUEST_REVIEW", at(10)),
        ],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  it("ignores a dismissed review", () => {
    expect(
      deriveReview([review("ana", "REQUEST_CHANGES", at(10), { dismissed: true })], []),
    ).toEqual({ kind: "none" });
  });

  it("ignores a team's REQUEST_REVIEW row, which has no user", () => {
    expect(
      deriveReview(
        [{ user: null, team: { name: "dotnetapprovers" }, state: "REQUEST_REVIEW", dismissed: false, submitted_at: at(10) }],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  it("waits on a requested team that has not decided", () => {
    expect(deriveReview([], ["dotnetapprovers"])).toEqual({
      kind: "awaiting",
      reviewers: ["dotnetapprovers"],
    });
  });

  it("stops waiting once a requested reviewer approves", () => {
    expect(deriveReview([review("ana", "APPROVED", at(10))], ["ana"])).toEqual({
      kind: "approved",
      reviewers: ["ana"],
    });
  });

  it("does not wait on a requested bot that only comments", () => {
    expect(
      deriveReview(
        [review("lore-bot", "COMMENT", at(10))],
        ["lore-bot", "taronish"],
      ),
    ).toEqual({ kind: "awaiting", reviewers: ["taronish"] });
    expect(deriveReview([review("lore-bot", "COMMENT", at(10))], ["lore-bot"])).toEqual({ kind: "none" });
  });

  it("does not wait on a reviewer whose review was dismissed", () => {
    expect(
      deriveReview([review("ana", "REQUEST_CHANGES", at(10), { dismissed: true })], ["ana"]),
    ).toEqual({ kind: "none" });
  });

  it("keeps waiting on a requested reviewer whose only row is a pending draft or a request", () => {
    expect(
      deriveReview(
        [review("ana", "PENDING", at(10)), review("bo", "REQUEST_REVIEW", at(10))],
        ["ana", "bo"],
      ),
    ).toEqual({ kind: "awaiting", reviewers: ["ana", "bo"] });
  });

  it("says none when nobody reviewed and nobody was asked", () => {
    expect(deriveReview([], [])).toEqual({ kind: "none" });
  });
});

describe("pull request state", () => {
  const pull = (extra: Record<string, unknown>) => ({
    title: "Fix it",
    html_url: `${base}/acme/widgets/pulls/4`,
    state: "open",
    merged: false,
    head: { sha: "abc" },
    ...extra,
  });

  it.each([
    [{}, "open"],
    [{ state: "closed", merged: true }, "merged"],
    [{ state: "closed" }, "closed"],
  ])("reads %j as %s", (extra, state) => {
    expect(parsePull(pull(extra))).toMatchObject({ state, headSha: "abc", title: "Fix it" });
  });

  it("collects requested users and teams from the real response shape", () => {
    expect(
      parsePull(
        pull({
          requested_reviewers: [{ login: "ana" }],
          requested_reviewers_teams: [{ name: "dotnetapprovers" }],
        }),
      ).requested,
    ).toEqual(["ana", "dotnetapprovers"]);
    expect(
      parsePull(pull({ requested_reviewers: [], requested_reviewers_teams: [{ name: "dotnetapprovers" }] })).requested,
    ).toEqual(["dotnetapprovers"]);
    expect(parsePull(pull({})).requested).toEqual([]);
  });
});

describe("item status schema", () => {
  const pr = { kind: "pr", repo: "acme/widgets", number: 4, title: "Fix it", url: `${base}/acme/widgets/pulls/4` } as const;

  it("accepts an open pull request with its CI and review", () => {
    expect(
      itemStatusSchema.safeParse({
        ...pr,
        lifecycle: { state: "open", draft: false, ci: { kind: "passing", total: 1 }, review: { kind: "none" } },
      }).success,
    ).toBe(true);
  });

  it("gives a merged pull request no CI to go stale", () => {
    const parsed = itemStatusSchema.parse({
      ...pr,
      lifecycle: { state: "merged", ci: { kind: "failing", total: 1, failed: [{ name: "a", url: "" }] } },
    });
    expect(parsed).toEqual({ ...pr, lifecycle: { state: "merged" } });
  });

  it("rejects a failing CI that names no failed check", () => {
    expect(
      itemStatusSchema.safeParse({
        ...pr,
        lifecycle: { state: "open", draft: false, ci: { kind: "failing", total: 1, failed: [] }, review: { kind: "none" } },
      }).success,
    ).toBe(false);
  });
});
