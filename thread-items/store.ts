import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  itemSnapshotSchema,
  linkSources,
  type ItemKind,
  type ItemSnapshot,
  type LinkSource,
} from "./contract.js";
import type { CreationWindow } from "./detect.js";
import { hotForMs, touchThrottleMs } from "./pull-state.js";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

const migrations = [
  `CREATE TABLE thread_items (
    server TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    repo_key TEXT NOT NULL,
    number INTEGER NOT NULL,
    repo TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
    source TEXT NOT NULL CHECK (source IN ('sent', 'auto-fixer', 'opened', 'pushed', 'linked')),
    account TEXT,
    linked_at INTEGER NOT NULL,
    created_from INTEGER,
    created_to INTEGER,
    fallback_source TEXT CHECK (fallback_source IN ('sent', 'auto-fixer', 'pushed', 'linked')),
    fallback_account TEXT,
    PRIMARY KEY (server, thread_id, repo_key, number)
  )`,
  `CREATE INDEX thread_items_by_item ON thread_items (server, repo_key, number, linked_at)`,
  `CREATE TABLE pull_states (
    server TEXT NOT NULL,
    repo_key TEXT NOT NULL,
    number INTEGER NOT NULL,
    snapshot TEXT,
    checked_at INTEGER,
    due_at INTEGER DEFAULT 0,
    touched_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    resets INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server, repo_key, number)
  )`,
  `CREATE INDEX pull_states_due ON pull_states (server, due_at)`,
  `CREATE TABLE scan_cursors (
    server TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    after_seq INTEGER NOT NULL,
    PRIMARY KEY (server, thread_id)
  )`,
  // Development builds of 1.1.0 kept state for pull requests only, in
  // snapshots without a kind.
  `ALTER TABLE pull_states RENAME TO item_states`,
  `UPDATE item_states SET snapshot = json_set(snapshot, '$.kind', 'pr')
    WHERE snapshot IS NOT NULL AND json_extract(snapshot, '$.kind') IS NULL`,
  `INSERT OR IGNORE INTO item_states (server, repo_key, number)
    SELECT DISTINCT server, repo_key, number FROM thread_items`,
  `CREATE TABLE unresolved_creates (
    server TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_from INTEGER NOT NULL,
    created_to INTEGER NOT NULL,
    numbers TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server, thread_id, created_from, created_to)
  )`,
];

export type ItemId = { repoKey: string; number: number };

export type NewLink = ItemId & {
  threadId: string;
  repo: string;
  kind: ItemKind;
  source: LinkSource;
  account: string | null;
  linkedAt: number;
  window: CreationWindow | null;
};

/** A create command whose output named its pull requests only by number; see `DetectedCreate`. */
export type NewCreate = {
  threadId: string;
  numbers: number[];
  linkedAt: number;
  window: CreationWindow;
};

/** A create waiting for the refresher to find its pull requests. `failures` counts consecutive failed searches. */
export type UnresolvedCreate = NewCreate & { failures: number };

export type ItemState = {
  snapshot: ItemSnapshot | null;
  dueAt: number | null;
  touchedAt: number | null;
  failures: number;
  error: string | null;
  /** How many times the plugin expired this row; a read saves its due time only if this has not moved since. */
  resets: number;
};

export type DueItem = ItemId & ItemState & { kind: ItemKind };

export type StoredLink = Omit<NewLink, "window"> & { state: ItemState | null };

const linkRowSchema = z.object({
  thread_id: z.string(),
  repo_key: z.string(),
  number: z.number(),
  repo: z.string(),
  kind: z.enum(["issue", "pr"]),
  source: z.enum(linkSources),
  account: z.string().nullable(),
  linked_at: z.number(),
});
const stateRowSchema = z.object({
  snapshot: z.string().nullable(),
  due_at: z.number().nullable(),
  touched_at: z.number().nullable(),
  failures: z.number(),
  error: z.string().nullable(),
  resets: z.number(),
});
const joinedRowSchema = linkRowSchema.extend({ state_present: z.string().nullable() });
const dueRowSchema = stateRowSchema.extend({ repo_key: z.string(), number: z.number(), kind: z.enum(["issue", "pr"]) });
const sourceRowSchema = z.object({ source: z.enum(linkSources) });
const createRowSchema = z.object({
  thread_id: z.string(),
  created_from: z.number(),
  created_to: z.number(),
  numbers: z.string().transform((raw) => z.array(z.number()).parse(JSON.parse(raw))),
  linked_at: z.number(),
  failures: z.number(),
});

function parseSnapshot(raw: string | null): ItemSnapshot | null {
  if (raw === null) return null;
  const parsed = itemSnapshotSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

function itemState(row: z.infer<typeof stateRowSchema>): ItemState {
  return {
    snapshot: parseSnapshot(row.snapshot),
    dueAt: row.due_at,
    touchedAt: row.touched_at,
    failures: row.failures,
    error: row.error,
    resets: row.resets,
  };
}

function storedLink(row: z.infer<typeof linkRowSchema>): Omit<StoredLink, "state"> {
  return {
    threadId: row.thread_id,
    repoKey: row.repo_key,
    number: row.number,
    repo: row.repo,
    kind: row.kind,
    source: row.source,
    account: row.account,
    linkedAt: row.linked_at,
  };
}

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

const sameItem = `server = @server AND repo_key = @repoKey AND number = @number`;
const unconfirmed = `source = 'opened' AND created_from IS NOT NULL`;
const outsideWindow = `(@createdAt < created_from OR @createdAt > created_to)`;

/** Unconfirmed `opened` rows matching `condition` take their fallback source; `rejectCandidate` deletes the rest. */
const promoteFallback = (condition: string) => `
  UPDATE thread_items SET source = fallback_source, account = fallback_account,
    fallback_source = NULL, fallback_account = NULL, created_from = NULL, created_to = NULL
  WHERE ${sameItem} AND ${unconfirmed} AND ${condition} AND fallback_source IS NOT NULL`;
const rejectCandidate = (condition: string) =>
  `DELETE FROM thread_items WHERE ${sameItem} AND ${unconfirmed} AND ${condition}`;

/** The plugin's thread link, item state, and scan cursor tables, scoped by Gitea server. */
export function openStore(
  storage: Pick<BbPluginApi["storage"], "database" | "migrate">,
) {
  const db: Database = storage.database();
  storage.migrate(db, migrations);

  const sql = {
    // An unconfirmed `opened` row keeps its label and window; the first other
    // source to arrive waits as its fallback in case the window rejects it.
    insertLink: db.prepare(`
      INSERT INTO thread_items
        (server, thread_id, repo_key, number, repo, kind, source, account, linked_at, created_from, created_to)
      VALUES (@server, @threadId, @repoKey, @number, @repo, @kind, @source, @account, @linkedAt, @from, @to)
      ON CONFLICT (server, thread_id, repo_key, number) DO UPDATE SET
        fallback_source = excluded.source, fallback_account = excluded.account
      WHERE thread_items.${unconfirmed} AND thread_items.fallback_source IS NULL
        AND excluded.source <> 'opened'`),
    deleteLink: db.prepare(`
      DELETE FROM thread_items WHERE ${sameItem} AND thread_id = @threadId AND kind = @kind
      RETURNING source`),
    accountLinks: db.prepare(`
      SELECT * FROM thread_items
      WHERE server = ? AND source IN ('sent', 'linked') AND account = ?
      ORDER BY linked_at, rowid`),
    latestStarted: db.prepare(`
      SELECT thread_id FROM thread_items
      WHERE server = ? AND repo_key = ? AND number = ? AND source IN ('sent', 'auto-fixer', 'linked')
      ORDER BY linked_at DESC, rowid DESC LIMIT 1`),
    promoteOutside: db.prepare(promoteFallback(outsideWindow)),
    rejectOutside: db.prepare(rejectCandidate(outsideWindow)),
    promoteAll: db.prepare(promoteFallback("1")),
    rejectAll: db.prepare(rejectCandidate("1")),
    confirmInside: db.prepare(`
      UPDATE thread_items SET created_from = NULL, created_to = NULL, fallback_source = NULL, fallback_account = NULL
      WHERE ${sameItem} AND ${unconfirmed}`),
    insertState: db.prepare(
      `INSERT OR IGNORE INTO item_states (server, repo_key, number) VALUES (?, ?, ?)`,
    ),
    selectState: db.prepare(
      `SELECT * FROM item_states WHERE server = ? AND repo_key = ? AND number = ?`,
    ),
    // A number linked both ways is read as a pull request; Gitea answers a
    // wrong kind with an error the row shows.
    dueItems: db.prepare(`
      SELECT * FROM (
        SELECT s.*, (SELECT MAX(l.kind) FROM thread_items l
          WHERE l.server = s.server AND l.repo_key = s.repo_key AND l.number = s.number) AS kind
        FROM item_states s
        WHERE s.server = ? AND s.due_at IS NOT NULL AND s.due_at <= ?
      ) WHERE kind IS NOT NULL
      ORDER BY due_at LIMIT ?`),
    saveSnapshot: db.prepare(`
      INSERT INTO item_states (server, repo_key, number, snapshot, checked_at, due_at, failures, error)
      VALUES (@server, @repoKey, @number, @snapshot, @checkedAt, @dueAt, 0, NULL)
      ON CONFLICT (server, repo_key, number) DO UPDATE SET
        snapshot = excluded.snapshot, checked_at = excluded.checked_at, failures = 0, error = NULL,
        due_at = CASE WHEN resets = @resets THEN excluded.due_at ELSE due_at END`),
    saveFailure: db.prepare(`
      UPDATE item_states SET failures = @failures, error = @error,
        due_at = CASE WHEN resets = @resets THEN @dueAt ELSE due_at END
      WHERE ${sameItem}`),
    touch: db.prepare(`
      UPDATE item_states SET
        due_at = CASE WHEN due_at IS NOT NULL AND (touched_at IS NULL OR touched_at < @cold) THEN MIN(due_at, @now) ELSE due_at END,
        touched_at = @now
      WHERE ${sameItem} AND (touched_at IS NULL OR touched_at < @recent)`),
    expire: db.prepare(
      `UPDATE item_states SET due_at = 0, resets = resets + 1 WHERE ${sameItem}`,
    ),
    readCursor: db.prepare(
      `SELECT after_seq FROM scan_cursors WHERE server = ? AND thread_id = ?`,
    ),
    writeCursor: db.prepare(`
      INSERT INTO scan_cursors (server, thread_id, after_seq) VALUES (?, ?, ?)
      ON CONFLICT (server, thread_id) DO UPDATE SET after_seq = MAX(after_seq, excluded.after_seq)`),
    deleteCursor: db.prepare(
      `DELETE FROM scan_cursors WHERE server = ? AND thread_id = ?`,
    ),
    insertCreate: db.prepare(`
      INSERT OR IGNORE INTO unresolved_creates (server, thread_id, created_from, created_to, numbers, linked_at)
      VALUES (@server, @threadId, @from, @to, @numbers, @linkedAt)`),
    dueCreate: db.prepare(`
      SELECT * FROM unresolved_creates WHERE server = ? AND due_at <= ?
      ORDER BY due_at, rowid LIMIT 1`),
    deleteCreate: db.prepare(`
      DELETE FROM unresolved_creates
      WHERE server = @server AND thread_id = @threadId AND created_from = @from AND created_to = @to`),
    saveCreateFailure: db.prepare(`
      UPDATE unresolved_creates SET failures = @failures, due_at = @dueAt
      WHERE server = @server AND thread_id = @threadId AND created_from = @from AND created_to = @to`),
  };
  const createKeys = (server: string, create: NewCreate) =>
    ({ server, threadId: create.threadId, from: create.window.from, to: create.window.to });

  function readState(server: string, item: ItemId): ItemState | null {
    const row = sql.selectState.get(server, item.repoKey, item.number);
    return row === undefined ? null : itemState(stateRowSchema.parse(row));
  }

  function addLinks(server: string, links: readonly NewLink[]): NewLink[] {
    const added: NewLink[] = [];
    for (const link of links) {
      const { changes } = sql.insertLink.run({
        server,
        threadId: link.threadId,
        repoKey: link.repoKey,
        number: link.number,
        repo: link.repo,
        kind: link.kind,
        source: link.source,
        account: link.account,
        linkedAt: link.linkedAt,
        from: link.window?.from ?? null,
        to: link.window?.to ?? null,
      });
      if (changes === 0) continue;
      added.push(link);
      sql.insertState.run(server, link.repoKey, link.number);
      const known = readState(server, link)?.snapshot;
      if (known?.kind === "pr") settleWindows(server, link, Date.parse(known.createdAt));
    }
    return added;
  }

  /**
   * Settles the unconfirmed `opened` rows of a pull request created at
   * `createdAt`. Inside its window a row is confirmed as `opened`. Outside it,
   * a row takes its fallback source, or is deleted when it has none. Returns
   * how many rows changed source or were deleted.
   */
  function settleWindows(server: string, item: ItemId, createdAt: number): number {
    const keys = { server, repoKey: item.repoKey, number: item.number, createdAt };
    const changed = sql.promoteOutside.run(keys).changes + sql.rejectOutside.run(keys).changes;
    sql.confirmInside.run(keys);
    return changed;
  }

  return {
    /** Inserts links; a link already present is kept as it was, except that an unconfirmed `opened` one records its first other source. Returns the links that changed. */
    addLinks: (server: string, links: readonly NewLink[]) =>
      db.transaction(() => addLinks(server, links))(),

    /** Inserts links of several servers at once. */
    importLinks: (byServer: ReadonlyMap<string, readonly NewLink[]>) =>
      db.transaction(() => {
        for (const [server, links] of byServer) addLinks(server, links);
      })(),

    /**
     * Inserts the links and unresolved creates one event page found and moves
     * the thread's cursor past that page, atomically. Returns the links that
     * changed and how many creates were new.
     */
    addScannedPage: (
      server: string,
      threadId: string,
      found: { links: readonly NewLink[]; creates: readonly NewCreate[] },
      lastSeq: number,
    ) =>
      db.transaction(() => {
        const links = addLinks(server, found.links);
        let creates = 0;
        for (const create of found.creates)
          creates += sql.insertCreate.run({
            ...createKeys(server, create),
            numbers: JSON.stringify(create.numbers),
            linkedAt: create.linkedAt,
          }).changes;
        sql.writeCursor.run(server, threadId, lastSeq);
        return { links, creates };
      })(),

    /** The unresolved create whose search is due soonest, or null when none is due. */
    dueCreate(server: string, now: number): UnresolvedCreate | null {
      const raw = sql.dueCreate.get(server, now);
      if (raw === undefined) return null;
      const row = createRowSchema.parse(raw);
      return {
        threadId: row.thread_id,
        numbers: row.numbers,
        linkedAt: row.linked_at,
        window: { from: row.created_from, to: row.created_to },
        failures: row.failures,
      };
    },

    /** Inserts the links a create's search found and forgets the create, atomically. Returns the links that changed. */
    resolveCreate: (server: string, create: NewCreate, links: readonly NewLink[]) =>
      db.transaction(() => {
        const added = addLinks(server, links);
        sql.deleteCreate.run(createKeys(server, create));
        return added;
      })(),

    saveCreateFailure(server: string, create: NewCreate, failure: { failures: number; dueAt: number }) {
      sql.saveCreateFailure.run({ ...createKeys(server, create), ...failure });
    },

    /** Deletes a thread's link to an item of `kind`. Returns the deleted link's source, or null when there was none. */
    removeLink(server: string, threadId: string, item: ItemId, kind: ItemKind): LinkSource | null {
      const row = sql.deleteLink.get({ server, threadId, repoKey: item.repoKey, number: item.number, kind });
      return row === undefined ? null : sourceRowSchema.parse(row).source;
    },

    linksOf(server: string, threadIds: readonly string[]): StoredLink[] {
      if (threadIds.length === 0) return [];
      return db
        .prepare(`
          SELECT l.*, s.server AS state_present, s.snapshot, s.due_at, s.touched_at, s.failures, s.error, s.resets
          FROM thread_items l
          LEFT JOIN item_states s ON s.server = l.server AND s.repo_key = l.repo_key AND s.number = l.number
          WHERE l.server = ? AND l.thread_id IN (${placeholders(threadIds.length)})
          ORDER BY l.linked_at DESC, l.rowid DESC`)
        .all(server, ...threadIds)
        .map((raw: unknown) => {
          const row = joinedRowSchema.parse(raw);
          return {
            ...storedLink(row),
            state: row.state_present === null ? null : itemState(stateRowSchema.parse(raw)),
          };
        });
    },

    /**
     * Threads sent for or linked to an item from one account, oldest first.
     * Gitea can switch servers and accounts, so badges stay scoped to the
     * identity the lists are shown for.
     */
    accountLinks: (server: string, account: string) =>
      sql.accountLinks.all(server, account).map((row: unknown) => storedLink(linkRowSchema.parse(row))),

    /** The thread most recently started for or linked to an item. */
    latestStartedThread: (server: string, item: ItemId) =>
      z.object({ thread_id: z.string() }).optional().parse(sql.latestStarted.get(server, item.repoKey, item.number))?.thread_id,

    readState,

    cursor: (server: string, threadId: string) =>
      z.object({ after_seq: z.number() }).optional().parse(sql.readCursor.get(server, threadId))?.after_seq ?? 0,

    forgetCursor(server: string, threadId: string) {
      sql.deleteCursor.run(server, threadId);
    },

    /** Items linked to some thread whose refresh is due, soonest first. */
    dueItems: (server: string, now: number, limit: number): DueItem[] =>
      sql.dueItems.all(server, now, limit).map((raw: unknown) => {
        const row = dueRowSchema.parse(raw);
        return { repoKey: row.repo_key, number: row.number, kind: row.kind, ...itemState(row) };
      }),

    /**
     * Records a successful read and settles a pull request's `opened`
     * candidates against its creation time. `resets` is the row's count when the read began; if the
     * plugin expired the row since, its due time stays. Returns whether a link
     * changed source or was deleted.
     */
    saveSnapshot: (
      server: string,
      item: ItemId,
      read: { snapshot: ItemSnapshot; checkedAt: number; dueAt: number | null; resets: number },
    ) =>
      db.transaction(() => {
        sql.saveSnapshot.run({
          server,
          repoKey: item.repoKey,
          number: item.number,
          snapshot: JSON.stringify(read.snapshot),
          checkedAt: read.checkedAt,
          dueAt: read.dueAt,
          resets: read.resets,
        });
        return read.snapshot.kind === "pr" && settleWindows(server, item, Date.parse(read.snapshot.createdAt)) > 0;
      })(),

    /**
     * Gitea has no such pull request, so no thread created it: every
     * unconfirmed `opened` row of it takes its fallback source, or is deleted
     * when it has none. Returns whether a link changed source or was deleted.
     */
    rejectCandidates(server: string, item: ItemId): boolean {
      const keys = { server, repoKey: item.repoKey, number: item.number };
      return db.transaction(() => sql.promoteAll.run(keys).changes + sql.rejectAll.run(keys).changes)() > 0;
    },

    saveFailure(server: string, item: ItemId, failure: { failures: number; error: string; dueAt: number | null; resets: number }) {
      sql.saveFailure.run({ server, repoKey: item.repoKey, number: item.number, ...failure });
    },

    /**
     * Marks items as looked at, at most once per `touchThrottleMs` per
     * row. A row that was not hot becomes due now, so a thread someone opens
     * refreshes promptly. Returns whether any of them is due.
     */
    touch: (server: string, items: readonly ItemId[], now: number) =>
      db.transaction(() => {
        let due = false;
        for (const item of items) {
          sql.touch.run({ server, repoKey: item.repoKey, number: item.number, now, cold: now - hotForMs, recent: now - touchThrottleMs });
          const dueAt = readState(server, item)?.dueAt;
          if (dueAt !== undefined && dueAt !== null && dueAt <= now) due = true;
        }
        return due;
      })(),

    /** The plugin changed this item, so read it again on the next sweep. */
    expire(server: string, item: ItemId) {
      sql.expire.run({ server, repoKey: item.repoKey, number: item.number });
    },
  };
}
