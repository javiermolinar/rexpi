# Configuration

## Model routing

Rexpi supports two distinct ways to choose a model:

- **Native virtual models** route an interactive Pi session or a newly launched child through the separately installed [`pi-routing-policies`](https://github.com/radioflyer28/pi-routing-policies) extension. That extension owns native registration, sticky session state, `/vmodel`, and `/virtual-model`.
- **Parent-side assignments** use `selection` on `rexpi_delegate` or an individual `rexpi_fanout` child. Rexpi resolves and revalidates a physical target, then launches that child once. It does not switch the parent model.

Rexpi vendors the side-effect-free policy core and selectors, not the native extension or its UI. Install the native extension only if you want interactive virtual models and `/vmodel`; parent-side explicit assignments need only Rexpi and a policy file. Both paths can read the same policy.

### Non-destructive setup

Requirements: Pi 1.5.0+, Node 24+, and exact physical models available in your Pi registry. Configure provider credentials with Pi, never in `virtual-models.json`.

From the Rexpi checkout, choose a policy path and copy the example **only if that path does not already exist**:

```sh
# Use an existing override, or a separate example path beside the default policy.
policy="${PI_VIRTUAL_MODELS_CONFIG:-$HOME/.pi/agent/virtual-models.rex.json}"

if [ -e "$policy" ]; then
  printf 'Keeping existing policy: %s\n' "$policy"
else
  cp examples/virtual-models.json "$policy"
  printf 'Created example policy: %s\n' "$policy"
fi

# Both extensions must inherit the same explicit path when not using the default.
export PI_VIRTUAL_MODELS_CONFIG="$policy"
```

This does not overwrite the normal `~/.pi/agent/virtual-models.json` or an existing override. If your Pi agent directory is customized, choose a path in that directory instead. To adopt the example in an existing policy, compare the files and manually merge the `models`, `questions.route.criteria`, `namespaces.rex`, and `selector` entries; do not replace existing roles blindly. Keep unrelated existing settings and credentials unchanged.

For native virtual models and diagnostics, install the full upstream extension from a reviewed checkout according to its README, then start a fresh Pi or run `/reload`. Loading Rexpi alone does not provide `/vmodel`. The policy is loaded lazily by Rexpi only when a delegated `selection` is requested; physical launches do not read it.

The example IDs are concrete registry identities, not aliases to invent or translate. Confirm them with Pi's model listing and `/vmodel doctor`. If your registry does not contain an exact target, edit your copy deliberately or do not use that variant. There is no implicit provider or model fallback.

### Tiers and exact identities

Policy selections use `role:effort`. Native virtual IDs encode that effort with a final slash and are launched with `thinking:"off"`; the policy controls the physical target's thinking. Policy effort supports `low`, `medium`, and `high` only. Physical Pi thinking also supports `max` where the model supports it.

| Tier and use | Policy selection / explicit pin | Native provider and model ID | Physical provider, model, and thinking |
|---|---|---|---|
| Deep: difficult planning, investigation, architecture, debugging, security, or cross-cutting work | `rex/deep-astra:high` | `rex` / `rex/deep-astra/high` | `openai-codex` / `gpt-6-astra` / `max` |
| Deep alternative | `rex/deep-opus:high` | `rex` / `rex/deep-opus/high` | `anthropic` / `claude-opus-5-5` / `max` |
| Everyday: ordinary implementation, documentation, and bounded review | `rex/everyday-sol:high` | `rex` / `rex/everyday-sol/high` | `openai-codex` / `gpt-6.1-sol` / `high` |
| Everyday alternative | `rex/everyday-kimi:high` | `rex` / `rex/everyday-kimi/high` | `openrouter` / `moonshotai/kimi-k3.1-pro` / `high` |
| Everyday alternative with max physical thinking | `rex/everyday-flash:high` | `rex` / `rex/everyday-flash/high` | `openrouter` / `deepseek/deepseek-v4.1-flash` / `max` |
| Fast: mechanical, low-risk, latency-sensitive work | `rex/fast-luna:low` | `rex` / `rex/fast-luna/low` | `openai-codex` / `gpt-6-luna` / `low` |

For example, an ordinary **physical** launch uses:

```json
{
  "provider": "openai-codex",
  "model": "gpt-6-astra",
  "thinking": "max"
}
```

The equivalent **native virtual** launch identity is:

```json
{
  "provider": "rex",
  "model": "rex/deep-astra/high",
  "thinking": "off"
}
```

Do not spell the native ID `rex/deep-astra:high`; Pi would interpret that colon suffix as its own thinking syntax. Do not use physical `max` as a policy effort. The example's `high` policy effort intentionally maps to `max` physical thinking for Astra, Opus, and DeepSeek Flash.

### Interactive routing and explicit pins

With the native extension loaded, `/vmodel` lists configured selections. Select an automatic route or pin an exact role and effort:

```text
/vmodel rex/auto
/vmodel rex/deep-astra:high
/vmodel rex/everyday-sol:high
/vmodel rex/fast-luna:low
```

An explicit role/effort is a pin: it bypasses selector inference but still checks physical identity, configured auth, and text-input eligibility. It remains selected until deliberately changed. `/thinking` is not the virtual-effort control; choose another native effort entry or use `/vmodel` instead.

Under the example policy, native automatic routing considers the whole task. Planning or security keywords are hints, not sufficient reasons to choose deep; quick or rename keywords do not make consequential work fast. Everyday is the ordinary default, and `__abstain__` fails closed rather than inventing a route. Native automatic selection normally runs per user turn. Tool continuations and retries reuse the applicable assignment; optional upstream `nativeRouting.affinity:"session"` extends automatic affinity across user turns. Policy changes, missing credentials, revoked targets, or unsupported inputs invalidate reuse rather than triggering replacement. See the upstream README for native dialogue-sharing and affinity options; Rexpi does not enable them.

### Delegated and fan-out routing

`rexpi_start_pi`, `rexpi_delegate`, and each `rexpi_fanout` child accept raw `provider`, `model`, and `thinking`. These fields can name either a physical model or an already registered native virtual model. Omitted fields preserve existing default-model behavior.

For parent-side policy resolution, use `selection` instead of all three raw fields:

```json
{
  "task": "Review the routing lifecycle without expanding scope",
  "grant": { "tools": ["read", "rexpi_agent_complete"], "readPaths": ["."], "writePaths": [], "delegation": { "maxDepth": 0 }, "returnResults": false, "turns": 3, "timeoutMs": 60000 },
  "selection": "rex/deep-astra:high"
}
```

Fan-out places `selection` and optional `allowAutomatic` on each child. Different children can use different pins. Rexpi resolves the selection, rereads and revalidates the current policy immediately before one launch, applies role guidance only to that child's prompt, and returns `routing.assignment`, `routing.receipt`, and any `routing.selectorMetadata` in delegation/fan-out/join evidence.

Routing does not change the parent model, expand tools or paths, alter delegation depth or turn budgets, authorize delegation, or add retries. Exact logical-call repeats inspect the original outcome without reselecting or relaunching. Changed selections conflict with the original logical ID. Policy revisions and target changes fail revalidation. Unknown or unconfirmed launch outcomes remain inspection evidence; they are not retry permission.

Parent-side assignment is launch-time routing, not native session affinity. Once a child is launched with a physical target, later turns in that child do not rerun the parent's selector. Use native virtual launch fields instead when the child needs the native extension's per-turn or session-affinity behavior.

### Automatic selector consent and limits

Automatic parent-side routing requires both fields on the same delegate or fan-out child:

```json
{
  "selection": "rex/auto",
  "allowAutomatic": true
}
```

Without `allowAutomatic:true`, `rex/auto` fails before inventory or inference. Explicit pins never construct or call the selector.

Consent permits **one bounded selector call per newly resolved child assignment**. The example selector is `openai-codex` / `gpt-6-luna` at `low` thinking, with a 30,000 ms timeout and 2,048 maximum output tokens. The selector has no execution tools and does not execute the task.

For Rexpi parent-side selection, the selector receives only:

- the current task's first 3,000 UTF-16 code units (not tokens), and
- a `taskTruncated` flag,

plus the configured routing question and eligible criteria. It does not receive conversation history, files, images, tool results, or the parent prompt. This is truncation, not redaction: secrets in the task prefix are still sent to the selector provider. Use an explicit pin for sensitive tasks or when truncation could remove routing-relevant requirements.

The selector adds provider latency and may add token charges. Usage and latency metadata can be absent or underreported; an unknown value is not zero cost. Cancellation and timeout stop the wait, but a provider that continues work may still charge. No fallback selector, backup provider, retry escalation, or substitute execution model is used. Selector errors, abstention, ineligible candidates, cancellation, and stale policy revisions prevent launch.

Native interactive automatic routing is separately controlled by `/vmodel` and the upstream extension. Its optional dialogue-context settings have their own sharing limits and are not enabled by this example (`routingContext` is `off`). Do not assume Rexpi's 3,000-code-unit parent-side guarantee describes an upstream native configuration with dialogue history enabled.

### Diagnostics: doctor, preview, and explain

These commands belong to the full native `pi-routing-policies` extension. Use policy spellings, not native slash-effort IDs:

```text
/vmodel doctor
/vmodel doctor rex/auto:high
/vmodel preview rex/everyday-sol:high -- Fix a spelling mistake
/vmodel preview --allow-inference rex/auto:high -- Review a difficult documentation change
/vmodel explain
/vmodel explain latest
/vmodel explain RECEIPT_ID
```

- **`doctor [selection]`** checks the loaded policy against the current local registry, configured-auth presence, text-input eligibility, selector configuration, and registration identities. It makes no selector call, credential refresh, endpoint probe, or configuration write.
- **`preview [--allow-inference] selection -- task`** resolves a proposal without switching the active model, applying role guidance, launching work, or calling the execution model. Explicit previews make no selector call. Automatic previews require `--allow-inference`; without it they do not infer. Preview accepts a supplied text task of 1–3,000 characters and rejects oversized input rather than truncating it. It does not read the latest prompt, history, files, or images.
- **`explain [latest|receipt-id]`** displays an original decision receipt on the active branch, including preview failures. It uses the receipt ID, not the decision/assignment ID. It makes no selector call and does not recheck current eligibility; historical policy revisions are labeled.

Diagnostics do not change sticky assignments or pending coordinator handles. Expand diagnostic entries in the TUI for bounded details. Receipts and notices describe resolution, not successful endpoint inference or task completion. They intentionally omit task text, raw selector answers, and chain-of-thought. Doctor success is not a live endpoint smoke test.

### Failure and lifecycle semantics

Across native and parent-side routing, alternatives in `models` are eligible policy choices, not failover order. No path silently falls back after an explicit or automatic decision fails.

- **Physical launches** pass the exact provider/model/thinking to Pi and need no policy file.
- **Native virtual launches** pass the exact native ID with `thinking:"off"`; the native extension resolves each applicable request and owns sticky continuation/retry state.
- **Parent-side assignments** revalidate current physical identity, auth, inputs, policy revision, and target before dispatch.
- **Revocation and policy changes** fail closed. Rexpi's file-backed runtime rereads the policy for revalidation; it does not preserve a stale assignment as authority.
- **Cancellation** prevents new dispatch where observed. It does not fabricate child completion or prove an already dispatched process stopped.
- **Uncertain creation or unconfirmed binding** preserves the launch handle/evidence and blocks automatic retry. Fan-out stops additional dispatch after rejection or uncertain evidence without cleaning up active children.
- **Fan-out authority revocation** prevents undispatched children from launching and preserves already dispatched evidence.

### Validation and evidence boundaries

Repository checks:

```sh
npm test
npm run typecheck
node --test tests/model-selection.test.mjs tests/delegation.test.mjs tests/fanout-tools.test.mjs tests/fanout.test.mjs tests/launch.test.mjs tests/extension.test.mjs tests/package.test.mjs
```

The routing tests use fake providers/selectors and Pi 1.5.0 APIs. They cover argument forwarding, native virtual registration/route-state interoperability, explicit and opt-in automatic assignments, bounded selector input, sticky continuation state at the Pi native routing contract, credential revocation, policy changes, cancellation, uncertain/failing launch evidence, and no fallback. They do not contact a provider.

The vendored upstream README separately records 37 upstream core/selector tests passing against Pi 1.5.0 before vendoring. That is compatibility evidence for the core, not proof of every native UI lifecycle in this checkout.

**Not established by these checks:** live credential validity, endpoint availability, actual provider thinking behavior, native `/vmodel` UI behavior in a running Pi 1.5 session, end-to-end virtual child execution, output quality, latency under real load, or actual charges. No live endpoint smoke tests are part of `npm test`. Tier labels and criteria are configuration policy, not benchmark results; no claim is made that Astra, Opus, Sol, Kimi, DeepSeek Flash, or Luna is best for a task.

## Layout creation and capture

`rexpi_layout` supports `save`, `capture`, `list`, `show`, `open`, and `delete`. Use `show` on a built-in to inspect the spec before creating a variation. An example `save` input:

```json
{
  "action": "save",
  "name": "my-build",
  "layout": {
    "version": 1,
    "root": {
      "type": "split", "direction": "row", "ratio": 0.5,
      "before": { "type": "terminal", "title": "Pi", "role": "pi", "source": "current", "focus": true },
      "after": {
        "type": "split", "direction": "column", "ratio": 0.65,
        "before": { "type": "terminal", "title": "Editor shell" },
        "after": { "type": "terminal", "title": "Shell" }
      }
    }
  }
}
```

Tools are **opt-in**. Start a tool manually in a shell, or ask Pi to `show` a built-in and `save` a customized copy under a user name. For example, “Copy `inspect` to `my-review` and run `hunk diff` in the review pane.” An explicit `command: ["hunk", "diff"]` on that non-Pi leaf opts into Hunk; `command: ["hx"]` or `command: ["k9s"]` are other optional choices, not built-in defaults. Use whatever editor, diff viewer, or monitor you prefer. Only opening a customized spec requires its chosen executables on PATH; missing executables fail preflight before any panes are created. Saving still runs nothing, and built-ins stay unchanged.

`row` puts `before` on the left; `column` puts it on top. `ratio` is the fraction assigned to `before` (strictly between 0 and 1). Terminal leaves accept literal `command` argv or explicit `shell` text (not both), optional `cwd`, `keepOpen`, and `focus`. Without a command, a new login shell starts. Relative cwd resolves against the invoking Pi's directory. The current-Pi leaf cannot override command, shell, cwd, or keep-open behavior. A spec permits at most 32 panes, 16 levels, one current-Pi slot, and one focused leaf. Names are lowercase letters, digits, and interior hyphens, start with a letter, and contain at most 64 characters. Use the tool for names that coincide with command verbs such as `save` or `preview`.

To capture an arrangement, arrange panes in Rex and run `/rxl save my-workspace`. Capture reads the **active tab** in Pi's Rex session, not necessarily the tab containing Pi. It preserves tiled topology, split ratios, pane labels, and focus. It identifies the invoking Pi only when that exact pane is present. Floating layers and unsupported block types are rejected rather than silently omitted.

**Capture is not process restoration.** Current Rex snapshots expose structure but not declared terminal launch argv/cwd. Those panes become new shell leaves, with the fallback titles reported when saving; terminal contents and foreground processes are never scraped to guess commands. Describe commands to Pi when creating a reusable spec instead.

User layouts live in `getAgentDir()/pi-rex/layouts` (normally `~/.pi/agent/pi-rex/layouts`), separate from conversation bindings. Private files are written atomically and survive reload. Existing user names require explicit `overwrite: true` or `/rxl save NAME --overwrite`; built-ins cannot be overwritten or deleted. Use the tool's `delete` action to remove a user layout. Saving or deleting a definition never closes existing panes. Specs do not store live process, pane, endpoint, or conversation IDs. Layout commands are unavailable in capability-granted child runtimes; the tool also fails closed without a full local layout runtime.

## Remote terminals

Rexpi can open terminals on hosts configured in `rex hosts`. Add an exact connection entry for each remote host you want to use:

```json
{
  "pi-rex": {
    "hosts": {
      "connections": {
        "debian": {
          "sshTarget": "debian",
          "remoteSocketPath": "/run/user/1000/rex/server.sock",
          "expectedServerHostId": "01234567-89ab-cdef-0123-456789abcdef",
          "expectedServerInstanceId": "fedcba98-7654-3210-fedc-ba9876543210"
        }
      }
    }
  }
}
```

Use the host's actual SSH alias, remote Rex socket, and the `host_id` and `instance_id` reported by `rex whoami --json`. No credentials or private keys go in this file.

Ask Pi to list hosts, connect to one, or open a terminal there. `rexpi_connect_host` changes only the current conversation's default execution host; `rexpi_open_terminal` also accepts a one-off `host` without changing that selection. Remote cwd, executables, and PATH resolve on the remote machine. Other launches, configured commands, agents, and messaging remain local. Restored remote selections require an explicit reconnect.

The selected remote host is checked every 30 seconds with the same bounded `whoami` identity probe used during connection. This covers both Rexpi-owned and external SSH tunnels. Three consecutive failures mark the host disconnected and stop polling; a successful check resets the failure count. `rexpi_inspect` exposes `lastVerifiedAt` while the selection is verified. Health checks never spawn or replace a tunnel, and recovery still requires an explicit `rexpi_connect_host`. No remote operation is replayed after reconnection.

## Helix and Hunk, floating

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

## Defaults and workspace navigation

Everything else works with the defaults: `rex` and `pi` from PATH, plus the shortcuts listed in the README. No environment variables are required unless you want to override the virtual-model policy path.

Switching between Rex workspaces requires **Remote Control** enabled in Rex Settings; navigation within the same workspace doesn't.
