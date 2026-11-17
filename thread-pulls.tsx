import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useAppPanel,
  experimental_useRpcKeyedQuery,
  experimental_useThreadContextKind,
  type ExperimentalPanelController,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
  type PluginThreadAction,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import type { ThreadItemsSummary, ThreadPull, ThreadPulls } from "./thread-items/contract.js";
import { threadPullsReadContract } from "./thread-items/read-contract.js";
import { chipFor, ciChips, lifecycleChips, StatusChip, toneClasses, type ChipSpec } from "./thread-items-panel.js";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Each thread's pull requests by thread id, as far as they have loaded. */
export type ThreadPullsById = Record<string, ThreadPulls> | undefined;

/** The thread's Gitea table; its id predates the tab API, so tabs opened before keep working. */
export const giteaTab = { id: "item", context: { kind: "thread" }, availability: "action" } as const;

export const openGiteaTab = (panel: ExperimentalPanelController) => panel.openTab({ tab: giteaTab });

/**
 * One keyed read for many threads. Watching `threadPulls` keeps the threads'
 * pull requests fresh, so thread panes read it; `threadPullBadges` reads only
 * what is stored, for lists of many threads.
 */
function usePullsOf(method: "threadPulls" | "threadPullBadges", threadIds: readonly string[]): ThreadPullsById {
  return experimental_useRpcKeyedQuery({
    contract: threadPullsReadContract,
    method,
    keys: threadIds,
    enabled: threadIds.length > 0,
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
function standing(summary: ThreadItemsSummary): Pick<ChipSpec, "icon" | "tone"> & { note: string | null } {
  if (summary.ciFailing > 0) return { icon: "X", tone: "red", note: `${summary.ciFailing} failing` };
  if (summary.ciRunning > 0) return { icon: "Clock", tone: "amber", note: "CI running" };
  if (summary.merged === summary.total)
    return { icon: "GitMerge", tone: "purple", note: summary.total === 1 ? "merged" : "all merged" };
  return { icon: "GitPullRequest", tone: "green", note: summary.merged > 0 ? `${summary.merged} merged` : null };
}

export const usePullCounts = ({ threadIds }: PluginThreadActionDataInput) => usePullsOf("threadPulls", threadIds);

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

/** How many pull requests the context row and card show before collapsing the rest to "+N". */
const shownPulls = 3;

const checkingChip: ChipSpec = { label: "Checking", tone: "muted", icon: "Clock", title: "Not read from Gitea yet" };

/** A pull request's state as one chip: its CI while open, otherwise merged or closed. */
function pullChip(pull: ThreadPull): ChipSpec {
  if (!pull.state)
    return pull.error === null
      ? checkingChip
      : { label: "Couldn't load", tone: "muted", icon: "AlertTriangle", title: pull.error };
  const { lifecycle } = pull.state;
  return lifecycle.state === "open" ? chipFor(ciChips, lifecycle.ci) : lifecycleChips[lifecycle.state];
}

function describePull(pull: ThreadPull): string {
  const title = pull.state ? ` · ${pull.state.title}` : "";
  return `${pull.repo}#${pull.number}${title} · ${pullChip(pull).label}`;
}

/** Pull requests that can still change first, then merged and closed ones; newest linked first within each. */
function byAttention(pulls: readonly ThreadPull[]): ThreadPull[] {
  const settled = (pull: ThreadPull) => pull.state !== null && pull.state.lifecycle.state !== "open";
  return [...pulls.filter((pull) => !settled(pull)), ...pulls.filter(settled)];
}

function useOwnPulls(threadId: string | null): ThreadPull[] {
  const rows = usePullsOf("threadPulls", threadId === null ? [] : [threadId]);
  return (threadId === null ? undefined : rows?.[threadId]?.pulls) ?? [];
}

/** The context row repeats the card, so it shows only while the pane draws the banner. */
export function usePullsSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const banner = experimental_useThreadContextKind() === "banner";
  return useOwnPulls(banner ? threadId : null).length > 0;
}

/** The thread's pull requests in the context row above the composer, each as `#n` in its CI chip's colours. */
export function PullsSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const pulls = byAttention(useOwnPulls(threadId));
  const panel = experimental_useAppPanel();
  const more = pulls.length - shownPulls;
  const open = () => void openGiteaTab(panel);
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs">
      {pulls.slice(0, shownPulls).map((pull) => {
        const chip = pullChip(pull);
        const description = describePull(pull);
        return (
          <button
            key={`${pull.repo}#${pull.number}`}
            type="button"
            title={description}
            aria-label={description}
            onClick={open}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-medium tabular-nums hover:opacity-80",
              toneClasses[chip.tone],
            )}
          >
            <Icon name={chip.icon} className="size-3" />#{pull.number}
          </button>
        );
      })}
      {more > 0 && (
        <button
          type="button"
          title={`${more} more Gitea pull ${more === 1 ? "request" : "requests"}`}
          onClick={open}
          className="shrink-0 rounded-full px-1 py-0.5 text-muted-foreground hover:text-foreground"
        >
          +{more}
        </button>
      )}
    </span>
  );
}

/** The thread's pull requests on the thread context card, one row each with its title and the table's chip. */
export function PullsCardRows({ threadId }: ExperimentalThreadContextCardProps) {
  const pulls = byAttention(useOwnPulls(threadId));
  const panel = experimental_useAppPanel();
  const more = pulls.length - shownPulls;
  const open = () => void openGiteaTab(panel);
  return (
    <>
      {pulls.slice(0, shownPulls).map((pull) => (
        <ThreadContextCardRow
          key={`${pull.repo}#${pull.number}`}
          icon="gitea/teacup"
          label={`#${pull.number} ${pull.state?.title ?? pull.repo}`}
          trailing={<StatusChip spec={{ ...pullChip(pull), href: undefined }} />}
          title={describePull(pull)}
          onClick={open}
        />
      ))}
      {more > 0 && (
        <ThreadContextCardRow
          icon="GitPullRequest"
          label={`+${more} more pull ${more === 1 ? "request" : "requests"}`}
          onClick={open}
        />
      )}
    </>
  );
}

export const useRowPulls = ({ threads }: ExperimentalThreadRowMetadataDataInput) =>
  usePullsOf("threadPullBadges", threads.map((thread) => thread.id));

/** The sidebar row's badge: how many pull requests the thread has, in the colour of how they stand. */
export function PullsRowBadge({ thread, data }: ExperimentalThreadRowMetadataProps<ThreadPullsById>) {
  const pulls = data?.[thread.id];
  if (!pulls || pulls.summary.total === 0) return null;
  const { icon, tone } = standing(pulls.summary);
  const summary = breakdown(pulls.summary);
  return (
    <span
      role="img"
      aria-label={summary}
      title={[summary, ...byAttention(pulls.pulls).map(describePull)].join("\n")}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full px-1 text-xs leading-3.5 tabular-nums", toneClasses[tone])}
    >
      <Icon name={icon} className="size-3" />
      {pulls.summary.total}
    </span>
  );
}
