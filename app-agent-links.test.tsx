// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const settings = { baseUrl: "https://gitea.example/", teaProfile: "work", extraRepos: "acme/widgets" };
const freshness = { state: "fresh" as const, fetchedAt: "2026-10-12T12:00:00Z" };
const preferences = {
  autoFix: false, autoMerge: false,
  execution: { providerId: "pi", model: "model", reasoningLevel: "xhigh", serviceTier: "default" },
} as const;

function item<Kind extends "issue" | "pr">(kind: Kind) {
  return {
    repo: "Acme/Widgets", number: 42, kind, title: `${kind} with an agent`,
    state: "open" as const, author: "dev", labels: [], assignees: [], body: "Requested work",
    url: `https://gitea.example/acme/widgets/${kind === "issue" ? "issues" : "pulls"}/42`,
    updatedAt: freshness.fetchedAt,
  };
}

function link(kind: "issue" | "pr", threadId: string) {
  return { repo: "acme/widgets", number: 42, kind, threadId, createdAt: freshness.fetchedAt };
}

function mount(subPath: string, overrides: Record<string, () => unknown> = {}, currentAccount = () => account) {
  const kind = subPath.startsWith("pulls/") ? "pr" : "issue";
  const list = (kind: "issue" | "pr") => ({
    account: currentAccount(), freshness, login: "dev", truncated: false, errors: [],
    items: [item(kind)],
  });
  return renderSlot(app.navPanels[0]!, { subPath }, {
    settings,
    rpc: {
      status: () => ({ state: "connected", login: "dev", account: currentAccount(), repos: [{ repo: "acme/widgets", projectId: "project-1" }] }),
      listItems: (input: unknown) => list(
        typeof input === "object" && input !== null && "kind" in input && input.kind === "pr" ? "pr" : "issue",
      ),
      listMyIssues: () => list("issue"),
      listMyPullRequests: () => ({ ...list("pr"), preferences, items: [{
        ...item("pr"), autoFixer: { status: "idle", actions: ["start"], automation: { fix: false, merge: false } },
      }] }),
      getAutoFixerPreferences: () => preferences,
      listLinks: () => ({ account: currentAccount(), links: {} }),
      repoOptions: () => ({ labels: [], assignees: [] }),
      conversation: () => ({
        freshness, threadId: null,
        conversation: kind === "issue" ? {
          ...item("issue"), comments: [], commentsTruncated: false,
          relations: { state: "loaded", blockers: [], blocking: [], truncated: false },
        } : {
          ...item("pr"), comments: [], commentsTruncated: false,
          headRefName: "topic", baseRefName: "main", revision: { head: "a".repeat(40), base: "b".repeat(40) },
          changedFiles: 0, draft: false, checks: { state: "loaded", values: [], truncated: false },
          reviews: [], reviewsTruncated: false, reviewComments: [],
        },
      }),
      ...overrides,
    },
  });
}

it.each(["issues", "my-issues", "pulls", "my-prs"])("shows clickable, numbered historical agent badges in %s", async (view) => {
  const kind = view === "pulls" || view === "my-prs" ? "pr" : "issue";
  const slot = mount(view, {
    listLinks: () => ({ account, links: { [`${kind}:acme/widgets#42`]: [link(kind, "thread-1"), link(kind, "thread-2")] } }),
  });
  const first = await screen.findByRole("button", { name: "Open BB thread thread-1" });
  expect(first.textContent).toBe("⚡ agent 1");
  expect(screen.getByRole("button", { name: "Open BB thread thread-2" }).textContent).toBe("⚡ agent 2");
  fireEvent.click(first);
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thread-1" }]);
  expect(slot.rpcCalls.filter(call => call.method === "listLinks")).toHaveLength(1);
});

it("starts one thread from a list row and opens it, without opening the item or root composer", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const slot = mount("issues", { sendAgent: async () => { await held; return { threadId: "sent-thread" }; } });
  const send = await screen.findByRole("button", { name: "Start" });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(slot.rpcCalls.filter(call => call.method === "sendAgent")).toEqual([
    { method: "sendAgent", input: { repo: "Acme/Widgets", number: 42, kind: "issue" } },
  ]);
  expect(send.hasAttribute("disabled")).toBe(true);
  expect(slot.navigateCalls).toEqual([]);
  await act(async () => release());
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "sent-thread" }]);
});

it.each(["issue", "pr"] as const)("sends directly from %s detail and shows the Agents sidebar", async (kind) => {
  const slot = mount(`${kind === "issue" ? "issues" : "pulls"}/acme/widgets/42`, {
    listLinks: () => ({ account, links: { [`${kind}:acme/widgets#42`]: [link(kind, "previous-thread")] } }),
    sendAgent: () => ({ threadId: "new-thread" }),
  });
  const agents = await screen.findByRole("region", { name: "Agents" });
  const previous = within(agents).getByRole("button", { name: "Open BB thread previous-thread" });
  expect(previous.textContent).toBe("⚡ agent");
  expect(screen.queryByText("Draft with agent")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: kind === "issue" ? "Send agent" : "Review with agent" })));
  expect(slot.rpcCalls.filter(call => call.method === "sendAgent")[0]?.input).toEqual({ repo: "Acme/Widgets", number: 42, kind });
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "new-thread" }]);
});

it("shows a failed-send error, stays on the item, and allows another attempt", async () => {
  const sendAgent = vi.fn().mockRejectedValueOnce(new Error("Provider unavailable")).mockResolvedValueOnce({ threadId: "retry-thread" });
  const slot = mount("issues/acme/widgets/42", { sendAgent });
  const send = await screen.findByRole("button", { name: "Send agent" });
  await act(async () => fireEvent.click(send));
  expect(toast.error).toHaveBeenCalledWith("Provider unavailable");
  expect(slot.navigateCalls).toEqual([]);
  expect(send.hasAttribute("disabled")).toBe(false);
  await act(async () => fireEvent.click(send));
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "retry-thread" }]);
});

it("refreshes badges when another client sends an agent", async () => {
  let links = [link("issue", "first-thread")];
  const slot = mount("issues", { listLinks: () => ({ account, links: { "issue:acme/widgets#42": links } }) });
  await screen.findByRole("button", { name: "Open BB thread first-thread" });
  links = [...links, link("issue", "second-thread")];
  await slot.emitRealtime("links-changed", {});
  await screen.findByRole("button", { name: "Open BB thread second-thread" });
  expect(screen.getByRole("button", { name: "Open BB thread first-thread" }).textContent).toBe("⚡ agent 1");
});

it("does not let a late initial fetch replace a newer badge refresh", async () => {
  let release!: (value: unknown) => void;
  const held = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const slot = mount("issues", {
    listLinks: () => ++reads === 1 ? held : { account, links: { "issue:acme/widgets#42": [link("issue", "newest-thread")] } },
  });
  await waitFor(() => expect(reads).toBe(1));
  await slot.emitRealtime("links-changed", {});
  await screen.findByRole("button", { name: "Open BB thread newest-thread" });
  await act(async () => release({ account, links: {} }));
  expect(screen.getByRole("button", { name: "Open BB thread newest-thread" })).toBeTruthy();
});

it("reconciles badges after reconnecting without receiving a links-changed event", async () => {
  let links = [link("issue", "first-thread")];
  const slot = mount("issues", { listLinks: () => ({ account, links: { "issue:acme/widgets#42": links } }) });
  await screen.findByRole("button", { name: "Open BB thread first-thread" });
  await slot.setRealtimeConnectionState("reconnecting");
  links = [...links, link("issue", "missed-thread")];
  await slot.setRealtimeConnectionState("connected");
  await screen.findByRole("button", { name: "Open BB thread missed-thread" });
});

it("does not restore another account's badges from a late RPC response", async () => {
  let current = account;
  let release!: (value: unknown) => void;
  const held = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const slot = mount("issues", { listLinks: () => ++reads === 1 ? held : { account: current, links: {} } }, () => current);
  await waitFor(() => expect(reads).toBe(1));
  current = '["https://gitea.example/","other","another-user"]';
  await slot.emitRealtime("display-changed", { item: null });
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  await act(async () => release({ account, links: { "issue:acme/widgets#42": [link("issue", "private-thread")] } }));
  expect(screen.queryByRole("button", { name: "Open BB thread private-thread" })).toBeNull();
});

it("preserves the linked-thread action for legacy sends without a history record", async () => {
  const slot = mount("issues/acme/widgets/42", {
    conversation: () => ({ freshness, threadId: "legacy-thread", conversation: {
      ...item("issue"), comments: [], commentsTruncated: false,
      relations: { state: "loaded", blockers: [], blocking: [], truncated: false },
    } }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open linked BB thread" }));
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "legacy-thread" }]);
});
