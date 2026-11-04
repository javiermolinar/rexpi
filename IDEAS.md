# Ideas

## Workspace templates

- `/rxsave <name>`: save a named workspace template.
- `/rxrestore <name>`: reuse a matching live workspace, or recreate it from the saved template if absent.
- Start with workspace names and project directories; decide whether to include tab/pane layouts.
- Use fresh Pi conversations by default. Do not automatically execute saved prompts or arbitrary commands.
- Prefer native Rex support where available. Rex already exposes server-startup restoration through `--restore` (default true); the installed API currently exposes no per-workspace restore/template action.
- Templates recreate workspace structure, not running processes, terminal state, or conversation history.

## Worktree management overlay

- A small Pi overlay to list Git worktrees, switch between them, and delete them.
- Show each worktree's path, branch, and dirty status.
- Define switching semantics: open Pi in the selected worktree or change the current conversation's working directory.
- Require confirmation before deletion; protect the main worktree and worktrees with uncommitted changes or active agents.

## Agents status overlay

- First slice implemented as `/rxagents`: filter native agent statuses per pane and jump between live agents, including splits sharing a tab.
- Reuse Rex's native Activity reporting for statuses rather than introducing a duplicate status protocol.
- Resolve the selected agent's current live pane before navigating; clearly distinguish stale or unavailable agents.
