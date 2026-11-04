# Ideas

## Workspace templates

- `/rxsave <name>`: save a named workspace template.
- `/rxrestore <name>`: reuse a matching live workspace, or recreate it from the saved template if absent.
- Start with workspace names and project directories; decide whether to include tab/pane layouts.
- Use fresh Pi conversations by default. Do not automatically execute saved prompts or arbitrary commands.
- Prefer native Rex support where available. Rex already exposes server-startup restoration through `--restore` (default true); the installed API currently exposes no per-workspace restore/template action.
- Templates recreate workspace structure, not running processes, terminal state, or conversation history.

## Worktree management overlay

- First slice implemented as `/rxw` (`/rxworktrees`), sharing the agents panel's tree picker and styling.
- Show each worktree's path, branch/detached HEAD, dirty status, and main/current/agent context.
- Enter opens fresh Pi in the selected worktree in a new tab; the current conversation's cwd and history are unchanged.
- Space toggles deletion marks; Ctrl+D confirms the marked batch and rechecks each removal, stopping on failure or uncertainty. Protect main/current/bare/locked worktrees and prunable entries whose directories still exist; allow targeted cleanup of confirmed-missing registrations. Protect uncommitted/untracked/ignored changes, and known live Rex agents. Incomplete discovery blocks deletion.

## Agents status overlay

- First slice implemented as `/rxagents`: filter native agent statuses per pane and jump between live agents, including splits sharing a tab.
- Reuse Rex's native Activity reporting for statuses rather than introducing a duplicate status protocol.
- Resolve the selected agent's current live pane before navigating; clearly distinguish stale or unavailable agents.
