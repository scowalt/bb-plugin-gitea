// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const scrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const freshness = { state: "fresh" as const, fetchedAt: "2026-11-16T12:00:00Z" };
type Ref = { repo: string; number: number; kind: "issue" | "pr" };

function conversation({ repo, number, kind }: Ref) {
  const item = {
    repo, number, kind, title: `${repo}#${number} title`, state: "open" as const, author: "dev",
    labels: [], assignees: [], body: `Body of ${repo}#${number}`, updatedAt: freshness.fetchedAt,
    url: `https://gitea.example/${repo}/${kind === "pr" ? "pulls" : "issues"}/${number}`,
    comments: [], commentsTruncated: false,
  };
  return {
    freshness, threadId: "thr_existing",
    conversation: kind === "issue"
      ? { ...item, relations: { state: "loaded", blockers: [], blocking: [], truncated: false } }
      : {
        ...item, headRefName: "topic", baseRefName: "main",
        revision: { head: "a".repeat(40), base: "b".repeat(40) }, changedFiles: 0, draft: false,
        checks: { state: "loaded", values: [], truncated: false },
        reviews: [], reviewsTruncated: false, reviewComments: [],
      },
  };
}

function mount(items: () => Ref[]) {
  return renderSlot(app.threadPanelActions[0]!, { threadId: "thr_existing", params: null }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      threadItems: () => ({ items: items() }),
      conversation: (input: unknown) => conversation(input as Ref),
    },
  });
}

const camp: Ref = { repo: "acme/camp", number: 4066, kind: "pr" };
const ops: Ref = { repo: "acme/ops", number: 1143, kind: "pr" };
const issue: Ref = { repo: "acme/ops", number: 7, kind: "issue" };

it("shows one linked item without a switcher", async () => {
  mount(() => [camp]);
  expect(await screen.findByText("acme/camp#4066 title")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Linked Gitea item" })).toBeNull();
});

it("switches between every item linked to the thread", async () => {
  const slot = mount(() => [camp, ops, issue]);
  expect(await screen.findByText("Body of acme/camp#4066")).toBeTruthy();
  const switcher = screen.getByRole("combobox", { name: "Linked Gitea item" });
  expect(switcher.textContent).toContain("acme/camp#4066 · pr");
  fireEvent.click(switcher);
  expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
    "acme/camp#4066 · pr", "acme/ops#1143 · pr", "acme/ops#7 · issue",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "acme/ops#7 · issue" }));
  expect(await screen.findByText("Body of acme/ops#7")).toBeTruthy();
  expect(slot.rpcCalls.filter((call) => call.method === "conversation").at(-1)?.input).toMatchObject(issue);
});

it("picks up a link added while the panel is open", async () => {
  let items = [camp];
  const slot = mount(() => items);
  expect(await screen.findByText("acme/camp#4066 title")).toBeTruthy();
  const conversations = () => slot.rpcCalls.filter((call) => call.method === "conversation").length;
  const before = conversations();
  await slot.emitRealtime("links-changed", { key: "link:other" });
  expect(conversations()).toBe(before);
  items = [camp, ops];
  await slot.emitRealtime("links-changed", { key: "link:ops" });
  expect(await screen.findByRole("combobox", { name: "Linked Gitea item" })).toBeTruthy();
  expect(screen.getByText("acme/camp#4066 title")).toBeTruthy();
});

it("says when the thread has no linked item", async () => {
  mount(() => []);
  expect(await screen.findByText("This BB thread is not linked to a Gitea issue or pull request.")).toBeTruthy();
});
