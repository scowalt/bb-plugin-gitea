// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ItemStatus } from "./item-status.js";

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
const freshness = { state: "fresh" as const, fetchedAt: "2026-11-16T12:00:00Z" };
type Ref = { repo: string; number: number; kind: "issue" | "pr" };

const camp: Ref = { repo: "acme/camp", number: 4066, kind: "pr" };
const ops: Ref = { repo: "acme/ops", number: 1143, kind: "pr" };
const shipped: Ref = { repo: "acme/ops", number: 1100, kind: "pr" };
const issue: Ref = { repo: "acme/ops", number: 7, kind: "issue" };

const url = ({ repo, number, kind }: Ref) =>
  `https://gitea.example/${repo}/${kind === "pr" ? "pulls" : "issues"}/${number}`;
type Open = Extract<Extract<ItemStatus, { kind: "pr" }>["lifecycle"], { state: "open" }>;
const open = (
  ref: Ref,
  title: string,
  ci: Open["ci"],
  review: Open["review"],
  draft = false,
): ItemStatus => ({
  kind: "pr", repo: ref.repo, number: ref.number, title, url: url(ref),
  lifecycle: { state: "open", draft, ci, review },
});

const statuses: Record<string, ItemStatus> = {
  [`${camp.repo}#${camp.number}`]: open(
    camp, "Add the pager",
    { kind: "failing", total: 23, failed: [
      { name: "build / unit", url: "https://gitea.example/acme/camp/actions/runs/1/jobs/2" },
      { name: "lint", url: "https://gitea.example/acme/camp/actions/runs/1/jobs/3" },
    ] },
    { kind: "changes-requested", reviewers: ["ana", "bo"] },
  ),
  [`${ops.repo}#${ops.number}`]: open(
    ops, "WIP: Rework retries",
    { kind: "running", total: 8, pending: 3, url: "https://gitea.example/acme/ops/actions/runs/9/jobs/1" },
    { kind: "awaiting", reviewers: ["dotnetapprovers"] },
    true,
  ),
  [`${shipped.repo}#${shipped.number}`]: {
    kind: "pr", repo: shipped.repo, number: shipped.number, title: "Old fix", url: url(shipped),
    lifecycle: { state: "merged" },
  },
  [`${issue.repo}#${issue.number}`]: {
    kind: "issue", repo: issue.repo, number: issue.number, title: "Retries loop", url: url(issue), state: "open",
  },
};

function mount(
  items: () => Ref[],
  status: (ref: Ref) => unknown = (ref) => ({
    freshness, status: statuses[`${ref.repo}#${ref.number}`],
  }),
) {
  return renderSlot(app.threadPanelActions[0]!, { threadId: "thr_existing", params: null }, {
    rpc: {
      threadItems: () => ({ items: items() }),
      itemStatus: (input: unknown) => status(input as Ref),
    },
  });
}

const rowOf = (text: string) => screen.getByText(text).closest("tr")!;
const statusCalls = (slot: ReturnType<typeof mount>) =>
  slot.rpcCalls.filter((call) => call.method === "itemStatus");

it("lists every linked pull request with its review and CI status", async () => {
  mount(() => [camp, ops]);
  expect(await screen.findByText("Add the pager")).toBeTruthy();
  expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
    "Pull request", "Review", "CI",
  ]);
  const first = within(rowOf("Add the pager"));
  expect(first.getByText("camp#4066")).toBeTruthy();
  expect(first.getByText("Changes requested").getAttribute("title")).toBe("Changes requested by ana, bo");
  expect(first.getByText("2 failing").getAttribute("title")).toBe("build / unit\nlint");
  const second = within(rowOf("WIP: Rework retries"));
  expect(second.getByText("Draft")).toBeTruthy();
  expect(second.getByText("Awaiting").getAttribute("title")).toBe("Review requested from dotnetapprovers");
  expect(second.getByText("Running").getAttribute("title")).toBe("3 of 8 checks running");
});

it("links the pull request and its failing check", async () => {
  mount(() => [camp]);
  await screen.findByText("Add the pager");
  const row = within(rowOf("Add the pager"));
  expect(row.getByRole("link", { name: /Add the pager/ }).getAttribute("href")).toBe(url(camp));
  expect(row.getByRole("link", { name: /2 failing/ }).getAttribute("href")).toBe(
    "https://gitea.example/acme/camp/actions/runs/1/jobs/2",
  );
});

it("shows nothing but the table: no description, comments or conversation read", async () => {
  const slot = mount(
    () => [camp],
    (ref) => ({
      freshness,
      status: { ...statuses[`${ref.repo}#${ref.number}`], body: "Private description text", comments: ["secret"] },
    }),
  );
  await screen.findByText("Add the pager");
  expect(screen.queryByText("Private description text")).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(slot.rpcCalls.map((call) => call.method).filter((method) => method !== "threadItems")).toEqual(["itemStatus"]);
});

it("shows a merged pull request as Merged without CI or review chips, dimmed", async () => {
  mount(() => [shipped]);
  await screen.findByText("Old fix");
  const row = rowOf("Old fix");
  expect(within(row).getByText("Merged")).toBeTruthy();
  expect(within(row).queryByText(/Passing|failing|Running|No CI|Unknown/)).toBeNull();
  expect(within(row).queryByText(/Approved|Awaiting|No review|Changes requested/)).toBeNull();
  expect(row.className).toContain("opacity-60");
});

it("shows an issue's state", async () => {
  mount(() => [issue]);
  await screen.findByText("Retries loop");
  expect(within(rowOf("Retries loop")).getByText("Issue · open")).toBeTruthy();
});

it("picks up a link added while the panel is open", async () => {
  let items = [camp];
  const slot = mount(() => items);
  await screen.findByText("Add the pager");
  const before = statusCalls(slot).length;
  await slot.emitRealtime("links-changed", { key: "link:other" });
  expect(statusCalls(slot)).toHaveLength(before);
  items = [camp, ops];
  await slot.emitRealtime("links-changed", { key: "link:ops" });
  expect(await screen.findByText("WIP: Rework retries")).toBeTruthy();
  expect(screen.getByText("Add the pager")).toBeTruthy();
});

it("says how to link when the thread has no linked item", async () => {
  mount(() => []);
  expect(await screen.findByText("This BB thread is not linked to a Gitea issue or pull request.")).toBeTruthy();
  expect(screen.getByText("bb gitea link pr <owner/repo> <number>")).toBeTruthy();
});

it("keeps the other rows when one row's read fails", async () => {
  mount(
    () => [camp, ops],
    (ref) => {
      if (ref.repo === "acme/ops") throw new Error("Gitea API returned HTTP 500.");
      return { freshness, status: statuses[`${ref.repo}#${ref.number}`] };
    },
  );
  expect(await screen.findByText("Add the pager")).toBeTruthy();
  const failed = await screen.findByText("Couldn't load");
  expect(failed.getAttribute("title")).toContain("Gitea API returned HTTP 500.");
  expect(screen.getByText("ops#1143")).toBeTruthy();
  expect(screen.getByText("2 failing")).toBeTruthy();
});

it("warns when a row is shown from older data", async () => {
  mount(
    () => [camp],
    (ref) => ({
      freshness: { state: "stale-error", fetchedAt: freshness.fetchedAt, error: "Gitea is unreachable" },
      status: statuses[`${ref.repo}#${ref.number}`],
    }),
  );
  await screen.findByText("Add the pager");
  expect(within(rowOf("Add the pager")).getByTitle("Gitea is unreachable")).toBeTruthy();
});

it("rereads every row when Refresh is pressed", async () => {
  const slot = mount(() => [camp, ops]);
  await screen.findByText("Add the pager");
  expect(statusCalls(slot).every((call) => (call.input as { refresh: boolean }).refresh === false)).toBe(true);
  const before = statusCalls(slot).length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(statusCalls(slot)).toHaveLength(before + 2));
  const refreshed = statusCalls(slot).slice(before);
  expect(refreshed.map((call) => call.input)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ number: camp.number, refresh: true }),
      expect.objectContaining({ number: ops.number, refresh: true }),
    ]),
  );
});

it("rereads only the row whose item changed", async () => {
  const slot = mount(() => [camp, ops]);
  await screen.findByText("Add the pager");
  const before = statusCalls(slot).length;
  await slot.emitRealtime("display-changed", { item: "acme/ops#1143" });
  await vi.waitFor(() => expect(statusCalls(slot)).toHaveLength(before + 1));
  expect(statusCalls(slot).at(-1)?.input).toMatchObject({ number: ops.number });
  await slot.emitRealtime("display-changed", { item: "lists" });
  await slot.emitRealtime("display-changed", { item: null, files: true });
  await vi.waitFor(() => expect(statusCalls(slot)).toHaveLength(before + 3));
});

it("rereads every 30 seconds while open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const slot = mount(() => [camp]);
  await screen.findByText("Add the pager");
  const before = statusCalls(slot).length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(statusCalls(slot)).toHaveLength(before + 1);
});
