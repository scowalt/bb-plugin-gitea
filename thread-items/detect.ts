import { z } from "zod";
import { itemKey } from "../auto-fixer.js";
import type { ItemRef } from "./contract.js";

/** The fields of a bb thread event row that detection reads. */
export type ThreadEventRow = {
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
};

export type CreationWindow = { from: number; to: number };

/** A pull request a command created or pushed to; `at` is when the command completed. */
export type DetectedLink =
  | { source: "opened"; repo: string; number: number; at: number; window: CreationWindow }
  | { source: "pushed"; repo: string; number: number; at: number };

/**
 * A create whose output was cut down to numbers, such as `| grep -o 'pulls/[0-9]*'`
 * or `| jq -r .number`, so it names no repository. The pull requests it opened are
 * those the login created inside `window` whose number is in `numbers`.
 */
export type DetectedCreate = { numbers: number[]; at: number; window: CreationWindow };

export type Detection = { links: DetectedLink[]; creates: DetectedCreate[] };

type ShellRun = {
  command: string;
  output: string;
  exitCode: number | null;
  startedAt: number;
  completedAt: number;
};

const missingStartMs = 30 * 60_000;
const windowSlackMs = 60_000;
const shellTools = new Set(["bash", "shell", "exec_command"]);
const escapes = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const createCommand =
  /\btea\s+(?:pr|pulls?)\s+create\b|\btea\s+api\b.*(?:-X\s*POST|--method[\s=]+POST).*\/pulls\b(?!\/)/s;
const pushes = /\bgit\s+push\b/;
const remoteLine = /^\s*remote:/;

const itemIdSchema = z.object({ item: z.object({ id: z.string() }) });
const resultTextSchema = z.union([
  z.string(),
  z
    .object({ content: z.array(z.object({ text: z.string().optional() })) })
    .transform(({ content }) =>
      content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n"),
    ),
]);
const completedItemSchema = z.object({
  item: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("commandExecution"),
      id: z.string(),
      command: z.string(),
      aggregatedOutput: z.string().nullish(),
      exitCode: z.number().nullish(),
    }),
    z.object({
      type: z.literal("toolCall"),
      id: z.string(),
      tool: z.string(),
      arguments: z.unknown(),
      result: z.unknown(),
    }),
  ]),
});
const shellArgumentsSchema = z.object({ command: z.string() });

function shellRun(
  data: unknown,
  startedAt: number,
  completedAt: number,
): ShellRun | null {
  const parsed = completedItemSchema.safeParse(data);
  if (!parsed.success) return null;
  const { item } = parsed.data;
  switch (item.type) {
    case "commandExecution":
      return {
        command: item.command,
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode ?? null,
        startedAt,
        completedAt,
      };
    case "toolCall": {
      if (!shellTools.has(item.tool.toLowerCase())) return null;
      const args = shellArgumentsSchema.safeParse(item.arguments);
      const output = resultTextSchema.safeParse(item.result);
      if (!args.success || !output.success) return null;
      return {
        command: args.data.command,
        output: output.data,
        exitCode: null,
        startedAt,
        completedAt,
      };
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const itemPath = (server: string, section: string) =>
  `${escapeRegExp(server)}([\\w.-]+/[\\w.-]+)/${section}/(\\d+)`;

function pullUrls(text: string, server: string) {
  return [...text.matchAll(new RegExp(itemPath(server, "pulls"), "g"))].map((match) => ({
    repo: match[1]!,
    number: Number(match[2]),
  }));
}

/** The issue or pull request that `url` points at on `server`, or null when it points elsewhere. */
export function parseItemUrl(url: string, server: string): ItemRef | null {
  const match = url.match(new RegExp(`^${itemPath(server, "(pulls|issues)")}(?:[/?#].*)?$`));
  if (!match) return null;
  return { repo: match[1]!, number: Number(match[3]), kind: match[2] === "pulls" ? "pr" : "issue" };
}

/**
 * The numbers an output names as `pulls/<n>` or on a line of its own. Never
 * `#<n>`: a new pull request's body often mentions an older one that way.
 */
function namedNumbers(text: string): number[] {
  const named = [...text.matchAll(/\bpulls\/(\d+)/g), ...text.matchAll(/^\s*(\d+)\s*$/gm)];
  return [...new Set(named.map((match) => Number(match[1])))];
}

const nothing: Detection = { links: [], creates: [] };

function detectRun(run: ShellRun, server: string): Detection {
  if (run.exitCode !== null && run.exitCode !== 0) return nothing;
  const texts = [run.output, run.output.replace(escapes, "")];
  if (createCommand.test(run.command)) {
    const window = {
      from: run.startedAt - windowSlackMs,
      to: run.completedAt + windowSlackMs,
    };
    const links = texts.flatMap((text) =>
      pullUrls(text, server).map((pull) => ({
        source: "opened" as const,
        ...pull,
        at: run.completedAt,
        window,
      })),
    );
    if (links.length > 0) return { links, creates: [] };
    const numbers = namedNumbers(texts[1]!);
    return { links: [], creates: numbers.length > 0 ? [{ numbers, at: run.completedAt, window }] : [] };
  }
  if (pushes.test(run.command))
    return {
      links: texts.flatMap((text) =>
        text
          .split(/\r?\n/)
          .filter((line) => remoteLine.test(line))
          .flatMap((line) =>
            pullUrls(line, server).map((pull) => ({
              source: "pushed" as const,
              ...pull,
              at: run.completedAt,
            })),
          ),
      ),
      creates: [],
    };
  return nothing;
}

/**
 * Pull requests that a thread's shell commands created or pushed to on `server`
 * (a cleaned base URL href with a trailing slash). Rows are `item/started` and
 * `item/completed` events in seq order; a completed command whose start row is
 * not among them is assumed to have started `missingStartMs` before it completed.
 * Each (source, repo, number) appears once, at its first detection. A create
 * that printed no pull request URL on `server` is returned as a `DetectedCreate`
 * when its output names numbers.
 */
export function detect(rows: readonly ThreadEventRow[], server: string): Detection {
  const startedAt = new Map<string, number>();
  const found = new Map<string, DetectedLink>();
  const creates: DetectedCreate[] = [];
  for (const row of rows) {
    const id = itemIdSchema.safeParse(row.data);
    if (!id.success) continue;
    if (row.type === "item/started") {
      startedAt.set(id.data.item.id, row.createdAt);
      continue;
    }
    if (row.type !== "item/completed") continue;
    const run = shellRun(
      row.data,
      startedAt.get(id.data.item.id) ?? row.createdAt - missingStartMs,
      row.createdAt,
    );
    if (!run) continue;
    const detection = detectRun(run, server);
    for (const link of detection.links) {
      const key = `${link.source} ${itemKey(link.repo, link.number)}`;
      if (!found.has(key)) found.set(key, link);
    }
    creates.push(...detection.creates);
  }
  return { links: [...found.values()], creates };
}
