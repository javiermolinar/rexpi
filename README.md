# Rexpi

[![CI](https://github.com/javiermolinar/rexpi/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/javiermolinar/rexpi/actions/workflows/ci.yml)
[![Pi extension](https://img.shields.io/badge/Pi-extension-8b5cf6?style=flat-square)](https://pi.dev)
[![Rex multiplexer](https://img.shields.io/badge/Rex-multiplexer-f97316?style=flat-square)](https://www.superlogical.com/rex)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)

Tiny arms, many panes. A Pi extension for Rex to multiplex the world.

![Rexpi](assets/rexpi.jpg)

Extra capabilities for the [Rex](https://www.superlogical.com/rex) multiplexer, still in private beta. Rex already has a comprehensive API. This extension fills a few gaps for Pi users with particularly exquisite taste in panes.

Rexpi is meant to be used conversationally:

> “Run a fresh review in a side split and send the findings back.”
>
> “Open the Grafana project in a new tab.”
>
> “Put Hunk in a floating pane.”

But it comes with batteries included. There are commands and shortcuts too; you don't need to ask an LLM to open a menu.

## Capabilities

- **Your tools, where you want them.** Add custom commands to open Helix, Hunk, logs, or whatever else you keep running in splits, tabs, and floating panes.
- **Agents that report back.** Ask for a fresh review and request the findings back. Related agents can exchange messages, and opted-in review results come back to the parent conversation automatically. No copy-paste courier service required. Delegated prompts include the exact tool/path grant and delivery budget, and incomplete result-return grants are rejected before launch.
- **Coordinator workflows that stay inspectable.** Delegate and fan out supervised subagents with visible handles, bounded result waits, compact status and inbox output, and quiet completion. Use `verbose:true` for full evidence and bounded text projection for oversized conversations.
- **Projects by name.** Open an existing project by path or let zoxide find it. Start a fresh Pi there without changing your current conversation's directory.
- **Find the agent you lost.** Search live Pi, Claude, Codex, OpenCode, and Gemini agents across Rex workspaces and jump to their panes. The seventh tab was not, in fact, the last one.
- **Worktree housekeeping.** Browse a repository's Git worktrees, open one in Pi, or mark old ones for confirmed removal. Dirty worktrees and worktrees with live agents are protected; branches stay put.

New agents get fresh conversations, not a copy of yours. Returning findings is opt-in and can trigger additional model turns. **Ctrl+Alt+M** stops future returns without killing the agents.

## How to install

You need **Pi 1.5.0+**, **Node 22.19.0+**, and Pi running inside a local Rex terminal. Keep `rex` and `pi` on PATH. Install zoxide if you want project lookup by name.

```sh
pi install npm:@javimolina/rexpi
```

Or install directly from GitHub:

```sh
pi install git:github.com/javiermolinar/rexpi
```

Then start Pi in Rex, or run `/reload`. Outside Rex, the extension stays out of the way.

To try it directly from a checkout without installing:

```sh
pi -e ./extensions/index.ts
```

## List of commands

| Command | What it does |
|---|---|
| `/rxn [task]` | Start fresh Pi in a new Rex workspace |
| `/rxv [task]` | Start fresh Pi in a split on the right |
| `/rxh [task]` | Start fresh Pi in a split below |
| `/rxt [task]` | Start fresh Pi in a new tab |
| `/rxa` or `/rxagents` | Find an agent and jump to its pane |
| `/rxw` or `/rxworktrees` | Browse, open, or remove Git worktrees |

Leave out `[task]` for an empty conversation. These launch commands don't enable automatic result returns; ask Pi to delegate and send findings back for that.

The `rexpi_start_pi` tool follows the same rule: omit `prompt` only when you want an idle interactive session. For supervised work, use `rexpi_delegate`, which requires a task and an explicit capability grant instead of creating empty review sessions.

| Shortcut | What it does |
|---|---|
| **Ctrl+Alt+A** | Open the agent panel |
| **Ctrl+Alt+B** | Return to the parent Pi conversation |
| **Ctrl+Alt+M** | Stop future agent result returns |

In either panel, type to search, use the arrow keys to move, and press Enter to open. **Esc** closes and **Ctrl+R** refreshes. In the worktree panel, **Space** marks a worktree and **Ctrl+D** asks to remove marked entries. Removal requires confirmation; it isn't a surprise keyboard shortcut.

You can also just ask Pi to open or reuse a named workspace, choose a model for a new agent, return to its parent, or inspect incoming findings. Those use tools rather than more slash commands.

## Configure

### Host registry and read-only discovery

`rexpi_hosts` performs on-demand, read-only discovery through `lib/hosts.ts`; extension activation does no discovery. Listing never selects a host. `rexpi_connect_host` explicitly selects either `local` or one exact configured alias for only the current Pi conversation. `rexpi_open_terminal` uses that execution-host selection, or an exact one-off `host` alias without changing the selection. Launch, messaging, agent operations, and configured terminal slash commands remain local to the verified Runtime/Rex server.

The trust boundaries are deliberate:

| Source | Authority | Literal invocation/input |
|---|---|---|
| `rex hosts` | The **only** source of configured Rex host IDs and local Unix-socket forward endpoints | `rex --autostart=false --timeout 5s hosts --json` (timeout follows settings) |
| OpenSSH configuration | Explicitly named SSH candidates only | Caller-supplied text, or a caller-supplied path read through the injected reader |
| Tailscale status | Connectivity candidates only | `tailscale status --json` |

A `discover()` call always reads `rex hosts`. The CLI explicitly defines `rex hosts` as independent of `-S`/`REX_SERVER`, so no local or selected endpoint is passed to it. Tailscale is included by default and can be omitted with `{ tailscale:false }`. OpenSSH is never read unless the call explicitly supplies `openSsh: { configText }` or `openSsh: { configPath }`; file-backed reads check the regular-file size against the remaining byte budget before reading. Wildcard and negated OpenSSH `Host` patterns are not candidates. Parsing is data-only: includes, `Match exec`, proxy/local/remote commands, and SSH itself are never executed. All execution and file access is dependency-injected and read-only, with literal argv and no shell. Overlapping calls serialize rather than failing merely because another discovery is active.

Configured entries require a valid ID, label, and at least one endpoint. Absolute paths and `unix:` URIs canonicalize to decoded absolute local socket paths, so equivalent forms deduplicate and cross-owner conflicts cannot evade comparison. Percent escapes in plain absolute paths are not decoded. Valid non-Unix endpoint URIs are counted as unsupported without retaining or probing them; they do not disable listing. Reusing an alias for another ID, changing an ID's alias or endpoint set, or sharing a canonical Unix endpoint between IDs fails the entire refresh. Candidate aliases must not collide with each other or with configured aliases; discovery does not guess that two sources describe one machine. Malformed input, process failure, truncation, and conflicts leave an empty registry rather than partial or stale authority.

Aliases are normalized with Unicode NFKC, trimming, lowercase folding, whitespace/underscore-to-hyphen folding, and repeated-hyphen folding. Normalized aliases use a bounded ASCII letter/digit/dot/hyphen grammar. `resolve()` compares the **whole normalized alias exactly** and returns configured Rex hosts only: no prefix/fuzzy match, candidate promotion, implicit local host, or single-host default. Unknown valid aliases return `undefined`; malformed aliases are rejected.

Every result is explicitly either `state:"configured"` (`rexConfigured:true`) or `state:"candidate"` (`rexConfigured:false`). Both have `ready:false`, `readiness:"unverified"`, `rexInstalled:"unknown"`, and `rexReachable:"unknown"`. A configured endpoint is configuration evidence, not a health check. Tailscale `online` describes only Tailscale connectivity. Discovery never probes or infers Rex installation/readiness and never claims a host is ready.

Candidates contain only normalized aliases and, for Tailscale, validated DNS/IP connectivity data. OpenSSH `HostName`, users, identity/certificate/agent files, environment assignments, proxy/jump/command/control directives, and all other directive values are not returned. Credentials, arbitrary process stderr, OpenSSH comments, `rex hosts` home/from/held metadata, and unknown Tailscale fields are not stored in the snapshot.

The reserved `pi-rex.hosts` settings schema is:

```json
{
  "pi-rex": {
    "hosts": {
      "discovery": {
        "maxEntries": 128,
        "maxOutputBytes": 1048576,
        "timeoutMs": 5000
      }
    }
  }
}
```

| Key | Type and range | Default | Meaning |
|---|---|---:|---|
| `discovery.maxEntries` | Integer, 1–256 | `128` | Aggregate inspected host, candidate-alias, Tailscale-node, and endpoint entries |
| `discovery.maxOutputBytes` | Integer, 128–4194304 | `1048576` | Aggregate UTF-8 bytes across process stdout/stderr and explicitly supplied OpenSSH input |
| `discovery.timeoutMs` | Integer, 1–30000 | `5000` | One whole-discovery deadline, combined with the caller's `AbortSignal` |

`discovery` and each key are optional. Unknown keys and out-of-range values are rejected. The executor also receives the remaining output budget, remaining timeout, and cancellation signal; the registry independently checks returned byte counts and races the deadline so an uncooperative executor cannot extend the await. Candidate sources are off in `rexpi_hosts` unless `openSsh:true` and/or `tailscale:true` is supplied.

Remote selection additionally requires an exact per-alias `connections` entry:

```json
{
  "pi-rex": {
    "hosts": {
      "discovery": {
        "maxEntries": 128,
        "maxOutputBytes": 1048576,
        "timeoutMs": 5000
      },
      "connections": {
        "debian": {
          "sshTarget": "user@explicit-host.example",
          "remoteSocketPath": "/run/user/1000/rex.sock",
          "expectedServerHostId": "01234567-89ab-cdef-0123-456789abcdef",
          "expectedServerInstanceId": "fedcba98-7654-3210-fedc-ba9876543210"
        }
      }
    }
  }
}
```

`connections` is an object with at most 128 normalized aliases; `local` is reserved. Every entry requires exactly these four fields. `sshTarget` is a trimmed, control-character-free string of 1–1024 characters, `remoteSocketPath` is an absolute control-character-free path of at most 4096 characters with no colon or brackets that OpenSSH could misparse, and both expected server identities are lowercase UUIDs. Alias normalization is the same strict normalization used by discovery. Unknown fields—including passwords, private keys, identity files, environment values, local paths, endpoint overrides, and other credential or connection material—are rejected. Neither an SSH target nor a remote socket path is guessed from an alias, and there is no first-use identity acceptance.

A connecting call always performs fresh configured-host discovery without candidates. The alias must identify exactly one `rex hosts` entry with exactly one supported local Unix-socket endpoint; `unix:` endpoints are converted to their literal local path. Multiple or unsupported endpoints fail closed rather than selecting a local Rex server or probing alternatives. Discovery conflicts, unknown/candidate aliases, missing settings, transport failures, identity mismatches, cancellation, and stale conversations leave the prior selection unchanged and never fall back to local.

A successful remote connection verifies `rex whoami --json` through the selected local forward and requires exact equality with both expected server UUIDs. These are distinct from the `rex hosts` registry ID. The returned remote endpoint and local-only caller-block/same-UID rules are deliberately ignored for this remote identity check. Success reports `state:"verified"` with the configured registry ID, expected server host/instance UUIDs, and an immutable ticket snapshot; a listening socket alone is not success.

Selection is scoped to the current verified Pi session/activation. `local` explicitly selects the already verified local Runtime server without a new probe. Remote intent is persisted as a versioned `pi-rex.host-selection` custom entry containing only `piSessionId`, alias, configured registry ID, and expected server UUIDs. It contains no SSH target, socket path, credential, ticket, or endpoint. On reload or `session_tree`, matching remote intent is restored as `state:"disconnected"` and `reconnectRequired:true` without discovery, probing, or reconnecting. Forks and new Pi session IDs do not inherit it and start with explicit local state. Owned-process disconnects immediately revoke verified status and remove the ticket; switching hosts closes the prior owned tunnel. Borrowed external tunnels have no process handle and are explicitly marked `monitoring:"external"`/`last-verified`, not continuously monitored. `rexpi_inspect` distinguishes `localOrigin` from `executionHost`, and the status line reflects those states. Invalid optional host settings or restored host-intent data disable only host tools with a warning; local Rexpi features remain active.

### Standalone SSH Unix-socket transport

`lib/ssh-transport.ts` provides `SshUnixSocketTransport` for configured-host selection. The extension wires literal-argv Node spawn, `lstat`, identity-checked conditional unlink, and bounded Rex whoami adapters. Construction performs no I/O. Process spawning, Rex health probing, socket inspection, and conditional socket unlinking remain injected boundaries, so standalone tests need no SSH or filesystem access.

```ts
const transport = new SshUnixSocketTransport({
  spawn, probe, inspectSocket, unlinkSocket,
  createSocketStaging, publishStagedSocket, removeSocketStaging,
});
const result = await transport.withOperation({
  hostId: configured.id,
  hostAlias: configured.alias,
  sshTarget: "user@explicit-target",
  localSocketPath: "/absolute/local/rex.sock",
  remoteSocketPath: "/absolute/remote/rex.sock",
}, async (ticket, signal) => rexOver(ticket.endpoint, signal), abortSignal);
await transport.close({ hostId: configured.id, hostAlias: configured.alias });
```

The SSH target and remote socket path are always explicit; neither is inferred from a host ID or alias. `connect()` returns an immutable ticket containing the exact host binding, local endpoint, and `"rexpi"`/`"external"` ownership. Identical concurrent connects share startup, while conflicting host bindings or configurations fail. A socket is reused only when the injected, bounded Rex health probe returns true. A healthy external tunnel can be borrowed for that connection but is never adopted, killed, or unlinked.

When no healthy socket exists, the connector creates a private per-attempt staging directory and spawns literal argv with `ssh -N -T`, `BatchMode=yes`, `ExitOnForwardFailure=yes`, keepalives, `ConnectTimeout`, and only Unix-socket `-L` forwarding to that staging path. After identity verification, an atomic hard link publishes the staging socket to the configured endpoint without replacing an existing path. A concurrent winner causes `EEXIST`; the loser cleans only its own staging resources and never adopts or unlinks the winner's socket. There is no shell, command-string concatenation, TCP forwarding, credential argument, or local-Rex fallback. Ordinary OpenSSH configuration remains available, but Rexpi-owned forwards set `ControlMaster=no`, `ControlPath=none`, and `ControlPersist=no` so an external control master cannot own or retain their lifecycle. Only `HOME`, `PATH`, and an absolute `SSH_AUTH_SOCK` are copied from the supplied environment; other variables are excluded. Probe, inspection, startup, and cleanup waits have independent deadlines and cancellation races even if a dependency ignores its signal. Arbitrary stderr and dependency messages are not exposed.

Only Rexpi-spawned or positively recovered processes are signalled. Public-path ownership exists only after successful atomic publication from the private staging path. Owned socket cleanup requires the originally observed opaque socket identity for both public and staging links; `unlinkSocket` must re-check that identity and leave a mismatched path untouched. Staging-directory removal is non-recursive and removes only an empty private directory. Unhealthy or unidentified stale sockets therefore fail closed. `close()`/`closeAll()` never clean up borrowed external tunnels. `closeAll()` starts every close before awaiting cleanup, and an unresponsive owned process receives a bounded `SIGKILL` escalation after `SIGTERM`.

Each attempt writes a private journal record before spawning SSH, then updates it with the SSH process start token and staging/public socket identities. Records live under Rexpi's private state directory and contain no credential fields. Successful close removes the journal only after socket and staging cleanup. Pi's asynchronous shutdown and replacement handlers await this cleanup rather than exiting after `SIGTERM`.

On a later activation, a matching journal is recovery evidence, not automatic authority. If the original Pi controller is still alive, another conversation may borrow a healthy tunnel only as `external`; it cannot kill or clean it. If the controller is gone, recovery requires the recorded SSH PID/start token, both socket identities, and the exact remote Rex UUIDs before reclaiming the tunnel as Rexpi-owned. A dead or replaced child is never signalled; only matching owned paths are cleaned before a fresh attempt. Multiple, malformed, replaced, unhealthy, or uncertain records fail closed without deleting arbitrary sockets.

`withOperation()` invokes its callback **exactly once** and performs no automatic connection or operation retry. Connection errors have `operationStarted:false`; only those may be deliberately retried by the caller before dispatch. Once the callback starts, callback failure, cancellation, or owned-tunnel disconnect raises `SshTransportError` with `code:"operation_uncertain"`, `operationStarted:true`, and `retryable:false`. A disconnect during a mutation consequently has an uncertain outcome, never an implied success or safe retry.

### Remote terminals

`rexpi_open_terminal` accepts `placement:"session"`, `"right"`, `"down"`, `"tab"`, or `"floating"`. With no `host`, it uses the conversation's selected execution host; `host:"local"` and an exact configured alias are explicit one-off overrides and never rewrite the selection. Unknown, ambiguous, disconnected, restored-but-not-reconnected, or stale remote selections fail before creation and never fall back to local Rex.

Remote creation uses the selected host's verified SSH Unix-socket operation boundary and a fresh exact `whoami` server-identity check. It does not apply the local Runtime's caller-block, process, project, executable, cwd, or PATH checks to the remote server. A new session needs no existing anchor and starts in the remote home. Every other placement requires exactly one appropriate terminal on the expected remote server as its Rex anchor. That anchor's process cwd is the default and the base for relative paths; `~` and `~/` use the remote shell's `HOME`. A fixed `/bin/sh` wrapper receives every requested value literally, changes directory remotely, and performs remote PATH lookup for argv commands. String commands intentionally use remote `/bin/sh -c`. Local credentials, arbitrary local environment, local PATH, and the Mac project database are not forwarded.

Results keep `localOrigin` separate from `executionHost` and include the configured host ID, expected and verified server UUIDs, and the exact Rex session/window/block/layer IDs returned by creation. A malformed creation reply or any interruption after dispatch is `creation:"unknown"`: inspect Rex before a deliberate retry. There is no automatic retry or cleanup. Configured slash commands remain explicitly local even when the conversation selects a remote host.

### Helix and Hunk, floating

Merge this into `~/.pi/agent/settings.json`. The settings key is still `pi-rex` for compatibility with existing configurations:

```json
{
  "pi-rex": {
    "commands": {
      "helix": {
        "run": ["hx"],
        "acceptArgs": true,
        "placement": "floating",
        "title": "Helix"
      },
      "hunk": {
        "run": ["hunk", "diff"],
        "placement": "floating",
        "title": "Working-tree changes"
      }
    }
  }
}
```

Run `/reload`, then `/helix` or `/helix src/main.ts` to open Helix, and `/hunk` to inspect your changes. Both tools need to be installed and on PATH. The commands run directly, without a model turn.

Floating panes default to 80% of the tab, centered. Prefer a split? Change `placement` to `right`, `down`, or `tab`.

Commands reject extra arguments unless `acceptArgs` is true. Arguments are passed literally, not expanded by a shell. You can also set `cwd`, `focus`, and `keepOpen` on an entry.

Everything else works with the defaults: `rex` and `pi` from PATH, plus the shortcuts listed above. No environment variables to set.

Switching between Rex workspaces requires **Remote Control** enabled in Rex Settings; navigation within the same workspace doesn't.

## Screenshots

### Agent panel

![Agent panel showing filtered Rexpi conversations and their statuses](assets/agents.png)

### Worktree panel

![Worktree panel showing the protected current worktree](assets/worktrees.png)

Captured from a live Rex session. The home-directory path is shortened.

## License

MIT. See [LICENSE](LICENSE).
