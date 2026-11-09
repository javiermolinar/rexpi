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
- **Terminals on other Rex hosts.** Discover configured hosts, select one for the current conversation, and open remote sessions, tabs, splits, and floating panes over SSH Unix-socket forwarding. Remote paths and PATH stay remote, exact server identities are verified, and local agents and messaging stay local.
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

### Remote terminals

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
