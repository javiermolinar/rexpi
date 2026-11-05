# Changelog

## Unreleased

- Add one-shot related-launch capability grants for literal tool whitelists, attenuated delegation, result return, model turns, whole-incarnation timeouts, and authorized read/write/edit paths. Grants are in memory, revoked on replacement, and preserve ungranted launch compatibility.
- Add canonical path containment, no-follow and replacement fences, descriptor-based file I/O, hardlink-write denial, and missing-parent cleanup. Document the residual non-atomic ancestor-lookup limitation and that explicitly granted shell tools are not OS-sandboxed.
- Extend related conversation reads with bounded head/tail pagination, exclusive since entries, entry-type filters, and stable text-only projections; cursors now bind the complete query and stale leaf.
- Pin the verified startup endpoint incarnation and reject first-contact same-bootstrap replacements before accepting status/results or issuing cancellation/stop effects; correct legacy protocol-safe request-ID documentation.
- Add the standalone supervised-agent lifecycle: related launches return and propagate exact token-free handles; status/events, explicit completion/results, cancellation, and sequential `rex_agent_stop` preserve independent evidence axes.
- Add explicitly authorized (`authorize:true`) cooperating-endpoint stop using only Pi graceful shutdown, with accepted/closed/disconnected/unknown outcomes, exact generation/runtime fences, and parent/child deduplication. Stop never aborts, kills, restarts, cleans up, retries, or retracts surviving work.
- Document handle creation versus binding/readiness, bounded retained evidence, pending/unknown results, cancellation acknowledgement versus quiescence, and stop acceptance versus exit.
- Add authenticated native reads of related live Pi branches and compacted context, plus attributed peer messages with explicit steering/follow-up delivery.
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
