# Changelog

## Unreleased

### Added

- Add a **Hide blocked** switch to the Issues and My Issues filter bars, plus `--hide-blocked` for their CLI commands. Open Gitea dependencies block issues; closed dependencies do not. Unavailable or incomplete checks remain visible as Unverified. Dependency reads are bounded, cached briefly, and refreshed without loading issue conversations.
- Add a **Gitea** environment. Its picker lists where to work and the project's Gitea branches, split into your branches and other branches. Pull request branches show a badge colored by state: draft, CI failing, CI running, CI passing, or merged. Picking a branch starts the thread on that branch in a new worktree, or switches an existing worktree to it.

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
