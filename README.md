# Gitea for BB

Browse and act on Gitea issues and pull requests from BB, and let a BB agent fix or merge your pull requests. All Gitea access goes through the [`tea`](https://gitea.com/gitea/tea) CLI; BB stores no Gitea token.

## Requirements

- BB 0.44.0 or newer with bundled plugin SDK 0.5.29 or newer. SDK 0.5.29 is the earliest published version with `threads.get().canRestoreEnvironment`, used to detect when an auto-fixer needs its workspace restored.
- `tea` 0.15.1 or newer, signed in with `tea login add`.
- A BB project whose `origin` remote points at the Gitea instance, or repositories listed in `extraRepos`. Agent features need a project checkout.

## Install

```sh
bb plugin install https://github.com/Nick-Motion/bb-plugin-gitea
bb plugin update gitea --yes   # later, to update
```

The plugin id is `gitea` and it adds the `bb gitea` command.

## Configure

| Setting              | Default             | Meaning                                                                                          |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `baseUrl`            | `https://gitea.com` | Gitea root URL. HTTPS is required except on localhost. A path prefix such as `/gitea/` is kept.  |
| `teaProfile`         | auto                | `tea` login to use. Leave empty when one login matches `baseUrl`.                                |
| `extraRepos`         | empty               | Extra `owner/repo` names, comma or space separated.                                              |
| `cacheEntryLimitMiB` | 16                  | Largest Gitea response the plugin reads and caches, in MiB. Larger responses fail with an error. |
| `cacheLimitMiB`      | 64                  | Memory for each display cache (conversations, diffs, lists), in MiB.                             |

```sh
bb plugin config gitea set baseUrl https://gitea.example.com
bb plugin config gitea set extraRepos owner/repo,team/project
```

Repositories are the union of matching project `origin` remotes and `extraRepos`.

## Panel

The Gitea panel has five tabs: **My PRs**, **My Issues**, **Issues**, **Pull requests**, and **Auto-fixers**. Lists filter by repository, state, and text. **My Issues** shows issues assigned to the signed-in account (not pull requests); creating an issue from that tab assigns it to you. Creating from **Issues** does not automatically assign anyone.

An issue or pull request opens on **Conversation**, where you can:

- comment, and edit or delete your own comments;
- add or remove labels and assignees from the repository's options;
- close or reopen, and mark a pull request as a draft or ready;
- review (comment, request changes, approve);
- see checks (click one to open its run) and reviews;
- draft an agent thread (**Draft with agent** pre-fills the BB compose form so you can add skills before submitting).

**Files changed** shows a file tree and diffs, unified or split. Click the `+` beside a line to leave a line comment; existing line comments appear under their line and in the conversation.

The same views appear in the side panel of a BB thread linked to the item.

## Gitea environment

When you start a thread, pick **Gitea** in the environment picker. Its menu has these parts:

- **Work in**: **New worktree** or **Existing worktree**, the same choices as BB's Worktree environment.
- **Your branches**: branches with an open pull request from you, newest pull request update first, then branches whose last commit is yours, newest commit first.
- **Other branches**: all other branches of the project's Gitea repository, newest commit first. This section is hidden until you select **Show other branches** or type a search.

A branch with a pull request shows the pull request title, with the branch name below it, and a badge with its number. The color shows the pull request's state:

| Color  | State |
| ------ | ----- |
| Grey   | Draft, or open with no CI statuses |
| Red    | CI failing |
| Yellow | CI running |
| Green  | CI passing |
| Purple | Merged |

The badge shows the newest open pull request for the branch, or else the newest merged one. Merged badges come from the 100 most recently updated closed pull requests. CI states load after the branch list, so badges start grey and then change color. The CI states of other people's pull requests are read only when **Other branches** is shown, for at most 100 of them. A passing or failing result is kept for 5 minutes per commit, and a running one for 20 seconds.

With **New worktree** and no branch picked, the thread gets a new branch from the default branch. Picking a branch creates a worktree on that branch itself. The plugin fetches the branch from `origin`, then uses the local branch or creates one that tracks `origin`.

Under **Existing worktree**, pick a worktree, then pick **Keep current branch** or a branch. A branch switches that worktree to it. The switch fails if the worktree has uncommitted changes.

The environment is available only when the `origin` remote of the project's checkout is on the configured Gitea instance. Branches from forks are not listed, because they cannot be checked out from `origin`. Worktrees go under the plugin's data folder on the machine that has the project checkout. The plugin does not copy `.worktreeinclude` files into new worktrees.

## Auto-fix and Auto-merge

Pull request rows in **My PRs** and **Pull requests** have two independent switches, both off by default:

- **Auto-fix**: fix CI failures and address review feedback. It may commit, push, rebase, reply to and resolve review comments, and mark a WIP pull request ready. It never merges.
- **Auto-merge**: merge once permissions, branch protection, required checks, approvals, and conflicts allow. It never changes code.

Turning either on starts an auto-fixer: a hidden BB thread that watches the pull request until it is merged or closed, or until it needs you. Changing a switch updates the same thread. Turning both off stops it and archives the thread. **Retry** resumes a failed or needs-you auto-fixer.

Closed or merged PRs automatically archive their auto-fixers, including paused and failed sessions. BB stops the thread, withdraws plugin-owned queued messages, and retires its terminals and managed environment through the thread archive lifecycle. Failed cleanup retries automatically. Archived sessions are hidden by default; select **Show archived** to view their history. A reopened closed PR can start a new auto-fixer.

Auto-fixers run on the host of the repository checkout discovered by the plugin. Install `tea` and sign in on that host as well as the BB server host. If BB has retired a failed auto-fixer’s workspace, Retry starts a replacement thread and preserves the archived one.

While idle, an auto-fixer waits with `bb gitea pr-watch`, which checks the pull request record and its combined CI status every 30 seconds and returns as soon as either changes. It rereads the full diff and conversation only after a change.

Gitea has no native auto-merge. The auto-fixer acts with your `tea` login's permissions, and the limits above are enforced by its instructions, not by Gitea. A reported merge or close counts only when Gitea confirms it.

The top of **My PRs** has **Auto-fix all** and **Auto-merge all**. When on, the plugin checks every five minutes, and immediately when switched on, and starts auto-fixers for your open pull requests that have none. The same bar picks the model for new auto-fixers.

## CLI

Every panel action has a `bb gitea` command. Read commands accept `--json`.

```sh
bb gitea status | repos | refresh
bb gitea issues|prs|my-prs|my-issues [owner/repo] [--state open|closed|all] [--query text]
bb gitea show <issue|pr> <owner/repo> <number>             # live read
bb gitea conversation <issue|pr> <owner/repo> <number> [--refresh]
bb gitea files <owner/repo> <number> [--refresh]
bb gitea create-issue <owner/repo> <title> [--body text]
bb gitea comment <owner/repo> <number> <body>
bb gitea comment-edit <owner/repo> <number> <comment-id> <body>
bb gitea comment-delete <owner/repo> <number> <comment-id>
bb gitea line-comment <owner/repo> <number> <path> <line> [--old] <body>
bb gitea options <owner/repo>                              # labels and assignees
bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>
bb gitea set-state <owner/repo> <number> <open|closed>
bb gitea draft <owner/repo> <number> on|off
bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]
bb gitea send-agent <issue|pr> <owner/repo> <number>
bb gitea agent-execution [<provider> <model> <reasoning> [fast|default] | default]
bb gitea thread <thread-id>
bb gitea auto-fix|auto-merge <owner/repo> <number> on|off
bb gitea auto-fixer-status|auto-fixer-retry <owner/repo> <number>
bb gitea pr-watch <owner/repo> <number> [--since token] [--timeout seconds]
bb gitea auto-fixer-thread <thread-id>
bb gitea auto-fixers
bb gitea automation-defaults [fix|merge on|off]
bb gitea auto-fixer-execution <provider> <model> <reasoning> [fast|default]
```

Comment ids come from `bb gitea conversation ... --json`. `--old` puts a line comment on the removed side of the diff.

## Behavior and limits

- `conversation`, `files`, and the panel read through a short in-memory cache (about 15 seconds for conversations and lists, 5 minutes for diffs) and refresh in the background. Repository discovery is reused for 30 seconds and label and assignee options for 60 seconds; `bb gitea refresh` clears both. Any write through the plugin clears the affected entries. `show`, `issues`, `prs`, `my-prs`, `my-issues`, auto-fixers, and merges always read Gitea directly.
- Lists cover at most 50 repositories and 200 items. Comments and reviews stop at 500, files at 500, checks at 100. Results that hit a cap say so.
- Checks come from commit statuses.
- Gitea marks a draft by title prefix. `draft on` adds `WIP: `; `draft off` removes `WIP:` or `[WIP]`.
- Agent threads started with **send-agent** are told not to write to Gitea unless asked. Auto-fixers are the exception, within their switches.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build .
```

Tests use a fake `tea` and never contact Gitea.

## License

MIT. Adapted from the My GitHub plugin in [BB](https://github.com/get-bb/bb).
