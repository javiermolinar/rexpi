# Changelog

## 0.3.0

- Add configurable multi-host terminal execution: read-only Rex host discovery, explicit per-conversation selection, bounded SSH Unix-socket forwarding, and remote sessions, tabs, splits, and floating panes with exact host/server/resource identities. Remote cwd, executable lookup, and PATH stay remote; disconnects and uncertain creation fail closed without local fallback or automatic retry.
- Document the controller, remote-Pi, and cross-host agent contract in `docs/remote-controller-contract.md`. Existing launches, configured commands, agents, and messaging remain local.

- Validate the complete delegation result-delivery grant before launch: `returnResults:true` now requires `rexpi_message_send` alongside `rexpi_agent_complete`, with no child created on rejection. Delegated prompts include a compact tool/read/write-path manifest and turn-delivery guidance so reviewers do not need to discover their own grant.

## 0.2.0

- Allow image-heavy Pi histories in result-return setup by replacing the incompatible 1 MiB per-entry limit with a 32 MiB aggregate bound, and clarify idle `rexpi_start_pi` sessions versus required-task `rexpi_delegate` work.

- Bound text-only conversation projections per entry with truncation markers and working continuation while preserving raw-read rejection, and treat omitted or empty inbox cursors as the same first page.
- Compact model-visible agent status/result/event and inbox responses by default, with `verbose:true` for full correlation and notices, and add log-backed test commands plus a deterministic coordinator smoke procedure.
- Terminate Pi's current tool batch after `rexpi_agent_complete`, then disarm the capability deadline at the exact local child's `agent_end`. Mixed batches retain normal turn/deadline enforcement, and later turns abort quietly without post-completion turn-limit or expiry warnings.
- Add optional bounded `waitMs` retrieval to `rexpi_agent_result`, with abortable exact-handle reads for pending evidence, immediate terminal/unknown results, and no completion inference from settlement or deadlines.
- Expose exact delegation and fan-out handles in model-visible output, add bounded join outcome projections with clipped summaries, and add opt-in cached agent handles and lifecycle states to `rexpi_inspect` without native or peer reads.
- Rename every model-facing `rex_*` tool to `rexpi_*`, including capability grants and delegated return-route instructions. Expand the injected Rexpi guidance to explain Rex multiplexer control and supervised subagent orchestration, replace terse tool descriptions with concise functional text, and consolidate lifecycle guidance in the shared prompt.
- Reject stale mailbox-worker page schemas, fall back to bounded synchronous read-only decoding, and isolate pending outcomes by worker so retirement cannot reject fresh publishes or trigger publish replay.
- Close orchestration review findings: delegated children receive a bootstrap-bound explicit-completion tool and one-shot settlement opt-in, high-level grants require `rexpi_agent_complete`, stop uses the real authorization contract, fan-out retries hash raw inputs and namespace child IDs by batch, delegation binds parent cwd, and outer-width layouts reserve activity, result, and native-status evidence before parent/title text.
- Add a verified subagent hierarchy to the agent panel with stable selectable rows, Unicode/ASCII markers, conservative parent/history fallbacks, adaptive cached activity/result badges, and token-free persisted launch evidence. Filtering, narrow layouts, stale identities, ambiguity, cycles, and excessive depth never invent relationships or completion.
- Add correlated `rexpi_delegate` launches with literal grants and token-free handles, bounded explicit `rexpi_fanout` dispatch, and bounded `rexpi_join` outcomes. Exact retries inspect original work; failures, cancellation, revocation, stale evidence, and coordinator interruption never trigger automatic relaunch, resend, cleanup, or handle switching.
- Add version-2 message correlation and evidence-backed delivery records. Mailbox and void SDK acceptance no longer imply target delivery, processing, settlement, or completion; exact reply scope is validated and uncertain outcomes remain unknown.
- Include original failures and every preserved artifact path in caller-visible capability tool errors, enforce requested entry types on conversation responses, reject noncanonical cursor encodings, and align cleanup documentation with preserved-artifact behavior.
- Disable automatic rollback deletion for capability-created paths because pathname identity checks cannot make unlink/rmdir race-safe; post-creation failures now preserve and report every artifact for explicit inspection.
- Fail closed when any grant-shaped bootstrap has malformed identity/agent metadata, abort later turns for already expired or revoked runtimes, and preserve uncertain replacement paths with explicit incomplete-cleanup errors when created-inode identity is unavailable.
- Anchor delegated relative path grants to the parent cwd, propagate absolute parent deadlines through one-shot metadata, check deadlines at tool/turn boundaries even with delayed timers, strictly validate conversation response metadata and measured byte bounds, and register newly created paths for cleanup before fallible identity checks.
- Add one-shot related-launch capability grants for literal tool whitelists, attenuated delegation, result return, model turns, whole-incarnation timeouts, and authorized read/write/edit paths. Grants are in memory, revoked on replacement, and preserve ungranted launch compatibility.
- Add canonical path containment, no-follow and replacement fences, descriptor-based file I/O, hardlink-write denial, and missing-parent cleanup. Document the residual non-atomic ancestor-lookup limitation and that explicitly granted shell tools are not OS-sandboxed.
- Extend related conversation reads with bounded head/tail pagination, exclusive since entries, entry-type filters, and stable text-only projections; cursors now bind the complete query and stale leaf.
- Pin the verified startup endpoint incarnation and reject first-contact same-bootstrap replacements before accepting status/results or issuing cancellation/stop effects; correct legacy protocol-safe request-ID documentation.
- Add the standalone supervised-agent lifecycle: related launches return and propagate exact token-free handles; status/events, explicit completion/results, cancellation, and sequential `rexpi_agent_stop` preserve independent evidence axes.
- Add explicitly authorized (`authorize:true`) cooperating-endpoint stop using only Pi graceful shutdown, with accepted/closed/disconnected/unknown outcomes, exact generation/runtime fences, and parent/child deduplication. Stop never aborts, kills, restarts, cleans up, retries, or retracts surviving work.
- Document handle creation versus binding/readiness, bounded retained evidence, pending/unknown results, cancellation acknowledgement versus quiescence, and stop acceptance versus exit.
- Add authenticated native reads of related live Pi branches and compacted context, plus attributed peer messages with explicit steering/follow-up delivery.
- Use Rexpi consistently in user-facing messages and internal labels while retaining existing configuration, state, and messaging identifiers for compatibility.
- Add project path and zoxide lookup to `rexpi_start_pi`, with session, tab, and split placement kept independent of directory lookup.
- Reject combining `project` and `cwd`; explicit directories remain path-only.
- Remove `rexpi_jump` from the tool list. Use `rexpi_start_pi` for fresh conversations and `rexpi_open_session` to reuse named workspaces.

## 0.1.0

First release. Tiny arms, many panes.

- Start fresh Pi conversations in Rex workspaces, splits, and tabs, with model selection and parent navigation.
- Exchange messages between related agents and opt into automatic review findings and result returns.
- Open your favorite tools through custom commands, including floating Helix and Hunk panes.
- Open projects by path or zoxide lookup, and create or reuse named workspaces.
- Find live agents across Rex workspaces with the searchable agent panel.
- Browse Git worktrees, open them in Pi, and remove eligible worktrees with confirmation and safety checks.
