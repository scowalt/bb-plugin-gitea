import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detect, parseItemUrl, type ThreadEventRow } from "./detect";

type Fixture = { name: string; thread: string; rows: ThreadEventRow[] };
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "../test-fixtures/thread-events.json"), "utf8"),
);
const fixture = (name: string) => {
  const found = fixtures.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing fixture ${name}`);
  return found.rows;
};
const server = "https://git.wonderly.info/";
const minute = 60_000;

function started(id: string, createdAt: number): ThreadEventRow {
  return { seq: 1, createdAt, type: "item/started", data: { item: { type: "commandExecution", id } } };
}
function command(
  id: string,
  createdAt: number,
  item: { command: string; aggregatedOutput?: string; exitCode?: number | null },
): ThreadEventRow {
  return {
    seq: 2,
    createdAt,
    type: "item/completed",
    data: { item: { type: "commandExecution", id, aggregatedOutput: "", exitCode: 0, ...item } },
  };
}
function toolCall(id: string, createdAt: number, tool: string, args: unknown, result: unknown): ThreadEventRow {
  return {
    seq: 2,
    createdAt,
    type: "item/completed",
    data: { item: { type: "toolCall", id, tool, arguments: args, result, status: "completed" } },
  };
}
const pull = (repo: string, number: number) => `https://git.wonderly.info/${repo}/pulls/${number}`;
/** The links rows yield, checking that they hold no create cut down to numbers. */
function detectLinks(rows: readonly ThreadEventRow[], at: string) {
  const { links, creates } = detect(rows, at);
  expect(creates).toEqual([]);
  return links;
}

type Call = { thread: string; startedAt: string; command: string; output: string };
const calls: Call[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "../test-fixtures/created-pr-filtered-output/calls.json"), "utf8"),
);
/** The rows of a real call; the fixture has no completion time, so it is taken as 15 s after the start. */
function callRows(call: Call, id: string): ThreadEventRow[] {
  const startedAt = Date.parse(call.startedAt);
  return [
    started(id, startedAt),
    command(id, startedAt + 15_000, { command: call.command, aggregatedOutput: call.output }),
  ];
}

describe("real thread commands", () => {
  it("finds the PR a tea pr create printed inside an OSC-8 link", () => {
    const rows = fixture("tea pr create with an OSC-8 link");
    const window = { from: rows[0]!.createdAt - minute, to: rows[1]!.createdAt + minute };
    expect(detectLinks(rows, server)).toEqual([
      { source: "opened", repo: "wonderlydotcom/internal-tool-camp", number: 4134, at: rows[1]!.createdAt, window },
    ]);
  });

  it("finds every PR that one command created with tea api POST", () => {
    expect(detectLinks(fixture("three tea api POST creates in one command"), server).map(({ source, repo, number }) => ({ source, repo, number }))).toEqual([
      { source: "opened", repo: "wonderlydotcom/internal-tool-csm-ops", number: 1134 },
      { source: "opened", repo: "wonderlydotcom/internal-tools-instance", number: 2500 },
      { source: "opened", repo: "wonderlydotcom/internal-tool-camp-eng-roadmap", number: 51 },
    ]);
  });

  it("keeps an older PR the new PR's body mentions as a candidate whose creation time rejects it", () => {
    const links = detectLinks(fixture("create output that prints an older PR from the body first"), server);
    expect(links.map(({ repo, number }) => `${repo}#${number}`)).toEqual([
      "wonderlydotcom/internal-tool-people-ops#413",
      "wonderlydotcom/workspace-security#83",
    ]);
    const [mention, created] = links.map((link) => {
      if (link.source !== "opened") throw new Error("expected opened candidates");
      return link.window;
    });
    expect(mention!.from).toBeGreaterThan(Date.parse("2026-09-28T23:50:50Z"));
    const createdAt = Date.parse("2026-11-10T15:58:51Z");
    expect([created!.from <= createdAt, createdAt <= created!.to]).toEqual([true, true]);
  });

  it("finds the PR a quiet git push printed on its only remote line", () => {
    expect(detectLinks(fixture("quiet git push that prints only the remote PR line"), server)).toEqual([
      { source: "pushed", repo: "wonderlydotcom/internal-tool-camp-eng-roadmap", number: 64, at: 1794798475541 },
    ]);
  });

  it.each([
    "tea api GET of several pulls",
    "tea api POST of an issue comment and a PATCH of a pull",
    "watch.mjs add printing the PR it watches",
    "tea pr list",
    "tea pulls <n> with links to CI runs",
  ])("links nothing for %s", (name) => {
    expect(detectLinks(fixture(name), server)).toEqual([]);
  });
});

describe("command rules", () => {
  const at = Date.parse("2026-11-16T12:00:00Z");
  const created = (repo: string, number: number) => `\u001b]8;id=1;${pull(repo, number)}\u0007${pull(repo, number)}\u001b]8;;\u0007\n`;

  it("ignores a create that exited non-zero", () => {
    expect(detectLinks([
      command("a", at, { command: "tea pr create --title x", aggregatedOutput: created("acme/widgets", 9), exitCode: 1 }),
    ], server)).toEqual([]);
  });

  it("ignores PR URLs printed by merges, views, and other commands", () => {
    expect(detectLinks([
      command("a", at, { command: "tea pr merge --repo acme/widgets 9", aggregatedOutput: pull("acme/widgets", 9) }),
      command("b", at, { command: "tea pr 9", aggregatedOutput: pull("acme/widgets", 9) }),
      command("c", at, { command: "tea api -X POST repos/acme/widgets/pulls/9/reviews", aggregatedOutput: pull("acme/widgets", 9) }),
    ], server)).toEqual([]);
  });

  it("links a push only to a PR on a remote line, not to a compare URL or a later echo", () => {
    expect(detectLinks([
      command("a", at, {
        command: "git push origin topic",
        aggregatedOutput: [
          "remote: Create a new pull request for 'topic':",
          "remote:   https://git.wonderly.info/acme/widgets/compare/main...topic",
          pull("acme/widgets", 3),
        ].join("\n"),
      }),
      command("b", at, {
        command: "git push -u origin topic 2>&1",
        aggregatedOutput: "remote: Visit the existing pull request:\nremote:   \u001b[1mhttps://git.wonderly.info/Acme/Widgets/pulls/12\u001b[0m\n",
      }),
    ], server)).toEqual([{ source: "pushed", repo: "Acme/Widgets", number: 12, at }]);
  });

  it("links only URLs on the configured server, including its path prefix", () => {
    const prefixed = "https://gitea.example/prefix/";
    expect(detectLinks([
      command("a", at, {
        command: "tea pr create",
        aggregatedOutput: [
          "https://gitea.example/acme/widgets/pulls/1",
          "https://other.example/prefix/acme/widgets/pulls/2",
          "https://gitea.example/prefix/acme/widgets/pulls/3",
        ].join("\n"),
      }),
    ], prefixed).map(({ number }) => number)).toEqual([3]);
  });

  it("assumes a command whose start row is missing started 30 minutes before it completed", () => {
    expect(detectLinks([command("a", at, { command: "tea pulls create", aggregatedOutput: pull("acme/widgets", 4) })], server)).toEqual([
      { source: "opened", repo: "acme/widgets", number: 4, at, window: { from: at - 31 * minute, to: at + minute } },
    ]);
  });

  it("reads shell tool calls and their text results, and nothing from other tools", () => {
    expect(detectLinks([
      started("a", at - 5_000),
      toolCall("a", at, "Bash", { command: "tea pr create --title x" }, { content: [{ type: "text", text: pull("acme/widgets", 5) }] }),
      toolCall("b", at, "exec_command", { command: "git push" }, `remote:   ${pull("acme/widgets", 6)}`),
      toolCall("c", at, "slack_search", { command: "tea pr create" }, pull("acme/widgets", 7)),
      toolCall("d", at, "bash", { cmd: "tea pr create" }, pull("acme/widgets", 8)),
    ], server)).toEqual([
      { source: "opened", repo: "acme/widgets", number: 5, at, window: { from: at - 5_000 - minute, to: at + minute } },
      { source: "pushed", repo: "acme/widgets", number: 6, at },
    ]);
  });

  it("reports each way a pull request was linked once, at its first detection", () => {
    expect(detectLinks([
      command("a", at, { command: "git push", aggregatedOutput: `remote: ${pull("acme/widgets", 9)}` }),
      command("b", at + minute, { command: "git push", aggregatedOutput: `remote: ${pull("ACME/widgets", 9)}` }),
      command("c", at + minute, { command: "tea pr create", aggregatedOutput: pull("acme/widgets", 9) }),
    ], server).map(({ source, repo, at }) => ({ source, repo, at }))).toEqual([
      { source: "pushed", repo: "acme/widgets", at },
      { source: "opened", repo: "acme/widgets", at: at + minute },
    ]);
  });
});

describe("creates whose output was cut down to numbers", () => {
  it.each([
    [0, [252, 253]],
    [1, [254]],
    [2, [4105]],
  ])("keeps real call %i as the numbers it named and its window, without a repository", (index, numbers) => {
    const call = calls[index]!;
    const startedAt = Date.parse(call.startedAt);
    expect(detect(callRows(call, `call-${index}`), server)).toEqual({
      links: [],
      creates: [{ numbers, at: startedAt + 15_000, window: { from: startedAt - minute, to: startedAt + 15_000 + minute } }],
    });
  });

  it("names numbers from pulls/<n> and bare-number lines only, never #<n> or numbers inside a line", () => {
    const at = Date.parse("2026-11-16T12:00:00Z");
    const output = ["Stacked on #253 (see #4104).", "pulls/12", "  13  ", "PR 14 is ready", "#15", "pulls/12"].join("\n");
    expect(detect([command("a", at, { command: "tea api -X POST repos/acme/widgets/pulls | jq -r .number", aggregatedOutput: output })], server).creates)
      .toEqual([{ numbers: [12, 13], at, window: { from: at - 31 * minute, to: at + minute } }]);
  });

  it("keeps nothing for a create that names no number, one that failed, or a command that creates nothing", () => {
    const at = Date.parse("2026-11-16T12:00:00Z");
    expect(detect([
      command("a", at, { command: "tea pr create --title x", aggregatedOutput: "Stacked on #253\n" }),
      command("b", at, { command: "tea pr create --title x | grep -o 'pulls/[0-9]*'", aggregatedOutput: "pulls/7\n", exitCode: 1 }),
      command("c", at, { command: "tea pr 9 | grep -o 'pulls/[0-9]*'", aggregatedOutput: "pulls/9\n" }),
      command("d", at, { command: "git push 2>&1 | grep -o 'pulls/[0-9]*'", aggregatedOutput: "pulls/10\n" }),
    ], server)).toEqual({ links: [], creates: [] });
  });

  it("takes a full URL on the server as the link and keeps no numbers for that create", () => {
    const at = Date.parse("2026-11-16T12:00:00Z");
    expect(detect([
      command("a", at, { command: "tea pr create --title x", aggregatedOutput: `${pull("acme/widgets", 9)}\npulls/12\n13\n` }),
    ], server)).toEqual({
      links: [{ source: "opened", repo: "acme/widgets", number: 9, at, window: { from: at - 31 * minute, to: at + minute } }],
      creates: [],
    });
  });
});

describe("parseItemUrl", () => {
  const prefixed = "https://gitea.example/prefix/";
  it("reads pull request and issue URLs on the configured server only", () => {
    expect(parseItemUrl(`${prefixed}Acme/widgets/pulls/9/files?x=1`, prefixed)).toEqual({ repo: "Acme/widgets", number: 9, kind: "pr" });
    expect(parseItemUrl(`${prefixed}acme/widgets/issues/4#issuecomment-1`, prefixed)).toEqual({ repo: "acme/widgets", number: 4, kind: "issue" });
    expect(parseItemUrl("https://gitea.example/acme/widgets/pulls/9", prefixed)).toBeNull();
    expect(parseItemUrl(`${prefixed}acme/widgets/pulls/9x`, prefixed)).toBeNull();
  });
});
