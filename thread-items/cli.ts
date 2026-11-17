import { threadItemLinkSchema, type ThreadItemsView, type ThreadPull } from "./contract.js";
import { parseItemUrl } from "./detect.js";
import type { ThreadItems } from "./service.js";

const commands = ["link", "unlink", "thread"] as const;
export type ThreadItemsCommand = (typeof commands)[number];

export function isThreadItemsCommand(command: string | undefined): command is ThreadItemsCommand {
  return commands.some((name) => name === command);
}

export type ThreadItemsCommandRequest = {
  command: ThreadItemsCommand;
  values: string[];
  /** The `--thread` option. */
  thread: string | undefined;
  scan: boolean;
  /** The thread the CLI ran in, from `$BB_THREAD_ID`. */
  contextThreadId: string | undefined;
};

export type ThreadItemsCommandResult =
  | { ok: true; value: unknown; human: string }
  | { ok: false; error: string };

const missingThread = "Pass --thread <thread-id>, or run this inside a bb thread.";

/** `<issue|pr> <owner/repo> <number>`, or one issue or pull request URL on the configured server. */
function itemArgument(values: string[], server: string) {
  const [first, second, third] = values;
  if (first?.includes("://")) {
    const item = parseItemUrl(first, server);
    if (!item) throw new Error(`${first} is not an issue or pull request on ${server}.`);
    return item;
  }
  return { kind: first, repo: second, number: Number(third) };
}

function stateWord(pull: ThreadPull): string {
  const lifecycle = pull.state?.lifecycle;
  if (!lifecycle) return pull.error === null ? "checking" : "unreadable";
  return lifecycle.state === "open" && lifecycle.draft ? "draft" : lifecycle.state;
}

function sourceText({ via }: ThreadPull): string {
  return via.type === "own" ? via.source : `from child ${via.threadId}`;
}

function describe(view: ThreadItemsView): string {
  const lines = [
    ...view.pulls.map((pull) =>
      [stateWord(pull).padEnd(8), `${pull.repo}#${pull.number}`, pull.state?.title ?? pull.error, `(${sourceText(pull)})`]
        .filter(Boolean)
        .join("  "),
    ),
    ...view.issues.map((issue) =>
      ["issue   ", `${issue.repo}#${issue.number}`, issue.state?.title ?? issue.error, `(${issue.source})`]
        .filter(Boolean)
        .join("  "),
    ),
  ];
  if (lines.length === 0) lines.push("No Gitea pull requests are linked to this thread.");
  if (view.scanning) lines.push("Still reading this thread's history; run the command again for the rest.");
  if (view.descendantsTruncated) lines.push("Some child threads could not be read.");
  return lines.join("\n");
}

/** Runs `bb gitea link`, `unlink` and `thread`. */
export async function runThreadItemsCommand(
  items: ThreadItems,
  request: ThreadItemsCommandRequest,
): Promise<ThreadItemsCommandResult> {
  const { command, values } = request;
  if (command === "thread") {
    const threadId = values[0] ?? request.thread ?? request.contextThreadId;
    if (!threadId) return { ok: false, error: missingThread };
    if (request.scan) await items.rescan(threadId);
    const view = await items.view(threadId);
    return { ok: true, value: view, human: describe(view) };
  }
  const threadId = request.thread ?? request.contextThreadId;
  if (!threadId) return { ok: false, error: missingThread };
  const input = threadItemLinkSchema.parse({ threadId, ...itemArgument(values, items.server()) });
  const ref = `${input.kind} ${input.repo}#${input.number}`;
  if (command === "link") {
    const value = await items.handlers.linkItem(input);
    return {
      ok: true,
      value,
      human: value.result === "added" ? `Linked ${ref} to ${threadId}.` : `${ref} was already linked to ${threadId}.`,
    };
  }
  const value = await items.handlers.unlinkItem(input);
  return {
    ok: true,
    value,
    human: value.removed ? `Unlinked ${ref} from ${threadId}.` : `${ref} was not linked to ${threadId}.`,
  };
}
