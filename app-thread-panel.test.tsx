// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CiStatus, ReviewStatus } from "./item-status.js";
import type { LinkSource, PullSnapshot, ThreadIssue, ThreadItemsView, ThreadPull } from "./thread-items/contract.js";
import { summarize } from "./thread-items/pull-state.js";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const scrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
afterAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
const app = await loadPluginApp(() => import("./app"));
const server = "https://gitea.example/";
const createdAt = "2026-11-16T12:00:00Z";

type Lifecycle = PullSnapshot["lifecycle"];
const open = (ci: CiStatus, review: ReviewStatus = { kind: "none" }, draft = false): Lifecycle => ({
  state: "open", draft, headSha: "a".repeat(40), ci, review,
});
const merged: Lifecycle = { state: "merged", mergedAt: createdAt };
const closed: Lifecycle = { state: "closed", closedAt: createdAt };
const passing: CiStatus = { kind: "passing", total: 4 };

function pull(
  repo: string,
  number: number,
  title: string,
  lifecycle: Lifecycle | null,
  {
    source = "opened",
    child = null,
    stale = false,
    error = null,
  }: { source?: LinkSource; child?: { id: string; title: string | null } | null; stale?: boolean; error?: string | null } = {},
): ThreadPull {
  const url = `${server}${repo}/pulls/${number}`;
  return {
    repo,
    number,
    url,
    state: lifecycle && { kind: "pr", title, url, createdAt, lifecycle },
    error,
    stale,
    via: child ? { type: "child", threadId: child.id, threadTitle: child.title } : { type: "own", source },
    links: [{ threadId: child?.id ?? "thr_existing", threadTitle: child?.title ?? null, source, linkedAt: number, own: !child }],
  };
}

const camp = pull("acme/camp", 4066, "Add the pager", open(
  { kind: "failing", total: 23, failed: [
    { name: "build / unit", url: "https://gitea.example/acme/camp/actions/runs/1/jobs/2" },
    { name: "lint", url: "https://gitea.example/acme/camp/actions/runs/1/jobs/3" },
  ] },
  { kind: "changes-requested", reviewers: ["ana", "bo"] },
));
const ops = pull("acme/ops", 1143, "WIP: Rework retries", open(
  { kind: "running", total: 8, pending: 3, url: "https://gitea.example/acme/ops/actions/runs/9/jobs/1" },
  { kind: "awaiting", reviewers: ["dotnetapprovers"] },
  true,
), { source: "pushed" });
const shipped = pull("acme/ops", 1100, "Old fix", merged, { source: "linked" });
function issueRow(number: number, title: string, state: "open" | "closed" | null, error: string | null = null): ThreadIssue {
  const url = `${server}acme/ops/issues/${number}`;
  return {
    repo: "acme/ops", number, url,
    state: state && { kind: "issue", title, url, state },
    error, stale: false, source: "sent", linkedAt: number,
  };
}
const issue = issueRow(7, "Retries never stop", "open");

function view(pulls: ThreadPull[], extra: Partial<ThreadItemsView> = {}, threadId = "thr_existing"): ThreadItemsView {
  return { threadId, server, scanning: false, descendantsTruncated: false, pulls, issues: [], summary: summarize(pulls), ...extra };
}

const tab = app.tabs.find((registration) => registration.id === "item");
if (tab?.context.kind !== "thread" || tab.availability !== "action") throw new Error("The Gitea tab is not a thread action tab");
const Panel = tab.component as ComponentType<ExperimentalThreadActionTabProps>;

function mount(threadItems: (input: { threadId: string; refresh: boolean }) => unknown) {
  return renderSlot({ component: Panel }, { threadId: "thr_existing", environment: null, params: null }, {
    rpc: { threadItems: (input: unknown) => threadItems(input as { threadId: string; refresh: boolean }) },
  });
}

const rowOf = (text: string) => screen.getByText(text).closest("tr")!;
const reads = (slot: ReturnType<typeof mount>) => slot.rpcCalls.filter((call) => call.method === "threadItems");

it("lists every pull request with its review and CI status", async () => {
  mount(() => view([camp, ops]));
  expect(await screen.findByText("Add the pager")).toBeTruthy();
  expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
    "Pull request", "Review", "CI",
  ]);
  const first = within(rowOf("Add the pager"));
  expect(first.getByText("camp#4066").getAttribute("title")).toBe("acme/camp · opened in this thread");
  expect(first.getByText("Changes requested").getAttribute("title")).toBe("Changes requested by ana, bo");
  expect(first.getByText("2 failing").getAttribute("title")).toBe("build / unit\nlint");
  const second = within(rowOf("WIP: Rework retries"));
  expect(second.getByText("ops#1143").getAttribute("title")).toBe("acme/ops · pushed to from this thread");
  expect(second.getByText("Draft")).toBeTruthy();
  expect(second.getByText("Awaiting").getAttribute("title")).toBe("Review requested from dotnetapprovers");
  expect(second.getByText("Running").getAttribute("title")).toBe("3 of 8 checks running");
});

it("links the pull request and its failing check", async () => {
  mount(() => view([camp]));
  await screen.findByText("Add the pager");
  const row = within(rowOf("Add the pager"));
  expect(row.getByRole("link", { name: /Add the pager/ }).getAttribute("href")).toBe(`${server}acme/camp/pulls/4066`);
  expect(row.getByRole("link", { name: /2 failing/ }).getAttribute("href")).toBe(
    "https://gitea.example/acme/camp/actions/runs/1/jobs/2",
  );
});

it("shows nothing but the table and reads nothing but the thread's cached items", async () => {
  const slot = mount(() => view([camp, ops, shipped], { issues: [issue] }));
  await screen.findByText("Add the pager");
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  expect(new Set(slot.rpcCalls.map((call) => call.method))).toEqual(new Set(["threadItems"]));
});

it("shows a merged or closed pull request with one dimmed chip and no CI or review", async () => {
  mount(() => view([shipped, pull("acme/ops", 1101, "Abandoned", closed)]));
  await screen.findByText("Old fix");
  for (const [title, chip] of [["Old fix", "Merged"], ["Abandoned", "Closed"]] as const) {
    const row = rowOf(title);
    expect(within(row).getByText(chip)).toBeTruthy();
    expect(within(row).queryByText(/Passing|failing|Running|No CI|Unknown/)).toBeNull();
    expect(within(row).queryByText(/Approved|Awaiting|No review|Changes requested/)).toBeNull();
    expect(row.className).toContain("opacity-60");
  }
});

it("shows pull requests from child threads with the child's title under their own", async () => {
  mount(() => view([
    camp,
    pull("acme/widgets", 12, "Fix the flaky test", open(passing, { kind: "approved", reviewers: ["ana"] }), {
      child: { id: "thr_child", title: "Fix CI" },
    }),
    pull("acme/widgets", 13, "Bump deps", open(passing), { child: { id: "thr_untitled", title: null } }),
  ]));
  await screen.findByText("Fix the flaky test");
  const row = within(rowOf("Fix the flaky test"));
  expect(row.getByText("from child Fix CI")).toBeTruthy();
  expect(row.getByText("widgets#12").getAttribute("title")).toBe("acme/widgets · from child thread Fix CI");
  expect(row.getByText("Approved")).toBeTruthy();
  expect(row.getByText("Passing")).toBeTruthy();
  expect(within(rowOf("Bump deps")).getByText("from child thr_untitled")).toBeTruthy();
  expect(within(rowOf("Add the pager")).queryByText(/from child/)).toBeNull();
});

it("shows the thread's issues after its pull requests, with their title and state", async () => {
  mount(() => view([camp], {
    issues: [issue, issueRow(8, "Old crash", "closed"), issueRow(9, "", null), issueRow(10, "", null, "Gitea API returned HTTP 404.")],
  }));
  await screen.findByText("Add the pager");
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getAllByText(/#\d+$/)[0]!.textContent)).toEqual([
    "camp#4066", "ops#7", "ops#8", "ops#9", "ops#10",
  ]);
  const first = within(rowOf("Retries never stop"));
  expect(first.getByText("Issue · Open")).toBeTruthy();
  expect(first.getByRole("link", { name: /Retries never stop/ }).getAttribute("href")).toBe(`${server}acme/ops/issues/7`);
  expect(within(rowOf("Old crash")).getByText("Issue · Closed")).toBeTruthy();
  expect(within(rowOf("ops#9")).getByTitle("Checking")).toBeTruthy();
  expect(within(rowOf("ops#10")).getByText("Couldn't load").getAttribute("title")).toBe("Gitea API returned HTTP 404.");
});

it("shows a pull request not read yet as loading, and one that can't be read without hiding the others", async () => {
  mount(() => view([
    camp,
    pull("acme/ops", 1143, "", null),
    pull("acme/ops", 1144, "", null, { error: "Gitea API returned HTTP 404." }),
  ]));
  await screen.findByText("Add the pager");
  expect(within(rowOf("ops#1143")).getByTitle("Checking")).toBeTruthy();
  const failed = within(rowOf("ops#1144")).getByText("Couldn't load");
  expect(failed.getAttribute("title")).toBe("Gitea API returned HTTP 404.");
  expect(screen.getByText("2 failing")).toBeTruthy();
});

it("warns when a row is shown from older data", async () => {
  mount(() => view([{ ...camp, stale: true, error: "Gitea is unreachable" }]));
  await screen.findByText("Add the pager");
  expect(within(rowOf("Add the pager")).getByTitle("Gitea is unreachable")).toBeTruthy();
});

it("picks up a pull request the thread opened while the panel is open", async () => {
  let pulls = [camp];
  const slot = mount(() => view(pulls));
  await screen.findByText("Add the pager");
  pulls = [camp, ops];
  await slot.emitRealtime("thread-items-changed", {});
  expect(await screen.findByText("WIP: Rework retries")).toBeTruthy();
  expect(screen.getByText("Add the pager")).toBeTruthy();
  expect(reads(slot).every((call) => (call.input as { refresh: boolean }).refresh === false)).toBe(true);
});

it("reloads after reconnecting", async () => {
  let pulls = [camp];
  const slot = mount(() => view(pulls));
  await screen.findByText("Add the pager");
  pulls = [camp, ops];
  await slot.setRealtimeConnectionState("reconnecting");
  await slot.setRealtimeConnectionState("connected");
  expect(await screen.findByText("WIP: Rework retries")).toBeTruthy();
});

it("says how to link when the thread has no pull request, and while its history is still read", async () => {
  mount(() => view([], { scanning: true }));
  expect(
    await screen.findByText("This thread hasn't opened, pushed to, or been linked to a Gitea pull request."),
  ).toBeTruthy();
  expect(screen.getByText("bb gitea link pr <owner/repo> <number>")).toBeTruthy();
  expect(screen.getByText("Scanning thread history…")).toBeTruthy();
});

it("says when some child threads were left out", async () => {
  mount(() => view([camp], { descendantsTruncated: true }));
  expect(await screen.findByText("Some child threads could not be included.")).toBeTruthy();
});

it("asks for the rows to be read again when Refresh is pressed", async () => {
  const slot = mount(() => view([camp, ops]));
  await screen.findByText("Add the pager");
  const before = reads(slot).length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(reads(slot)).toHaveLength(before + 1));
  expect(reads(slot).at(-1)?.input).toEqual({ threadId: "thr_existing", refresh: true });
});

it("rereads every 30 seconds while open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const slot = mount(() => view([camp]));
  await screen.findByText("Add the pager");
  const before = reads(slot).length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reads(slot)).toHaveLength(before + 1);
});

it("drops a late answer for the thread the panel showed before", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const slot = mount(async ({ threadId }) => {
    if (threadId === "thr_existing") {
      await held;
      return view([shipped]);
    }
    return view([camp], {}, "thr_other");
  });
  slot.lifecycle.rerender(<Panel threadId="thr_other" environment={null} params={null} />);
  await screen.findByText("Add the pager");
  await act(async () => release());
  expect(screen.queryByText("Old fix")).toBeNull();
  expect(screen.getByText("Add the pager")).toBeTruthy();
});
