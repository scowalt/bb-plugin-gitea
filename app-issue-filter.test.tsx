// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());
const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const freshness = { state: "fresh", fetchedAt: "2026-10-10T12:00:00Z" };
const preferences = { autoFix: false, autoMerge: false, execution: { providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default" } };
const issues = [
  { number: 1, title: "Ready issue", blockerState: "unblocked" },
  { number: 2, title: "Blocked issue", blockerState: "blocked" },
  { number: 3, title: "Unknown dependency status", blockerState: "unknown" },
].map(item => ({ ...item, kind: "issue", state: "open", repo: "acme/widgets", author: "dev", assignees: ["dev"], labels: [], body: "", url: `https://gitea.example/acme/widgets/issues/${item.number}`, updatedAt: freshness.fetchedAt }));
type ListInput = { kind?: string; hideBlocked?: boolean; query?: string; refresh?: boolean; repo?: string; state?: string };

function page(input: ListInput, rows = issues, truncated = false) {
  const matches = input.kind === "pr" ? [] : rows.filter(item =>
    (!input.repo || item.repo === input.repo) &&
    (!input.query || item.title.toLowerCase().includes(input.query.toLowerCase())));
  const items = input.hideBlocked ? matches.filter(item => item.blockerState !== "blocked") : matches;
  return { items, blockedCount: matches.length - items.length, truncated, errors: [], account, freshness };
}
function mount(subPath = "issues", options: { rows?: typeof issues; truncated?: boolean; all?: (input: ListInput) => unknown } = {}) {
  return renderSlot(app.navPanels[0]!, { subPath }, {
    settings: { baseUrl: "https://gitea.example/", teaProfile: "work", extraRepos: "acme/widgets" },
    rpc: {
      status: () => ({ state: "connected", account, login: "dev", repos: [{ repo: "acme/widgets", projectId: null }] }),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => ({ ...page({}, []), login: "dev", preferences }),
      listMyIssues: (input: unknown) => ({ ...page(input as ListInput, options.rows, options.truncated), login: "dev" }),
      listItems: (input: unknown) => options.all ? options.all(input as ListInput) : page(input as ListInput, options.rows, options.truncated),
    },
  });
}
const toggle = () => screen.getByRole("switch", { name: "Hide blocked issues" });
const search = () => screen.getByPlaceholderText("Search title, body, repository");

it("puts the hide-blocked switch in the existing filter bar and labels unknown checks", async () => {
  const slot = mount();
  expect(await screen.findByText("Ready issue")).toBeTruthy();
  expect(screen.queryByText("Blocked issue")).toBeNull();
  expect(screen.getByText("Unknown dependency status")).toBeTruthy();
  expect(screen.getByText("Unverified")).toBeTruthy();
  expect(screen.getByText("1 blocked hidden")).toBeTruthy();
  expect((toggle() as HTMLInputElement).checked).toBe(true);
  const toolbar = toggle().closest("label")!.parentElement!;
  expect(within(toolbar).getAllByRole("combobox")).toHaveLength(2);
  expect(within(toolbar).getByPlaceholderText("Search title, body, repository")).toBeTruthy();
  expect(slot.rpcCalls.some(call => call.method === "conversation")).toBe(false);
  fireEvent.click(toggle());
  expect(await screen.findByText("Blocked issue")).toBeTruthy();
  expect(screen.queryByText("Unverified")).toBeNull();
  fireEvent.click(toggle());
  await waitFor(() => expect(screen.queryByText("Blocked issue")).toBeNull());
});

it("preserves the selected filter when searching and refreshing", async () => {
  const slot = mount();
  expect(await screen.findByText("Ready issue")).toBeTruthy();
  fireEvent.change(search(), { target: { value: "Ready" } });
  await waitFor(() => expect(slot.rpcCalls.filter(call => call.method === "listItems").at(-1)?.input).toMatchObject({ kind: "issue", hideBlocked: true, state: "open", query: "Ready" }));
  await waitFor(() => expect(screen.queryByText("Unknown dependency status")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(slot.rpcCalls.filter(call => call.method === "listItems").at(-1)?.input).toMatchObject({ hideBlocked: true, query: "Ready", refresh: true }));
  expect((toggle() as HTMLInputElement).checked).toBe(true);
  fireEvent.change(search(), { target: { value: "" } });
  expect(await screen.findByText("Unknown dependency status")).toBeTruthy();
});

it("filters My Issues without changing the unfiltered assigned-issue badge", async () => {
  const slot = mount("my-issues");
  expect(await screen.findByText("Ready issue")).toBeTruthy();
  expect(screen.queryByText("Blocked issue")).toBeNull();
  expect(screen.getByRole("tab", { name: "My Issues 3" })).toBeTruthy();
  const calls = slot.rpcCalls.filter(call => call.method === "listMyIssues");
  expect(calls.some(call => (call.input as ListInput).hideBlocked === true)).toBe(true);
  expect(calls.some(call => (call.input as ListInput).hideBlocked === false)).toBe(true);
});

it("explains an all-blocked empty list and keeps the item-cap warning visible", async () => {
  mount("issues", { rows: [issues[1]!], truncated: true });
  expect(await screen.findByText("All loaded matching issues are blocked. Turn off Hide blocked to see them.")).toBeTruthy();
  expect(screen.getByText("Results are capped at 200 items; narrow the repository or search.")).toBeTruthy();
  fireEvent.click(toggle());
  expect(await screen.findByText("Blocked issue")).toBeTruthy();
  fireEvent.click(toggle());
  expect(await screen.findByText("All loaded matching issues are blocked. Turn off Hide blocked to see them.")).toBeTruthy();
});

it("discards a late unfiltered response after the switch is turned back on", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  mount("issues", { all: async input => {
    if (!input.hideBlocked) await held;
    return page(input);
  } });
  expect(await screen.findByText("Ready issue")).toBeTruthy();
  fireEvent.click(toggle());
  fireEvent.click(toggle());
  await act(async () => release());
  expect(screen.getByText("Ready issue")).toBeTruthy();
  expect(screen.queryByText("Blocked issue")).toBeNull();
});

it("does not put an issue-blocker filter on pull request lists", async () => {
  const slot = mount("pulls");
  await waitFor(() => expect(slot.rpcCalls.some(call => call.method === "listItems")).toBe(true));
  expect(screen.queryByRole("switch", { name: "Hide blocked issues" })).toBeNull();
  expect(slot.rpcCalls.filter(call => call.method === "listItems").at(-1)?.input).toMatchObject({ kind: "pr", hideBlocked: false });
});
