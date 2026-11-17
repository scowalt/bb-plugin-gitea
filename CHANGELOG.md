# Changelog

## 1.2.0 - 2026-11-17

### Added

- The row above a thread's composer lists the thread's pull requests, its own and its child threads', as **#n** pills in the colours of their table chips: green when CI passes, red when it fails, yellow while it runs, grey without CI or when CI could not be read, purple when merged, grey when closed or not read yet. Pull requests that can still change come first. Past three, the rest collapse to **+N**. Hover a pill to see which pull request it is and how it stands. Clicking a pill or **+N** opens the thread's **Gitea** table. The row shows nothing while the thread has no pull request, and nothing while the pane shows the thread context card instead.
- The thread context card lists the same pull requests in its pull request rows, one row each with **#n**, the title and the table's chip, and a **+N more pull requests** row past three. Clicking a row opens the **Gitea** table. bb shows the card only while the `threadContextCard` experiment is on.
- Sidebar rows show how many pull requests the thread has, in a pill that is red when any open pull request's CI fails, yellow while CI runs, purple when all are merged and green otherwise. Hover it for the breakdown and one line per pull request. The pill needs the `threadRowMetadata` experiment and **Organize → Rows → Metadata** turned on, and shows only in bb's own sidebar or in a plugin's thread list that draws `experimental_ThreadRowMetadata`.
- The `threadPulls` and `threadPullBadges` RPCs return each listed thread's pull requests and summary, keyed by thread id, from what the plugin stored. They read no Gitea and no thread history.

### Changed

- **Breaking:** the plugin needs plugin SDK 0.6.146 or newer.
- The thread header's pull request count is a bb header button, which shows only its label, so the label takes the place of the coloured dot and says how the pull requests stand, worst first: **3 PRs · 1 failing**, **2 PRs · CI running**, **2 PRs · all merged**, otherwise the merged count as before. Clicking it still opens the table. When the Git plugin's **Commit** button also shows, the count comes first and Commit joins its menu. The **Gitea** tab keeps its id, so tabs already open keep working.
- The table, the header count and the rows in the thread include pull requests from child threads up to four levels down with no 50-thread limit. The limit now applies only to the threads whose new commands the table reads when it opens.
- While bb shows a thread's header, context row or card, the plugin reads the thread's new commands every 30 seconds and keeps its open pull requests on the 30-second refresh, as an open table did. Sidebar badges do neither, so the refresher's 12 tea calls in any 30 seconds stay for the threads on screen.
- The model picker for auto-fixers refuses a reasoning level or service tier the plugin does not know before it saves, where the server refused it before.

## 1.1.0 - 2026-11-16

### Added

- The thread's **Gitea** table now lists every pull request the thread is associated with, not only the ones linked to it. A pull request is listed when the thread created it (`tea pr create`, `tea pulls create`, or `tea api -X POST …/pulls`), pushed to it (`git push` printed its URL on a `remote:` line), was started for it by **Send agent** or an auto-fixer, or was linked with `bb gitea link`. Pull requests of child threads, up to four levels down and 50 threads in all, are listed too, with **from child** and the child's title under their own title. A create whose output was cut down to `pulls/<n>` or a bare number, such as `| grep -o 'pulls/[0-9]*'` or `| jq -r .number`, is matched to the pull requests the tea login created while it ran with a number it named, through Gitea's pull request search; `#<n>` does not count. Hover a pull request's name to see how the thread got it. A URL that a create command only printed, such as an older pull request mentioned in the new one's body, is dropped once Gitea shows that pull request was created before the command ran, or answers that it does not exist.
- The thread header shows the thread's pull request count, such as **3 PRs · 2 merged**, once it has one. Issues are not counted. Its dot is red when any open pull request's CI fails, yellow while CI runs, purple when all are merged, and green otherwise. Clicking it opens the table.
- The first time a thread's table or `bb gitea thread` reads an old thread, it reads the thread's history and says **Scanning thread history…** until it finishes.
- `bb gitea link` and `bb gitea unlink` also take an issue or pull request URL on the configured server in place of `<issue|pr> <owner/repo> <number>`.
- `bb gitea thread` uses the thread it runs in when no thread id is given, and `--scan` reads the thread's whole history again.

### Changed

- The table no longer reads Gitea when it opens. The plugin keeps each listed pull request's state, review, and CI, and each listed issue's title and state, in its database and refreshes them in the background: an open item every 30 seconds while someone has its thread open and every 10 minutes otherwise, a closed one every 5 minutes or 6 hours, and a merged pull request never. Every refresh of an open pull request reads its reviews and its head's statuses again, so a re-run or a check posted later shows up on the same head. The refresher starts at most 12 tea calls in any 30 seconds; an open pull request costs three or more (the pull request, its reviews, and its head's statuses, one call per page), and a merged or closed one or an issue costs one. Looking up a cut-down create costs one call per page of 50 search results; it pages back until it reaches the command's start, up to 10 pages, and gives up with a log line after that. **Refresh** asks for the open and not yet read rows to be read again, and the table updates when the reads finish. A row whose last read failed keeps its last state and shows a warning with Gitea's error.
- A CI status read that fails for any reason now shows **Unknown**. In 1.0.9, a 403 or 404 from the status endpoint failed the whole row.
- **Breaking:** `bb gitea thread --json` prints the thread's table data (`threadId`, `server`, `scanning`, `descendantsTruncated`, `pulls`, `issues`, `summary`) instead of `{ items }`. Its human output has one line per pull request, such as `merged    owner/repo#12  Title  (opened)`.
- `bb gitea link` for a pull request reads only the pull request, so a failing reviews or status read no longer refuses the link; the refresher reads them right after.
- A view reads a thread's new events from bb at most every 30 seconds; a thread going idle or failing is read at once.
- **Breaking:** `bb gitea link --json` prints `{ result: "added" | "already" }` and `bb gitea unlink --json` prints `{ removed }`, instead of `{ changed, items }`. Their human output no longer lists the thread's other items.
- **Breaking:** the `linkThread` and `unlinkThread` RPCs are replaced by `linkItem` and `unlinkItem`, which take the same input. `threadItems` returns the table data and takes an optional `refresh`. The `itemStatus` RPC is removed.
- Thread links are stored in the plugin's SQLite database. On its first load, 1.1.0 copies the `link:`, `thread-link:`, and `thread:` keys that 1.0.9 and earlier wrote into it, and records `thread-items-imported`. The old keys stay for one release, so a downgrade still sees the links made before the upgrade. If a key's item kind cannot be read from Gitea, the import runs again on the next load. **Open linked BB thread** and the **⚡ agent** badges are unchanged.

### Fixed

- Publish `issue-references.ts`, which the app imports, in the package files.

### Tests

- Cover detection against real thread commands (OSC-8 links, several creates in one command, a body that mentions an older pull request, a quiet push, creates cut down to `pulls/<n>`), the search that resolves a cut-down create against real Gitea search results (its paging, page cap, budget, and retry after a failed search), scan cursors and crash safety, backfill, rescans during a scan, child threads, the creation-time check and what a rejected candidate falls back to, the refresh budget with reviews and multi-page reads, CI read again on the same head, the cadence, issue reads, a candidate Gitea answers 404 for, a plugin change during a read, Refresh of open rows only, the 30-second event read, failed reads, the kv import of 1.0.7 and 1.0.9 data, the CLI, and the table and header rows built from the thread's tracked pull requests.

## 1.0.9 - 2026-11-16

### Changed

- The thread side panel is now a **Gitea** table with one row per linked item: the pull request, its review status and its CI status. It no longer shows the description, conversation or changed files, and the menu for switching between linked items is gone. Open the item on Gitea from its row.
- Review status is **Changes requested**, **Approved**, **Awaiting** (requested reviewers and teams that have not reviewed) or **No review**. A requested reviewer who only commented is not awaited. CI status is **Passing**, **N failing**, **Running**, **No CI** or **Unknown**, read from the head commit's combined status. Merged and closed pull requests show only their state, and issues show open or closed.

### Added

- Add the `itemStatus` RPC, which returns one linked item's status through the same cache as `conversation`.

### Tests

- Cover the CI and review derivations, the `itemStatus` RPC for open, merged, closed and issue items, and the panel's rows, errors, refresh and realtime updates.

## 1.0.8 - 2026-11-16

### Added

- Add `bb gitea link <issue|pr> <owner/repo> <number> [--thread <thread-id>]` and the `linkThread` RPC. They link an issue or pull request to a BB thread that already exists, by default the thread that runs the command. The link adds the same **⚡ agent** badge and **Agents** entry as a send. Linking checks the thread and the item's kind and writes nothing to Gitea. Linking an item twice is a no-op.
- Add `bb gitea unlink` and the `unlinkThread` RPC to remove a link.
- A thread can have several linked items. The thread side panel shows a menu to switch between them when there is more than one, and it updates when links change.

### Changed

- `bb gitea thread <thread-id>` lists every linked item. Its `--json` output is now `{ items: [...] }` instead of one item or `null`, and the `threadItem` RPC is replaced by `threadItems`.
- A thread's links are stored as a list. A link stored as one item by 1.0.7 or earlier is still read, and becomes a list the next time that thread's links change.

### Tests

- Cover linking from the CLI with and without `--thread`, the duplicate no-op, several items on one thread, concurrent unlinks, rejected links, unlinking, the 1.0.7 single-item value, the auto-fixer's link, and the panel's switcher.

## 1.0.7 - 2026-10-12

### Added

- Add GitHub-style clickable **⚡ agent** badges to issue/PR lists and details, plus an **Agents** sidebar. Manual sends retain multiple thread links and refresh badges across clients; history is scoped to the Gitea account and persists across plugin reloads.

### Changed

- Replace **Draft with agent** with direct **Send agent** / **Review with agent**, and add **Start** / **Review** actions to list rows. Auto-fixer indicators remain separate.

### Tests

- Cover append-only link history, concurrent sends, failure handling, account isolation, reverse links, legacy detail links, realtime badge refresh, and direct-send navigation.

## 1.0.6 - 2026-10-10

### Added

- Add a **Hide blocked** switch to the Issues and My Issues filter bars, plus `--hide-blocked` for their CLI commands. Open Gitea dependencies block issues; closed dependencies do not. Unavailable or incomplete checks remain visible as Unverified. Dependency reads are bounded, cached briefly, and refreshed without loading issue conversations.
- Add a **Gitea** environment. Its picker lists where to work and the project's Gitea branches, split into your branches and other branches. Pull request branches show a badge colored by state: draft, CI failing, CI running, CI passing, or merged. Picking a branch starts the thread on that branch in a new worktree, or switches an existing worktree to it.
- Show issue dependencies and related references in the Conversation sidebar, including an explicit unavailable state when dependency reads fail.

### Changed

- Replace the panel's Send agent action with Draft with agent, pre-filling the BB compose form for review before sending.

### Tests

- Cover blocker classification, bounded and paginated dependency reads, filtering, cache invalidation, account isolation, failed checks, CLI behavior, and the panel toggle.

## 1.0.5 - 2026-10-01

### Fixed

- Automatically archive auto-fixers when their PR closes or merges, including paused and failed sessions; stop threads, withdraw queued automation, and invoke BB resource cleanup.
- Retry failed terminal cleanup while retaining the confirmed PR outcome.
- Fix stale caches, duplicate mutations, and diff whitespace handling.

### Changed

- Add an archived auto-fixer state and a Show archived history toggle. Reopened closed PRs can start a replacement auto-fixer.
- Model known states explicitly.

### Tests

- Cover external PR closure, cleanup retries, archived history visibility, and reopened PRs.

## 1.0.4 - 2026-10-01

### Fixed

- Restore the teacup icon in Gitea navigation and issue/PR panels.
- Give each list tab its own route so back/forward restores the correct tab, including returning to My PRs after opening a pull request.
- Return from issue creation and item details to the selected list.

### Changed

- Update the MIT license copyright holder to Nick Murphy.

### Tests

- Add regression coverage for PR navigation, route replay, and panel remounts.
