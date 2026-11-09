import { basename } from "node:path";
import type { RemoteHostOperationContext } from "./host-selection.ts";
import type { Created, Rex } from "./rex.ts";
import type { SshConnectionTicket } from "./ssh-transport.ts";
import { cleanTitle, record, type Target } from "./state.ts";
import {
  unknownTerminalResult,
  validateTerminal,
  type TerminalExecutionHost,
  type TerminalLocalOrigin,
  type TerminalOptions,
  type TerminalResult,
} from "./terminal.ts";

const MAX_REQUESTS = 4096;

/**
 * Runs inside the terminal created on the remote host. Every caller value is a positional
 * parameter, never interpolated into shell source. cd and exec therefore resolve directories,
 * PATH, and bare executables using only the remote process environment.
 */
const REMOTE_TERMINAL_SCRIPT = `base=$1
requested=$2
mode=$3
shift 3
case $requested in
  "") directory=$base ;;
  "~") directory=\${HOME:?Remote HOME is unavailable} ;;
  "~/"*) directory=\${HOME:?Remote HOME is unavailable}\${requested#\\~} ;;
  *) directory=$requested ;;
esac
case $directory in
  /*) ;;
  *) directory=$base/$directory ;;
esac
cd -- "$directory" || exit 125
if [ -z "\${PATH:-}" ]; then PATH=/usr/local/bin:/usr/bin:/bin; fi
export PATH
if [ "$mode" = "shell" ]; then
  [ "$#" -eq 1 ] || exit 125
  exec /bin/sh -c "$1"
fi
[ "$#" -gt 0 ] || exit 125
exec "$@"`;

export interface RemoteTerminalHosts {
  withRemoteOperation<T>(alias: string | undefined,
    operation: (context: RemoteHostOperationContext, signal: AbortSignal) => T | Promise<T>,
    signal?: AbortSignal): Promise<T>;
}
export type RemoteRexFactory = (ticket: SshConnectionTicket) => Rex;

/** Literal remote argv. No local executable(), launchDirectory(), PATH, cwd, or environment is consulted. */
export function remoteTerminalArgv(options: Pick<TerminalOptions, "command" | "cwd">, anchorCwd: string): string[] {
  return ["/bin/sh", "-c", REMOTE_TERMINAL_SCRIPT, "rexpi-remote-terminal", anchorCwd, options.cwd ?? "",
    typeof options.command === "string" ? "shell" : "argv",
    ...(typeof options.command === "string" ? [options.command] : options.command)];
}

/** The unique remote terminal's live process supplies the base directory; local cwd is never a fallback. */
export function remoteProcessDirectory(value: Record<string, unknown>): string {
  const candidates = [value.foreground, value.child,
    ...(Array.isArray(value.ancestors) ? value.ancestors : [])];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const cwd = record(candidate).cwd;
    if (cwd === undefined) continue;
    if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4096
        || /[\u0000-\u001f\u007f-\u009f]/.test(cwd))
      throw new Error("Remote Rex terminal returned an invalid process cwd");
    return cwd;
  }
  throw new Error("Remote Rex terminal did not provide a process cwd");
}

/** Remote creation shares the local outcome shape but never performs local source/process verification. */
export class RemoteTerminalOpener {
  private readonly hosts: RemoteTerminalHosts;
  private readonly createRex: RemoteRexFactory;
  private readonly requests = new Map<string, Promise<TerminalResult> | TerminalResult>();

  constructor(hosts: RemoteTerminalHosts, createRex: RemoteRexFactory) {
    this.hosts = hosts;
    this.createRex = createRex;
  }

  open(id: string, options: TerminalOptions, host?: string, signal?: AbortSignal): Promise<TerminalResult> {
    const previous = this.requests.get(id);
    if (previous) return Promise.resolve(previous);
    if (this.requests.size >= MAX_REQUESTS)
      return Promise.reject(new Error("Terminal request history is full (" + MAX_REQUESTS + "); reload explicitly before more opens"));
    const result = this.perform(id, options, host, signal);
    this.requests.set(id, result);
    void result.then(value => { this.requests.set(id, value); }, () => { /* rejected IDs keep their evidence */ });
    return result;
  }

  private async perform(id: string, options: TerminalOptions, host: string | undefined,
      signal?: AbortSignal): Promise<TerminalResult> {
    validateTerminal(options);
    const placement = options.placement ?? "right";
    let creationStarted = false;
    let preparationFailure: unknown;
    let evidence: { executionHost: TerminalExecutionHost; localOrigin: TerminalLocalOrigin } | undefined;
    try {
      return await this.hosts.withRemoteOperation(host, async (context, operationSignal) => {
        let server: { hostId: string; instanceId: string };
        let source: Target | undefined;
        let directory = "~";
        let rex: Rex;
        try {
          operationSignal.throwIfAborted();
          rex = this.createRex(context.ticket);
          const expected = { hostId: context.host.expectedServerHostId,
            instanceId: context.host.expectedServerInstanceId };
          if (placement === "session") {
            // A new workspace is its own first anchor; an empty remote Rex server is valid.
            server = await rex.remoteIdentity(expected, operationSignal);
          } else {
            const anchor = await rex.remoteAnchor(expected, operationSignal);
            server = anchor.server;
            source = anchor.target;
            const process = await rex.terminalData(anchor.target, "process", operationSignal);
            directory = remoteProcessDirectory(process);
          }
          evidence = {
            executionHost: { ...context.host, serverHostId: server.hostId,
              serverInstanceId: server.instanceId },
            localOrigin: { ...context.localOrigin },
          };
          // Host switches, restored trees, disconnects, and cancellation all fence the mutation.
          context.check();
          operationSignal.throwIfAborted();
        } catch (error) {
          preparationFailure = error;
          throw error;
        }
        const title = cleanTitle(options.title ?? (Array.isArray(options.command) ? basename(options.command[0]) : "Terminal"));
        creationStarted = true;
        let target: Created;
        try {
          target = await rex.create({ placement, ...(source ? { source } : {}), cwd: directory,
            command: remoteTerminalArgv(options, directory), title,
            focus: options.focus ?? true, keepOpen: options.keepOpen ?? false, labelPrefix: "",
            ...(placement === "floating" ? { bounds: options.bounds ?? [0.1, 0.1, 0.8, 0.8] } : {}) }, operationSignal);
        } catch {
          return unknownTerminalResult(id, placement, evidence!);
        }
        return { requestId: id, creation: "confirmed", placement, ...evidence!, target };
      }, signal);
    } catch (error) {
      // withOperation deliberately erases the original post-dispatch error. Preserve only the
      // uncertainty outcome; pre-mutation failures remain ordinary rejected requests.
      if (creationStarted && evidence) return unknownTerminalResult(id, placement, evidence);
      throw preparationFailure ?? error;
    }
  }
}
