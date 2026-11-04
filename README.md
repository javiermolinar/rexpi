# pi-rex

Pi-aware launches and conversation navigation for [Rex](https://www.superlogical.com/rex).

Ports Pi-aware launches, conversation navigation, and configurable terminal workflows from [pi-cmux](https://github.com/javiermolinar/pi-cmux), using Rex's installed CLI/server API instead of cmux RPCs. Rex already supplies terminal control and Activity reporting; this package does not replace either.

## Requirements

- Pi **1.5.0+**, Node **22.19.0+**.
- Pi running interactively in a **local Rex terminal**.
- A same-user Unix-socket Rex server and the correct Rex CLI on PATH, or `PI_REX_CLI`.
- A Pi-compatible executable on PATH, or `PI_REX_BINARY`.

Native smoke tested with Rex Beta **0.1.0 (1758)**, Pi **1.5.0**, Node **26.12.1** on macOS. No minimum Rex version is certified.

## Try or install

From this repository, without changing your Pi settings:

```sh
pi -e ./extensions/index.ts
```

If `rex` on PATH is missing or is another program, set `PI_REX_CLI` to the full executable path first.

To enable it persistently, explicitly install the local package:

```sh
pi install /absolute/path/to/pi-rex
```

Then start a fresh Pi session in Rex, or use Pi's `/reload` after installation. Installation is not performed by any package command or startup hook.

The package activates only when both `REX_SESSION` and `REX_BLOCK` contain valid Rex IDs. Otherwise it registers **no tools, commands, shortcuts or lifecycle hooks**, performs no native calls or state writes, and leaves bootstrap data untouched. It can stay installed alongside other terminal integrations without reserving keys or commands outside Rex. Inside Rex, live server/pane/process verification is still required before the launch/open tools, personal commands and return shortcut activate.

## Commands

| Command | Effect |
|---|---|
| `/rxn [task]` | Fresh Pi in a new Rex session |
| `/rxv [task]` | Fresh Pi in a right split |
| `/rxh [task]` | Fresh Pi in a lower split |
| `/rxt [task]` | Fresh Pi in a tab |
| `/rxbk` | Return to the exact live parent Pi conversation |
| `/rxwho` | Inspect this conversation's identity and remembered child evidence |
| `/rxagents` | Filter agent statuses across Rex panes and jump to an exact live pane |
| **Ctrl+Alt+B** | Same as `/rxbk`, unless disabled or changed |

Commands accept plain task text, not shell options. All launches are **fresh conversations**. Slash launch commands are independent tasks in their specified location; use the structured tool for related tasks/reviewers.

The parent's conversation stays open. No source Rex session is renamed. Explicit launch labels apply only to newly created resources.

All Pi launches use Rex's `--keep-open`: quitting the agent retains its terminal, so an agent exit alone does not remove the last pane and its workspace. This applies to slash launches, `rex_start_pi`, `rex_jump`, and new workspaces from `rex_open_session`. It does not start a replacement shell or restart Pi. You can still close the pane explicitly; closing the last pane can remove the session. Existing panes are unchanged, and this does not provide restoration after a Rex server restart.

## Agents overlay: `/rxagents`

Open a small Pi overlay listing agents across local Rex sessions, tabs, **splits**, and floating panes. Agents sharing a tab remain separate rows, identified by pane and process rather than the tab's aggregate indicator.

- Type to filter by agent, state, title, session/tab, directory, pane ID, PID, or Pi role. Use the configured Pi selection keys (Up/Down and Enter by default); Esc or Ctrl+C closes. Ctrl+R refreshes immediately.
- The overlay reads Rex's native program-status records and live process information. It recognizes Pi, Claude/Claude Code, Codex, OpenCode, and Gemini. Agents without native status reporting are also discovered from known CLI executable/argv0/script metadata, including Claude's versioned native executable; terminal titles alone never establish agent identity. Other programs and remote/detached panes are excluded.
- Statuses are `working`, `blocked`, `error`, `done`, or `idle`. A recognized live agent without native status appears as `unknown`, never an invented success/idle state. Older/wrapped Pi executables can also be identified by a live pi-rex binding. Repeated nested reports from the same agent process collapse into its most urgent status.
- The current Rex session sorts first. Compact **workspace → agent** tree guides group agents from all tabs and splits without intermediate tab headings or pane-count rows; this is workspace membership, not inferred parent/child task ancestry. Urgent agents sort first within each workspace, and selection follows the rendered tree. Workspace headings remain visible while scrolling. Tab metadata remains searchable and exact pane navigation is unchanged. Conversation/task names lead each row, with a compact status aligned on the right and agent/current/review context underneath. Native terminal titles are used only when owned by that exact live process; generic `shell` and generated window labels fall back to meaningful project names.
- The entire overlay, including borders and padding, paints an opaque neutral themed surface so colored tool-result backgrounds cannot leak through. Selection uses the theme's soft selected background rather than inverse video. Full paths, PIDs and pane IDs stay out of the default view but remain searchable. Duplicate names get short, stable pane labels; the current Pi is marked `Current`.
- Reads refresh approximately every two seconds while open, with no overlapping refreshes. Closing the overlay cancels pending reads and stops its timer. Unavailable panes/status reads are reported; a failed refresh clears selectable stale rows.
- Enter closes the overlay, then rechecks the exact live process, its CLI identity for process-discovered agents, and any Pi conversation binding before focusing its current pane. Same-session navigation needs no app Remote Control; crossing sessions does. Closed, replaced, ambiguous or changed targets fail without fallback, retries, launches, or cleanup.

Rex also documents **Show each process in tabs** under Settings → Notifications → Program Activity, which can expose per-pane activity in its own Activity view. The overlay provides a separate searchable jump list without changing that setting.

This is a transient navigation UI, not another status protocol, task-completion tracker, or source of execution permission. It adds no default keyboard shortcut and sends no messages or model prompts.

## Terminal tool and personal commands: separate interfaces

### Agent tool: `rex_open_terminal`

For an explicitly requested arbitrary tool or command, the agent can use `rex_open_terminal`. It does **not** look up or require an entry in your personal command catalog.

| Argument | Meaning |
|---|---|
| `command` | Executable/argument array, or shell text |
| `placement` | `right` (default), `down`, `tab`, or `floating` |
| `cwd` | Existing local directory; default this Pi conversation's cwd |
| `title` | Optional terminal/tab label |
| `focus` | Default true; false preserves focus |
| `keepOpen` | Keep the terminal after the command exits; default false |
| `bounds` | Floating only: `[x, y, width, height]` fractions inside the current window |

For example: `{ "command": ["lazygit"], "placement": "floating" }`.

Arrays run directly with literal arguments and the parent's PATH. Strings explicitly run through `/bin/sh -c` and can use pipes/redirection; they are executable shell code, not a read-only viewer. Shell aliases/functions are not copied. Working directories and array executables are checked locally before creation.

Floating terminals are native layers inside the caller's Rex tab, **not macOS windows**. They default to `[0.1, 0.1, 0.8, 0.8]`; their size/position must fit the window. They use `session.new_layer` directly and do not require app Remote Control.

Terminal creation returns exact known IDs when confirmed. It does not prove the command is ready, successful or complete. Unknown outcomes are never retried or cleaned up automatically. Use `rex_start_pi`, not this terminal tool, for new Pi conversations.

### Your shortcuts: `pi-rex.commands`

Named user commands are independent configuration in Pi's settings, not a separate model tool per program:

```json
{
  "pi-rex": {
    "commands": {
      "ch": {
        "run": ["hx"],
        "acceptArgs": true,
        "placement": "right",
        "title": "Helix"
      },
      "cl": {
        "run": ["lazygit"],
        "placement": "floating",
        "bounds": [0.1, 0.1, 0.8, 0.8],
        "title": "Lazygit"
      },
      "ck": {
        "run": ["hunk", "diff", "--agent-notes", "--watch"],
        "acceptArgs": true,
        "placement": "right",
        "title": "Hunk diff"
      }
    }
  }
}
```

This example makes `/cl` floating; change each command's placement independently. `/ch "src/a file.ts"` forwards one literal filename. No keyboard bindings are added.

Settings come from Pi's effective `getSettings()`: global settings plus trusted project overrides. The extension does not read project configuration independently. Use `/reload` after changing the catalog.

Each entry can be a command string/array shorthand, or an object with `run`, `acceptArgs`, `placement`, `cwd`, `title`, `description`, `focus`, `keepOpen`, `bounds`, and `disabled`. Defaults: right split, focus true, keepOpen false, arguments disabled, command name as title. A project override with `"disabled": true` suppresses that entry under Pi's settings-merge rules.

Forwarded words support single/double quotes and backslash escapes, but **no variable, tilde, glob, or command expansion**. Arrays preserve literal arguments directly; shell-string entries append individually quoted words. Prefer arrays for unambiguous program-argument forwarding.

Command names must be lowercase letters/digits/hyphens, start with a letter, and contain at most 32 characters. Pi 1.5 built-ins and names already registered by other commands are reserved. Up to 64 configured entries are read; malformed/reserved entries are skipped with a warning. Invalid personal configuration does not disable `rex_open_terminal`. Later extension registrations can still introduce conflicts outside this package's control.

Nothing in the catalog runs at startup, and an entry does not authorize an agent to execute it. User invocation of a slash command is distinct from an agent's explicit `rex_open_terminal` request. No `pi-cmux` settings are imported automatically.

## Reusable named workspaces: `rex_open_session`

Ask **"Open my Tempo session"**. The agent can use:

```json
{ "sessionName": "Tempo", "query": "tempo", "title": "Main" }
```

- A unique existing **Tempo** session is selected. No Pi is started, no task is sent, and no existing tab/model/name is changed.
- If absent, `query` resolves its creation directory (path or zoxide), and one empty Pi workspace is created with exact session name **Tempo** and initial tab title **Main**.
- `query` is required only for creation; use `"."` for the current directory. Existing workspaces do not perform a directory lookup. `title` is also creation-only.
- `focus: false` finds or creates without switching the app. App selection requires Rex **Remote Control**; creation itself does not. If selection fails after creation, the result retains the known new session rather than retrying.
- Existing sessions may contain any programs, not necessarily Pi. This tool only navigates to them. It has no prompt or model-change parameter.
- Names match case-insensitively with Unicode NFC normalization. Multiple matching labels are rejected, never guessed, renamed, closed or merged.
- New names are trimmed, 1–120 characters, without control characters or a leading dash. There is no automatic `Pi ·` prefix, alias matching or stripping prefixes from older labels.

Pi-rex clients reserve a name in private local state while creating it, rechecking before creation. Unknown creation leaves that reservation in place: no automatic expiry, stealing after process death, or retry. Inspect Rex and settle the uncertain outcome before explicitly clearing a retained reservation. Manual/nonparticipating Rex clients do not honor these reservations, so global name uniqueness is not guaranteed; ambiguous names remain an error.

These are reusable **named workspaces**, not a new persistence engine. They follow Rex's existing lifecycle. New Pi terminals stay open after the agent exits, but this package does not pin empty sessions, restore programs after a server restart, or promise restart survival.

`rex_start_pi` remains fresh-only. It also accepts `sessionName` for exact naming with session placement, independent of `title`. It rejects existing names rather than silently reusing them; use `rex_open_session` for reuse. Without `sessionName`, its original `Pi · <title>` naming stays unchanged.

## Project jumps by prompt: `rex_jump`

Ask **"Open Tempo in a new tab"**. The agent can call:

```json
{ "query": "tempo" }
```

`rex_jump` resolves an existing local directory or zoxide keywords, then reuses the verified Pi launcher to create **one fresh Pi conversation in a new tab**. It does not change the current conversation's cwd or open a shell-only tab.

- Existing absolute, relative and `~/…` paths take priority and work without zoxide.
- Non-path keywords use `zoxide query -- <keywords>` and its best-ranked match, without a picker. The result reports the resolved directory.
- Missing explicit paths and existing non-directory files fail rather than silently opening an unrelated project.
- Fuzzy lookup requires `zoxide` on the parent Pi process's PATH. Lookup is bounded to five seconds and does not modify zoxide's database.
- `prompt` is optional: opening a project alone sends no initial model task. Supply it only for an explicitly requested task.
- Optional `title`, `focus`, `provider`, `model`, `thinking`, `related` and `role` follow Pi launch semantics. Placement is always a new tab; new tasks are independent by default.
- The source conversation stays open. Parent identity, `/rxbk`, exact startup checks and unknown-outcome guards are retained; no history or automatic results are transferred.
- No zoxide slash commands or keyboard bindings are installed by this feature.

Directory resolution and the source conversation are checked before creation. A successful lookup is not task permission or task readiness. Repeated request IDs return the original outcome and never launch again automatically.

## Structured Pi launches

The `rex_start_pi` tool supports:

- `prompt`, an optional initial task, limited to 16,384 characters.
- `cwd`: an existing absolute, relative, or `~/…` local directory; defaults to the caller's cwd.
- `placement`: `session`, `right`, `down`, or `tab`.
- `related` and `role` (`chat` or `review`); review implies related.
- `title`, `focus`, `provider`, `model`, and `thinking`.
- `sessionName`: an optional exact new session label, only with session placement; separate from the tab/task title.

Provider requires model. Omitting both uses the child's normal Pi defaults, not necessarily the parent's current selection. Thinking supports Pi's levels through `max`; Pi applies its own model-capability clamping.

Placement defaults:

| Relationship | Placement |
|---|---|
| Independent task | New Rex session |
| First related task/reviewer | Right split |
| Further related tasks | Tab |
| Background related task (`focus: false`) | Tab |
| Explicit placement | Always honored |

Once a related split was requested in this runtime, even an uncertain launch reserves that preference. There is no automatic replacement when a child closes. Child memory is bounded and clears on reload, tree navigation, and session replacement; it is not a process monitor or scheduler.

### Startup evidence

Creation and initialization are separate:

- `creation: confirmed`: Rex returned the exact new block ID.
- `creation: unknown`: the request may have taken effect before its reply was lost.
- `startup.state: bound`: the exact expected child task, conversation, Pi session, Rex pane and live process matched.
- `startup.state: unconfirmed`: no matching binding was verified, verification was interrupted, or its deadline expired.

Verification waits up to ten seconds after creation. A binding proves the Pi orientation hook ran, **not** that all startup work finished, a prompt was processed, the task is ready, or the task completed.

Repeated tool-call IDs return their original promise/result. Unknown outcomes are never retried, respawned, killed, or cleaned up automatically. Inspect Rex before deliberately trying again. Cancellation after dispatch does not terminate the child or roll back creation. A confirmed creation can still have an unconfirmed app-selection outcome.

Children explicitly load this extension, even when the parent was started with `-e` rather than a persistent install. Launches use an argv array and `--shell=none`, not interpolated shell commands. Leading `@` and slash task text is prefixed with `Task:` so it cannot attach files or invoke extension commands.

## Conversation identity and return

Task IDs group related work; conversation IDs identify particular chats. Pi session IDs are recorded separately. Parent links apply to independent launches too.

- Reload/resume restores metadata from the **active branch** for the same Pi session.
- New sessions, forks and clones do not adopt their source session's conversation identity.
- Tree navigation rebuilds branch-relative state and cancels operations using the old runtime.
- Pi keeps setup-only chats in memory until their first user/assistant message; an empty no-prompt chat has no durable session file yet.
- `/rxbk` resolves the parent's uniquely live conversation, checks the exact process and current Rex location, then selects/focuses it. Moving panes/tabs does not require saved coordinates.
- Closed, stale, duplicate, remote, detached or reused targets fail without a nearby-pane/title/index fallback.
- Parent links, titles, reviewer roles and live bindings **never grant execution or messaging permission**.

Bindings are same-user local evidence, not a security boundary against another process running as you. They are private `0600` files in a `0700` directory, renew every five seconds, and expire after twenty. They contain identities, process IDs and Rex block IDs, not prompts or conversation history. Server instance IDs prevent reuse after a server restart. Shutdown removes this runtime's lease; crashes can leave expired files.

Navigation is not atomic with other clients moving/replacing panes. It rechecks identities before and between focus operations and reports uncertainty; it does not attempt rollback. Same-session returns use server-side pane/tab focus and do not require app Remote Control. Cross-session returns additionally select the session through a client action and require **Remote Control** in Rex Settings; a disabled setting is reported explicitly. Exact pane focus is verified against the server's layout.

## Configuration

Set environment variables **before starting Pi**:

| Variable | Default | Purpose |
|---|---|---|
| `PI_REX_CLI` | `rex` | Rex executable name or path |
| `PI_REX_BINARY` | `pi` | Pi-compatible executable name or path; no inline arguments |
| `PI_REX_SERVER` | CLI discovery | Initial server selection; pinned to its verified endpoint/instance |
| `PI_REX_CLIENT` | Pane owner, otherwise one unambiguous app | Full Rex client ID for app selection |
| `PI_REX_STATE_DIR` | `<Pi agent dir>/pi-rex/bindings` | Private local binding directory; symlink components are refused |
| `PI_REX_RETURN_KEY` | `ctrl+alt+b` | `off`, or ordered ctrl/alt/shift modifiers plus a letter/digit |

The Pi agent directory honors `PI_CODING_AGENT_DIR`. Children share that directory and its settings/auth files. Their PATH is explicitly taken from the parent. Environment-only provider credentials are not explicitly forwarded; the child otherwise inherits the Rex server's environment. No credential values are placed in launch arguments by this package.

An executable override is one executable, not shell code. Wrappers must forward Pi's CLI flags, including `--session-id`, `--extension` and the prompt separator `--`. Relative executable paths resolve in the parent cwd before the child changes directory.

## Deliberately not implemented

- Conversation-history handoffs or worktree creation.
- Peer messaging or automatic result return.
- Browser annotations.
- Remote/SSH Pi launches.
- Token/cost dashboards, persistent custom panels, or duplicate OSC activity reporting.
- Automatic delegation, scheduling, recovery or installation.

Those are separate follow-up slices, not implied by a successful launch.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run pack:check
```

The automated tests use fake Rex responses and temporary private state. They cover launch fencing, cancellation/lost replies, exact identity, process checks, reload/fork handling, competing leases, target replacement, argv safety and symlink rejection.

An explicit native smoke test is also available:

```sh
PI_REX_CLI=/absolute/path/to/rex npm run smoke
```

It creates a hidden disposable Rex session with isolated Pi settings, a dummy key, offline wrappers and **no model prompts**. It checks exact session naming separately from tab titles, real parent/child Pi tab bindings, parent identity across `/reload`, same-session `/rxbk` focus, fresh identity after `/new`, and configured floating/tab terminals executing with preserved focus. It destroys only its known test session. If creation is uncertain, it leaves state for inspection rather than retrying. Cross-session app selection and provider/model task execution are not exercised; those remain unverified live.

The smoke script is repository-only and is not published in the npm package.
