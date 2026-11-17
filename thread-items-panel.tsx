import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  UrlLink,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import type { giteaRpcContract } from "./server.js";
import type { CiStatus, ReviewStatus } from "./item-status.js";
import type {
  LinkSource,
  ThreadIssue,
  ThreadItemsView,
  ThreadPull,
} from "./thread-items/contract.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const refetchEveryMs = 30_000;

/** One fetch of a thread's pull requests, refreshed on change signals, reconnects, and every 30 seconds. */
export function useThreadItems(threadId: string) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<{ threadId: string; view: ThreadItemsView | null; error: string | null }>({
    threadId,
    view: null,
    error: null,
  });
  const latest = useRef(0);
  const refetch = useCallback(async (refresh = false) => {
    const request = ++latest.current;
    try {
      const view = await rpc.call("threadItems", { threadId, refresh });
      if (request === latest.current && view.threadId === threadId)
        setState({ threadId, view, error: null });
    } catch (error) {
      if (request === latest.current)
        setState((current) => ({
          threadId,
          view: current.threadId === threadId ? current.view : null,
          error: error instanceof Error ? error.message : "Could not load this thread's pull requests.",
        }));
    }
  }, [rpc, threadId]);
  useEffect(() => {
    void refetch();
    const timer = setInterval(() => void refetch(), refetchEveryMs);
    return () => {
      clearInterval(timer);
      latest.current += 1;
    };
  }, [refetch, connection]);
  const onChange = useCallback(() => void refetch(), [refetch]);
  useRealtime("thread-items-changed", onChange);
  const current = state.threadId === threadId ? state : { view: null, error: null };
  return { view: current.view, error: current.error, refetch };
}

type Tone = "green" | "red" | "amber" | "purple" | "muted";
type ChipSpec = {
  label: string;
  tone: Tone;
  icon: string;
  title: string;
  href?: string;
};
type ChipTable<U extends { kind: string }> = {
  [K in U["kind"]]: (status: Extract<U, { kind: K }>) => ChipSpec;
};

const toneClasses: Record<Tone, string> = {
  green: "bg-green-500/15 text-green-700 dark:text-green-400",
  red: "bg-red-500/15 text-red-600 dark:text-red-400",
  amber: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  muted: "bg-muted text-muted-foreground",
};

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const reviewChips: ChipTable<ReviewStatus> = {
  "changes-requested": ({ reviewers }) => ({
    label: "Changes requested",
    tone: "red",
    icon: "X",
    title: `Changes requested by ${reviewers.join(", ")}`,
  }),
  approved: ({ reviewers }) => ({
    label: "Approved",
    tone: "green",
    icon: "Check",
    title: `Approved by ${reviewers.join(", ")}`,
  }),
  awaiting: ({ reviewers }) => ({
    label: "Awaiting",
    tone: "amber",
    icon: "Clock",
    title: `Review requested from ${reviewers.join(", ")}`,
  }),
  none: () => ({ label: "No review", tone: "muted", icon: "Minus", title: "No review" }),
};

const ciChips: ChipTable<CiStatus> = {
  passing: ({ total }) => ({
    label: "Passing",
    tone: "green",
    icon: "Check",
    title: `${plural(total, "check")} passed`,
  }),
  failing: ({ failed }) => ({
    label: `${failed.length} failing`,
    tone: "red",
    icon: "X",
    title: failed.map((check) => check.name).join("\n"),
    href: failed[0]?.url,
  }),
  running: ({ total, pending, url }) => ({
    label: "Running",
    tone: "amber",
    icon: "Clock",
    title: `${pending} of ${plural(total, "check")} running`,
    href: url,
  }),
  none: () => ({ label: "No CI", tone: "muted", icon: "Minus", title: "No CI checks on the latest commit" }),
  unavailable: () => ({
    label: "Unknown",
    tone: "muted",
    icon: "Minus",
    title: "Couldn't read CI status",
  }),
};

// The tables are exhaustive over `kind` by their mapped type, so the entry always accepts its own status.
function chipFor<U extends { kind: string }>(table: ChipTable<U>, status: U): ChipSpec {
  const make = table[status.kind as U["kind"]] as (status: U) => ChipSpec;
  return make(status);
}

const lifecycleChips: Record<"merged" | "closed", ChipSpec> = {
  merged: { label: "Merged", tone: "purple", icon: "GitMerge", title: "Merged" },
  closed: { label: "Closed", tone: "muted", icon: "X", title: "Closed without merging" },
};

const issueChips: Record<"open" | "closed", ChipSpec> = {
  open: { label: "Issue · Open", tone: "muted", icon: "Circle", title: "Open issue" },
  closed: { label: "Issue · Closed", tone: "muted", icon: "Check", title: "Closed issue" },
};

function StatusChip({ spec }: { spec: ChipSpec }) {
  const chip = (
    <span
      title={spec.title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        toneClasses[spec.tone],
      )}
    >
      <Icon name={spec.icon} className="size-3" />
      {spec.label}
    </span>
  );
  return spec.href ? (
    <UrlLink href={spec.href} className="hover:opacity-80">
      {chip}
    </UrlLink>
  ) : (
    chip
  );
}

const sourceText: Record<LinkSource, string> = {
  opened: "opened in",
  pushed: "pushed to from",
  linked: "linked to",
  sent: "sent to an agent in",
  "auto-fixer": "watched by the auto-fixer in",
};

/** How the thread got the pull request, for the row's tooltip. */
function origin({ repo, via }: ThreadPull): string {
  return via.type === "own"
    ? `${repo} · ${sourceText[via.source]} this thread`
    : `${repo} · from child thread ${via.threadTitle ?? via.threadId}`;
}

function StatusRowFrame({
  repo,
  number,
  tooltip,
  link,
  title,
  child,
  draft = false,
  warning = null,
  dim = false,
  children,
}: {
  repo: string;
  number: number;
  tooltip: string;
  link: string;
  title: string | null;
  child: string | null;
  draft?: boolean;
  warning?: string | null;
  dim?: boolean;
  children: ReactNode;
}) {
  const name = `${repo.split("/")[1] ?? repo}#${number}`;
  return (
    <tr className={cn("border-b last:border-b-0", dim && "opacity-60")}>
      <td className="w-full max-w-0 py-2 pl-3 pr-2">
        <UrlLink href={link} className="block min-w-0 hover:underline">
          <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <span title={tooltip}>{name}</span>
            {draft && <span className="font-sans">Draft</span>}
            {warning !== null && (
              <span title={warning}>
                <Icon name="AlertTriangle" className="size-3" aria-label="Showing older data" />
              </span>
            )}
          </span>
          {title !== null && <span className="block truncate text-sm">{title}</span>}
        </UrlLink>
        {child !== null && (
          <span className="block truncate text-[11px] text-muted-foreground" title={`from child ${child}`}>
            from child {child}
          </span>
        )}
      </td>
      {children}
    </tr>
  );
}

function spanning(spec: ChipSpec) {
  return (
    <td colSpan={2} className="px-2 py-2 pr-3">
      <StatusChip spec={spec} />
    </td>
  );
}

type RowFrame = Omit<Parameters<typeof StatusRowFrame>[0], "children">;

/** The cells of a row not read yet, or never read successfully. */
function UnreadRow({ frame, error }: { frame: RowFrame; error: string | null }) {
  return (
    <StatusRowFrame {...frame}>
      {error === null ? (
        <>
          <td className="px-2 py-2" title="Checking"><Skeleton className="h-5 w-24" /></td>
          <td className="px-2 py-2 pr-3"><Skeleton className="h-5 w-20" /></td>
        </>
      ) : (
        <td colSpan={2} className="px-2 py-2 pr-3 text-xs text-muted-foreground" title={error}>
          Couldn't load
        </td>
      )}
    </StatusRowFrame>
  );
}

const staleWarning = ({ stale, error }: { stale: boolean; error: string | null }) =>
  stale ? (error ?? "The last refresh failed") : null;

function PullRow({ pull }: { pull: ThreadPull }) {
  const frame = {
    repo: pull.repo,
    number: pull.number,
    tooltip: origin(pull),
    link: pull.url,
    title: pull.state?.title ?? null,
    child: pull.via.type === "child" ? (pull.via.threadTitle ?? pull.via.threadId) : null,
  };
  const { state } = pull;
  if (!state) return <UnreadRow frame={frame} error={pull.error} />;
  const warning = staleWarning(pull);
  const { lifecycle } = state;
  if (lifecycle.state !== "open")
    return (
      <StatusRowFrame {...frame} warning={warning} dim>
        {spanning(lifecycleChips[lifecycle.state])}
      </StatusRowFrame>
    );
  return (
    <StatusRowFrame {...frame} warning={warning} draft={lifecycle.draft}>
      <td className="px-2 py-2"><StatusChip spec={chipFor(reviewChips, lifecycle.review)} /></td>
      <td className="px-2 py-2 pr-3"><StatusChip spec={chipFor(ciChips, lifecycle.ci)} /></td>
    </StatusRowFrame>
  );
}

function IssueRow({ issue }: { issue: ThreadIssue }) {
  const frame = {
    repo: issue.repo,
    number: issue.number,
    tooltip: `${issue.repo} · ${sourceText[issue.source]} this thread`,
    link: issue.url,
    title: issue.state?.title ?? null,
    child: null,
  };
  if (!issue.state) return <UnreadRow frame={frame} error={issue.error} />;
  return (
    <StatusRowFrame {...frame} warning={staleWarning(issue)}>
      {spanning(issueChips[issue.state.state])}
    </StatusRowFrame>
  );
}

/** The thread's pull requests, its own and its child threads', and its own issues, with review and CI status. */
export function GiteaThreadPanel({ threadId }: ExperimentalThreadActionTabProps) {
  const { view, error, refetch } = useThreadItems(threadId);
  if (!view)
    return <div className="p-4 text-sm text-muted-foreground">{error ?? "Loading Gitea items…"}</div>;
  const note = error ?? (view.scanning ? "Scanning thread history…" : null);
  const empty = view.pulls.length === 0 && view.issues.length === 0;
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex shrink-0 items-center justify-end gap-2 px-2 pt-2">
        {note !== null && <p className="min-w-0 flex-1 truncate pl-1 text-xs text-muted-foreground">{note}</p>}
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Refresh"
          onClick={() => void refetch(true)}
        >
          <Icon name="ArrowReloadHorizontal" className="size-3.5" />
        </Button>
      </div>
      {empty ? (
        <div className="space-y-1 p-4 text-sm text-muted-foreground">
          <p>This thread hasn't opened, pushed to, or been linked to a Gitea pull request.</p>
          <p>
            Link one with <code>bb gitea link pr &lt;owner/repo&gt; &lt;number&gt;</code>.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="py-1.5 pl-3 pr-2 font-medium">Pull request</th>
                <th className="px-2 py-1.5 font-medium">Review</th>
                <th className="px-2 py-1.5 pr-3 font-medium">CI</th>
              </tr>
            </thead>
            <tbody>
              {view.pulls.map((pull) => (
                <PullRow key={`pr:${pull.repo}#${pull.number}`} pull={pull} />
              ))}
              {view.issues.map((issue) => (
                <IssueRow key={`issue:${issue.repo}#${issue.number}`} issue={issue} />
              ))}
            </tbody>
          </table>
          {view.descendantsTruncated && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Some child threads could not be included.</p>
          )}
        </div>
      )}
    </div>
  );
}
