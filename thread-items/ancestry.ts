import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Which linked threads sit at or under each thread, and the titles of the threads read to find out. */
export type Ancestry = {
  /** For a thread, every linked thread that is it or under it within the depth limit. */
  below: ReadonlyMap<string, readonly string[]>;
  titles: ReadonlyMap<string, string | null>;
};

type Read = { id: string; parent: string | null; title: string | null };
type Cached = { at: number; linked: ReadonlySet<string>; ancestry: Promise<Ancestry>; involved: ReadonlySet<string> | null };

const batchSize = 200;
const maxConcurrent = 4;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, items.length) }, worker));
  return results;
}

/**
 * Finds the threads above the linked ones, so a thread's rows cost a map
 * lookup and bb is asked about linked threads and their ancestors only, never
 * about every thread a list shows. Threads count as `walk` counts them:
 * archived and hidden ones yes, deleted ones only for themselves.
 */
export function createAncestry(options: {
  threads: {
    list(args: { threadIds: readonly string[]; archived: boolean; includeHidden: true }): Promise<
      readonly { id: string; parentThreadId: string | null; title: string | null; titleFallback: string | null }[]
    >;
  };
  log: Pick<BbPluginApi["log"], "warn">;
  maxDepth: number;
  ttlMs: number;
}) {
  const { threads, log, maxDepth, ttlMs } = options;
  let cached: Cached | null = null;

  async function read(ids: readonly string[]): Promise<Read[]> {
    const batches = [];
    for (let at = 0; at < ids.length; at += batchSize)
      for (const archived of [false, true]) batches.push({ threadIds: ids.slice(at, at + batchSize), archived });
    const lists = await inBatches(batches, async (batch) => {
      try {
        return await threads.list({ ...batch, includeHidden: true });
      } catch (error) {
        log.warn(`Could not read ${batch.threadIds.length} threads above linked threads: ${message(error)}`);
        return [];
      }
    });
    return lists.flat().map((thread) => ({
      id: thread.id,
      parent: thread.parentThreadId ?? null,
      title: thread.title ?? thread.titleFallback ?? null,
    }));
  }

  async function build(linked: readonly string[]): Promise<Ancestry> {
    const known = new Map<string, Read>();
    let wanted = linked;
    for (let depth = 0; depth < maxDepth && wanted.length > 0; depth += 1) {
      const found = await read(wanted);
      for (const thread of found) known.set(thread.id, thread);
      wanted = [...new Set(found.flatMap(({ parent }) => (parent && !known.has(parent) ? [parent] : [])))];
    }
    const below = new Map<string, string[]>();
    for (const id of linked) {
      const chain = [id];
      for (let parent = known.get(id)?.parent; parent && chain.length <= maxDepth && !chain.includes(parent); ) {
        chain.push(parent);
        parent = known.get(parent)?.parent;
      }
      for (const above of chain) {
        const ids = below.get(above);
        if (ids) ids.push(id);
        else below.set(above, [id]);
      }
    }
    return { below, titles: new Map([...known.values()].map(({ id, title }) => [id, title])) };
  }

  return {
    /** The ancestry of `linked`, reused until it is `ttlMs` old or a thread in `linked` is new to it. */
    of(linked: readonly string[]): Promise<Ancestry> {
      const now = Date.now();
      if (cached && now - cached.at < ttlMs && linked.every((id) => cached!.linked.has(id))) return cached.ancestry;
      const entry: Cached = { at: now, linked: new Set(linked), ancestry: build([...new Set(linked)]), involved: null };
      cached = entry;
      void entry.ancestry.then(({ titles }) => {
        entry.involved = new Set([...entry.linked, ...titles.keys()]);
      });
      return entry.ancestry;
    },

    /**
     * Drops the ancestry when `threadId` moved or was deleted and it was one
     * of the threads it read, or it is still being read. Returns whether it did.
     */
    forget(threadId: string): boolean {
      if (!cached || (cached.involved && !cached.involved.has(threadId))) return false;
      cached = null;
      return true;
    },
  };
}
