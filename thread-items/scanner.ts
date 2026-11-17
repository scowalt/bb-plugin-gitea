import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { repoKey } from "../auto-fixer.js";
import { detect, type DetectedCreate, type DetectedLink } from "./detect.js";
import type { NewCreate, NewLink, openStore } from "./store.js";

/** How many full event pages a reader waits for before it returns with `scanning: true`. */
const SCAN_PAGES_PER_READ = 3;
/** The most events bb's server returns in one `events.list` call; it rejects a larger limit. */
const pageSize = 100;
/** A reader reuses a scan that finished this recently instead of asking bb for the thread's events again. */
const readerScanMs = 30_000;

const eventRowsSchema = z.array(
  z.object({ seq: z.number(), createdAt: z.number(), type: z.string(), data: z.unknown() }),
);

type Run = {
  promise: Promise<void>;
  /** A reader returned while this run was scanning, so its end changes what that reader showed. */
  observed: boolean;
  /**
   * Resolves once `count` more full pages are read, and marks the run observed
   * at that moment, before it can end. Never resolves when the run ends first.
   */
  afterPages(count: number): Promise<void>;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function detectedLink(threadId: string, link: DetectedLink): NewLink {
  return {
    threadId,
    repo: link.repo,
    repoKey: repoKey(link.repo),
    number: link.number,
    kind: "pr",
    source: link.source,
    account: null,
    linkedAt: link.at,
    window: link.source === "opened" ? link.window : null,
  };
}

function detectedCreate(threadId: string, create: DetectedCreate): NewCreate {
  return { threadId, numbers: create.numbers, linkedAt: create.at, window: create.window };
}

/**
 * Reads threads' shell command events from each thread's cursor and records
 * the pull requests they opened or pushed to, and the creates whose pull
 * requests the refresher has to look up. A thread has at most one run in
 * flight, and each run reads to the end of the thread's history.
 */
export function createScanner({
  bb,
  store,
  server,
  added,
  publish,
}: {
  bb: Pick<BbPluginApi, "sdk" | "log">;
  store: ReturnType<typeof openStore>;
  server: () => string;
  added: (found: { links: readonly NewLink[]; creates: number }) => void;
  publish: () => void;
}) {
  const runs = new Map<string, Run>();
  const finishedAt = new Map<string, number>();

  async function scan(threadId: string, run: Run, pageRead: () => void) {
    try {
      const at = server();
      for (;;) {
        const rows = eventRowsSchema.parse(
          await bb.sdk.threads.events.list({
            threadId,
            afterSeq: String(store.cursor(at, threadId)),
            types: ["item/started", "item/completed"],
            limit: String(pageSize),
            order: "asc",
          }),
        );
        const last = rows.at(-1);
        if (last) {
          const found = detect(rows, at);
          added(store.addScannedPage(at, threadId, {
            links: found.links.map((link) => detectedLink(threadId, link)),
            creates: found.creates.map((create) => detectedCreate(threadId, create)),
          }, last.seq));
        }
        if (rows.length < pageSize) {
          finishedAt.set(threadId, Date.now());
          return;
        }
        pageRead();
      }
    } catch (error) {
      bb.log.warn(`Could not read the history of BB thread ${threadId}: ${message(error)}`);
    } finally {
      if (runs.get(threadId) === run) runs.delete(threadId);
      if (run.observed) publish();
    }
  }

  function start(threadId: string): Run {
    let pages = 0;
    const waiters: { at: number; resolve: () => void }[] = [];
    const run: Run = {
      promise: Promise.resolve(),
      observed: false,
      afterPages: (count) =>
        new Promise((resolve) => waiters.push({ at: pages + count, resolve })),
    };
    runs.set(threadId, run);
    run.promise = scan(threadId, run, () => {
      pages += 1;
      for (const waiter of waiters.filter(({ at }) => at <= pages)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        run.observed = true;
        waiter.resolve();
      }
    });
    return run;
  }

  const current = (threadId: string) => runs.get(threadId) ?? start(threadId);

  return {
    /**
     * Scans for a reader for up to `SCAN_PAGES_PER_READ` pages, unless a scan
     * finished in the last `readerScanMs`. Returns whether the scan is still
     * going; if it is, the reader gets a change signal when it ends.
     */
    async forRead(threadId: string): Promise<boolean> {
      const finished = finishedAt.get(threadId);
      if (!runs.has(threadId) && finished !== undefined && Date.now() - finished < readerScanMs) return false;
      const run = current(threadId);
      return await Promise.race([
        run.promise.then(() => false),
        run.afterPages(SCAN_PAGES_PER_READ).then(() => true),
      ]);
    },

    /** Reads everything the thread logged up to now, including events after a run already in flight. */
    toEnd(threadId: string): Promise<void> {
      const running = runs.get(threadId);
      return running ? running.promise.then(() => current(threadId).promise) : current(threadId).promise;
    },

    /** Forgets the thread's cursor and reads its whole history again, after any run in flight. */
    async rescan(threadId: string): Promise<void> {
      for (let running = runs.get(threadId); running; running = runs.get(threadId))
        await running.promise;
      store.forgetCursor(server(), threadId);
      await start(threadId).promise;
    },

    /** Forgets a deleted thread's cursor. */
    forget(threadId: string) {
      store.forgetCursor(server(), threadId);
      finishedAt.delete(threadId);
    },
  };
}
