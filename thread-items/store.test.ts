import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { LinkSource, PullSnapshot } from "./contract";
import { openStore, type NewLink } from "./store";

const server = "https://gitea.example/";
const createdAt = Date.parse("2026-11-16T12:00:00Z");
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function store() {
  const host = createFakePluginHost({ pluginId: "gitea" });
  hosts.push(host);
  return openStore(host.bb.storage);
}

const item = { repoKey: "acme/widgets", number: 9 };
function link(source: LinkSource, overrides: Partial<NewLink> = {}): NewLink {
  return {
    ...item,
    threadId: "thr-a",
    repo: "acme/widgets",
    kind: "pr",
    source,
    account: source === "linked" ? "account" : null,
    linkedAt: createdAt,
    window: source === "opened" ? { from: createdAt - 60_000, to: createdAt + 60_000 } : null,
    ...overrides,
  };
}
const snapshot = (created: number): PullSnapshot => ({
  kind: "pr",
  title: "Change",
  url: `${server}acme/widgets/pulls/9`,
  createdAt: new Date(created).toISOString(),
  lifecycle: { state: "merged", mergedAt: "2026-11-16T13:00:00Z" },
});
const settle = (links: ReturnType<typeof store>, created: number) =>
  links.saveSnapshot(server, item, { snapshot: snapshot(created), checkedAt: created, dueAt: null, resets: 0 });
const sources = (links: ReturnType<typeof store>) =>
  links.linksOf(server, ["thr-a"]).map((row) => [row.source, row.account]);

describe("how an unconfirmed opened link settles", () => {
  it("stays opened when the thread created the pull request and then pushed to it", () => {
    const links = store();
    expect(links.addLinks(server, [link("opened"), link("pushed")])).toHaveLength(2);
    expect(sources(links)).toEqual([["opened", null]]);
    expect(settle(links, createdAt)).toBe(false);
    expect(sources(links)).toEqual([["opened", null]]);
    expect(links.addLinks(server, [link("pushed")])).toEqual([]);
  });

  it("becomes its first other source when the pull request was created outside the window", () => {
    const links = store();
    links.addLinks(server, [link("opened"), link("linked"), link("pushed")]);
    expect(settle(links, createdAt - 86_400_000)).toBe(true);
    expect(sources(links)).toEqual([["linked", "account"]]);
  });

  it("is deleted when the pull request was created outside the window and nothing else linked it", () => {
    const links = store();
    links.addLinks(server, [link("opened")]);
    expect(settle(links, createdAt + 86_400_000)).toBe(true);
    expect(sources(links)).toEqual([]);
  });

  it("settles at once when the pull request was already read", () => {
    const links = store();
    links.addLinks(server, [link("pushed", { threadId: "thr-b" })]);
    settle(links, createdAt - 86_400_000);
    links.addLinks(server, [link("opened")]);
    expect(sources(links)).toEqual([]);
  });

  it("never replaces an existing link with an opened candidate", () => {
    const links = store();
    links.addLinks(server, [link("sent", { account: "account" })]);
    expect(links.addLinks(server, [link("opened")])).toEqual([]);
    expect(sources(links)).toEqual([["sent", "account"]]);
  });
});

it("keeps a reset due time when the read that saves after it began before it", () => {
  const links = store();
  links.addLinks(server, [link("pushed")]);
  const before = links.readState(server, item)!.resets;
  links.expire(server, item);
  links.saveSnapshot(server, item, { snapshot: snapshot(createdAt), checkedAt: createdAt, dueAt: createdAt + 600_000, resets: before });
  expect(links.readState(server, item)).toMatchObject({ dueAt: 0, resets: before + 1 });
  links.saveSnapshot(server, item, { snapshot: snapshot(createdAt), checkedAt: createdAt, dueAt: createdAt + 600_000, resets: before + 1 });
  expect(links.readState(server, item)?.dueAt).toBe(createdAt + 600_000);
});
