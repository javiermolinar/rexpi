# Changelog

## Unreleased

- Use Rexpi consistently in user-facing messages and internal labels while retaining existing configuration, state, and messaging identifiers for compatibility.
- Add project path and zoxide lookup to `rex_start_pi`, with session, tab, and split placement kept independent of directory lookup.
- Reject combining `project` and `cwd`; explicit directories remain path-only.
- Remove `rex_jump` from the tool list. Use `rex_start_pi` for fresh conversations and `rex_open_session` to reuse named workspaces.

## 0.1.0

First release. Tiny arms, many panes.

- Start fresh Pi conversations in Rex workspaces, splits, and tabs, with model selection and parent navigation.
- Exchange messages between related agents and opt into automatic review findings and result returns.
- Open your favorite tools through custom commands, including floating Helix and Hunk panes.
- Open projects by path or zoxide lookup, and create or reuse named workspaces.
- Find live agents across Rex workspaces with the searchable agent panel.
- Browse Git worktrees, open them in Pi, and remove eligible worktrees with confirmation and safety checks.
