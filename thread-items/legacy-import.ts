import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { itemKey, repoKey } from "../auto-fixer.js";
import { itemRefSchema, threadLinkSchema, type ItemKind } from "./contract.js";
import type { GiteaReads } from "./service.js";
import type { NewLink, openStore } from "./store.js";

/** Set once every legacy key has been read into the table. Its value is the import time. */
export const importedKey = "thread-items-imported";

const accountSchema = z.tuple([z.string(), z.string(), z.string()]);
/** 1.0.7 stored one item per thread; 1.0.8 stores a list. */
const threadItemsSchema = z.array(itemRefSchema);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Parses a legacy `thread:` key in its `thread:owner/repo#n` or older `thread:owner/repo:n` form. */
function threadKey(key: string): { repo: string; number: number } | null {
  const match = key.match(/^thread:([\w.-]+\/[\w.-]+)[#:]([1-9]\d*)$/);
  return match ? { repo: match[1]!, number: Number(match[2]) } : null;
}

/**
 * Copies the kv link stores this table replaced (`link:`, `thread-link:` and
 * `thread:`) into it, once. The keys stay, so a plugin version from before the
 * table still sees its links after a downgrade; they can go one release later.
 * A `thread:` key that no other key covers needs one Gitea read for its kind.
 * If that read fails, the marker is not written and the whole import, which is
 * idempotent, runs again on the next load.
 */
export async function importLegacy({
  kv,
  gitea,
  store,
  log,
}: {
  kv: BbPluginApi["storage"]["kv"];
  gitea: Pick<GiteaReads, "server" | "kind">;
  store: ReturnType<typeof openStore>;
  log: Pick<BbPluginApi["log"], "warn">;
}): Promise<void> {
  if ((await kv.get<unknown>(importedKey)) !== undefined) return;
  const current = gitea.server();
  const byServer = new Map<string, NewLink[]>();
  const add = (server: string, link: Omit<NewLink, "repoKey" | "window">) =>
    byServer.set(server, [
      ...(byServer.get(server) ?? []),
      { ...link, repoKey: repoKey(link.repo), window: null },
    ]);
  const covered = new Set<string>();
  const cover = (threadId: string, repo: string, number: number) =>
    covered.add(`${threadId} ${itemKey(repo, number)}`);
  const skip = (key: string, reason: string) =>
    log.warn(`Left legacy Gitea link ${key} unimported: ${reason}`);
  let complete = true;

  for (const key of await kv.list("link:")) {
    const match = key.match(/^link:(\[.*\]):(issue|pr):(.+)$/);
    const owner = match ? accountSchema.safeParse(safeJson(match[1]!)) : null;
    const stored = await kv.get<unknown>(key);
    if (!match || !owner?.success || !Array.isArray(stored)) {
      skip(key, "unrecognized key or value");
      continue;
    }
    for (const value of stored) {
      const entry = threadLinkSchema.safeParse(value);
      if (!entry.success) continue;
      const { repo, number, kind, threadId, createdAt } = entry.data;
      const linkedAt = Date.parse(createdAt);
      if (kind !== match[2] || itemKey(repo, number) !== match[3] || Number.isNaN(linkedAt)) continue;
      add(owner.data[0], { threadId, repo, number, kind, source: "sent", account: match[1]!, linkedAt });
      cover(threadId, repo, number);
    }
  }

  for (const key of await kv.list("thread-link:")) {
    const threadId = key.slice("thread-link:".length);
    const stored = await kv.get<unknown>(key);
    const items = threadItemsSchema.safeParse(Array.isArray(stored) ? stored : [stored]);
    if (!threadId || !items.success) {
      skip(key, "unrecognized value");
      continue;
    }
    const autoFixer = (await kv.get<unknown>(`auto-fixer-thread:${threadId}`)) !== undefined;
    for (const { repo, number, kind } of items.data) {
      add(current, {
        threadId, repo, number, kind,
        source: autoFixer ? "auto-fixer" : "sent", account: null, linkedAt: 0,
      });
      cover(threadId, repo, number);
    }
  }

  for (const key of await kv.list("thread:")) {
    const ref = threadKey(key);
    const threadId = await kv.get<unknown>(key);
    if (!ref || typeof threadId !== "string" || !threadId) {
      skip(key, "unrecognized key or value");
      continue;
    }
    if (covered.has(`${threadId} ${itemKey(ref.repo, ref.number)}`)) continue;
    let kind: ItemKind;
    try {
      kind = await gitea.kind(ref.repo, ref.number);
    } catch (error) {
      log.warn(`Will retry legacy Gitea link ${key} on the next load: ${message(error)}`);
      complete = false;
      continue;
    }
    add(current, { threadId, ...ref, kind, source: "sent", account: null, linkedAt: 0 });
  }

  store.importLinks(byServer);
  if (complete) await kv.set(importedKey, Date.now());
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
