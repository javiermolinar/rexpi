# Remote controller architecture contract

**Status:** design for Hyperion step 06; no implementation is authorized by this document.
**Current baseline:** host registry/selection, SSH Unix-socket transport, and remote terminals exist. Local-bound controllers, remote Pi launch, remote project lookup, and cross-host agents/messaging do not.

## 1. Ground truth and operation model

Current `rexpi_connect_host` verifies and selects an `executionHost` for only the calling Pi conversation. It does not move or restart Pi, change `controllerHost`, set a future SSH-tool destination, or redirect every tool. Today that selection changes the default destination of `rexpi_open_terminal`; configured terminal slash commands, Pi/session launch, delegation, agents, peers, and messaging remain local to the verified Runtime/Rex server.

| Operation | Controller location | `executionHost` | Rex server(s) | Project/cwd resolution | Credentials/session storage | Disconnect survival | Messaging |
|---|---|---|---|---|---|---|---|
| Connect to Debian — **current** `rexpi_connect_host` | Existing local Pi, normally Mac | Debian after exact verification; caller selection only | Local Runtime remains local; Debian Rex is reached through a local Unix forward | No process or cwd is created; local launch/project behavior is unchanged | Local Pi state only; selection intent has alias/IDs, no credentials or endpoint | No new workload; owned tunnel closes locally on teardown; restored intent is disconnected | Unchanged, same local server only |
| Open local Pi bound to Debian — **proposed** | New local Pi, normally Mac | Debian as that new conversation's initial selection | Local Rex owns/binds the controller; Debian Rex executes selected terminals | **Local** cwd, PATH, zoxide/projects, extension, and settings | Local Pi config/auth/session/state; Debian gets no copy | Local controller and remote Rex workloads are independent; tunnel loss only disconnects selection | Local related agents/messages only; never automatically Debian |
| Open Pi on Debian — **proposed** | New Pi process on Debian | Debian Rex for creation; inside that Pi, `local` means its Debian Runtime | Debian Rex owns the terminal/process; Mac Rex remains only the caller's origin | **Remote** cwd, PATH, `pi`, extensions, and any future project resolver | Debian Pi config/auth/session/state; no Mac bootstrap state or auth import | Rex-owned Pi survives SSH tunnel closure while Debian Rex/process remain alive | No relation to Mac caller; only same-Debian-server operations, if independently configured |
| Open terminal on Debian — **current** `rexpi_open_terminal` | Existing local caller; no new controller | Selected Debian host or exact one-off `host` override | Debian Rex, freshly identity-verified per operation | Remote anchor cwd/HOME, remote PATH and `/bin/sh`; no local project lookup | No Pi session or credential transfer | Remote terminal survives tunnel closure while Debian Rex/process remain alive | None added; terminal is not a conversation endpoint |

“Bound to Debian” therefore describes a local controller's default execution host. “Pi on Debian” describes the controller process itself. Neither phrase implies an SSH-tool target or a messaging route.

## 2. Identity is a tuple, not a host alias

The axes are independent and must never be inferred from one another:

- **Calling/local origin:** exact `taskId`, `conversationId`, `piSessionId`, `role`, origin Rex `blockId`, and origin `host_id`/`instance_id`. This identifies evidence, not authority.
- **`controllerHost`:** machine and Rex server running the Pi process. A local-bound controller has the Mac/local Runtime as controller host and Debian as execution host. A remote Pi has Debian as both controller host and its own local execution server; its caller remains a separate origin.
- **`executionHost`:** configured Rex server on which a terminal/process is created. Preserve `kind`, exact normalized alias, configured `rex hosts` ID, expected server UUIDs, verified server UUIDs, connection state, and generation/ticket evidence where applicable.
- **`targetHost` (future only):** explicit SSH destination for an SSH-capable tool. It is not `executionHost`, `controllerHost`, or the `sshTarget` used to construct a Rex socket tunnel. No current tool accepts it.

Never replace configured host ID with server `host_id`, or either with `instance_id`. Never derive conversation identity from them. Creation results must retain exact Rex `sessionId`, `windowId`, `blockId`, and optional `layerId`, qualified by the server that issued them. A block ID from one server is not an anchor on another. `hostId` plus `serverInstance` is server evidence, not proof of a conversation, route, live process, reachability, or permission.

All proposed launch results include the following fields; none implies a later lifecycle state:

| Field | Required meaning |
|---|---|
| `requestId` | Stable logical launch ID used for retained outcome inspection. |
| `localOrigin` | Exact calling conversation and calling Rex server evidence. |
| `identity` | Fresh child conversation identity; never the caller's session identity. |
| `controllerHost` | Host on which the controller process is created, with qualifying server identity; never inferred from the request alone. |
| `requestedExecutionHost` | Immutable requested alias/configured ID/expected UUIDs. |
| `executionHost` | Verified selection evidence when available; never synthesized from intent. |
| `target` | Exact session/window/block/layer IDs only after confirmed creation. |
| `creation`, `startup`, `hostSetup` | Independent creation, exact binding, and host-connection evidence, where applicable. |
| `promptDelivery` | For a requested prompt, exactly `"not-sent"`, `"sent"`, or `"unknown"`; never inferred from creation. |

Do not collapse these into a single `host` result field.

## 3. Required tool surface and defaults

### Unchanged current tools

- `rexpi_open_terminal` needs no redesign: omitted `host` uses the current verified selection; `host:"local"` or an exact configured alias is a one-off override and never changes selection.
- `rexpi_start_pi`, `rexpi_open_session`, `rexpi_delegate`, fan-out/join, configured slash commands, peer tools, and messaging remain explicitly local regardless of `executionHost`. Do not add a host parameter that silently retargets them.
- `rexpi_connect_host` remains the only persistent selection mutation for an existing conversation. Unknown, candidate, stale, disconnected, or failed hosts never fall back to local.

### Proposed `rexpi_start_bound_pi`

Create a fresh **local** independent Pi with an initial remote execution-host selection.

```ts
{
  executionHost: string,       // required exact configured alias; not "local"
  prompt?: string,
  cwd?: string,                // local; mutually exclusive with project
  project?: string,            // local path or zoxide query
  placement?: "session" | "right" | "down" | "tab", // local Rex; default session
  sessionName?: string,        // session placement only
  title?: string,
  focus?: boolean,
  provider?: string,
  model?: string,
  thinking?: Thinking
}
```

Use existing local validation, including `provider` requiring `model`. `additionalProperties:false`; initially omit/reject `related`, `role`, `returnResults`, `grant`, `notifyParentOnSettlement`, and `targetHost`. The launch is independent, not a related agent. The local project resolver and local PATH are correct because the controller runs locally.

`executionHost` is required: neither current caller selection nor a single configured host is a default. It is a one-off choice for this launch and does not modify the caller. A launch-only initial-host envelope carries the alias, configured host ID, and expected server UUIDs, but no ticket, credential, or endpoint. The child consumes it once and performs its own fresh discovery, exact connection, and server verification during initial startup; no parent ticket becomes child authority. Later activation restores only disconnected intent and never auto-connects.

Result semantics:

- Pre-dispatch failure rejects and creates nothing. Post-dispatch interruption returns `creation:"unknown"`; never retry automatically.
- Confirmed local creation returns local target IDs and `startup:"bound"|"unconfirmed"` using existing exact local binding checks.
- Report `requestedExecutionHost` separately. `hostSetup` is `"verified"`, `"disconnected"`, `"unconfirmed"`, or `"unknown"`. Successful verification also returns `executionHost.state:"verified"`; failure after confirmed creation leaves creation intact and reports `hostSetup:"disconnected"` with `reconnectRequired:true` and a warning. Interrupted verification is `unconfirmed`; unknown creation is `unknown`. Binding, host setup, readiness, and task completion are distinct.
- Once created, a host-setup failure is a result, not an exception that hides the local Pi. No automatic second connection or launch attempt occurs.
- Withhold the initial prompt until both exact local binding and host setup are verified. A pre-launch or host-setup failure yields `promptDelivery:"not-sent"`; successful dispatch yields `"sent"`; an interrupted prompt dispatch yields `"unknown"`. Reconnection never replays the prompt automatically.

### Proposed `rexpi_start_remote_pi`

Create a fresh independent Pi process through configured remote Rex.

```ts
{
  host: string,                 // required exact configured alias
  prompt?: string,
  cwd?: string,                 // remote path; mutually exclusive with project
  project?: string,             // reserved; every query rejected until phase D
  placement?: "session" | "right" | "down" | "tab", // default session
  title?: string,
  focus?: boolean,
  provider?: string,
  model?: string,
  thinking?: Thinking
}
```

`host` neither reads nor changes caller selection. The new Pi's location is immutable; this is new-conversation-only, never adoption or rebinding of an existing session. Initially omit/reject `sessionName`, `related`, `role`, `returnResults`, `grant`, delegation/subscription options, `keepOpen`, environment, executable, extension path, and `targetHost`. `project` is recognized only to return the explicit unsupported-query error in section 4; `cwd` and `project` remain mutually exclusive. Keep the remote terminal pane open on Pi exit. Use remote `pi` from remote PATH and Rexpi installed/configured on that host; do not pass the Mac extension path or `PI_CODING_AGENT_DIR`.

Reuse remote terminal anchor rules: `session` needs only exact `whoami`; other placements require exactly one suitable remote terminal anchor. Verify configured ID and both server UUIDs immediately before dispatch. Pass the optional prompt as one literal Pi argument, never as shell source or an option prefix. Result `creation:"confirmed"` includes exact remote Rex IDs; any lost/malformed/interrupted creation reply is `creation:"unknown"` with no target claimed. Initial `startup` is always `"unconfirmed"` until a remote binding protocol exists; Rex creation, a visible `pi` process, or an accepted initial prompt is not exact Pi readiness or prompt processing. No related handle, return ticket, or messaging route is returned, and the prompt is never resent automatically.

Host choices on both tools apply only at new-conversation creation. There is no schema for moving an existing Pi, changing another conversation's selection, or supplying per-call arbitrary remote environment.

Common outcome rules for both proposed tools:

- Retain outcomes by `requestId`; an identical repeat inspects that outcome and a conflicting repeat fails without dispatch.
- Reject invalid combinations, unknown hosts, and unavailable preflight before Rex creation.
- `creation:"confirmed"` proves only Rex creation; it never proves command readiness or task completion.
- `creation:"unknown"` requires inspection on the identified target server and permits neither retry nor cleanup guesses.
- Cancellation and host-selection generation changes fence dispatch; they cannot retroactively erase a confirmed or unknown effect.

## 4. Remote projects, paths, and environment

- Local-bound controller `cwd`, `project`, zoxide, executable lookup, extension path, and state directory resolve locally. Its remote selection must not alter them.
- Remote terminal behavior is already correct: non-session placements use the remote anchor process cwd; `~` uses remote `HOME`; relative paths use the remote base; argv and shell strings resolve through remote PATH. Local `toolCtx.cwd`, PATH, project database, and environment are not consulted.
- Remote Pi uses the same remote cwd algorithm. Only an existing remote directory supplied as `cwd` is supported initially. It is validated/entered remotely, not with local `realpath`/`stat`.
- Initially, every remote project **query** is unsupported: zoxide names, aliases, relative project paths, repository discovery, and local absolute paths must fail before creation with `remote project resolution is unavailable; no Pi was launched`. Use remote `cwd` for an explicit remote directory; never emulate a query locally.
- A later resolver must execute on the selected remote host and use only remote configuration, aliases, and remote databases. Its results require exact host qualification and remote directory validation. Enabling the reserved `project` field on `rexpi_start_remote_pi` is a separate phase; it remains mutually exclusive with `cwd`.

SSH client filtering (`HOME`, `PATH`, absolute `SSH_AUTH_SOCK`) only constrains the local OpenSSH process. It is not remote environment forwarding. Remote Rex/shell supplies the remote process environment; no arbitrary Mac environment, PATH, auth variable, agent socket, or `PI_*` variable is propagated.

## 5. Credentials, storage, and capabilities

Local controllers retain local config, auth, sessions, binding stores, peer mailboxes, return grants, and selection entries. Remote Pi uses its own remote Pi/Rexpi config, auth, sessions, binding store, and extension installation. Never copy Mac auth, settings, tokens, session files, mailboxes, grants, tunnel journals, or state directories to Debian. Fresh remote conversation IDs do not make local session files portable.

Existing capability grants are local launch metadata. A remote execution selection is not delegated authority, and a local path grant must never be reinterpreted as a remote path. Future remote-capable grants need explicit host identity (configured ID plus exact server UUIDs), absolute host-local paths, read/write scope, allowed tools, conversation/run generation, expiry, and revocation. Enforcement must occur on the host owning the path. SSH access, a verified tunnel, or possession of server IDs grants no ambient remote read/write/delegation/messaging rights.

## 6. Persistence and failure boundaries

Remote Rex owns remote terminal and Pi processes, so SSH tunnel closure alone does not kill them. Rexpi-owned tunnels still clean up local processes/sockets on controller shutdown; borrowed external tunnels are never killed or unlinked. Selection restoration is disconnected/reconnect-required and contains no reusable ticket.

| Event | Required interpretation |
|---|---|
| Local controller death | Local messaging/binding endpoint is gone; owned tunnels clean up or undergo bounded identity-checked recovery. Remote Rex workloads survive; no controller is transparently replaced. |
| Owned tunnel death | Revoke verified selection immediately and require explicit reconnect. Borrowed tunnels remain `external`/last-verified, not continuously monitored. In-flight post-dispatch creation is unknown. |
| Debian/local Rex server restart | `instance_id` changes invalidate prior server and anchor evidence even if `host_id` is stable. Reverify exact identity; do not assume Rex-owned processes survived or reuse old resource IDs. A fixed expected instance ID fails until deliberately reconfigured. |
| Pi process replacement | Old PID/token/endpoint generation and message authority are stale. A surviving block is not the same conversation; do not adopt, retarget, or replay to the replacement. |

Every new operation reverifies exact server identity. There is no automatic reconnect, uncertain creation retry, remote cleanup guess, or message replay. Explicit reconnect authorizes a new connection, not repetition of earlier mutations.

## 7. Related agents and messaging boundary

Current protocol decoders require equal `serverInstance` and `hostId`, equal task ID, distinct related conversations/blocks, a unique live local binding, exact recipient/source tokens, local Rex process checks, and a private same-UID Unix socket. Binding and peer storage are local to the Runtime state directory. These checks cannot authenticate or route a remote conversation.

Until a later phase, related launches, peer reads/sends, result returns, delegation/fan-out/join, and agent cancel/stop remain same-server/local. Mac-to-Debian and Debian-to-Mac use is unsupported, including when both endpoints share a task ID or know each other's host IDs. A remote selection must not change this behavior. Related children of a bound controller still start with local selection under the current new-conversation rules; they never inherit the parent's remote selection, ticket, or host authority implicitly.

A secure cross-host design must add all of the following as one reviewed protocol, not ad hoc SSH writes:

1. Remote conversation registration with exact task/conversation/session/role, server IDs, block/PID/token, endpoint generation, and liveness evidence.
2. Exact endpoint validation at sender, router, and receiver; authenticated host-to-host transport with bounded routed requests, not guessed socket paths.
3. Explicit host-scoped capability and relationship grants; peer text and registry metadata remain non-authoritative.
4. Durable, host-qualified intent and receipt records at defined origin/destination locations, with stable logical IDs and conflicting-ID rejection.
5. Separate evidence for transport acceptance, mailbox delivery, processing, settlement, and completion; acceptance never implies processing.
6. Cancellation and stale-generation fences at every hop, including process/server/controller replacement.
7. Bounded recovery that inspects and reconciles receipts without replaying messages, launches, cancellations, stops, or returns whose effects are uncertain.

## 8. Unsupported cases and phased delivery

Initially unsupported: moving/adopting Pi across hosts; remote named-session reuse; remote related/delegated launch; remote project queries; cross-host peers, returns, controls, or result subscriptions; credential/config/session migration; arbitrary remote environment; and `targetHost` SSH tools. Remote `focus` is only remote Rex creation state, not proof that a Mac UI focused a remote workspace.

| Phase | Dependencies | Deliverable | Acceptance tests |
|---|---|---|---|
| A. Contract (this document) | Current steps 01–05 | Reviewed identity/security/lifecycle contract | Four-operation table and every checklist item below are unambiguous; no existing local tool changes meaning. |
| B. Local-bound controller | A; existing selection/transport | `rexpi_start_bound_pi` and child initial-connect bootstrap | Local cwd/project/auth remain local; caller selection unchanged; exact child host verified; pre/post-dispatch failures, disconnect restore, and no-retry outcomes tested. |
| C. Independent remote Pi | A; existing remote terminal foundation | `rexpi_start_remote_pi` with remote cwd/PATH and unconfirmed startup | Remote-only executable/environment/storage; exact IDs; unknown creation not retried; Pi survives tunnel close; no local grant/relation/return is created. |
| D. Remote projects | C | Explicit remote resolver; enable the reserved `project` field | Queries execute only remotely; missing/ambiguous databases fail before creation; Mac cwd, aliases, zoxide, and environment cannot influence results. |
| E. Cross-host registry/transport | B or C plus a separate security review | Registration, exact endpoint validation, routed transport, durable receipts | Wrong host/server/task/token/generation fails; partition produces bounded unknown evidence; delivery is not processing; recovery never replays. |
| F. Cross-host agents | D when paths are used; E | Host-scoped related launch, messaging, returns, delegation and controls | Explicit grants survive review; cancellation/settlement fences work across disconnect/restart; no ambient host authority or automatic retry/replay. |

B and C are separately implementable after A. D depends on C; E does not implicitly enable F. Each phase requires its own implementation authorization and tests.

## 9. Invariants

1. Controller location, execution host, SSH target, and conversation identity are independent.
2. Remote intent never implies readiness, reachability, a live conversation, or permission.
3. Exact configured host ID and server `host_id`/`instance_id` qualify every remote operation and resource.
4. Local paths/state stay local; remote paths/state resolve remotely.
5. No credential, environment, grant, or messaging authority crosses hosts implicitly.
6. Existing local tools never silently follow remote execution selection.
7. Restored selections reconnect only explicitly; uncertain mutations are inspected, never retried automatically.
8. Creation, binding, delivery, processing, settlement, and completion are different evidence states.
9. Server/process/controller replacement invalidates old generations and endpoints.
10. Cross-host messaging remains unsupported until the complete routed security protocol exists.

## 10. Acceptance checklist

| Requirement | Contract evidence |
|---|---|
| 1. Four operations | Section 1 table; connect and terminal marked current, both controller modes proposed; connect's narrow effect stated. |
| 2. Identity axes | Sections 1–2 distinguish origin, controller, execution, future target and preserve all configured/server/conversation/Rex IDs. |
| 3. Tool schemas | Section 3 fixes defaults, overrides, persistence, new-only rules, parameter combinations, and result/uncertainty semantics; terminal unchanged. |
| 4. Remote projects | Section 4 separates local/remote resolution and fails every initial remote query before creation. |
| 5. Security/storage | Sections 4–5 forbid state/environment transfer and require host/path/scope-bound grants. |
| 6. Persistence | Section 6 distinguishes controller, tunnel, server, and Pi failures and prohibits reconnect/retry/replay automation. |
| 7. Agents/messaging | Section 7 documents same-server checks, current unsupported cross-host use, and all required later protocol elements. |
| 8. Unsupported/roadmap | Section 8 lists unsupported cases, dependencies, separable phases, and acceptance tests; sections 9–10 provide invariants and traceability. |
