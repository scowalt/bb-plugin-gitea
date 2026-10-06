// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());
const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const execution = {
  providerId: "pi",
  model: "example-model",
  reasoningLevel: "xhigh",
  serviceTier: "default",
} as const;
const freshness = { state: "fresh", fetchedAt: "2026-09-30T12:00:00Z" };
const emptyList = { items: [], truncated: false, errors: [], account, freshness, login: "dev" };

it("does not save an equivalent auto-fixer model and saves a real change once", async () => {
  const slot = renderSlot(app.navPanels[0]!, { subPath: "auto-fixers" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, autoMerge: false, execution }),
      setAutoFixerExecution: (next: typeof execution) => ({ autoFix: false, autoMerge: false, execution: next }),
      listMyPullRequests: () => emptyList,
      listMyIssues: () => emptyList,
      listItems: () => emptyList,
    },
  });
  const apply = await screen.findByRole("button", { name: "Apply execution selection" });
  fireEvent.change(screen.getByLabelText("Service tier"), { target: { value: "" } });
  await act(async () => fireEvent.click(apply));
  const writes = () => slot.rpcCalls.filter(call => call.method === "setAutoFixerExecution");
  expect(writes()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "another-model" } });
  await act(async () => fireEvent.click(apply));
  expect(writes()).toHaveLength(1);
});

it("creates an issue once while the request is pending and locks the draft", async () => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "new" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [{ repo: "acme/widgets", projectId: null }] }),
      listMyPullRequests: () => emptyList,
      listMyIssues: () => emptyList,
      listItems: () => emptyList,
      createIssue: async () => { await held; return { repo: "acme/widgets", number: 1, kind: "issue" }; },
    },
  });
  const title = await screen.findByLabelText("Issue title");
  fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "acme/widgets" }));
  fireEvent.change(title, { target: { value: "One issue" } });
  const create = screen.getByRole("button", { name: /Create issue/i });
  fireEvent.click(create);
  fireEvent.click(create);
  expect(slot.rpcCalls.filter(call => call.method === "createIssue")).toHaveLength(1);
  expect(title.hasAttribute("disabled")).toBe(true);
  await act(async () => release());
  Element.prototype.scrollIntoView = scrollIntoView;
});

it("guards comment keyboard submission and locks the composer while posting", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "issues/acme/widgets/10" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, autoMerge: false, execution }),
      listMyPullRequests: () => emptyList,
      listMyIssues: () => emptyList,
      listItems: () => emptyList,
      conversation: () => ({
        freshness, threadId: null,
        conversation: {
          repo: "acme/widgets", number: 10, kind: "issue", title: "Issue detail",
          state: "open", author: "dev", labels: [], assignees: [], body: "See #12",
          url: "https://gitea.example/acme/widgets/issues/10", updatedAt: freshness.fetchedAt,
          comments: [], commentsTruncated: false,
          relations: { state: "loaded", blockers: [{ repo: "acme/widgets", number: 11, title: "Prerequisite", state: "open", url: "https://gitea.example/acme/widgets/issues/11" }], blocking: [], truncated: false },
        },
      }),
      comment: async () => { await held; return { ok: true }; },
    },
  });
  const composer = await screen.findByPlaceholderText("Write a comment");
  fireEvent.click(screen.getByRole("button", { name: /Prerequisite/ }));
  fireEvent.click(screen.getByRole("button", { name: "acme/widgets#12" }));
  expect(slot.navigateCalls.slice(-2)).toEqual([
    { method: "toPluginPanel", path: "gitea", options: { subPath: "issues/acme/widgets/11" } },
    { method: "toPluginPanel", path: "gitea", options: { subPath: "issues/acme/widgets/12" } },
  ]);
  fireEvent.change(composer, { target: { value: "A comment" } });
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
  expect(slot.rpcCalls.filter(call => call.method === "comment")).toHaveLength(1);
  expect((composer as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => release());
});
