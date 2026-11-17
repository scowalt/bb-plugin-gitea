# Gitea commands and settings

The plugin reads and writes Gitea through `tea api`, using the `tea` CLI 0.15.1 or newer signed in with `tea login add`. BB stores no Gitea token. `tea logins list` shows profile names.

Write to Gitea only when the user asks. Read commands accept `--json`. List commands default to open items and accept `--state open|closed|all` and `--query text`.

## Read

- `bb gitea status` checks sign-in and lists repositories.
- `bb gitea repos` lists repositories from matching project `origin` remotes and `extraRepos`.
- `bb gitea issues|prs|my-prs|my-issues [owner/repo]` list items. `my-issues` lists issues assigned to the signed-in account (not pull requests); all list commands accept `--state open|closed|all`, `--query text`, and `--json`. `my-prs` lists pull requests by the signed-in login, with each one's Auto-fix, Auto-merge, and auto-fixer state and the automation defaults. New issues created from My Issues are assigned to the signed-in account; ordinary creation is unchanged.
- `issues` and `my-issues` also accept `--hide-blocked`. It hides open issues with open Gitea dependencies after the repository/state/search filters and 200-item cap. Closed dependencies do not block. Failed, malformed, or capped dependency reads remain visible as `blockerState: "unknown"`; human output marks them `[blockers unknown]`. Filtered responses include `blockedCount`. The panel's filter-bar switch uses this behavior and is on by default; the CLI flag is opt-in.
- `bb gitea show <issue|pr> <owner/repo> <number>` reads Gitea directly: the item, comments, and for a pull request its files, checks, and reviews. Use it when a decision needs current state.
- `bb gitea conversation <issue|pr> <owner/repo> <number> [--refresh]` returns what the panel shows, without files. It is cached; `freshness.state` is `fresh`, `refreshing`, or `stale-error`. `--refresh` rereads Gitea. Comment `id`s come from here.
- `bb gitea files <owner/repo> <number> [--refresh]` returns changed files and diffs for the returned `revision`, with `freshness` and a `stale` flag when the pull request moved during the read. Each file's `diff.kind` is `text` (with `patch`), `empty`, `binary`, `too-large` (over 256 KiB), or `unavailable` with `reason` `missing`, `stale`, `diff-too-large`, or `diff-failed`.
- `bb gitea options <owner/repo>` lists the repository's labels (name and color) and assignable users.
- `bb gitea thread [<thread-id>] [--scan]` lists the pull requests of a BB thread, this one by default, and of its child threads, with each one's state and how the thread got it (`opened`, `pushed`, `sent`, `auto-fixer`, `linked`, or `from child <thread>`). `--json` returns `pulls` (each with `state`, null until first read, holding the title and, while open, `review` and `ci`; `error` when the last read failed; `via`; and `links`), `issues` (each with `state`, null until first read, holding the title and `open` or `closed`), `summary` (pull requests only), and `scanning`. `--scan` rereads the thread's whole history. The thread's side panel shows the same pull requests as a table of review and CI status, and the thread's header count, context row, context card (with bb's `threadContextCard` experiment on) and sidebar row (with the `threadRowMetadata` experiment and Organize → Rows → Metadata on, in bb's sidebar or a plugin list that draws `experimental_ThreadRowMetadata`) show their CI.
- `bb gitea refresh` rediscovers repositories now. Otherwise discovery is reused for 30 seconds, so a newly added project can take that long to appear.

## Write

- `bb gitea create-issue <owner/repo> <title> [--body text]`
- `bb gitea comment <owner/repo> <number> <body>`
- `bb gitea comment-edit <owner/repo> <number> <comment-id> <body>`
- `bb gitea comment-delete <owner/repo> <number> <comment-id>`
- `bb gitea line-comment <owner/repo> <number> <path> <line> [--old] <body>` comments on a line of the head diff. `--old` targets the removed side.
- `bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>` replaces labels and assignees. An empty string clears a field.
- `bb gitea set-state <owner/repo> <number> <open|closed>`
- `bb gitea draft <owner/repo> <number> on|off` adds or removes the `WIP: ` title prefix that marks a Gitea draft. `off` also strips `[WIP]`.
- `bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]`
- `bb gitea send-agent <issue|pr> <owner/repo> <number>` starts a BB thread on the item. The item's repository needs a BB project checkout. The thread is told not to write to Gitea unless asked. This and the panel's direct Start/Review actions append manual thread links; clickable ⚡ agent badges show the resulting history, separately from auto-fixer status.
- `bb gitea agent-execution [<provider> <model> <reasoning> [fast|default] | default]` shows or sets the model for send-agent threads. `default` uses the project default.
- `bb gitea link <issue|pr> <owner/repo> <number> [--thread <thread-id>]`, or `bb gitea link <url>`, links an item to an existing BB thread, by default the thread that runs the command. It adds the same ⚡ agent badge as a send and writes nothing to Gitea. It fails if the thread is deleted or the item is the other kind. Linking an item twice is a no-op; the output says `already linked`. `--json` returns `{ result: "added" | "already" }`.
- `bb gitea unlink` takes the same arguments and removes that link from the thread and from the item's badges. Other threads' links to the item stay. `--json` returns `{ removed }`.

## A thread's pull requests

Do nothing to make a pull request show up in your thread's Gitea table. The plugin reads your thread's commands. A successful `tea pr create`, `tea pulls create`, or `tea api -X POST …/pulls` links each pull request URL it printed for this server, and a `git push` links the pull request named on a `remote:` line. A URL that only appeared in printed text, such as an older pull request mentioned in the new one's body, is dropped once Gitea shows it was created before the command ran. A create whose output you cut down to `pulls/<n>` or a bare number, with `| grep -o 'pulls/[0-9]*'` or `| jq -r .number`, is linked too: the plugin finds the pull requests your tea login created while the command ran with a number the output named. `#<n>` does not count. Run `bb gitea link pr` only for one the plugin cannot see, such as a pull request you land but did not open, or one created in the web UI.

## Auto-fix and Auto-merge

Each pull request has two independent switches, both off by default.

- Auto-fix fixes CI failures and addresses review feedback. It may commit, push, rebase, and reply to and resolve review comments. It never merges.
- Auto-merge merges with `tea pulls merge --style` once permissions, branch protection, required checks, approvals, and conflicts allow. It never changes code.

Turning either on starts an auto-fixer: a hidden BB thread on the host of the repository checkout discovered by the plugin. Install `tea` and sign in on that host; the plugin server's login does not automatically authenticate an agent on another host. The thread watches the pull request until Gitea reports it merged or closed, or until it needs a human. Its final marker counts only when Gitea's `merged` or `state` confirms it. Changing a switch updates the same thread; if the update cannot be delivered, the auto-fixer stops. Turning both off stops the auto-fixer, archives the thread, and keeps the session record. Gitea has no native auto-merge, so these limits come from the auto-fixer's instructions and the tea login's permissions.

- `bb gitea auto-fix|auto-merge <owner/repo> <number> on|off`
- `bb gitea auto-fixer-status <owner/repo> <number>` shows `status` (`idle`, `watching`, `needs_you`, `failed`, `stopped`, `merged`, `closed`), `automation` (`fix`, `merge`), and available actions.
- `bb gitea auto-fixer-retry <owner/repo> <number>` resumes a failed or needs-you auto-fixer with its last switches. It starts a replacement thread if the old thread was deleted or its workspace was retired, preserving the archived old thread. It rejects stopped, closed, and missing sessions; turn a switch on instead.
- `bb gitea auto-fixer-thread <thread-id>` shows the session owned by a thread.
- `bb gitea auto-fixers` lists sessions.
- `bb gitea automation-defaults [fix|merge on|off]` shows or sets Auto-fix all and Auto-merge all. When on, every five minutes (and immediately when switched on) the plugin turns the switch on for your open pull requests in project-backed repositories that have no session or only a closed one.
- `bb gitea pr-watch <owner/repo> <number> [--since token] [--timeout seconds]` waits for a cheap change signal: the pull request record (state, head, base, mergeability, update time, comment counts) and the combined head commit status, checked every 30 seconds for up to 240 seconds (at most 600). It prints `changed`, `unchanged`, or `inactive` (the auto-fixer session is no longer watching) and a token for the next `--since`. Auto-fixers use it instead of rereading the full diff and conversation.
- `bb gitea auto-fixer-execution <provider> <model> <reasoning> [fast|default]` sets the model for new auto-fixers.

## RPCs

Reads: `status`, `refresh`, `listItems`, `listMyIssues`, `listMyPullRequests`, `detail`, `conversation`, `pullFiles` (pass the conversation `revision`; the current one is returned if the pull request moved), `repoOptions`, `threadItems` (`threadId` and optional `refresh`; the thread's pull requests with their stored state, review and CI, its child threads' pull requests, and the issues it was started for, with a `summary`; `refresh` reads the open and not yet read ones again on the next sweep; the realtime channel `thread-items-changed` says when to read it again), `threadPulls` and `threadPullBadges` (`{ keys }`, up to 200 thread ids; each thread's `pulls` and `summary` as `threadItems` returns them, from what the plugin stored, with no Gitea or history reads; while a client watches a thread through `threadPulls`, the plugin reads its new commands and keeps its open pull requests on the 30 s refresh, and `threadPullBadges` does neither; both carry the tag `thread-pulls`, invalidated whenever a link or a stored state changes or a thread above a linked one moves or is deleted, and each row also carries `thread-pulls:<thread-id>`, invalidated when a watched thread's rows change, such as when it gains a child thread), `listLinks` (manual thread links keyed by `kind:lowercase-repo#number`, with the current Gitea `account`; badge history persists through archival/deletion).

Writes: `createIssue`, `comment`, `editComment`, `deleteComment`, `reviewComment` (line comments), `updateMetadata`, `setState`, `setDraft`, `review`, `sendAgent`, `linkItem` and `unlinkItem` (`{ repo, number, kind, threadId }`, returning `{ result }` and `{ removed }`; bb-side only, no Gitea write), `draftAgent` (returns the prompt without starting a thread), `getAgentExecution`, `setAgentExecution` (`execution`, or null for the project default).

Auto-fixers: `setAutomation` (`repo`, `number`, and `fix`, `merge`, or both), `retryAutoFixer`, `getAutoFixerStatus`, `autoFixerThread`, `listAutoFixerSessions`, `getAutoFixerPreferences`, `setAutoAutomation` (`fix`, `merge`, or both), `setAutoFixerExecution`.

## Limits

- Lists cover at most 50 repositories, ten pages of 50 items per repository, and 200 items total. Errors are reported per repository.
- Comments and reviews stop at 500, files at 500, checks at 100. A full result is marked as possibly truncated.
- Thread table: open pull requests and issues are reread every 30 s while their thread's table, header, context row or card is open and every 10 min otherwise, closed ones every 5 min or 6 h, merged ones never; an open pull request's reviews and CI are read on every refresh; at most 12 tea calls in any 30 s.
- Panel caches: conversations 15 s fresh and 10 min stale, file sets 5 min fresh and 30 min stale, lists 15 s fresh and 10 min stale. Writes, settings changes, and rejected logins clear them. `show`, list commands, auto-fixers, and merges never use the cache.
- Issue blocker checks use only dependency endpoints, stop at a known open blocker or ten pages, and share the eight-request tea limit. They are cached for 15 seconds without stale reuse and are invalidated by refreshes, writes, and account/settings changes. A filtered empty list may still have unchecked issues beyond the 200-item cap; narrow the repository or query.
- Checks come from commit statuses.

## Settings

Set in the plugin settings page or with `bb plugin config gitea set <key> <value>`.

- `baseUrl`: Gitea root URL, default `https://gitea.com`. HTTPS is required except on localhost. A path prefix is kept.
- `teaProfile`: optional `tea` login name. When empty, the plugin uses the login whose URL matches `baseUrl`. Set it when matching logins belong to different users. A login for another instance is rejected.
- `extraRepos`: optional `owner/repo` names, comma or space separated. They work without a project, but agent features need a project checkout.
- `cacheEntryLimitMiB` (default 16): largest Gitea response read and cached. Larger reads fail with "exceeded the N MiB limit"; raise it for huge diffs.
- `cacheLimitMiB` (default 64): memory for each display cache.
