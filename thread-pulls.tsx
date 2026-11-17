import { useMemo } from "react";
import {
  experimental_useRpcKeyedQuery,
  type ExperimentalPanelController,
  type PluginThreadAction,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import type { ThreadItemsSummary, ThreadPulls } from "./thread-items/contract.js";
import { threadPullsReadContract } from "./thread-items/read-contract.js";

/** Each thread's pull requests by thread id, as far as they have loaded. */
export type ThreadPullsById = Record<string, ThreadPulls> | undefined;

/** The thread's Gitea table; its id predates the tab API, so tabs opened before keep working. */
export const giteaTab = { id: "item", context: { kind: "thread" }, availability: "action" } as const;

export const openGiteaTab = (panel: ExperimentalPanelController) => panel.openTab({ tab: giteaTab });

/** One keyed read for every thread a thread pane shows; watching it keeps those threads' pull requests fresh. */
export function useThreadPulls(threadIds: readonly string[]): ThreadPullsById {
  const keys = useMemo(() => [...new Set(threadIds)], [threadIds]);
  return experimental_useRpcKeyedQuery({
    contract: threadPullsReadContract,
    method: "threadPulls",
    keys,
    enabled: keys.length > 0,
  }).data;
}

/** bb's header button shows only its label, so the label also says how the pull requests stand. */
function countText(summary: ThreadItemsSummary): string {
  const prs = `${summary.total} ${summary.total === 1 ? "PR" : "PRs"}`;
  const { note } = standing(summary);
  return note ? `${prs} · ${note}` : prs;
}

function breakdown(summary: ThreadItemsSummary): string {
  const parts = [
    `${summary.open} open`,
    `${summary.merged} merged`,
    `${summary.closed} closed`,
    ...(summary.checking ? [`${summary.checking} checking`] : []),
    ...(summary.unreadable ? [`${summary.unreadable} unreadable`] : []),
    ...(summary.ciFailing ? [`${summary.ciFailing} with failing CI`] : []),
    ...(summary.ciRunning ? [`${summary.ciRunning} with CI running`] : []),
  ];
  return `Gitea pull requests: ${parts.join(", ")}`;
}

/** How the thread's pull requests stand, worst first: CI failing, CI running, all merged, or otherwise. */
function standing(summary: ThreadItemsSummary): { icon: string; note: string | null } {
  if (summary.ciFailing > 0) return { icon: "X", note: `${summary.ciFailing} failing` };
  if (summary.ciRunning > 0) return { icon: "Clock", note: "CI running" };
  if (summary.merged === summary.total)
    return { icon: "GitMerge", note: summary.total === 1 ? "merged" : "all merged" };
  return { icon: "GitPullRequest", note: summary.merged > 0 ? `${summary.merged} merged` : null };
}

export const usePullCounts = ({ threadIds }: PluginThreadActionDataInput) => useThreadPulls(threadIds);

/** The thread header's pull request count; hidden until the thread has one. */
export function pullCountAction({
  thread,
  data,
  experimental_panel,
}: PluginThreadActionItemInput<ThreadPullsById>): PluginThreadAction | null {
  const summary = data?.[thread.id]?.summary;
  if (!summary || summary.total === 0) return null;
  return {
    label: countText(summary),
    detail: breakdown(summary),
    icon: standing(summary).icon,
    run: () => void openGiteaTab(experimental_panel),
  };
}
