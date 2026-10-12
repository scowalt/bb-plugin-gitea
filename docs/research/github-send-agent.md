# How the BB GitHub plugin's Send Agent links issues and PRs to threads, and how to port it to Gitea

Researched 2026-10-11. Everything here comes from reading source and type declarations. I did not click Send Agent, did not reload any plugin, and did not change anything remote. The bundled GitHub plugin is on disk but is **not loaded** in this BB install (`bb plugin list` has no GitHub entry). So the GitHub behavior below comes from the source code, not from watching a live session.

**Follow-up decision (2026-10-12):** The user chose to mirror GitHub's direct Send/Review workflow, replacing the panel's compose-first action. The implementation adds persistent manual-send link history, realtime badge refresh, and clickable badges; auto-fixers remain separate. The embedded-composer recommendation in §4 records the earlier alternative, not the chosen implementation. The Gitea findings below describe the pinned pre-change commit.

## Versions and revisions used

| Artifact | Version / revision | Where |
|---|---|---|
| Installed BB | `bb-app` 0.44.0 | `/home/scowalt/.local/share/mise/installs/node/24.18.0/lib/node_modules/bb-app/package.json` |
| Installed bundled GitHub plugin | `bb-plugin-github` 0.2.1, built with BB 0.44.0 and plugin SDK 0.5.29 | `…/bb-app/server/dist/builtin-plugins/github/{package.json,dist/server.meta.json,dist/app.meta.json}` |
| Upstream GitHub plugin source | `get-bb/bb` tag `desktop-v0.44.0` = commit `0baa605b32a00619c1d7e3f32be6553ebcf8244a`. At that tag, `plugins/github` is 0.2.1, `packages/bb-app` is 0.44.0, and `packages/plugin-sdk` is 0.5.29, the same as the install. | https://github.com/get-bb/bb/tree/0baa605b32a00619c1d7e3f32be6553ebcf8244a/plugins/github |
| Upstream `main` at research time | `3aa5ef327093f2834f800370881ac0bed8f2d811` (2026-10-11). GitHub plugin is still 0.2.1. SDK is 0.6.39. | the Send Agent path is unchanged; see "Version notes" |
| Gitea plugin (this worktree) | `bb-plugin-gitea` 1.0.6, commit `98302a9a7bff7a894dfbddfdf7232f772f2b9a25` (on `fork/main`), pins `@get-bb/plugin-sdk` 0.5.29 | local paths below; mirrors at `https://github.com/scowalt/bb-plugin-gitea/blob/98302a9a7bff7a894dfbddfdf7232f772f2b9a25/<file>` |
| Pinned SDK declarations | `@get-bb/plugin-sdk` 0.5.29 `bundled-types/*.d.ts` | `/home/scowalt/Code/bb-plugin-gitea/node_modules/@get-bb/plugin-sdk/bundled-types/` (byte-identical to the 0.5.29 copy under `~/.local/share/bb-plugin-previews/gitea-blocked-issues/…`) |

How I matched the installed bundle to upstream source: the installed `dist/` is minified and has no source maps or esbuild inputs (`*.meta.json` only records versions). I matched it to the tagged source by string-grepping the minified code for distinctive literals:

- `link:${kind}:${repo}#${number}`
- `storage.kv.set(n,[...s,t]),o.realtime.publish("links-changed",{key:n})`
- `threads.spawn({projectId:l,environment:{type:"project-default"},title:…slice(0,120)`
- `⚡ agent`
- `"links-changed"` in `app.js`

All of them match the tag. In `plugins/github`, `git diff desktop-v0.44.0 origin/main` only changes:

- clipboard handling
- container-query CSS classes
- sync-cursor fields
- moving `fetchRepoItems` behind a non-export, plus test refactors

None of these touch the link path.

Abbreviations used below: `GH/server.ts` means `plugins/github/server.ts` at `0baa605`, and `GH/app.tsx` means `plugins/github/app.tsx` at `0baa605`. URL form: `https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/plugins/github/<file>#L<a>-L<b>`. `SDK` means `bundled-types/bb-plugin-sdk.d.ts` (0.5.29), `SDK-app` means `bundled-types/bb-plugin-sdk-app.d.ts`, and `SDK-test` means `bundled-types/bb-plugin-sdk-testing.d.ts`.

---

## 1. Confirmed facts: the GitHub Send Agent flow

### 1.1 What kind of record the link is

**The link is a record in the plugin's own namespaced key-value store (`bb.storage.kv`).** It is not BB thread metadata. The plugin does not assign anyone on GitHub, post a comment, or add a label, and it does not use any other GitHub or BB mechanism to record the link.

- Shape: `threadLinkSchema = { kind: "issue"|"pr", repo, number, threadId, createdAt }`, strict. Source: GH/server.ts L60-68 ([link](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/plugins/github/server.ts#L60-L68)).
- Key: `link:${kind}:${repo}#${number}`. The value is an **array** of `ThreadLink` (GH/server.ts L908-910). Repo casing is kept exactly as given, with no normalization.
- Write: `addLink` reads the array, appends one entry, writes it back, then calls `bb.realtime.publish("links-changed", { key })` (GH/server.ts L912-917, [link](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/plugins/github/server.ts#L908-L929)).
- Read-all: `listAllLinks` calls `kv.list("link:")`, then `kv.get` on each key, drops empty arrays, and returns a `Record<"kind:repo#n", ThreadLink[]>` (GH/server.ts L919-929).
- Storage semantics, from the pinned SDK: "Namespaced JSON key-value rows in bb.db; values ≤256KB each". `kv.list(prefix?)` returns key strings only (SDK L20481-20490).
- The Send Agent path makes no GitHub-side change. `spawnOnItem` (GH/server.ts L943-993) only calls `bb.sdk.threads.spawn` and `addLink`. Remote-writing RPCs, such as commenting and creating issues, are separate handlers not called by this path (for example GH/server.ts L1423, L1471-1480, L1485-1493). The spawned agent's prompt *suggests* putting "Fixes #N" in any PR it opens (L964-965), but the plugin does not depend on that.
- `server.ts` contains no use of `bb.sdk.threads.getPluginMetadata`, `updatePluginMetadata`, or a `pluginMetadata` seed (checked with grep).

### 1.2 Path from UI action to thread creation

1. **Buttons**
   - Issue list rows: "Start". PR list rows: "Review". Source: `ItemRow`, GH/app.tsx L643-710; the button is at L689-706 and calls `startWork` or `startReview` depending on `item.kind`.
   - Issue detail: "Send agent" (GH/app.tsx L1088-1095).
   - PR detail: "Review with agent" (GH/app.tsx L1722-1729).
2. **`useSpawn`** (GH/app.tsx L137-162):
   - sets `spawningKey = "repo#n"`, which disables the buttons controlled by that hook instance; separate rows/details have independent instances
   - calls `rpc.call(method, { repo, number })`
   - on success, calls `navigate.toThread(result.threadId)`
   - on failure, calls `toast.error(message)`
   - in `finally`, clears `spawningKey`
3. **RPC contract**
   - `startWork` and `startReview` both take `{ repo, number }` and return `{ threadId: string.min(1) }` (GH/server.ts L252-259).
   - `listLinks` takes `null` and returns `{ links: Record<string, ThreadLink[]> }` (L261-268).
   - Handlers: `startWork` calls `spawnOnItem("issue")`, `startReview` calls `spawnOnItem("pr")`, and `listLinks` calls `listAllLinks()` (L1504-1514).
4. **`spawnOnItem`** (GH/server.ts L943-993):
   - takes the title and body from the cached SQLite item
   - resolves the project with `resolveProjectId` (L931-941). This tries the BB project whose checkout `origin` matches the repo (found by `discoverRepos`, L617+), then the `defaultProject` setting (L541-546). If neither exists it throws "No BB project is attached to …".
   - builds the prompt. Issues get "Work on GitHub issue …" plus a `gh issue view` hint. PRs get "Review GitHub pull request …", read-only, with a "Do not push changes or post to GitHub unless asked" instruction.
   - calls `bb.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, title: "${repo}#${n}: ${title}".slice(0,120), prompt })` (L978-983)
   - only after the spawn succeeds, calls `addLink(...)` (L984-990) and returns `{ threadId }`
5. **Attribution.** The SDK stamps every `bb.sdk.threads.spawn` call with `origin: "plugin"` and `originPluginId: <plugin id>` unless the caller overrides them (SDK L22210-22222). So every GitHub-spawned thread is also attributed to the plugin in BB core. The link record does not depend on that attribution.

### 1.3 How the UI reads links and gets live updates

- `useLinks()` (GH/app.tsx L121-135) calls `rpc.call("listLinks")` on mount and again every time `useRealtime("links-changed", refetch)` fires. Errors are swallowed and the previous map is left unchanged (initially `{}`). Each list, the issue detail, and the PR detail calls `useLinks()` on its own (L771, L975, L1615).
- Realtime events are ephemeral. They are broadcast to every connected client with no per-channel subscription, and nothing is persisted (SDK L21123-21131). App signature: `useRealtime(channel, handler)` (SDK-app L19928).
- Lookup is a client-side string key: `links[\`${kind}:${repo}#${number}\`]` (L795, L1066, L1639).

### 1.4 Badges, navigation, and the "Agents" sidebar

- `ThreadPills` (GH/app.tsx L266-287) renders one `⚡ agent` badge per link, numbered when there is more than one. Clicking a badge calls `event.stopPropagation()` and then `navigate.toThread(link.threadId)`. Its tooltip is `Open BB thread <id>`.
- Where the badges appear:
  - inline in list rows (L667)
  - an "Agents" sidebar section on issue detail (L1228-1233)
  - the PR detail meta row (L1748) and an "Agents" sidebar section on PR detail (L1785-1790)
- **Filters:** there is none. `app-logic.ts` (`parseQuery`, `buildSuggestions`) has no agent or link term, so there is no "has agent" filter or sort.
- **Thread-side panel:** `threadPanelAction({ id: "pull", title: "GitHub PR", component: PullPanelTab })` (L2235-2240). `PullPanelTab` (L1846-1899) calls `pullForThread`. Server side (L1427-1465):
  1. It first reads `bb.sdk.threads.get`, then `bb.sdk.environments.pullRequest({ environmentId })`, and parses a `github.com/<repo>/pull/<n>` URL from the result.
  2. If that fails, it falls back to a **linear scan of every `link:pr:*` key** looking for a matching `threadId`. There is no reverse index.
  3. If nothing matches, the tab shows a PR picker.
  - Issue-only links are never resolved from the thread side, because the scan only accepts `pr:` keys.
- No thread header action is registered. The only slots are `navPanel` and `threadPanelAction` (L2226-2241).

### 1.5 Cleanup, status, and errors

- **No cleanup.** `server.ts` has no `bb.events.on(...)` and no `kv.delete` on `link:` keys. Links to archived or deleted threads stay forever. Their pills still navigate to the thread id, and the plugin does not check the thread's status. Links are append-only, so sending the same item repeatedly accumulates pills (`⚡ agent 1`, `2`, and so on).
- **No live thread status** (running, idle, failed) on pills. `ThreadLink` has only `createdAt`.
- **Race condition:** `addLink` does an unlocked read-modify-write, so two concurrent spawns for the same item can lose one link. The UI only partly prevents this: it disables buttons in each hook instance while a spawn is pending.
- **Failure ordering:** a spawn failure throws before `addLink`, so no orphan link is written. The client shows a toast. If `addLink` itself throws, the thread exists but has no link, and the RPC rejects, so the user sees an error even though the thread was created.
- **Tests:**
  - `server.test.ts` L168-190 only checks `startWork` input and output validation, using a fake handler.
  - `app.test.tsx` stubs `listLinks: () => ({ links: {} })` (L36, L138).
  - No test exercises `addLink`, `listAllLinks`, `links-changed`, or the pills.
- **Docs drift:** `plugins/github/README.md` describes a "Homepage section". `app.tsx` at this revision registers no homepage slot. Mentions are registered server-side through `bb.ui.registerMentionProvider` (GH/server.ts L1594, L1606).

---

## 2. Thread-linking APIs in the pinned SDK 0.5.29

All of the following are public plugin APIs in 0.5.29.

| Need | API | Declaration |
|---|---|---|
| Item-keyed index | `bb.storage.kv.{get,set,delete,list(prefix)}` | SDK L20481-20490 |
| Push to UI | `bb.realtime.publish(channel, payload)` and `useRealtime(channel, handler)` | SDK L21123-21131; SDK-app L19928 |
| Spawn | `bb.sdk.threads.spawn(ThreadSpawnArgs)` returns `ThreadResponse` | SDK L16532-16538, L16809 |
| **Per-thread plugin metadata** | `createThreadRequestSchema.pluginMetadata?: JsonObject` (seed at spawn); `bb.sdk.threads.getPluginMetadata({ threadId })` and `updatePluginMetadata({ threadId, set?, remove? })`, which default `pluginId` to this plugin. 256 KiB cap. Spawning with a seed always attributes the thread to the plugin. | SDK L11963 / L12128; L16546-16557; L16775-16776; L22130-22148; L22219-22221 |
| Thread lookup and status | `bb.sdk.threads.get`. `ThreadResponse` includes `status`, `archivedAt`, `deletedAt`, `originPluginId`, and `title`. **It does not include `pluginMetadata`.** | SDK L13539-13592 |
| List by plugin | `bb.sdk.threads.list({ originPluginId, projectId, archived, … })`. There is no filter by metadata. | SDK L14274-14304, L16390-16406 |
| Lifecycle | `bb.events.on("thread.created" \| "thread.idle" \| "thread.failed" \| "thread.archived" \| "thread.unarchived" \| "thread.deleted", …)`. Handlers run fire-and-forget after the change. | SDK L20569-20625, L21982-21988 |
| Thread-side UI | `threadPanelAction` (props `{ threadId, params }`) and `experimental_threadHeaderAction` (props `{ threadId, projectId, isCompactViewport }`) | SDK-app L16842-16856, L17131-17149, L18644, L18672 |
| Navigation | `useBbNavigate().toThread(id)`, `toPluginPanel(path, { subPath })`, and `toCompose({ initialPrompt?, focusPrompt? })`. **`toCompose` has no callback, token, or metadata, so the plugin cannot learn which thread the user creates from it.** | SDK-app L19599-19623 (upstream source `packages/plugin-sdk/src/app-contract.ts` L3062 at `desktop-v0.44.0`) |
| Compose surface owned by the plugin | `experimental_NewThreadComposer`. It has `initialPrompt`, `default*` seeds, `draftKey`, and `onSubmit(request: NewThreadRequest)`. The draft is **kept if `onSubmit` throws**. `NewThreadRequest` (projectId, providerId, model, reasoningLevel, permissionMode, serviceTier?, executionInputSources, environment, `input: PromptInput[]`, sendAt?) is JSON that the plugin is meant to forward unchanged to `bb.sdk.threads.spawn`. | SDK-app L19347-19392, L19402-19501, export L19919 |
| Test harness | `createFakePluginHost`, `harness.behavior.emitThreadEvent(event, payload)`, `harness.inspection.realtimeSignals`, `host.harness.sdk.callsTo("threads.spawn")` | SDK-test L1052, L1227, L1299-1306, L1413 |

The `experimental_` APIs in the table may still change.

### Additional composer source verification

The host wrapper [`PluginNewThreadComposer.tsx` L49-85](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/apps/app/src/components/plugin/PluginNewThreadComposer.tsx#L49-L85) delegates to BB's shared `NewThreadComposer`, forwards the user's request, and renders its ordinary prompt box. The shared composer includes provider-native skill command suggestions ([L1479-1499](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/apps/app/src/components/promptbox/NewThreadComposer.tsx#L1479-L1499)), supplies command suggestions and attachments to the prompt box ([L1879-1911](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/apps/app/src/components/promptbox/NewThreadComposer.tsx#L1879-L1911)), and constructs `request.input` from the current structured draft ([L1590-1646](https://github.com/get-bb/bb/blob/0baa605b32a00619c1d7e3f32be6553ebcf8244a/apps/app/src/components/promptbox/NewThreadComposer.tsx#L1590-L1646)). This is source evidence for retaining the native skill-composition path, not a live verification of every provider or plugin composer extension. Forward `input` unchanged rather than regenerating it from the original item prompt.

### Version notes

- The installed GitHub plugin and the Gitea plugin both build against SDK 0.5.29, so every API above is available to Gitea today.
- Upstream `main` (SDK 0.6.39) adds `threads.experimental_listPluginMetadata` (`packages/plugin-sdk/src/backend-contract.ts` L2053-2081 at `3aa5ef3`). It also extends `toCompose` with `projectId`, `placement`, `environmentId`, and `hostId` (`app-contract.ts` L3444-3451). **Even on `main`, `toCompose` still cannot carry metadata or report back the thread it created.** Using `experimental_listPluginMetadata` would require upgrading the SDK, so it is out of scope for 1.0.6.

---

## 3. What the Gitea plugin does today (commit 98302a9)

These facts come from the parent thread's inspection, and I re-checked each one in this worktree.

- **Backend Send Agent already exists.**
  - The `sendAgent` RPC contract is at `server.ts` L373-380 and its handler at L3063-3099. The handler:
    - spawns with `project-default` and an optional saved execution (provider, model, reasoning, tier)
    - then writes a forward key `thread:${itemKey(repo, number)}` → `threadId` (L3093)
    - and a reverse key `thread-link:${threadId}` → `{ repo, number, kind }` (L3094-3098)
  - The forward key uses `itemKey` = `${repo.toLowerCase()}#${number}` (`auto-fixer.ts` L225-231), so it looks like `thread:acme/widgets#42`.
  - The CLI entry is `bb gitea send-agent <issue|pr> <owner/repo> <number>` (`server.ts` L3375-3377, L3690-3697).
- **Reading links.**
  - `readThreadId` (L1690-1704) returns the **single** latest id. If it finds none, it falls back to legacy `thread:Repo:9` colon keys with case-insensitive repo matching. Test: `server.test.ts` L1328-1336.
  - `conversation` returns `threadId` (L2836-2858).
  - Detail view shows "Open linked BB thread" (`app.tsx` L2242-2251).
  - `GiteaThreadPanel` resolves the item through the reverse `threadItem` RPC (`server.ts` L405-414, L3127-3128; `app.tsx` L3140+). This is an O(1) reverse index, which is better than GitHub's scan.
- **The UI does not call `sendAgent`.** The detail button is "Draft with agent" (`app.tsx` L2218-2220). It calls `draftAgent` (prompt only, L3101-3104), then `navigate.toCompose({ initialPrompt, focusPrompt: true })` (`app.tsx` L1963-1975). A thread created from the compose screen is never linked to the item.
  - This was deliberate. Commit `6abecd538627b1f91e47b8e7acaa72172852f4a7` (2026-10-06), titled "Replace Send agent with Draft with agent", says: *"Pre-fill the BB compose form … instead of starting a thread immediately, so skills can be added before submitting."* README L51 says the same.
- **Weak spots compared with what GitHub shows:**
  - List rows show no agent indicator.
  - The `display-changed` realtime event doesn't cover manual links.
  - A repeat `sendAgent` overwrites the forward key, so item-side lookup loses older thread ids while their reverse associations remain.
  - Keys carry no Gitea instance or login and no `kind`.
  - Nothing removes `thread:` or `thread-link:` keys when a thread is archived or deleted. `forgetDeletedThread` (L1763-1773) only clears `auto-fixer:` and `auto-fixer-thread:` keys.
- **Auto-fixers** use a separate session store:
  - `auto-fixer:<itemKey>` → a session with a status
  - `auto-fixer-thread:<id>` → the item ref
  - the reverse `thread-link:<id>` (L2204-2221)
  - realtime `auto-fixer-changed` (L1748-1773)
  - `bb.events.on` for idle, failed, archived, and deleted (L2578-2587)

  Auto-fixers already have a lifecycle and status design that manual links lack.

---

## 4. Recommendations for porting GitHub's link display to Gitea

These are recommendations, not verified behavior.

**Approach.** Keep the compose-first experience the 6abecd5 commit chose. The way to get both composition and a link is for the plugin to own the submit. `toCompose` can't carry a link, but `experimental_NewThreadComposer` hands the plugin the user's full `NewThreadRequest`. Copy GitHub's display pattern (item-keyed list plus `⚡` pills plus a realtime refetch). Do not copy GitHub's gaps: no reverse index, no cleanup, and an unlocked append.

### Minimal steps

1. **Storage (server).** Keep the O(1) reverse lookup `thread-link:<id>`. Change the forward index to an array of `{ threadId, kind, createdAt, source: "manual" }`. On read, support legacy plain string values and colon-separated keys; do not invent missing timestamps. Serialize appends per item with the existing `serialized(repo, number, …)` helper (L2096-2111) so concurrent sends can't lose a link.
   - Prefer a versioned forward key that includes normalized Gitea base URL, `kind`, normalized repo, and number, and retain the instance identity in the reverse record. Switching the existing `baseUrl` setting can already collide with another server's `owner/repo#number`; this is not only a future multi-server concern (`server.ts` L735-740, L1690-1704). Legacy records have no instance, so migration must not silently attribute ambiguous history to another server.
   - Optional extra: seed `pluginMetadata: { instance, repo, number, kind }` on `threads.spawn` for per-thread context, not authorization. It is public in 0.5.29. Validate stored link records and metadata before using them. Keep KV as the lookup index, because `ThreadResponse` does not include metadata and listing by metadata needs SDK 0.6.
2. **Linked spawn RPC.** Add `startAgentThread({ repo, number, kind, request: NewThreadRequest })`. It should:
   - validate the request and item ref at the RPC boundary, and resolve the item
   - call `bb.sdk.threads.spawn({ ...request, title: "${ref}: ${title}".slice(0,120) })`, preserving the user's structured `input`, selected project/environment, execution options, and provenance
   - only after that succeeds, write both keys and call `bb.realtime.publish("agent-links-changed", { item })`
   - reject a spawn failure so the composer keeps the draft (SDK-app L19494-19500)
   - handle post-spawn persistence failure separately: retain the created thread id and make link repair/retry idempotent, rather than blindly spawning a second thread when the user retries (the failure ordering described in §1.5 is the reason)

   Refactor `sendAgent` to share the same write path, so the CLI and the UI behave the same.
3. **Compose UI.** Change "Draft with agent" to open a plugin-owned panel or dialog that renders `experimental_NewThreadComposer`:
   - `initialPrompt` = the `draftAgent` prompt
   - `defaultProjectId` = the repo's project
   - `draftKey` scoped to instance, kind, repo, and number
   - `onSubmit` calls `startAgentThread`, then `navigate.toThread(threadId)`

   Prefer a full-width plugin compose route. Do not silently fall back to `toCompose` for this linked action: that would lose the association again. A separate plain drafting action could retain the current unlinked behavior if desired.
4. **Batch lookup RPC.** Add `agentLinks(null)` → `Record<itemKey, Link[]>` (like GitHub's `listLinks`), optionally with each thread's `status` and `archivedAt` from `threads.get`. Alternatively, add `agentThreadIds` to the `conversation` and list RPC outputs. Add an app `useAgentLinks()` that refetches on `agent-links-changed` (and on `auto-fixer-changed`, if auto-fixer threads should get pills too).
5. **Display.**
   - a pill component modeled on `ThreadPills` (`stopPropagation`, then `navigate.toThread`) in list rows and on detail
   - replace the single "Open linked BB thread" with the list of pills
   - optionally, an "Agents" sidebar section
   - optionally, a "has:agent" filter term. GitHub has none, so this is new.
6. **Cleanup and status.**
   - On `thread.deleted`: remove the id from the forward array and delete `thread-link:<id>`, then publish. Extend `forgetDeletedThread`.
   - On `thread.archived`: preserve the historical association by default and mark it archived, then publish. Hiding archived badges is a separate display policy; archiving does not undo the fact that an agent was sent.
   - Optional: show idle/failed/running on pills. This is either a `threads.get` lookup at list time or tracking through `thread.idle` and `thread.failed`, the same way auto-fixers already do.

### Tests to add

Backend tests use `createFakePluginHost` and the existing `server.test.ts` helpers; app tests use the existing `loadPluginApp` / `renderSlot` harness (`app-navigation.test.tsx` L1-25).

- `startAgentThread` forwards `request` fields unchanged to `threads.spawn` (`callsTo("threads.spawn")`), then writes both the forward array and the reverse key, then emits `agent-links-changed` (`inspection.realtimeSignals`).
- If spawn rejects, no keys are written and the RPC rejects (so the composer keeps the draft).
- A post-spawn link-write failure can be repaired without creating a duplicate thread.
- Identically named repositories on different configured Gitea instances do not share links or drafts.
- Two concurrent sends for the same item keep both thread ids.
- `sendAgent` (CLI) appends instead of overwriting, and still finds threads when only the repo casing differs.
- A legacy forward value (a plain string, and the `thread:Repo:9` key) still resolves.
- `emitThreadEvent("thread.deleted", { thread })` removes both keys and publishes. `thread.archived` follows whichever policy is chosen.
- `threadItem` still resolves for manual and auto-fixer threads.
- App:
  - a list row with a stubbed `agentLinks` shows a pill; clicking it calls `toThread` and does not open the row
  - the composer `onSubmit` calls `startAgentThread`, then navigates
  - a failed submit shows an error and leaves navigation unchanged

---

## 5. Open questions and blockers

- I did not observe the GitHub plugin live, because it isn't loaded in this install. Everything above is static source analysis of the tagged source and the matching minified bundle.
- The shared composer source confirms native skill suggestions and structured draft submission (see §2). Live verification should still check the user's actual provider, skill selection, attachments, and any root-composer extensions before replacing the current path.
- The proposed full-width plugin compose route has not been exercised live. Verify layout and `draftKey` restoration for reopening an item and switching between items/instances.
- Suggested archive policy: preserve history and mark archived; whether archived badges are shown by default remains a product choice. GitHub keeps them forever without marking status.
- Legacy forward/reverse records have no instance or login. Switching `baseUrl` can already produce ambiguous historical links, so a safe migration policy needs explicit handling rather than assuming all legacy links belong to the current instance.
