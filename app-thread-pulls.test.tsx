// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  experimental_useAppPanel,
  useBbNavigate,
  useSdk,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { CiStatus } from "./item-status.js";
import type { PullSnapshot, ThreadPull, ThreadPulls } from "./thread-items/contract.js";
import { summarize } from "./thread-items/pull-state.js";
import { threadPullsReadContract } from "./thread-items/read-contract.js";

afterEach(cleanup);
const app = await loadPluginApp(() => import("./app"));
const server = "https://gitea.example/";
const createdAt = "2026-11-16T12:00:00Z";

type Lifecycle = PullSnapshot["lifecycle"];
const open = (ci: CiStatus, draft = false): Lifecycle => ({
  state: "open", draft, headSha: "a".repeat(40), ci, review: { kind: "none" },
});
const passing = open({ kind: "passing", total: 4 });
const failing = open({ kind: "failing", total: 2, failed: [{ name: "lint", url: `${server}acme/ops/actions/runs/1/jobs/2` }] });
const running = open({ kind: "running", total: 3, pending: 1, url: `${server}acme/ops/actions/runs/2` });
const merged: Lifecycle = { state: "merged", mergedAt: createdAt };
const closed: Lifecycle = { state: "closed", closedAt: createdAt };

function pull(number: number, lifecycle: Lifecycle | null, { repo = "acme/ops", error = null as string | null } = {}): ThreadPull {
  const url = `${server}${repo}/pulls/${number}`;
  return {
    repo,
    number,
    url,
    state: lifecycle && { kind: "pr", title: `Change ${number}`, url, createdAt, lifecycle },
    error,
    stale: false,
    via: { type: "own", source: "opened" },
    links: [{ threadId: "thr_a", threadTitle: null, source: "opened", linkedAt: number, own: true }],
  };
}

const row = (...pulls: ThreadPull[]): ThreadPulls => ({ pulls, summary: summarize(pulls) });

type Rows = Record<string, ThreadPulls>;

/** Serves the keyed read from `rows` and counts its requests. */
function keyed(rows: Rows) {
  const requests: string[][] = [];
  const options: RenderSlotOptions<typeof threadPullsReadContract> = {
    experimental_rpcContract: threadPullsReadContract,
    rpc: {
      threadPulls: ({ keys }) => {
        requests.push([...keys]);
        return Object.fromEntries(keys.map((key) => [key, rows[key] ?? row()]));
      },
    },
    experimental_panel: { openTab: () => true },
  };
  return { requests, options };
}

function target(id: string): PluginThreadActionTarget {
  return {
    id,
    projectId: "proj_a",
    parentThreadId: null,
    parentNotifications: "auto",
    archivedAt: null,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: null,
  };
}

const giteaTabOpen = {
  method: "openTab",
  options: { tab: { id: "item", context: { kind: "thread" }, availability: "action" } },
};

const pullCount = app.threadActions.find((action) => action.id === "pulls")!;

/** Draws the header action the way bb's header does at normal width: one useData for every header on screen, one button per thread showing only its label. */
function Header({ threadIds }: { threadIds: string[] }) {
  const data = pullCount.useData?.({ threadIds });
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  return (
    <>
      {threadIds.map((id) => {
        const action = pullCount.item({ thread: target(id), data, sdk, navigate, experimental_panel: panel });
        return action ? (
          <button key={id} type="button" onClick={() => void action.run({ requestRename: () => {} })}>
            {action.label}
          </button>
        ) : null;
      })}
    </>
  );
}

it("registers the pull request count as a header action that leads the Git plugin's Commit button", () => {
  expect(pullCount).toMatchObject({ placement: "header", title: "Gitea pull requests" });
  expect(pullCount.group < "git").toBe(true);
});

it("counts each header's pull requests from one keyed read, says in the label how their CI stands, and opens the Gitea tab", async () => {
  const rows: Rows = {
    thr_ok: row(pull(1, merged), pull(2, merged), pull(3, passing)),
    thr_failing: row(pull(1, merged), pull(2, failing), pull(3, running), pull(4, failing)),
    thr_running: row(pull(1, running), pull(2, passing)),
    thr_merged: row(pull(1, merged), pull(2, merged)),
    thr_one: row(pull(1, merged)),
    thr_open: row(pull(1, passing)),
  };
  const { requests, options } = keyed(rows);
  const slot = renderSlot({ component: Header }, { threadIds: [...Object.keys(rows), "thr_none"] }, options);
  await screen.findByText("3 PRs · 2 merged");
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "3 PRs · 2 merged",
    "4 PRs · 2 failing",
    "2 PRs · CI running",
    "2 PRs · all merged",
    "1 PR · merged",
    "1 PR",
  ]);
  expect(requests.map((keys) => keys.sort())).toEqual([[...Object.keys(rows), "thr_none"].sort()]);
  fireEvent.click(screen.getByText("1 PR"));
  expect(slot.inspection.experimental_panelCalls).toEqual([giteaTabOpen]);
});

it("updates the count when the server marks the keyed read stale", async () => {
  const rows: Rows = { thr_a: row(pull(1, running)) };
  const { options } = keyed(rows);
  const slot = renderSlot({ component: Header }, { threadIds: ["thr_a"] }, options);
  await screen.findByText("1 PR · CI running");
  rows.thr_a = row(pull(1, failing), pull(2, closed));
  await act(() => slot.behavior.experimental_invalidateRpc(["thread-pulls"]));
  expect(await screen.findByText("2 PRs · 1 failing")).toBeTruthy();
});

const segment = app.threadContextSegments.find((registration) => registration.id === "pulls")!;

/** Draws the segment the way bb's context row does: asks useVisible, then mounts the summary. */
function ContextRow({ threadId }: { threadId: string }) {
  const input = { threadId, projectId: "proj_a", environment: null };
  const visible = segment.useVisible?.(input) ?? true;
  const Summary = segment.summary;
  return (
    <div data-testid="context-row" data-visible={visible}>
      {visible && (
        <Summary {...input} segments={[{ key: "gitea/pulls", pluginId: "gitea" }]} isExpanded={false} onToggle={() => {}} />
      )}
    </div>
  );
}

const five = row(
  pull(5, merged),
  pull(4, failing),
  pull(3, closed),
  pull(2, null),
  pull(1, passing, { repo: "acme/camp" }),
);

it("lists the thread's pull requests above the composer, open ones first, as #n in their CI colours, and collapses past three", async () => {
  const { options } = keyed({ thr_a: five });
  renderSlot({ component: ContextRow }, { threadId: "thr_a" }, options);
  const failingChip = await screen.findByRole("button", { name: "acme/ops#4 · Change 4 · 1 failing" });
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["#4", "#2", "#1", "+2"]);
  expect(failingChip.className).toContain("bg-red-500/15");
  expect(screen.getByRole("button", { name: "acme/ops#2 · Checking" }).className).toContain("bg-muted");
  expect(screen.getByRole("button", { name: "acme/camp#1 · Change 1 · Passing" }).className).toContain("bg-green-500/15");
  expect(screen.getByText("+2").title).toBe("2 more Gitea pull requests");
});

it("shows merged and closed pull requests in their own colours", async () => {
  const { options } = keyed({ thr_a: row(pull(2, merged), pull(1, closed)) });
  renderSlot({ component: ContextRow }, { threadId: "thr_a" }, options);
  expect((await screen.findByRole("button", { name: "acme/ops#2 · Change 2 · Merged" })).className).toContain("bg-purple-500/15");
  expect(screen.getByRole("button", { name: "acme/ops#1 · Change 1 · Closed" }).className).toContain("bg-muted");
});

it("opens the Gitea tab from a pull request or the +N in the context row", async () => {
  const { options } = keyed({ thr_a: five });
  const slot = renderSlot({ component: ContextRow }, { threadId: "thr_a" }, options);
  fireEvent.click(await screen.findByText("#4"));
  fireEvent.click(screen.getByText("+2"));
  expect(slot.inspection.experimental_panelCalls).toEqual([giteaTabOpen, giteaTabOpen]);
});

it("hides the context row segment while the thread has no pull request", async () => {
  const { requests, options } = keyed({ thr_a: row() });
  renderSlot({ component: ContextRow }, { threadId: "thr_a" }, options);
  await act(async () => {});
  expect(requests).toEqual([["thr_a"]]);
  expect(screen.getByTestId("context-row").dataset.visible).toBe("false");
});

it("leaves the context row to the card while the pane shows the thread context card", async () => {
  const { requests, options } = keyed({ thr_a: five });
  renderSlot({ component: ContextRow }, { threadId: "thr_a" }, { ...options, threadContextKind: "card" });
  await act(async () => {});
  expect(screen.getByTestId("context-row").dataset.visible).toBe("false");
  expect(requests).toEqual([]);
});
