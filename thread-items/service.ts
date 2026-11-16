import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { itemKey, repoKey } from "../auto-fixer.js";
import type {
  CiState,
  ItemKind,
  LinkSource,
  PullSnapshot,
  ThreadIssue,
  ThreadItemsView,
  ThreadLink,
  ThreadPull,
  threadItemsRpcMethods,
} from "./contract.js";
import { importLegacy } from "./legacy-import.js";
import { summarize } from "./pull-state.js";
import { createRefresher } from "./refresher.js";
import { createScanner } from "./scanner.js";
import { openStore, type ItemId, type NewLink, type StoredLink } from "./store.js";

/** What the thread items service needs from the Gitea side of the plugin. */
export interface GiteaReads {
  /** The cleaned base URL href of the configured server, with a trailing slash. */
  server(): string;
  /** The display account the plugin scopes lists and badges to. */
  account(): Promise<string>;
  /** `pulls/{n}` JSON. Throws when Gitea cannot answer. */
  pull(repo: string, number: number, signal?: AbortSignal): Promise<unknown>;
  ci(repo: string, sha: string, signal?: AbortSignal): Promise<CiState>;
  /** Whether `issues/{n}` is an issue or a pull request. */
  kind(repo: string, number: number): Promise<ItemKind>;
}

type RecordInput = {
  threadId: string;
  repo: string;
  number: number;
  kind: ItemKind;
  source: Extract<LinkSource, "sent" | "auto-fixer">;
  account: string;
};

const maxDepth = 4;
const maxThreads = 50;
const treeTtlMs = 30_000;
const changed = "thread-items-changed";

type Tree = { threads: { id: string; title: string | null }[]; truncated: boolean };
type PullRows = [StoredLink, ...StoredLink[]];

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function itemOf(repo: string, number: number): ItemId {
  return { repoKey: repoKey(repo), number };
}

/** Whether the plugin's badges show this source: threads it started or someone linked. */
const badged = (source: LinkSource) => source === "sent" || source === "linked";

/**
 * The one owner of thread-to-item links: who linked which Gitea item to which
 * thread and how, detected pull requests from thread commands, and the state
 * of every linked pull request.
 */
export async function registerThreadItems(bb: BbPluginApi, gitea: GiteaReads) {
  const store = openStore(bb.storage);
  const publish = () => bb.realtime.publish(changed, {});
  const refresher = createRefresher({ store, gitea, publish, log: bb.log });
  const scanner = createScanner({
    bb,
    store,
    server: () => gitea.server(),
    publish,
    added(links: readonly NewLink[]) {
      if (links.length === 0) return;
      publish();
      if (links.some((link) => link.kind === "pr")) refresher.wake();
    },
  });

  const trees = new Map<string, { at: number; tree: Promise<Tree> }>();

  async function children(threadId: string) {
    const lists = await Promise.all(
      [false, true].map((archived) =>
        bb.sdk.threads.list({ parentThreadId: threadId, includeHidden: true, archived }),
      ),
    );
    return lists.flat().map((thread) => ({
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? null,
    }));
  }

  async function walk(root: string): Promise<Tree> {
    const threads = new Map<string, string | null>([[root, null]]);
    let truncated = false;
    let level = [root];
    for (let depth = 0; depth < maxDepth && level.length > 0; depth += 1) {
      const next: string[] = [];
      for (const parent of level) {
        let found: { id: string; title: string | null }[];
        try {
          found = await children(parent);
        } catch (error) {
          bb.log.warn(`Could not list the child threads of ${parent}: ${message(error)}`);
          truncated = true;
          continue;
        }
        for (const child of found) {
          if (threads.has(child.id)) continue;
          if (threads.size >= maxThreads) {
            truncated = true;
            break;
          }
          threads.set(child.id, child.title);
          next.push(child.id);
        }
      }
      level = next;
    }
    return {
      threads: [...threads].map(([id, title]) => ({ id, title })),
      truncated,
    };
  }

  function treeOf(root: string): Promise<Tree> {
    const now = Date.now();
    const cached = trees.get(root);
    if (cached && now - cached.at < treeTtlMs) return cached.tree;
    for (const [id, entry] of trees) if (now - entry.at >= treeTtlMs) trees.delete(id);
    const tree = walk(root);
    trees.set(root, { at: now, tree });
    return tree;
  }

  function pullOf(server: string, root: string, titles: Map<string, string | null>, rows: PullRows): ThreadPull {
    const [first] = rows;
    const own = rows.find((row) => row.threadId === root);
    const { state } = first;
    return {
      repo: (own ?? first).repo,
      number: first.number,
      url: `${server}${(own ?? first).repo}/pulls/${first.number}`,
      state: state?.snapshot ?? null,
      error: state && state.snapshot === null && state.failures > 0 ? state.error : null,
      stale: state !== null && state.snapshot !== null && state.failures > 0,
      via: own
        ? { type: "own", source: own.source }
        : { type: "child", threadId: first.threadId, threadTitle: titles.get(first.threadId) ?? null },
      links: rows.map((row) => ({
        threadId: row.threadId,
        threadTitle: titles.get(row.threadId) ?? null,
        source: row.source,
        linkedAt: row.linkedAt,
        own: row.threadId === root,
      })),
    };
  }

  async function view(threadId: string): Promise<ThreadItemsView> {
    const tree = await treeOf(threadId);
    const ids = tree.threads.map((thread) => thread.id);
    const scanning = (await Promise.all(ids.map((id) => scanner.forRead(id)))).some(Boolean);
    const server = gitea.server();
    const titles = new Map(tree.threads.map((thread) => [thread.id, thread.title]));
    const byPull = new Map<string, PullRows>();
    const issues: ThreadIssue[] = [];
    for (const row of store.linksOf(server, ids)) {
      if (row.kind === "issue") {
        if (row.threadId === threadId)
          issues.push({
            repo: row.repo,
            number: row.number,
            url: `${server}${row.repo}/issues/${row.number}`,
            source: row.source,
            linkedAt: row.linkedAt,
          });
        continue;
      }
      const key = itemKey(row.repoKey, row.number);
      const rows = byPull.get(key);
      if (rows) rows.push(row);
      else byPull.set(key, [row]);
    }
    const pulls = [...byPull.values()].map((rows) => pullOf(server, threadId, titles, rows));
    if (store.touch(server, pulls.map((pull) => itemOf(pull.repo, pull.number)), Date.now()))
      refresher.wake();
    return {
      threadId,
      server,
      scanning,
      descendantsTruncated: tree.truncated,
      pulls,
      issues,
      summary: summarize(pulls),
    };
  }

  async function requireThread(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === "thread_not_found") return null;
      throw error;
    });
    if (!thread || thread.deletedAt) throw new Error(`BB thread ${threadId} was not found.`);
  }

  function linkChanged(source: LinkSource, kind: ItemKind, repo: string, number: number) {
    publish();
    if (badged(source))
      bb.realtime.publish("links-changed", { item: `${kind}:${itemKey(repo, number)}` });
  }

  bb.background.service("thread-items", { start: (signal) => refresher.start(signal) });

  const scanQuietly = (threadId: string) => scanner.toEnd(threadId);
  bb.events.on("thread.idle", ({ thread }) => scanQuietly(thread.id));
  bb.events.on("thread.failed", ({ thread }) => scanQuietly(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => scanner.forget(thread.id));

  try {
    await importLegacy({ kv: bb.storage.kv, gitea, store, log: bb.log });
  } catch (error) {
    bb.log.warn(`Gitea thread links from before 1.1.0 will be imported on the next load: ${message(error)}`);
  }

  const handlers = {
    threadItems: ({ threadId }) => view(threadId),
    async linkItem({ threadId, repo, number, kind }): Promise<{ result: "added" | "already" }> {
      const server = gitea.server();
      const item = itemOf(repo, number);
      const [account] = await Promise.all([gitea.account(), requireThread(threadId)]);
      let read: { snapshot: PullSnapshot; resets: number } | null = null;
      if (kind === "pr") {
        const previous = store.readState(server, item);
        try {
          read = { snapshot: await refresher.read(repo, number, previous?.snapshot ?? null), resets: previous?.resets ?? 0 };
        } catch (error) {
          if ((await gitea.kind(repo, number).catch(() => null)) === "issue")
            throw new Error(`${repo}#${number} is an issue; link it as issue.`);
          throw new Error(`Could not read pull request ${repo}#${number} on ${server}: ${message(error)}`);
        }
      } else {
        let actual: ItemKind;
        try {
          actual = await gitea.kind(repo, number);
        } catch (error) {
          throw new Error(`Could not read issue ${repo}#${number} on ${server}: ${message(error)}`);
        }
        if (actual !== "issue") throw new Error(`${repo}#${number} is a pull request; link it as pr.`);
      }
      const changes = store.addLinks(server, [{
        threadId, repo, ...item, kind, source: "linked", account,
        linkedAt: Date.now(), window: null,
      }]);
      if (read) refresher.saveRead(server, item, read.snapshot, read.resets);
      if (changes.length === 0) {
        if (read) publish();
        return { result: "already" };
      }
      linkChanged("linked", kind, repo, number);
      return { result: "added" };
    },
    async unlinkItem({ threadId, repo, number, kind }) {
      const removed = store.removeLink(gitea.server(), threadId, itemOf(repo, number), kind);
      if (removed) linkChanged(removed, kind, repo, number);
      return { removed: removed !== null };
    },
  } satisfies PluginRpcHandlers<typeof threadItemsRpcMethods>;

  return {
    handlers,
    view,
    server: () => gitea.server(),

    /** Links an item to a thread the plugin started for it. */
    record(input: RecordInput) {
      const changes = store.addLinks(gitea.server(), [{
        ...input, repoKey: repoKey(input.repo), linkedAt: Date.now(), window: null,
      }]);
      if (changes.length === 0) return;
      linkChanged(input.source, input.kind, input.repo, input.number);
      if (input.kind === "pr") refresher.wake();
    },

    /** Every thread sent for or linked to an item from this account, by `kind:owner/repo#n`, oldest first. */
    async badgeLinks(): Promise<{ account: string; links: Record<string, ThreadLink[]> }> {
      const account = await gitea.account();
      const links: Record<string, ThreadLink[]> = {};
      for (const row of store.accountLinks(gitea.server(), account)) {
        const key = `${row.kind}:${itemKey(row.repo, row.number)}`;
        (links[key] ??= []).push({
          repo: row.repo,
          number: row.number,
          kind: row.kind,
          threadId: row.threadId,
          createdAt: new Date(row.linkedAt).toISOString(),
        });
      }
      return { account, links };
    },

    latestThread: (repo: string, number: number) =>
      store.latestStartedThread(gitea.server(), itemOf(repo, number)),

    /** The plugin changed this pull request; read it again soon. */
    expire(repo: string, number: number) {
      store.expire(gitea.server(), itemOf(repo, number));
      refresher.wake();
    },

    rescan: (threadId: string) => scanner.rescan(threadId),
  };
}

export type ThreadItems = Awaited<ReturnType<typeof registerThreadItems>>;
