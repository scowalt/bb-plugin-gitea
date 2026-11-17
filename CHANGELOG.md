# Changelog

## Unreleased

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
