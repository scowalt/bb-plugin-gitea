import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  Markdown,
  UrlLink,
  type ExperimentalProviderModelPickerValue,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcClient, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { giteaRpcContract } from "./server.js";
import { GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID } from "./branch-inputs.js";
import { issueReferences } from "./issue-references.js";
import { GiteaBranchInputsControl } from "./environment-picker.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
} from "@pierre/diffs";
import { FileDiff as PierreFileDiff, Virtualizer } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  changeTotals,
  changedFilesTree,
  fileCounts,
  fileLabel,
} from "./pull-files-view.js";

type Item = PluginRpcResult<
  (typeof giteaRpcContract)["listItems"]
>["items"][number];
type ConversationView = PluginRpcResult<
  (typeof giteaRpcContract)["conversation"]
>;
type FilesView = PluginRpcResult<(typeof giteaRpcContract)["pullFiles"]>;
type FileEntry = FilesView["files"][number];
type FileDiff = FileEntry["diff"];
type Freshness = ConversationView["freshness"];
type ItemRef = { kind: "issue" | "pr"; repo: string; number: number };
type Loadable<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string };
type Keyed<T> = { key: string; view: Loadable<T> };
type MyPulls = PluginRpcResult<(typeof giteaRpcContract)["listMyPullRequests"]>;
type Preferences = MyPulls["preferences"];
type AutoFixerView = MyPulls["items"][number]["autoFixer"];
type AutoFixerSessions = PluginRpcResult<
  (typeof giteaRpcContract)["listAutoFixerSessions"]
>["sessions"];
type ListView = "my-prs" | "my-issues" | "issues" | "pulls";
type View = ListView | "auto-fixers";
type Route =
  | { kind: "list"; view: View }
  | { kind: "new-issue"; from: "issues" | "my-issues" }
  | { kind: "item"; item: ItemRef };
type DetailSection = "conversation" | "files";
type Status = PluginRpcResult<(typeof giteaRpcContract)["status"]>;
type StateFilter = "open" | "closed" | "all";
type ListFilters = {
  view: ListView;
  state: StateFilter;
  repo: string;
  query: string;
};
type ItemList = {
  account: string;
  items: Item[];
  truncated: boolean;
  errors: Array<{ repo: string; message: string }>;
  freshness: Freshness;
};

type Scope = { state: "unverified" } | { state: "verified"; account: string };
type DisplayMemory = {
  epoch: number;
  scope: Scope;
  settings: string | null;
  knownSettings: string | null;
  status: Status | null;
  lists: ReadonlyMap<string, ItemList>;
};
type ScopeEvent =
  | { type: "revoke" }
  | { type: "doubt" }
  | { type: "settings"; key: string | null }
  | { type: "status"; epoch: number; status: Status }
  | { type: "list"; epoch: number; key: string; list: ItemList }
  | { type: "list-failed"; epoch: number; key: string };

const rememberedLists = 16;
const unverified = { state: "unverified" } as const;

function holdsPrivate(memory: DisplayMemory) {
  return (
    memory.scope.state === "verified" ||
    memory.lists.size > 0 ||
    memory.status?.state === "connected"
  );
}

function revoke(memory: DisplayMemory, status: Status | null = null) {
  return holdsPrivate(memory)
    ? {
        ...memory,
        epoch: memory.epoch + 1,
        scope: unverified,
        status,
        lists: new Map<string, ItemList>(),
      }
    : { ...memory, status };
}

function invalidate(memory: DisplayMemory) {
  return {
    ...memory,
    epoch: memory.epoch + 1,
    scope: unverified,
    status: null,
    lists: new Map<string, ItemList>(),
  };
}

function doubt(memory: DisplayMemory): DisplayMemory {
  return holdsPrivate(memory)
    ? { ...memory, epoch: memory.epoch + 1, scope: unverified }
    : memory;
}

function trust(memory: DisplayMemory, account: string): DisplayMemory {
  const base =
    memory.scope.state === "verified" && memory.scope.account !== account
      ? revoke(memory)
      : memory;
  return {
    ...base,
    scope: { state: "verified", account },
    status:
      base.status?.state === "connected" && base.status.account === account
        ? base.status
        : null,
    lists: new Map(
      [...base.lists].filter(([, list]) => list.account === account),
    ),
  };
}

function nextMemory(memory: DisplayMemory, event: ScopeEvent): DisplayMemory {
  switch (event.type) {
    case "revoke":
      return invalidate(memory);
    case "doubt":
      return doubt(memory);
    case "settings": {
      if (event.key === memory.settings) return memory;
      const changed =
        event.key !== null &&
        memory.knownSettings !== null &&
        event.key !== memory.knownSettings;
      return {
        ...(changed ? invalidate(memory) : doubt(memory)),
        settings: event.key,
        knownSettings: event.key ?? memory.knownSettings,
      };
    }
    case "status": {
      if (event.epoch !== memory.epoch) return memory;
      const { status } = event;
      return status.state === "connected"
        ? { ...trust(memory, status.account), status }
        : revoke(memory, status);
    }
    case "list": {
      if (event.epoch !== memory.epoch) return memory;
      const trusted = trust(memory, event.list.account);
      const lists = new Map(trusted.lists);
      lists.delete(event.key);
      lists.set(event.key, event.list);
      for (const oldest of lists.keys()) {
        if (lists.size <= rememberedLists) break;
        lists.delete(oldest);
      }
      return { ...trusted, lists };
    }
    case "list-failed": {
      if (event.epoch !== memory.epoch || !memory.lists.has(event.key))
        return memory;
      const lists = new Map(memory.lists);
      lists.delete(event.key);
      return { ...memory, lists };
    }
  }
}

function trustedAccount(memory: DisplayMemory, settings: string | null) {
  return memory.scope.state === "verified" && settings === memory.settings
    ? memory.scope.account
    : null;
}

function trustedList(
  memory: DisplayMemory,
  settings: string | null,
  key: string,
) {
  const list = memory.lists.get(key);
  return list && list.account === trustedAccount(memory, settings)
    ? list
    : undefined;
}

function trustedStatus(memory: DisplayMemory, settings: string | null) {
  const { status } = memory;
  if (!status) return undefined;
  return status.state === "unavailable" || status.account === trustedAccount(memory, settings)
    ? status
    : undefined;
}

function connectionNotice(status: Status | null | undefined) {
  return status?.state === "unavailable"
    ? status.error
    : status
      ? null
      : "Checking Gitea configuration…";
}

let displayMemory: DisplayMemory = {
  epoch: 0,
  scope: unverified,
  settings: null,
  knownSettings: null,
  status: null,
  lists: new Map(),
};
const memoryListeners = new Set<() => void>();
let scopeWatchers = 0;
const panelMemory: { filters: ListFilters; preferences: Preferences | null } = {
  filters: { view: "my-prs", state: "open", repo: "all", query: "" },
  preferences: null,
};

function dispatch(event: ScopeEvent) {
  const next = nextMemory(displayMemory, event);
  if (next === displayMemory) return;
  displayMemory = next;
  for (const listener of memoryListeners) listener();
}

function subscribeMemory(listener: () => void) {
  memoryListeners.add(listener);
  return () => {
    memoryListeners.delete(listener);
  };
}

function useDisplayMemory() {
  return useSyncExternalStore(subscribeMemory, () => displayMemory);
}

async function verifyScope(rpc: PluginRpcClient<typeof giteaRpcContract>) {
  const { epoch } = displayMemory;
  dispatch({ type: "status", epoch, status: await rpc.call("status", null) });
}

function settingsKey(
  values: Record<string, string | number | boolean> | undefined,
) {
  return values === undefined
    ? null
    : JSON.stringify(
        Object.entries(values).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
}

function useScopeWatch() {
  const settings = settingsKey(useSettings().values);
  const connection = useRealtimeConnectionState();
  const seenConnection = useRef(connection);
  useEffect(() => {
    scopeWatchers += 1;
    return () => {
      scopeWatchers -= 1;
      if (scopeWatchers === 0) dispatch({ type: "doubt" });
    };
  }, []);
  useEffect(() => dispatch({ type: "settings", key: settings }), [settings]);
  useEffect(() => {
    if (seenConnection.current === connection) return;
    seenConnection.current = connection;
    dispatch({ type: "doubt" });
  }, [connection]);
  const onChange = useCallback((payload: unknown) => {
    if (parseDisplayChange(payload)?.scope === "all")
      dispatch({ type: "revoke" });
  }, []);
  useRealtime("display-changed", onChange);
  return settings;
}

function DisplayScopeWatch() {
  useScopeWatch();
  return null;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

const openMyPullRequests: ListFilters = {
  view: "my-prs",
  state: "open",
  repo: "all",
  query: "",
};

const openMyIssues: ListFilters = {
  view: "my-issues",
  state: "open",
  repo: "all",
  query: "",
};

function listKey({ view, state, repo, query }: ListFilters) {
  return JSON.stringify([view, repo, state, query]);
}

function useIsDarkTheme() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

const unavailableText = {
  missing: "Gitea's raw diff has no section that matches this file.",
  stale:
    "The pull request changed while its files were loading. Reload to see a consistent diff.",
  "diff-too-large":
    "The pull request's raw diff exceeds the 16 MiB limit, so per-file diffs are not shown here.",
  "diff-failed": "Gitea did not return the raw diff for this pull request.",
} as const;

type PullConversation = Extract<
  ConversationView["conversation"],
  { kind: "pr" }
>;
type Check = Extract<PullConversation["checks"], { state: "loaded" }>["values"][number];
type ItemState = PullConversation["state"];
const stateDot: Record<ItemState, string> = {
  open: "bg-green-500",
  closed: "bg-purple-500",
};
type ReviewComment = PullConversation["reviewComments"][number];
type ConversationComment = ConversationView["conversation"]["comments"][number];
type RepoOptions = PluginRpcResult<(typeof giteaRpcContract)["repoOptions"]>;
type LineTarget = Pick<ReviewComment, "line" | "side">;
type FileReview = {
  comments: ReviewComment[];
  post: (target: LineTarget, body: string) => Promise<void>;
};
type LineReview = {
  repo: string;
  number: number;
  comments: ReviewComment[];
  onPosted: () => Promise<unknown>;
};
type LineNote =
  { kind: "thread"; comments: ReviewComment[] } | { kind: "draft" };

function CheckRow({ check }: { check: Check }) {
  const content = (
    <>
      <span
        className={`size-2 shrink-0 rounded-full ${check.status === "success" ? "bg-green-500" : check.status === "failure" ? "bg-red-500" : "bg-muted-foreground"}`}
      />
      <span className="min-w-0 flex-1 truncate">{check.name}</span>
      <Badge variant="secondary">{check.status}</Badge>
    </>
  );
  const className =
    "flex items-center gap-2 border-b border-border px-3 py-2 text-xs";
  if (!check.url) return <div className={className}>{content}</div>;
  return (
    <UrlLink
      href={check.url}
      title={`Open ${check.name}`}
      className={`${className} hover:bg-muted/50`}
    >
      {content}
    </UrlLink>
  );
}

function DiffNotice({
  children,
  filesUrl,
}: {
  children: string;
  filesUrl: string;
}) {
  return (
    <div
      data-testid="bb-diff-notice"
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>{children}</span>
      {filesUrl && (
        <UrlLink href={filesUrl} className="underline hover:text-foreground">
          View on Gitea ↗
        </UrlLink>
      )}
    </div>
  );
}

type DiffStyle = "unified" | "split";

const diffStyleKey = "gitea.diffStyle";
const diffStyleListeners = new Set<() => void>();

function readDiffStyle(): DiffStyle {
  try {
    return localStorage.getItem(diffStyleKey) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function writeDiffStyle(style: DiffStyle) {
  try {
    localStorage.setItem(diffStyleKey, style);
  } catch {}
  for (const listener of diffStyleListeners) listener();
}

function useDiffStyle() {
  return useSyncExternalStore((listener) => {
    diffStyleListeners.add(listener);
    return () => diffStyleListeners.delete(listener);
  }, readDiffStyle);
}

function DiffStyleToggle() {
  const style = useDiffStyle();
  return (
    <div
      role="group"
      aria-label="Diff layout"
      className="flex overflow-hidden rounded-md border border-border"
    >
      {(["unified", "split"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={style === option}
          onClick={() => writeDiffStyle(option)}
          className={`px-2 py-0.5 text-xs capitalize ${style === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function GiteaDiff({
  path,
  diff,
  filesUrl,
  review,
}: {
  path: string;
  diff: FileDiff;
  filesUrl: string;
  review: FileReview;
}) {
  if (diff.kind === "text")
    return <PatchView path={path} patch={diff.patch} review={review} />;
  if (diff.kind === "empty")
    return (
      <DiffNotice filesUrl="">
        No content changes (rename or mode change only).
      </DiffNotice>
    );
  if (diff.kind === "binary")
    return <DiffNotice filesUrl={filesUrl}>Binary file changed.</DiffNotice>;
  if (diff.kind === "too-large")
    return (
      <DiffNotice filesUrl={filesUrl}>
        {`This file's diff is ${formatBytes(diff.bytes)}, above the ${formatBytes(diff.limit)} inline limit.`}
      </DiffNotice>
    );
  return (
    <DiffNotice filesUrl={filesUrl}>{unavailableText[diff.reason]}</DiffNotice>
  );
}

function sameLine(a: LineTarget, b: LineTarget) {
  return a.line === b.line && a.side === b.side;
}

function lineNotes(
  comments: ReviewComment[],
  draft: LineTarget | null,
): DiffLineAnnotation<LineNote>[] {
  const threads = new Map<string, DiffLineAnnotation<LineNote>>();
  for (const comment of comments) {
    const key = `${comment.side}:${comment.line}`;
    const thread = threads.get(key);
    if (thread?.metadata.kind === "thread")
      thread.metadata.comments.push(comment);
    else
      threads.set(key, {
        side: comment.side,
        lineNumber: comment.line,
        metadata: { kind: "thread", comments: [comment] },
      });
  }
  const notes = [...threads.values()];
  if (draft)
    notes.push({
      side: draft.side,
      lineNumber: draft.line,
      metadata: { kind: "draft" },
    });
  return notes;
}

function LineThread({
  comments,
  onReply,
}: {
  comments: ReviewComment[];
  onReply: (() => void) | null;
}) {
  return (
    <div
      data-testid="bb-line-thread"
      className="mx-2 my-1.5 space-y-2 rounded-md border border-border bg-card p-2 font-sans text-xs"
    >
      {comments.map((comment) => (
        <article key={comment.id}>
          <div className="mb-0.5 text-muted-foreground">
            <span className="font-medium text-foreground">
              {comment.author}
            </span>{" "}
            · {comment.createdAt}
          </div>
          <Markdown content={comment.body} className="min-w-0" />
        </article>
      ))}
      {onReply && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={onReply}
        >
          Reply
        </Button>
      )}
    </div>
  );
}

function LineDraft({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const pending = useRef(false);
  const submit = async () => {
    if (pending.current || !body.trim()) return;
    pending.current = true;
    setPosting(true);
    try {
      await onSubmit(body);
    } finally {
      pending.current = false;
      setPosting(false);
    }
  };
  const cancel = () => {
    if (!pending.current) onCancel();
  };
  return (
    <div className="mx-2 my-1.5 space-y-2 rounded-md border border-border bg-card p-2 font-sans">
      <Textarea
        autoFocus
        aria-label="Line comment"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        disabled={posting}
        placeholder="Comment on this line"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={posting} onClick={cancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={posting || !body.trim()}
          onClick={() => void submit()}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}

function PatchView({
  path,
  patch,
  review,
}: {
  path: string;
  patch: string;
  review: FileReview;
}) {
  const dark = useIsDarkTheme();
  const diffStyle = useDiffStyle();
  const [draft, setDraft] = useState<LineTarget | null>(null);
  const annotations = useMemo(
    () => lineNotes(review.comments, draft),
    [review.comments, draft],
  );
  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    const normalized = patch.replace(/\r\n/g, "\n").trimEnd();
    const text = normalized.startsWith("diff --git")
      ? `${normalized}\n`
      : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${normalized}\n`;
    try {
      return parsePatchFiles(text)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [path, patch]);
  const options = useMemo<FileDiffOptions<LineNote>>(
    () => ({
      diffStyle,
      overflow: "scroll",
      disableFileHeader: true,
      themeType: dark ? "dark" : "light",
      enableGutterUtility: true,
      onGutterUtilityClick: (range) =>
        setDraft({
          line: range.end,
          side: range.endSide ?? range.side ?? "additions",
        }),
    }),
    [dark, diffStyle],
  );
  if (!fileDiff)
    return (
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-foreground/80">
        {patch}
      </pre>
    );
  return (
    <div data-testid="bb-diff" data-path={path}>
      <PierreFileDiff
        fileDiff={fileDiff}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={(note) =>
          note.metadata.kind === "draft" ? (
            <LineDraft
              onCancel={() => setDraft(null)}
              onSubmit={async (body) => {
                await review.post(
                  { line: note.lineNumber, side: note.side },
                  body,
                );
                setDraft(null);
              }}
            />
          ) : (
            <LineThread
              comments={note.metadata.comments}
              onReply={
                draft &&
                sameLine(draft, { line: note.lineNumber, side: note.side })
                  ? null
                  : () => setDraft({ line: note.lineNumber, side: note.side })
              }
            />
          )
        }
      />
    </div>
  );
}

function filesUrl(item: { url: string }) {
  return item.url ? `${item.url.replace(/\/+$/, "")}/files` : "";
}

function DiffBanner({ files }: { files: FileEntry[] }) {
  const reasons = new Set(
    files.flatMap((file) =>
      file.diff.kind === "unavailable" ? [file.diff.reason] : [],
    ),
  );
  const notices = (["stale", "diff-too-large", "diff-failed"] as const).filter(
    (reason) => reasons.has(reason),
  );
  if (!notices.length) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      {notices.map((reason) => (
        <div key={reason}>{unavailableText[reason]}</div>
      ))}
    </div>
  );
}

function itemKey(item: Pick<Item, "repo" | "number">) {
  return `${item.repo}#${item.number}`;
}

function itemTag(item: Pick<Item, "repo" | "number">) {
  return `${item.repo.toLowerCase()}#${item.number}`;
}

type DisplayChange =
  | { scope: "all"; files: boolean }
  | { scope: "lists" }
  | { scope: "item"; tag: string; files: boolean };

function parseDisplayChange(payload: unknown): DisplayChange | null {
  if (typeof payload !== "object" || payload === null || !("item" in payload))
    return null;
  const { item } = payload;
  const files = "files" in payload && payload.files === true;
  if (item === null) return { scope: "all", files };
  if (typeof item !== "string") return null;
  if (item === "lists") return { scope: "lists" };
  return { scope: "item", tag: item, files };
}

function changedSettings(payload: unknown) {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "settings" in payload &&
    payload.settings === true
  );
}

function useCoalesced(run: () => void, delayMs: number) {
  const latest = useRef(run);
  latest.current = run;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  }, [delayMs]);
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const loading = { state: "loading" } as const;

async function readItemList(
  rpc: PluginRpcClient<typeof giteaRpcContract>,
  { view, state, repo, query }: ListFilters,
  refresh: boolean,
): Promise<ItemList> {
  const input = { state, query, refresh, ...(repo === "all" ? {} : { repo }) };
  switch (view) {
    case "my-issues": {
      const { account, items, truncated, errors, freshness } = await rpc.call("listMyIssues", input);
      return { account, items, truncated, errors, freshness };
    }
    case "my-prs": {
      const { account, items, truncated, errors, freshness } = await rpc.call("listMyPullRequests", input);
      return { account, items, truncated, errors, freshness };
    }
    case "issues":
    case "pulls": {
      const { account, items, truncated, errors, freshness } = await rpc.call(
        "listItems", { kind: view === "issues" ? "issue" : "pr", ...input },
      );
      return { account, items, truncated, errors, freshness };
    }
  }
}

function useItemList(
  filters: ListFilters,
  memory: DisplayMemory,
  settings: string | null,
  onFailure: () => void,
  enabled = true,
) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const key = enabled ? listKey(filters) : null;
  const { view, state, repo, query } = filters;
  const { epoch } = memory;
  const [failure, setFailure] = useState<{
    key: string;
    epoch: number;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const run = useRef(0);
  const load = useCallback(
    async (refresh: boolean) => {
      if (key === null) return;
      const current = ++run.current;
      const started = displayMemory.epoch;
      setPending(key);
      try {
        const list = await readItemList(
          rpc,
          { view, state, repo, query },
          refresh,
        );
        if (current !== run.current) return;
        dispatch({ type: "list", epoch: started, key, list });
        setFailure(null);
      } catch (error) {
        if (current !== run.current) return;
        dispatch({ type: "list-failed", epoch: started, key });
        setFailure({
          key,
          epoch: started,
          message: errorText(error, "Could not load Gitea items"),
        });
        if (holdsPrivate(displayMemory)) onFailure();
      }
      setPending(null);
    },
    [key, rpc, view, state, repo, query, epoch, onFailure],
  );
  useEffect(() => {
    void load(false);
    return () => {
      run.current += 1;
    };
  }, [load]);
  const onChange = useCallback(
    (payload: unknown) => {
      if (parseDisplayChange(payload)?.scope === "lists") void load(false);
    },
    [load],
  );
  useRealtime("display-changed", onChange);
  const remembered =
    key === null ? undefined : trustedList(memory, settings, key);
  const list: Loadable<ItemList> = remembered
    ? { state: "ready", value: remembered }
    : failure?.key === key && failure.epoch === epoch
      ? { state: "error", message: failure.message }
      : loading;
  return { list, updating: key !== null && pending === key, load };
}

function useItemDisplay(target: ItemRef | null, wantFiles: boolean) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const epoch = useSyncExternalStore(
    subscribeMemory,
    () => displayMemory.epoch,
  );
  const key = target ? `${epoch}:${target.kind}:${itemTag(target)}` : null;
  const [conversation, setConversation] =
    useState<Keyed<ConversationView> | null>(null);
  const [files, setFiles] = useState<Keyed<FilesView> | null>(null);
  const conversationRun = useRef(0);
  const filesRun = useRef(0);
  const loadConversation = useCallback(
    async (refresh: boolean) => {
      if (!target || !key) return;
      const run = ++conversationRun.current;
      let view: Loadable<ConversationView>;
      try {
        view = {
          state: "ready",
          value: await rpc.call("conversation", { ...target, refresh }),
        };
      } catch (error) {
        view = {
          state: "error",
          message: errorText(error, "Could not load item"),
        };
      }
      if (run === conversationRun.current) setConversation({ key, view });
    },
    [key, rpc, target],
  );
  useEffect(() => {
    void loadConversation(false);
    return () => {
      conversationRun.current += 1;
    };
  }, [loadConversation]);
  const shown = conversation?.key === key ? conversation.view : loading;
  const shownRevision =
    shown.state === "ready" && shown.value.conversation.kind === "pr"
      ? shown.value.conversation.revision
      : null;
  const revisionHead = shownRevision?.head;
  const revisionBase = shownRevision?.base;
  const revision = useMemo(
    () =>
      revisionHead !== undefined && revisionBase !== undefined
        ? { head: revisionHead, base: revisionBase }
        : null,
    [revisionHead, revisionBase],
  );
  const filesKey =
    key && revision ? `${key}@${revision.head}:${revision.base}` : null;
  const loadFiles = useCallback(
    async (refresh: boolean) => {
      if (!target || !filesKey || !revision) return;
      const run = ++filesRun.current;
      let view: Loadable<FilesView>;
      try {
        view = {
          state: "ready",
          value: await rpc.call("pullFiles", {
            repo: target.repo,
            number: target.number,
            revision,
            refresh,
          }),
        };
      } catch (error) {
        view = {
          state: "error",
          message: errorText(error, "Could not load changed files"),
        };
      }
      if (run === filesRun.current) setFiles({ key: filesKey, view });
    },
    [filesKey, rpc, target],
  );
  useEffect(() => {
    if (!wantFiles) return;
    void loadFiles(false);
    return () => {
      filesRun.current += 1;
    };
  }, [loadFiles, wantFiles]);
  const onChange = useCallback(
    (payload: unknown) => {
      const change = parseDisplayChange(payload);
      if (!change || change.scope === "lists" || !target) return;
      if (change.scope === "item" && change.tag !== itemTag(target)) return;
      if (change.scope === "all" || !change.files)
        void loadConversation(false);
      if (wantFiles && (change.scope === "all" || change.files))
        void loadFiles(false);
    },
    [loadConversation, loadFiles, target, wantFiles],
  );
  useRealtime("display-changed", onChange);
  const shownFiles = files?.key === filesKey ? files.view : loading;
  const filesMoved =
    shownFiles.state === "ready" &&
    revision !== null &&
    (shownFiles.value.revision.head !== revision.head ||
      shownFiles.value.revision.base !== revision.base);
  return {
    conversation: shown,
    files: shownFiles,
    filesMoved,
    reload: () => loadConversation(false),
    refresh: async () => {
      await loadConversation(true);
      if (wantFiles) await loadFiles(true);
    },
  };
}

function FreshnessNote({
  freshness,
  onRefresh,
}: {
  freshness: Freshness;
  onRefresh?: () => void;
}) {
  const time = new Date(freshness.fetchedAt).toLocaleTimeString();
  return (
    <span
      data-testid="bb-freshness"
      data-state={freshness.state}
      className="flex shrink-0 items-center gap-1"
      title={freshness.state === "stale-error" ? freshness.error : undefined}
    >
      {freshness.state === "fresh"
        ? `Updated ${time}`
        : freshness.state === "refreshing"
          ? `Updating · shown from ${time}`
          : `Refresh failed · shown from ${time}`}
      {onRefresh && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={onRefresh}
        >
          Refresh
        </Button>
      )}
    </span>
  );
}

const PULL_FILE_TREE_STYLE = {
  "--trees-accent-override": "var(--ring)",
  "--trees-bg-muted-override":
    "color-mix(in oklab, var(--muted) 45%, transparent)",
  "--trees-bg-override": "transparent",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "var(--text-xs)",
  "--trees-icon-width-override": "14px",
  "--trees-item-margin-x-override": "0",
  "--trees-padding-inline-override": "0",
  "--trees-scrollbar-thumb-override":
    "color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
  "--trees-selected-bg-override":
    "color-mix(in oklab, var(--accent) 65%, transparent)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  height: "100%",
} as CSSProperties;

function filesCount(files: Loadable<FilesView>) {
  return files.state === "ready" ? files.value.files.length : null;
}

function DetailTabsList({
  comments,
  files,
}: {
  comments: number;
  files: number | null;
}) {
  return (
    <TabsList aria-label="Pull request sections">
      <TabsTrigger value="conversation" className="gap-1.5">
        Conversation <Badge variant="secondary">{comments}</Badge>
      </TabsTrigger>
      <TabsTrigger value="files" className="gap-1.5">
        Files changed{" "}
        {files !== null && <Badge variant="secondary">{files}</Badge>}
      </TabsTrigger>
    </TabsList>
  );
}

function PullFilesPane({
  files,
  url,
  moved,
  review,
}: {
  files: Loadable<FilesView>;
  url: string;
  moved: boolean;
  review: LineReview;
}) {
  if (files.state === "loading")
    return (
      <div className="space-y-2" data-testid="bb-files-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (files.state === "error")
    return (
      <p role="alert" className="text-xs text-muted-foreground">
        {files.message}
      </p>
    );
  if (moved)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        This pull request changed since its conversation loaded. Loading the
        latest revision…
      </p>
    );
  const { value } = files;
  if (!value.files.length)
    return (
      <p className="text-xs text-muted-foreground">
        This pull request has no changed files.
      </p>
    );
  return (
    <ChangedFiles
      key={`${value.revision.head}:${value.revision.base}`}
      view={value}
      url={url}
      review={review}
    />
  );
}

type RevealWhenNear = (node: Element, reveal: () => void) => () => void;

function useRevealWhenNear(root: Element | null): RevealWhenNear | null {
  const [observe, setObserve] = useState<RevealWhenNear | null>(null);
  useEffect(() => {
    if (!root) return;
    const pending = new Map<Element, () => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          pending.get(entry.target)?.();
          pending.delete(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { root, rootMargin: "1500px 0px" },
    );
    setObserve(() => (node: Element, reveal: () => void) => {
      pending.set(node, reveal);
      observer.observe(node);
      return () => {
        pending.delete(node);
        observer.unobserve(node);
      };
    });
    return () => {
      observer.disconnect();
      setObserve(null);
    };
  }, [root]);
  return observe;
}

function DeferredDiff({
  observe,
  lines,
  children,
}: {
  observe: RevealWhenNear | null;
  lines: number;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const placeholder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown || !observe || !placeholder.current) return;
    return observe(placeholder.current, () => setShown(true));
  }, [observe, shown]);
  if (shown) return children;
  return <div ref={placeholder} style={{ height: lines * 20 + 16 }} />;
}

const noComments: ReviewComment[] = [];

function ChangedFiles({
  view,
  url,
  review,
}: {
  view: FilesView;
  url: string;
  review: LineReview;
}) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const { repo, number, onPosted } = review;
  const head = view.revision.head;
  const byPath = useMemo(() => {
    const grouped = new Map<string, ReviewComment[]>();
    for (const comment of review.comments)
      grouped.set(comment.path, [
        ...(grouped.get(comment.path) ?? []),
        comment,
      ]);
    return grouped;
  }, [review.comments]);
  const reviews = useMemo(
    () =>
      new Map(
        view.files.map((file) => [
          file.path,
          {
            comments: byPath.get(file.path) ?? noComments,
            post: async (target: LineTarget, body: string) => {
              try {
                await rpc.call("reviewComment", {
                  repo,
                  number,
                  commitId: head,
                  path: file.path,
                  body,
                  ...target,
                });
              } catch (error) {
                toast.error(errorText(error, "Comment failed"));
                throw error;
              }
              toast.success("Comment added");
              await onPosted();
            },
          },
        ]),
      ),
    [byPath, head, number, onPosted, repo, rpc, view.files],
  );
  const cards = useRef(new Map<string, HTMLElement>());
  const [scrollRoot, setScrollRoot] = useState<Element | null>(null);
  const observe = useRevealWhenNear(scrollRoot);
  const diffColumn = useCallback(
    (node: HTMLDivElement | null) =>
      setScrollRoot(node?.firstElementChild ?? null),
    [],
  );
  const tree = useMemo(() => changedFilesTree(view.files), [view.files]);
  const totals = useMemo(() => changeTotals(view.files), [view.files]);
  const { model } = useFileTree({
    paths: tree.paths,
    gitStatus: tree.gitStatus,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    density: "compact",
    search: true,
    onSelectionChange: (paths) => {
      const path = paths.find((candidate) => cards.current.has(candidate));
      if (path !== undefined)
        cards.current.get(path)?.scrollIntoView({ block: "start" });
    },
    renderRowDecoration: ({ item }) => {
      const counts = item.kind === "file" ? tree.counts.get(item.path) : null;
      return counts ? { text: counts } : null;
    },
  });
  return (
    <div
      data-testid="bb-changed-files"
      className="@container flex h-full min-h-0 flex-col gap-2"
    >
      {view.filesTruncated && (
        <p role="status" className="text-xs text-muted-foreground">
          The file list reached its size cap and may be incomplete.{" "}
          {url && (
            <UrlLink href={url} className="underline hover:text-foreground">
              View all files on Gitea ↗
            </UrlLink>
          )}
        </p>
      )}
      {view.freshness.state === "stale-error" && (
        <p role="status" className="text-xs text-muted-foreground">
          Showing files from{" "}
          {new Date(view.freshness.fetchedAt).toLocaleTimeString()}. Gitea
          refresh failed: {view.freshness.error}
        </p>
      )}
      <DiffBanner files={view.files} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 @[44rem]:flex-row">
        <aside className="h-40 shrink-0 overflow-hidden rounded-lg border border-border bg-card @[44rem]:h-auto @[44rem]:w-64">
          <FileTree
            aria-label="Changed files"
            className="block h-full min-h-0"
            header={
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
                <span className="min-w-0 flex-1 truncate">
                  {view.files.length} file{view.files.length === 1 ? "" : "s"}{" "}
                  <span className="font-normal text-muted-foreground">
                    {fileCounts(totals)}
                  </span>
                </span>
                <DiffStyleToggle />
              </div>
            }
            model={model}
            style={PULL_FILE_TREE_STYLE}
          />
        </aside>
        <div ref={diffColumn} className="flex min-h-0 flex-1 flex-col">
          <Virtualizer
            className="min-h-0 flex-1 overflow-y-auto"
            contentClassName="space-y-3 pb-4"
          >
            {view.files.map((file) => (
              <section
                key={file.path}
                ref={(node) => {
                  if (node) cards.current.set(file.path, node);
                  else cards.current.delete(file.path);
                }}
                aria-label={fileLabel(file)}
                data-testid="bb-file-card"
                data-path={file.path}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                <header className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2 text-xs">
                  <span
                    className="min-w-0 flex-1 truncate font-mono"
                    title={fileLabel(file)}
                  >
                    {fileLabel(file)}
                  </span>
                  {reviews.get(file.path)!.comments.length > 0 && (
                    <Badge variant="secondary" className="gap-1">
                      <Icon name="MessageSquare" className="size-3" />
                      {reviews.get(file.path)!.comments.length}
                    </Badge>
                  )}
                  <span className="shrink-0 text-green-600 dark:text-green-400">
                    +{file.additions}
                  </span>
                  <span className="shrink-0 text-red-600 dark:text-red-400">
                    −{file.deletions}
                  </span>
                  <Badge variant="secondary">{file.status}</Badge>
                </header>
                {file.diff.kind === "text" ? (
                  <DeferredDiff
                    observe={observe}
                    lines={file.diff.patch.split("\n").length}
                  >
                    <GiteaDiff
                      path={file.path}
                      diff={file.diff}
                      filesUrl={url}
                      review={reviews.get(file.path)!}
                    />
                  </DeferredDiff>
                ) : (
                  <GiteaDiff
                    path={file.path}
                    diff={file.diff}
                    filesUrl={url}
                    review={reviews.get(file.path)!}
                  />
                )}
              </section>
            ))}
          </Virtualizer>
        </div>
      </div>
    </div>
  );
}

function parseRoute(subPath: string): Route | null {
  switch (subPath) {
    case "": case "my-prs": return { kind: "list", view: "my-prs" };
    case "my-issues": return { kind: "list", view: "my-issues" };
    case "auto-fixers": return { kind: "list", view: "auto-fixers" };
    case "issues": return { kind: "list", view: "issues" };
    case "pulls": return { kind: "list", view: "pulls" };
    case "new": return { kind: "new-issue", from: "issues" };
    case "my-issues/new": return { kind: "new-issue", from: "my-issues" };
  }
  const match = /^(issues|pulls)\/([^/]+)\/([^/]+)\/([1-9]\d*)$/.exec(subPath);
  if (!match)
    return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) return null;
  return { kind: "item", item: { kind: match[1] === "issues" ? "issue" : "pr", repo: `${match[2]}/${match[3]}`, number } };
}

function routePath(route: Route): string {
  switch (route.kind) {
    case "list": return route.view;
    case "new-issue": return route.from === "my-issues" ? "my-issues/new" : "new";
    case "item": return `${route.item.kind === "pr" ? "pulls" : "issues"}/${route.item.repo}/${route.item.number}`;
  }
}

const autoFixerLabels = {
  archived: "archived",
  idle: "off",
  watching: "running",
  needs_you: "needs you",
  failed: "failed",
  merged: "merged",
  closed: "closed",
  stopped: "stopped",
} as const;

const automationToggles = [
  {
    option: "fix",
    label: "Auto-fix",
    description:
      "Fix CI failures and address review feedback. Auto-fix never merges.",
  },
  {
    option: "merge",
    label: "Auto-merge",
    description:
      "Merge with your tea login once checks, approvals and branch rules allow it. Auto-merge never changes code.",
  },
] as const;

function autoFixerDetail(view: AutoFixerView) {
  if (view.status === "archived") return `PR ${view.outcome}. Auto-fixer archived.`;
  if (view.status === "merged" || view.status === "closed") return `PR ${view.status}. BB cleanup pending; retrying automatically.`;
  if (view.status === "failed") return view.error;
  if (view.status === "needs_you") return view.note;
  if (view.status === "stopped" && view.cleanupPending)
    return "The auto-fixer thread has not been archived yet; BB keeps retrying.";
  return "";
}

function AutoFixerControls({
  repo,
  number,
  view,
  onChanged,
}: {
  repo: string;
  number: number;
  view: AutoFixerView;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(done);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Automation change failed",
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const detail = autoFixerDetail(view);
  const changeable = view.actions.length > 0;
  return (
    <span
      data-testid="auto-fixer-controls"
      className="flex shrink-0 flex-wrap items-center gap-1"
    >
      {view.status !== "idle" && (
        <Badge
          variant={view.status === "failed" ? "destructive" : "secondary"}
          title={detail || undefined}
        >
          {autoFixerLabels[view.status]}
        </Badge>
      )}
      {"threadId" in view && (
        <Button
          size="sm"
          variant="link"
          className="h-7 px-1"
          onClick={() => navigate.toThread(view.threadId)}
        >
          Thread
        </Button>
      )}
      {automationToggles.map(({ option, label }) => {
        const on = view.automation[option];
        return (
          <Button
            key={option}
            size="sm"
            variant={on ? "default" : "outline"}
            className="h-7"
            aria-pressed={on}
            disabled={busy || !changeable}
            onClick={() =>
              void run(
                () =>
                  rpc.call("setAutomation", { repo, number, [option]: !on }),
                `${label} ${on ? "off" : "on"}`,
              )
            }
          >
            {label}
          </Button>
        );
      })}
      {view.actions.includes("retry") && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy}
          onClick={() =>
            void run(
              () => rpc.call("retryAutoFixer", { repo, number }),
              "Auto-fixer resumed",
            )
          }
        >
          Retry
        </Button>
      )}
    </span>
  );
}

function AutoFixerPreferencesControl() {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [loaded, setLoaded] = useState<Loadable<Preferences>>(() =>
    panelMemory.preferences
      ? { state: "ready", value: panelMemory.preferences }
      : { state: "loading" },
  );
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    void rpc
      .call("getAutoFixerPreferences", null)
      .then((preferences) => {
        panelMemory.preferences = preferences;
        setLoaded({ state: "ready", value: preferences });
      })
      .catch((error: unknown) =>
        setLoaded({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [rpc]);
  useEffect(load, [load]);
  const reloadSettings = useCallback(
    (payload: unknown) => {
      if (changedSettings(payload)) load();
    },
    [load],
  );
  useRealtime("auto-fixer-changed", reloadSettings);
  if (loaded.state === "loading") return null;
  if (loaded.state === "error")
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-xs text-destructive"
      >
        Could not load automation settings: {loaded.message}
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => {
            setLoaded({ state: "loading" });
            load();
          }}
        >
          Retry
        </Button>
      </div>
    );
  const preferences = loaded.value;
  const setPreferences = (next: Preferences) => {
    panelMemory.preferences = next;
    setLoaded({ state: "ready", value: next });
  };
  const save = async (
    update: () => Promise<Preferences>,
    optimistic: Preferences,
  ) => {
    const previous = preferences;
    setPreferences(optimistic);
    setSaving(true);
    try {
      setPreferences(await update());
    } catch (error) {
      setPreferences(previous);
      toast.error(
        error instanceof Error ? error.message : "Could not save settings",
      );
    } finally {
      setSaving(false);
    }
  };
  const execution: ExperimentalProviderModelPickerValue = preferences.execution;
  const fields = { fix: "autoFix", merge: "autoMerge" } as const;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {automationToggles.map(({ option, label, description }) => {
        const field = fields[option];
        return (
          <label
            key={option}
            title={description}
            className="flex items-center gap-2"
          >
            <input
              type="checkbox"
              checked={preferences[field]}
              disabled={saving}
              onChange={(event) => {
                const enabled = event.target.checked;
                void save(
                  () => rpc.call("setAutoAutomation", { [option]: enabled }),
                  { ...preferences, [field]: enabled },
                );
              }}
            />
            {label} all
          </label>
        );
      })}
      <ProviderModelPicker
        value={execution}
        disabled={saving}
        align="end"
        onChange={(value) => {
          const next = {
            ...value,
            serviceTier: value.serviceTier ?? "default",
          };
          if (
            execution.providerId === next.providerId &&
            execution.model === next.model &&
            execution.reasoningLevel === next.reasoningLevel &&
            (execution.serviceTier ?? "default") === next.serviceTier
          ) return;
          void save(() => rpc.call("setAutoFixerExecution", next), {
            ...preferences,
            execution: next,
          });
        }}
      />
    </div>
  );
}

function AutoFixerList() {
  const rpc = useRpc<typeof giteaRpcContract>();
  const navigate = useBbNavigate();
  const [sessions, setSessions] = useState<Loadable<AutoFixerSessions>>(loading);
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(() => {
    void rpc
      .call("listAutoFixerSessions", null)
      .then((result) => {
        setSessions({ state: "ready", value: result.sessions });
      })
      .catch((reason: unknown) =>
        setSessions({
          state: "error",
          message: errorText(reason, "Could not load auto-fixers"),
        }),
      );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("auto-fixer-changed", useCoalesced(load, 500));
  if (sessions.state === "error")
    return (
      <div role="alert" className="p-8 text-center text-muted-foreground">
        {sessions.message}
      </div>
    );
  if (sessions.state === "loading") return <Skeleton className="h-24 w-full" />;
  if (!sessions.value.length)
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
        No auto-fixers yet. Turn on Auto-fix or Auto-merge from My PRs.
      </div>
    );
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      <label className="flex items-center gap-2 px-3 py-2 text-sm"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived</label>
      {sessions.value.filter((session) => showArchived || session.status !== "archived").map((session) => (
        <div
          key={`${session.repo}#${session.number}`}
          data-testid="auto-fixer-session"
          className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center"
        >
          <button
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
            onClick={() =>
              navigate.toPluginPanel("gitea", {
                subPath: routePath({ kind: "item", item: { kind: "pr", repo: session.repo, number: session.number } }),
              })
            }
          >
            <span className="font-medium text-foreground">
              {session.repo}#{session.number}
            </span>
            <span className="text-xs text-muted-foreground">
              {session.updatedAt}
            </span>
            {autoFixerDetail(session) && (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {autoFixerDetail(session)}
              </span>
            )}
          </button>
          <AutoFixerControls
            repo={session.repo}
            number={session.number}
            view={session}
            onChanged={load}
          />
        </div>
      ))}
    </div>
  );
}

const viewLabels: Record<View, string> = {
  "my-prs": "My PRs",
  "my-issues": "My Issues",
  "auto-fixers": "Auto-fixers",
  issues: "Issues",
  pulls: "Pull requests",
};

function GiteaPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const navigate = useBbNavigate();
  const route = useMemo(() => parseRoute(subPath), [subPath]);
  const [view, setView] = useState<View>(route?.kind === "list" ? route.view : panelMemory.filters.view);
  const listView = view === "auto-fixers" ? panelMemory.filters.view : view;
  const [state, setState] = useState(panelMemory.filters.state);
  const [repo, setRepo] = useState(panelMemory.filters.repo);
  const [query, setQuery] = useState(panelMemory.filters.query);
  const searchQuery = useDebouncedValue(query, 250);
  useEffect(() => {
    panelMemory.filters = { view: listView, state, repo, query: searchQuery };
  }, [view, state, repo, searchQuery]);
  const settings = useScopeWatch();
  const memory = useDisplayMemory();
  const status = trustedStatus(memory, settings);
  const loadStatus = useCallback(async () => {
    try {
      await verifyScope(rpc);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not connect to Gitea",
      );
    }
  }, [rpc]);
  const verify = useCallback(() => void loadStatus(), [loadStatus]);
  const itemList = useItemList(
    { view: listView, state, repo, query: searchQuery },
    memory,
    settings,
    verify,
    view !== "auto-fixers",
  );
  const { list, load: loadList } = itemList;
  const openMine = useItemList(openMyPullRequests, memory, settings, verify);
  const openIssues = useItemList(openMyIssues, memory, settings, verify);
  const fromMyIssues = route?.kind === "new-issue" && route.from === "my-issues";
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creatingIssue, setCreatingIssue] = useState(false);
  const creatingIssueRef = useRef(false);
  const [reviewDraft, setReviewDraft] = useState<{ key: string; body: string } | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [detailSection, setDetailSection] =
    useState<DetailSection>("conversation");
  const newIssue = route?.kind === "new-issue";
  const display = useItemDisplay(route?.kind === "item" ? route.item : null, detailSection === "files");
  const shown = display.conversation;
  const detail = useMemo(
    () =>
      shown.state === "ready"
        ? shown.value.conversation
        : null,
    [shown],
  );
  const threadId = shown.state === "ready" ? shown.value.threadId : null;
  const [labelsDraft, setLabelsDraft] = useState<string[]>([]);
  const [assigneesDraft, setAssigneesDraft] = useState<string[]>([]);
  const [savingMetadata, setSavingMetadata] = useState(false);
  useEffect(() => {
    setLabelsDraft(detail?.labels ?? []);
    setAssigneesDraft(detail?.assignees ?? []);
  }, [detail]);
  const pickerOptions = useRepoOptions(detail?.repo ?? null);
  const loadedRepoOptions = pickerOptions.state === "ready" ? pickerOptions.value : null;
  const labelColors = useMemo(
    () =>
      new Map(
        (loadedRepoOptions?.labels ?? []).map((label) => [label.name, label.color]),
      ),
    [loadedRepoOptions],
  );

  const loadItems = useCallback(() => loadList(false), [loadList]);
  const { epoch } = memory;
  useEffect(() => {
    void loadStatus();
  }, [loadStatus, epoch]);
  const reloadAutoFixers = useCallback(() => {
    if (view === "my-prs" || view === "pulls") void loadItems();
  }, [loadItems, view]);
  useRealtime("auto-fixer-changed", useCoalesced(reloadAutoFixers, 500));
  const openItem = useCallback(
    async (item: Item) => {
      navigate.toPluginPanel("gitea", {
        subPath: routePath({ kind: "item", item }),
      });
    },
    [navigate],
  );
  const { reload: refreshDetail } = display;
  const reviewKey = route?.kind === "item"
    ? `${route.item.kind}:${route.item.repo}#${route.item.number}`
    : null;
  const reviewBody = reviewDraft?.key === reviewKey ? reviewDraft.body : "";
  useEffect(() => {
    if (route?.kind !== "item") {
      if (route?.kind === "list") setView(route.view);
      else if (route?.kind === "new-issue") setView(route.from);
      return;
    }
    setDetailSection("conversation");
  }, [route]);
  const refresh = useCallback(async () => {
    await Promise.all([loadStatus(), loadList(true)]);
  }, [loadList, loadStatus]);
  const setItemState = useCallback(
    async (next: "open" | "closed") => {
      if (!detail) return;
      try {
        await rpc.call("setState", {
          repo: detail.repo,
          number: detail.number,
          state: next,
        });
        await refreshDetail();
        await loadItems();
        toast.success(next === "closed" ? "Closed" : "Reopened");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Update failed");
      }
    },
    [detail, loadItems, refreshDetail, rpc],
  );
  const setDraft = useCallback(
    async (draft: boolean) => {
      if (!detail || detail.kind !== "pr") return;
      try {
        await rpc.call("setDraft", {
          repo: detail.repo,
          number: detail.number,
          draft,
        });
        await refreshDetail();
        await loadItems();
        toast.success(draft ? "Marked as draft" : "Ready for review");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Update failed");
      }
    },
    [detail, loadItems, refreshDetail, rpc],
  );
  const submitReview = useCallback(
    async (event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT") => {
      if (!detail || detail.kind !== "pr" || reviewPending) return;
      const submittedKey = `${detail.kind}:${detail.repo}#${detail.number}`;
      setReviewPending(true);
      try {
        await rpc.call("review", {
          repo: detail.repo,
          number: detail.number,
          event,
          body: reviewBody,
        });
        setReviewDraft((draft) => draft?.key === submittedKey ? null : draft);
        await refreshDetail();
        toast.success("Review submitted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Review failed");
      } finally {
        setReviewPending(false);
      }
    },
    [detail, refreshDetail, reviewBody, reviewPending, rpc],
  );
  const draftAgent = useCallback(async () => {
    if (!detail) return;
    try {
      const { prompt } = await rpc.call("draftAgent", {
        repo: detail.repo,
        number: detail.number,
        kind: detail.kind,
      });
      navigate.toCompose({ initialPrompt: prompt, focusPrompt: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not draft an agent prompt",
      );
    }
  }, [detail, navigate, rpc]);
  const saveMetadata = useCallback(
    async (labels: string[], assignees: string[]) => {
      if (!detail) return;
      setLabelsDraft(labels);
      setAssigneesDraft(assignees);
      setSavingMetadata(true);
      try {
        await rpc.call("updateMetadata", {
          repo: detail.repo,
          number: detail.number,
          labels,
          assignees,
        });
        await refreshDetail();
      } catch (error) {
        setLabelsDraft(detail.labels);
        setAssigneesDraft(detail.assignees);
        toast.error(errorText(error, "Metadata update failed"));
      } finally {
        setSavingMetadata(false);
      }
    },
    [detail, refreshDetail, rpc],
  );
  const repoOptions = useMemo(() => status?.repos ?? [], [status]);
  const create = useCallback(async () => {
    if (creatingIssueRef.current) return;
    if (repo === "all") return toast.error("Choose a repository first");
    creatingIssueRef.current = true;
    setCreatingIssue(true);
    try {
      const result = await rpc.call("createIssue", {
        repo,
        title: newTitle,
        body: newBody,
        assignToMe: fromMyIssues,
      });
      setNewTitle("");
      setNewBody("");
      await loadItems();
      await openItem(result);
      toast.success("Issue created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Issue creation failed",
      );
    } finally {
      creatingIssueRef.current = false;
      setCreatingIssue(false);
    }
  }, [fromMyIssues, loadItems, newBody, newTitle, openItem, repo, rpc]);

  const shownList = list.state === "ready" ? list.value : null;
  const visibleItems = shownList?.items ?? [];
  const count =
    openMine.list.state === "ready"
      ? `${openMine.list.value.items.length}${openMine.list.value.truncated ? "+" : ""}`
      : undefined;
  const issueCount =
    openIssues.list.state === "ready"
      ? `${openIssues.list.value.items.length}${openIssues.list.value.truncated ? "+" : ""}`
      : undefined;
  if (newIssue) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm md:p-5">
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => {
                navigate.toPluginPanel("gitea", {
                  subPath: fromMyIssues ? "my-issues" : "issues",
                });
              }}
            >
              ← {fromMyIssues ? "My Issues" : "Issues"}
            </Button>
            <span>New issue</span>
          </div>
          {connectionNotice(status) && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-muted-foreground">
              {connectionNotice(status)}
            </div>
          )}
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <h2 className="text-lg font-semibold">Create an issue</h2>
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger aria-label="Repository" disabled={creatingIssue}>
                <SelectValue placeholder="Choose a repository" />
              </SelectTrigger>
              <SelectContent>
                {repoOptions.map((entry) => (
                  <SelectItem key={entry.repo} value={entry.repo}>
                    {entry.repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Issue title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              disabled={creatingIssue}
              placeholder="Issue title"
            />
            <Textarea
              aria-label="Issue description"
              value={newBody}
              onChange={(event) => setNewBody(event.target.value)}
              disabled={creatingIssue}
              placeholder="Describe the issue"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={creatingIssue}
                onClick={() => navigate.toPluginPanel("gitea", { subPath: view })}
              >
                Cancel
              </Button>
              <Button
                disabled={creatingIssue || !newTitle.trim() || repo === "all"}
                onClick={() => void create()}
              >
                Create issue
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (route?.kind === "item" && shown.state === "loading") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm md:p-5">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    );
  }
  if (route?.kind === "item" && shown.state === "error") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm md:p-5">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-muted-foreground">
            <p>{shown.message}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate.toPluginPanel("gitea", { subPath: view })}
            >
              Back to list
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (route?.kind === "item" && shown.state === "ready") {
    const detail = shown.value.conversation;
    const threadId = shown.value.threadId;
    const related = detail.kind === "issue"
      ? issueReferences(detail.url, detail.repo, detail.number, [detail.body, ...detail.comments.map((comment) => comment.body)])
      : [];
    const openLinkedIssue = (repo: string, number: number) =>
      navigate.toPluginPanel("gitea", {
        subPath: routePath({ kind: "item", item: { kind: "issue", repo, number } }),
      });
    const header = (
      <div className="shrink-0 px-4 pt-4 md:px-5 md:pt-5">
        <div className="mx-auto w-full max-w-5xl space-y-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => navigate.toPluginPanel("gitea", { subPath: view })}
            >
              ← {viewLabels[view]}
            </Button>
            <span className="min-w-0 truncate">
              {detail.repo} · #{detail.number}
            </span>
            <span className="flex-1" />
            <FreshnessNote
              freshness={shown.value.freshness}
              onRefresh={() => void display.refresh()}
            />
            {detail.url && (
              <UrlLink
                href={detail.url}
                className="shrink-0 underline hover:text-foreground"
              >
                Open on Gitea ↗
              </UrlLink>
            )}
          </div>
          {shown.value.freshness.state === "stale-error" && (
              <p
                role="status"
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                Showing content from{" "}
                {new Date(shown.value.freshness.fetchedAt).toLocaleTimeString()}
                . Gitea refresh failed: {shown.value.freshness.error}
              </p>
            )}
          <div className="flex flex-wrap items-start gap-3">
            <h2 className="min-w-0 flex-1 text-xl font-semibold text-foreground">
              {detail.title}{" "}
              <span className="font-normal text-muted-foreground">
                #{detail.number}
              </span>
            </h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void setItemState(detail.state === "closed" ? "open" : "closed")
              }
            >
              {detail.state === "closed" ? "Reopen" : "Close"}
            </Button>
            {detail.kind === "pr" && detail.state === "open" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void setDraft(!detail.draft)}
              >
                {detail.draft ? "Mark ready" : "Convert to draft"}
              </Button>
            )}
            <Button size="sm" onClick={() => void draftAgent()}>
              Draft with agent
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="gap-1.5 font-normal">
              <span
                className={`size-2 rounded-full ${stateDot[detail.state]}`}
              />
              {detail.state}
            </Badge>
            {detail.kind === "pr" && detail.draft && (
              <Badge variant="outline" className="font-normal">
                draft
              </Badge>
            )}
            <span>
              {detail.repo} · {detail.author}
            </span>
            {detail.kind === "pr" && (
              <span className="font-mono">
                {detail.baseRefName} ← {detail.headRefName}
              </span>
            )}
            {threadId && (
              <Button
                size="sm"
                variant="link"
                className="h-auto px-1"
                onClick={() => navigate.toThread(threadId)}
              >
                Open linked BB thread
              </Button>
            )}
          </div>
          {detail.kind === "pr" && (
            <DetailTabsList
              comments={detail.comments.length}
              files={detail.changedFiles ?? filesCount(display.files)}
            />
          )}
        </div>
      </div>
    );
    const conversation = (
      <div className="mx-auto w-full max-w-5xl">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <main className="min-w-0 space-y-4">
            <article className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-xs text-muted-foreground">
                {detail.author} · {detail.updatedAt}
              </div>
              {detail.body ? (
                <Markdown content={detail.body} className="min-w-0" />
              ) : (
                <div className="text-muted-foreground">No description</div>
              )}
            </article>
            <section className="space-y-3 rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-semibold text-muted-foreground">
                Conversation
              </h3>
              {detail.commentsTruncated && (
                <p className="text-xs text-muted-foreground">
                  Conversation history reached the 500-comment cap and may be
                  incomplete.
                </p>
              )}
              {detail.comments.map((comment) => (
                <CommentCard
                  key={comment.id}
                  item={detail}
                  comment={comment}
                  mine={sameLogin(comment.author, status?.state === "connected" ? status.login : null)}
                  onChanged={refreshDetail}
                  className="rounded-md border border-border p-3"
                />
              ))}
              {detail.kind === "pr" && (
                <LineCommentList comments={detail.reviewComments} />
              )}
              <CommentComposer
                key={itemKey(detail)}
                item={detail}
                onPosted={refreshDetail}
              />
            </section>
          </main>
          <aside className="space-y-3">
            <section className="space-y-3 rounded-lg border border-border bg-card p-3">
              <ChipPicker
                label="Labels"
                options={
                  loadedRepoOptions?.labels.map((label) => label.name) ?? null
                }
                colors={labelColors}
                selected={labelsDraft}
                disabled={savingMetadata}
                onChange={(labels) => void saveMetadata(labels, assigneesDraft)}
              />
              <ChipPicker
                label="Assignees"
                options={loadedRepoOptions?.assignees ?? null}
                selected={assigneesDraft}
                disabled={savingMetadata}
                onChange={(assignees) =>
                  void saveMetadata(labelsDraft, assignees)
                }
              />
            </section>
            {detail.kind === "issue" && (
              <section className="space-y-3 rounded-lg border border-border bg-card p-3">
                <h3 className="text-xs font-semibold text-muted-foreground">Issue links</h3>
                {detail.relations.state === "unavailable" ? (
                  <p role="status" className="text-xs text-muted-foreground">Blockers unavailable.</p>
                ) : (
                  <>
                    {detail.relations.truncated && <p className="text-xs text-muted-foreground">Dependency lists may be incomplete.</p>}
                    {([
                      ["Blocked by", detail.relations.blockers],
                      ["Blocking", detail.relations.blocking],
                    ] as const).map(([label, links]) => (
                      <div key={label} className="space-y-1">
                        <h4 className="text-xs font-medium">{label}</h4>
                        {links.length ? links.map((link) => (
                          <button key={`${link.repo}#${link.number}`} type="button" onClick={() => openLinkedIssue(link.repo, link.number)} className="block w-full min-w-0 truncate text-left text-xs underline hover:text-foreground" title={link.title}>
                            {link.repo}#{link.number} · {link.title} ({link.state})
                          </button>
                        )) : <p className="text-xs text-muted-foreground">None</p>}
                      </div>
                    ))}
                  </>
                )}
                <div className="space-y-1">
                  <h4 className="text-xs font-medium">Related references</h4>
                  {related.length ? related.map((link) => (
                    <button key={`${link.repo}#${link.number}`} type="button" onClick={() => openLinkedIssue(link.repo, link.number)} className="block text-left text-xs underline hover:text-foreground">
                      {link.repo}#{link.number}
                    </button>
                  )) : <p className="text-xs text-muted-foreground">None</p>}
                </div>
              </section>
            )}
            {detail.kind === "pr" && (
              <>
                <section className="overflow-hidden rounded-lg border border-border bg-card">
                  <h3 className="border-b border-border bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground">
                    Checks
                  </h3>
                  {detail.checks.state === "unavailable" ? (
                    <p role="status" className="p-3 text-xs text-muted-foreground">
                      Checks unavailable.
                    </p>
                  ) : <>
                  {detail.checks.truncated && (
                    <p className="px-3 pt-2 text-xs text-muted-foreground">
                      Check list may be incomplete.
                    </p>
                  )}
                  {detail.checks.values.length ? (
                    detail.checks.values.map((check, index) => (
                      <CheckRow key={`${check.name}-${index}`} check={check} />
                    ))
                  ) : (
                    <p className="p-3 text-xs text-muted-foreground">
                      No checks reported.
                    </p>
                  )}
                  </>}
                </section>
                <section className="space-y-2 rounded-lg border border-border bg-card p-3">
                  <h3 className="text-xs font-semibold text-muted-foreground">
                    Reviews
                  </h3>
                  {detail.reviewsTruncated && (
                    <p className="text-xs text-muted-foreground">
                      Review history reached the 500-item cap and may be
                      incomplete.
                    </p>
                  )}
                  {detail.reviews.map((review, index) => (
                    <article
                      key={`${review.author}-${index}`}
                      className="border-b border-border py-2 text-xs"
                    >
                      <div className="font-medium">
                        {review.author} · {review.state}
                      </div>
                      <Markdown
                        content={review.body}
                        className="min-w-0 text-muted-foreground"
                      />
                    </article>
                  ))}
                  <Textarea
                    value={reviewBody}
                    onChange={(event) => {
                      if (reviewKey) setReviewDraft({ key: reviewKey, body: event.target.value });
                    }}
                    disabled={reviewPending}
                    placeholder="Review summary"
                  />
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reviewPending}
                      onClick={() => void submitReview("COMMENT")}
                    >
                      Comment
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reviewPending}
                      onClick={() => void submitReview("REQUEST_CHANGES")}
                    >
                      Request changes
                    </Button>
                    <Button
                      size="sm"
                      disabled={reviewPending}
                      onClick={() => void submitReview("APPROVED")}
                    >
                      Approve
                    </Button>
                  </div>
                </section>
              </>
            )}
          </aside>
        </div>
      </div>
    );
    const scroller = "min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5";
    if (detail.kind !== "pr")
      return (
        <div className="flex h-full min-h-0 flex-1 flex-col text-sm">
          {header}
          <div className={scroller}>{conversation}</div>
        </div>
      );
    return (
      <Tabs
        value={detailSection}
        onValueChange={(value) => setDetailSection(value as DetailSection)}
        className="flex h-full min-h-0 flex-1 flex-col text-sm"
      >
        {header}
        <TabsContent value="conversation" className={`mt-0 ${scroller}`}>
          {conversation}
        </TabsContent>
        <TabsContent
          value="files"
          className="mt-0 min-h-0 flex-1 px-4 py-3 md:px-5"
        >
          <div className="mx-auto h-full w-full max-w-5xl">
            <PullFilesPane
              files={display.files}
              url={filesUrl(detail)}
              moved={display.filesMoved}
              review={{
                repo: detail.repo,
                number: detail.number,
                comments: detail.reviewComments,
                onPosted: display.reload,
              }}
            />
          </div>
        </TabsContent>
      </Tabs>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="border-b border-border px-4 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
          <Tabs
            value={view}
            onValueChange={(value) => {
              navigate.toPluginPanel("gitea", { subPath: value });
              setView(value as View);
            }}
          >
            <TabsList>
              <TabsTrigger value="my-prs" className="gap-1.5">
                My PRs
                {count === undefined ? null : (
                  <Badge variant="secondary">{count}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="my-issues" className="gap-1.5">
                My Issues
                {issueCount === undefined ? null : (
                  <Badge variant="secondary">{issueCount}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="auto-fixers">Auto-fixers</TabsTrigger>
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="pulls">Pull requests</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
          {(view === "issues" || view === "my-issues") && (
            <Button
              size="sm"
              onClick={() =>
                navigate.toPluginPanel("gitea", { subPath: routePath({ kind: "new-issue", from: view === "my-issues" ? "my-issues" : "issues" }) })
              }
            >
              New issue
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {connectionNotice(status) && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {connectionNotice(status)}
            </div>
          )}
          {shownList && shownList.errors.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {shownList.errors.map((entry) => (
                <div key={entry.repo}>
                  {entry.repo}: {entry.message}
                </div>
              ))}
            </div>
          )}
          {(view === "my-prs" || view === "auto-fixers") && (
            <AutoFixerPreferencesControl />
          )}
          {view === "auto-fixers" ? (
            <AutoFixerList />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={repo} onValueChange={setRepo}>
                  <SelectTrigger className="w-52">
                    <SelectValue placeholder="All repositories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All repositories</SelectItem>
                    {repoOptions.map((entry) => (
                      <SelectItem key={entry.repo} value={entry.repo}>
                        {entry.repo}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={state}
                  onValueChange={(value) => setState(value as typeof state)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                    <SelectItem value="all">All states</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search title, body, repository"
                  className="max-w-sm"
                />
                {shownList && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    <FreshnessNote
                      freshness={
                        itemList.updating
                          ? {
                              state: "refreshing",
                              fetchedAt: shownList.freshness.fetchedAt,
                            }
                          : shownList.freshness
                      }
                    />
                  </span>
                )}
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="divide-y divide-border">
                  {list.state === "loading" ? (
                    <div
                      data-testid="bb-list-loading"
                      className="divide-y divide-border"
                    >
                      {Array.from({ length: 6 }, (_, index) => (
                        <div key={index} className="space-y-2 px-3 py-3">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-3 w-1/2" />
                        </div>
                      ))}
                    </div>
                  ) : list.state === "error" ? (
                    <div
                      role="alert"
                      className="p-8 text-center text-muted-foreground"
                    >
                      {list.message}
                    </div>
                  ) : visibleItems.length ? (
                    visibleItems.map((item) => (
                      <div
                        key={itemKey(item)}
                        className="flex flex-col gap-2 hover:bg-accent/50 sm:flex-row sm:items-center sm:pr-3"
                      >
                        <button
                          className="flex w-full min-w-0 flex-1 cursor-pointer flex-col gap-2 px-3 py-3 text-left sm:flex-row sm:items-center"
                          onClick={() => void openItem(item)}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <Badge
                              variant="outline"
                              className="gap-1.5 font-normal"
                            >
                              <span
                                className={`size-2 shrink-0 rounded-full ${stateDot[item.state]}`}
                              />
                              {item.state}
                            </Badge>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              #{item.number}
                            </span>
                            <span className="min-w-0 truncate text-sm font-medium text-foreground">
                              {item.title}
                            </span>
                            <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                              {item.repo}
                            </span>
                          </span>
                          <span className="flex flex-wrap items-center gap-1">
                            {item.labels.slice(0, 3).map((label) => (
                              <Badge
                                key={label}
                                variant="secondary"
                                className="font-normal text-muted-foreground"
                              >
                                {label}
                              </Badge>
                            ))}
                          </span>
                        </button>
                        {item.autoFixer && (
                          <span className="px-3 pb-3 sm:p-0">
                            <AutoFixerControls
                              repo={item.repo}
                              number={item.number}
                              view={item.autoFixer}
                              onChanged={reloadAutoFixers}
                            />
                          </span>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-muted-foreground">
                      {(view === "my-prs" || view === "my-issues") && status?.state !== "connected"
                        ? "Install tea and sign in with a matching Gitea login profile to see your pull requests."
                        : view === "my-prs"
                          ? "No pull requests authored by you in tracked repositories."
                          : view === "my-issues"
                            ? "No issues assigned to you in tracked repositories."
                          : repoOptions.length
                            ? "No matching items."
                            : "Add repositories in settings or attach a Gitea checkout to a BB project."}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function sameLogin(author: string, login: string | null | undefined) {
  return !!login && author.toLowerCase() === login.toLowerCase();
}

function useViewerLogin() {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [login, setLogin] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void rpc
      .call("status", null)
      .then((value) => {
        if (current) setLogin(value.state === "connected" ? value.login : null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [rpc]);
  return login;
}

function useRepoOptions(repo: string | null) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [options, setOptions] = useState<Loadable<RepoOptions>>(loading);
  useEffect(() => {
    if (!repo) {
      setOptions({ state: "loading" });
      return;
    }
    setOptions(loading);
    let current = true;
    void rpc
      .call("repoOptions", { repo })
      .then((value) => {
        if (current) setOptions({ state: "ready", value });
      })
      .catch((error: unknown) => {
        if (current) {
          setOptions({ state: "error", message: errorText(error, "Could not load labels and assignees") });
          toast.error(errorText(error, "Could not load labels and assignees"));
        }
      });
    return () => {
      current = false;
    };
  }, [repo, rpc]);
  return options;
}

function labelColor(color: string | undefined) {
  return color ? `#${color.replace(/^#/, "")}` : undefined;
}

function ChipPicker({
  label,
  options,
  selected,
  colors,
  disabled,
  onChange,
}: {
  label: string;
  options: string[] | null;
  selected: string[];
  colors?: Map<string, string>;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected.map((value) => value.toLowerCase()));
  const needle = query.trim().toLowerCase();
  const matches = (options ?? [])
    .filter(
      (option) =>
        !chosen.has(option.toLowerCase()) &&
        option.toLowerCase().includes(needle),
    )
    .slice(0, 8);
  const pick = (value: string) => {
    if (disabled) return;
    setQuery("");
    setOpen(false);
    onChange([...selected, value]);
  };
  const dot = (value: string) => {
    const color = labelColor(colors?.get(value));
    return color ? (
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
    ) : null;
  };
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
        {label}
      </h3>
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {selected.map((value) => (
            <Badge
              key={value}
              variant="secondary"
              className="gap-1 pr-1 font-normal"
            >
              {dot(value)}
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                disabled={disabled}
                className="rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onChange(selected.filter((entry) => entry !== value))
                }
              >
                <Icon name="X" className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="relative">
        <Input
          aria-label={`Add ${label.toLowerCase()}`}
          placeholder={options ? `Add ${label.toLowerCase()}…` : "Loading…"}
          value={query}
          disabled={disabled || !options}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              pick(matches[0]);
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {open && matches.length > 0 && (
          <div
            role="listbox"
            aria-label={label}
            className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {matches.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={false}
                disabled={disabled}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option);
                }}
              >
                {dot(option)}
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  item,
  comment,
  mine,
  onChanged,
  className,
}: {
  item: Pick<Item, "repo" | "number">;
  comment: ConversationComment;
  mine: boolean;
  onChanged: () => Promise<unknown>;
  className: string;
}) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const act = async (
    action: () => Promise<unknown>,
    done: string,
    failed: string,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      setMode("view");
      await onChanged();
      toast.success(done);
    } catch (error) {
      toast.error(errorText(error, failed));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const save = () =>
    act(
      () =>
        rpc.call("editComment", {
          repo: item.repo,
          number: item.number,
          id: comment.id,
          body: draft,
        }),
      "Comment updated",
      "Could not update the comment",
    );
  return (
    <article className={className}>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">
          {comment.author} · {comment.createdAt}
        </span>
        {mine && mode === "view" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setDraft(comment.body);
                setMode("edit");
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setMode("delete")}
            >
              Delete
            </Button>
          </>
        )}
      </div>
      {mode === "edit" ? (
        <div className="space-y-2">
          <Textarea
            aria-label="Edit comment"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busyRef.current) setMode("view");
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!busyRef.current && draft.trim()) void save();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setMode("view")}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !draft.trim() || draft === comment.body}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Markdown content={comment.body} className="min-w-0" />
      )}
      {mode === "delete" && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs">
          <span className="flex-1 text-muted-foreground">
            Delete this comment on Gitea?
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setMode("view")}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  rpc.call("deleteComment", {
                    repo: item.repo,
                    number: item.number,
                    id: comment.id,
                  }),
                "Comment deleted",
                "Could not delete the comment",
              )
            }
          >
            Delete
          </Button>
        </div>
      )}
    </article>
  );
}

function LineCommentList({ comments }: { comments: ReviewComment[] }) {
  if (!comments.length) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-muted-foreground">
        Line comments
      </h4>
      {comments.map((comment) => (
        <article
          key={comment.id}
          className="rounded-md border border-border p-3 text-sm"
        >
          <div className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">
              {comment.path}:{comment.line}
            </span>
            <span>
              {comment.author} · {comment.createdAt}
            </span>
          </div>
          <Markdown content={comment.body} className="min-w-0" />
        </article>
      ))}
    </div>
  );
}

function CommentComposer({
  item,
  onPosted,
}: {
  item: Pick<Item, "repo" | "number">;
  onPosted: () => Promise<unknown>;
}) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const submit = async () => {
    if (postingRef.current || !draft.trim()) return;
    postingRef.current = true;
    setPosting(true);
    try {
      await rpc.call("comment", {
        repo: item.repo,
        number: item.number,
        body: draft,
      });
      setDraft((current) => current === draft ? "" : current);
      await onPosted();
      toast.success("Comment added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Comment failed");
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };
  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        disabled={posting}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Write a comment"
      />
      <div className="flex justify-end">
        <Button
          disabled={posting || !draft.trim()}
          onClick={() => void submit()}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}

function GiteaThreadPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [linked, setLinked] = useState<Loadable<ItemRef>>(loading);
  useEffect(() => {
    let current = true;
    setLinked(loading);
    void rpc
      .call("threadItem", { threadId })
      .then((linked) => {
        if (!current) return;
        setLinked(linked
          ? { state: "ready", value: linked }
          : { state: "error", message: "This BB thread is not linked to a Gitea issue or pull request." });
      })
      .catch((reason: unknown) => {
        if (current)
          setLinked({ state: "error", message: errorText(reason, "Could not load the linked Gitea item.") });
      });
    return () => {
      current = false;
    };
  }, [rpc, threadId]);
  const [section, setSection] = useState<DetailSection>("conversation");
  useEffect(() => setSection("conversation"), [threadId]);
  const viewer = useViewerLogin();
  const item = linked.state === "ready" ? linked.value : null;
  const display = useItemDisplay(
    item,
    item?.kind === "pr" && section === "files",
  );
  const shown = display.conversation;
  if (linked.state === "error" || shown.state === "error")
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {linked.state === "error" ? linked.message : shown.state === "error" ? shown.message : ""}
      </div>
    );
  if (linked.state === "loading" || shown.state === "loading")
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading Gitea item…
      </div>
    );
  const detail = shown.value.conversation;
  const header = (
    <header className="shrink-0 space-y-2 border-b p-4">
      <div className="font-semibold">{detail.title}</div>
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="flex-1">
          {detail.repo}#{detail.number} · {detail.kind} · {detail.state}
        </span>
        <FreshnessNote
          freshness={shown.value.freshness}
          onRefresh={() => void display.refresh()}
        />
      </div>
      {detail.kind === "pr" && (
        <DetailTabsList
          comments={detail.comments.length}
          files={detail.changedFiles ?? filesCount(display.files)}
        />
      )}
    </header>
  );
  const conversation = (
    <>
      <article className="border-b p-4">
        <div className="mb-2 text-xs text-muted-foreground">
          {detail.author}
        </div>
        {detail.body ? (
          <Markdown content={detail.body} className="min-w-0" />
        ) : (
          <div className="text-muted-foreground">No description</div>
        )}
      </article>
      <section className="p-4">
        <h3 className="mb-2 font-medium">Conversation</h3>
        {detail.commentsTruncated && (
          <div className="mb-2 text-xs text-muted-foreground">
            Conversation history reached the 500-comment cap and may be
            incomplete.
          </div>
        )}
        {detail.comments.map((comment) => (
          <CommentCard
            key={comment.id}
            item={detail}
            comment={comment}
            mine={sameLogin(comment.author, viewer)}
            onChanged={display.reload}
            className="mb-3 rounded border p-3"
          />
        ))}
        {detail.kind === "pr" && (
          <LineCommentList comments={detail.reviewComments} />
        )}
        <CommentComposer
          key={itemKey(detail)}
          item={detail}
          onPosted={display.reload}
        />
      </section>
    </>
  );
  if (detail.kind !== "pr")
    return (
      <div className="flex h-full min-h-0 flex-col text-sm">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">{conversation}</div>
      </div>
    );
  return (
    <Tabs
      value={section}
      onValueChange={(value) => setSection(value as DetailSection)}
      className="flex h-full min-h-0 flex-col text-sm"
    >
      {header}
      <TabsContent
        value="conversation"
        className="mt-0 min-h-0 flex-1 overflow-y-auto"
      >
        {conversation}
      </TabsContent>
      <TabsContent value="files" className="mt-0 min-h-0 flex-1 p-3">
        <PullFilesPane
          files={display.files}
          url={filesUrl(detail)}
          moved={display.filesMoved}
          review={{
            repo: detail.repo,
            number: detail.number,
            comments: detail.reviewComments,
            onPosted: display.reload,
          }}
        />
      </TabsContent>
    </Tabs>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gitea",
    title: "Gitea",
    icon: "gitea/teacup",
    path: "gitea",
    component: GiteaPanel,
  });
  app.slots.threadPanelAction({
    id: "item",
    title: "Gitea issue or PR",
    icon: "gitea/teacup",
    component: GiteaThreadPanel,
  });
  app.slots.experimental_appOverlay({
    id: "display-scope",
    component: DisplayScopeWatch,
  });
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID,
    component: GiteaBranchInputsControl,
  });
});
