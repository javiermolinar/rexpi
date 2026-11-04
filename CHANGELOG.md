# Changelog

## 0.1.0

- Protect worktrees whose assume-unchanged/skip-worktree index entries can hide local edits, without changing those flags. Block tracked submodules and leftover submodule metadata before admitting a deletion batch; fail closed on incomplete index inspection.
- Replace unbounded batch confirmation with a wrapped, scrollable target review and an explicit Cancel/Remove choice defaulting to Cancel. Keep confirmation inside the terminal height and disable deletion when its choices cannot fit.
- Add Tab-accessible deletion-result details with full literal paths, branches, outcomes and reasons. Scroll long details and return to the existing filtered list without retrying or deleting anything.
- Limit per-removal Git status/index rechecks to the selected target while retaining whole-batch preflight and fresh live-agent discovery. Add regression tests for dispatched cancellation, hidden edits, submodules, large confirmations and long unknown-outcome details.

- Keep a dismissible deletion-results panel open after confirmed worktree batches, showing verified directory/registration removals, blocked/failed/unknown outcomes and unattempted targets. Verify Git registration and directory absence after successful exits; never label an unverified effect deleted or offer automatic retries. Show explicit cancellation feedback.

- Spell out `CTRL-D delete` in the worktree footer instead of `^D remove`; plain D still filters, and Enter still opens the focused worktree.

- Distinguish missing worktree directories from unreadable worktrees in `/rxw`: use neutral `Missing`/`Registration only` labels, a separate count, and sort existing worktrees first. Allow confirmed, targeted cleanup of missing prunable registrations through `git worktree remove -- <path>`, never global pruning. Recheck absence before removal, keep existing/prunable directories and locked entries protected, and label cleanup targets explicitly in confirmation.

- Add Space marking to `/rxw`: show deletion checkboxes and a marked count, preserve marks across filtering/unchanged refreshes, and clear stale or newly protected marks. Ctrl+D confirms all marked paths, preflights the entire batch, then rechecks sequential removals; stop on the first failure/unknown outcome and report confirmed progress. Enter still opens the focused worktree; Alt+Space inserts a search separator.

- Add `/rxw` (`/rxworktrees`) to browse the current repository's Git worktrees with the same shared tree picker as `/rxa`. Show branch/path/dirty status; Enter opens fresh Pi in a tab without task prompts or history transfer. Ctrl+D requires confirmation and rechecks identity, Git status and live Rex agents; protect main/current/bare/locked/prunable/dirty/unreadable worktrees, never force removal or delete branches, and treat interrupted writes as uncertain. Refresh only while open and add no model tool or default shortcut.

- Add `/rxa` as a short alias for `/rxagents` and Ctrl+Alt+A to open the overlay directly. Support `PI_REX_AGENTS_KEY` overrides and `off`, forward them to child launches, and skip return-key conflicts with a warning. Shortcuts activate only after verified Rex TUI startup.

- Remove intermediate tab/pane-count headings from `/rxagents` to save space. Nest agents directly under workspaces while retaining exact-pane navigation and searchable tab metadata.

- Make `/rxagents` nesting explicit with workspace/agent tree guides and sticky workspace context. Paint a full opaque themed surface, including borders and padding, and restore base colors after inner style resets to prevent tool-result background leakage.

- Fix missing Claude and other agents without native status reports in `/rxagents`. Discover recognized live CLI processes, including version-named Claude executables, show their status as unknown, and revalidate CLI identity before navigation.

- Redesign `/rxagents` around workspace groups and meaningful conversation names, with right-aligned statuses, soft selection, and compact controls. Use process-owned terminal titles instead of generic shell labels; hide raw IDs, PIDs and full paths from the default view.

- Add `/rxagents`, a filterable Pi overlay showing native agent statuses per Rex pane, including agents sharing a split tab. Refresh only while open and revalidate exact processes/conversations before jumping; add no status protocol, model tool, or default shortcut.

- Keep all newly launched Pi terminals open after the agent exits, including slash launches, project jumps and named workspace creation. Explicit pane closure and Rex server restarts are not covered.

- Add `rex_open_session` to reuse a unique named Rex workspace without starting Pi or sending tasks, creating an empty named workspace only when absent and a directory query is supplied.
- Add exact `sessionName` labels independent of tab/task titles to fresh session creation. Reject ambiguous names and retain cooperative creation reservations on unknown outcomes; do not add restart persistence.
- Add `rex_jump`: resolve an existing local path or read-only zoxide lookup, then open a fresh Pi conversation in a new tab with optional task/model settings and parent navigation. Add no slash commands or keyboard bindings.
- Add `rex_open_terminal` for arbitrary requested commands, separate from the per-user `pi-rex.commands` shortcut catalog.
- Support right/lower splits, tabs and native floating panes, with cwd, focus, keep-open and floating bounds options.
- Add literal argument forwarding, command-name collision checks and trusted effective Pi settings for personal shortcuts; add no keyboard bindings.
- Fix same-session return navigation to use server-side pane focus without requiring app Remote Control; report disabled Remote Control explicitly for cross-session app selection.
- Activate only with valid `REX_SESSION` and `REX_BLOCK`; register nothing and perform no native I/O outside Rex, so other terminal extensions remain unaffected.
- Add fresh Pi launches through Rex with model/thinking selection, local cwd selection, explicit placement, and task-aware defaults.
- Verify exact child conversation/process bindings separately from terminal creation, with conservative cancellation and unknown-outcome reporting.
- Add persistent branch-relative conversation identity, parent links, `/rxbk` return navigation and `/rxwho` inspection.
- Reuse Rex's native terminal control and Activity reporting; no persistent custom agent panel, handoffs or messaging yet.
- Add automated regression tests and an explicit isolated no-prompt native smoke test.
