import { record, rexId, uuid, type Server, type Target } from "./state.ts";
import { canonicalName, sessionName } from "./session-name.ts";

export interface ExecResult { code: number; stdout: string; stderr: string; killed?: boolean; truncated?: boolean }
export type Exec = (command: string, args: string[], options?: {
  signal?: AbortSignal; timeout?: number; maxBuffer?: number; cwd?: string;
}) => Promise<ExecResult>;
export interface CreateOptions {
  placement: "session" | "right" | "down" | "tab" | "floating";
  source: Target;
  cwd: string;
  title: string;
  focus: boolean;
  command: string[];
  keepOpen?: boolean;
  sessionName?: string;
  labelPrefix?: string;
  bounds?: [number, number, number, number];
}
export interface Created { sessionId: string; blockId: string; windowId?: string; layerId?: string }
export interface TerminalPane extends Target { sessionLabel: string; windowLabel: string; label: string }

function array(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid Rex collection response");
  return value;
}
/** Uses the installed CLI; no raw-socket protocol, shell strings, or automatic retries. */
export class Rex {
  readonly binary: string;
  private readonly exec: Exec;
  private endpoint?: string;
  private server?: Server;
  constructor(binary: string, exec: Exec, endpoint?: string) {
    this.binary = binary; this.exec = exec; this.endpoint = endpoint;
  }
  private async run(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    signal?.throwIfAborted();
    const result = await this.exec(this.binary, ["--autostart=false", "--timeout", "5s",
      ...(this.endpoint ? ["-S", this.endpoint] : []), ...args], { signal, timeout: 7000, maxBuffer: 2 * 1024 * 1024 });
    if (result.truncated) throw new Error("Rex request exceeded its output limit; the outcome may be uncertain");
    if (result.killed) throw new Error("Rex request was interrupted or timed out; the outcome may be uncertain");
    if (result.code !== 0) {
      if (result.stderr.includes("Rex.app is not accepting actions") || result.stderr.includes("Turn on Remote Control"))
        throw new Error("Rex app Remote Control is disabled. Enable Remote Control in Rex Settings to switch sessions.");
      // Do not echo arbitrary stderr: creation errors can contain task text or launch arguments.
      throw new Error("Rex request failed (exit " + result.code + ")");
    }
    return result;
  }
  async json(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.run(args, signal);
    return record(JSON.parse(result.stdout));
  }
  async api(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json(["api", "call", method, JSON.stringify(args)], signal);
  }
  private localServer(value: Record<string, unknown>): Server {
    const principal = record(value.principal);
    if (principal.kind !== "peer" || principal.transport !== "unix" || principal.uid !== process.getuid?.()
        || typeof value.endpoint !== "string" || !value.endpoint.startsWith("unix://")
        || !uuid(value.instance_id) || !uuid(value.host_id))
      throw new Error("pi-rex currently requires a same-user local Rex Unix socket");
    return { endpoint: value.endpoint, instanceId: value.instance_id, hostId: value.host_id };
  }
  async initialize(expectedBlock: string, signal?: AbortSignal): Promise<Server> {
    const value = await this.json(["whoami", "--json"], signal);
    if (!rexId(expectedBlock, "block") || value.block_id !== expectedBlock)
      throw new Error("Rex did not verify this terminal's exact REX_BLOCK");
    const server = this.localServer(value);
    this.endpoint = server.endpoint; this.server = server;
    return server;
  }
  async checkServer(signal?: AbortSignal): Promise<void> {
    const actual = this.localServer(await this.json(["whoami", "--json"], signal));
    if (!this.server || actual.instanceId !== this.server.instanceId || actual.hostId !== this.server.hostId)
      throw new Error("Rex server instance changed; reload pi-rex before continuing");
  }
  async view(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!rexId(sessionId, "session")) throw new Error("Invalid Rex session ID");
    const view = await this.api("session.view", { session_id: sessionId }, signal);
    if (view.session_id !== sessionId) throw new Error("Rex returned a different session");
    return view;
  }
  async matchingSessions(name: string, signal?: AbortSignal): Promise<Array<{ sessionId: string; name: string }>> {
    const result = await this.api("session.list", {}, signal);
    return array(result.sessions).map(raw => {
      const value = record(raw);
      if (!rexId(value.session_id, "session") || typeof value.label !== "string") throw new Error("Invalid Rex session identity or label");
      return { sessionId: value.session_id, name: value.label };
    }).filter(value => canonicalName(value.name) === canonicalName(name));
  }
  async locate(blockId: string, signal?: AbortSignal): Promise<Target> {
    if (!this.server || !rexId(blockId, "block")) throw new Error("Unverified Rex block");
    const listed = await this.api("session.list", {}, signal);
    const sessions = array(listed.sessions);
    if (sessions.length > 128) throw new Error("Too many Rex sessions to resolve a target safely");
    const matches: Target[] = [];
    for (const rawSession of sessions) {
      const sessionId = record(rawSession).session_id;
      if (!rexId(sessionId, "session")) throw new Error("Invalid Rex session identity");
      const view = await this.view(sessionId, signal);
      for (const rawWindow of array(view.windows ?? null)) {
        const window = record(rawWindow);
        if (!rexId(window.window_id, "window")) throw new Error("Invalid Rex window identity");
        for (const rawLayer of array(window.layers)) {
          for (const rawBlock of array(record(rawLayer).blocks)) {
            const block = record(rawBlock);
            if (block.block_id !== blockId) continue;
            if (block.host_id !== this.server.hostId || block.creator_name !== "com.superlogical.terminal")
              throw new Error("The Rex pane is remote or is not a terminal");
            if (block.owner != null && !rexId(block.owner, "client")) throw new Error("Invalid Rex pane owner");
            matches.push({ sessionId, windowId: window.window_id, blockId,
              ...(block.owner ? { owner: block.owner as string } : {}) });
          }
        }
      }
    }
    if (matches.length !== 1) throw new Error(matches.length ? "Rex pane is ambiguous" : "Rex pane is closed or detached");
    return matches[0];
  }
  /** Enumerate placed local terminals, including every split and floating layer. */
  async terminals(signal?: AbortSignal): Promise<TerminalPane[]> {
    if (!this.server) throw new Error("Unverified Rex server");
    const listed = array((await this.api("session.list", {}, signal)).sessions);
    if (listed.length > 128) throw new Error("Too many Rex sessions to list agents safely");
    const panes: TerminalPane[] = [];
    const seen = new Set<string>();
    for (const raw of listed) {
      const session = record(raw);
      if (!rexId(session.session_id, "session")) throw new Error("Invalid Rex session identity");
      const view = await this.view(session.session_id, signal);
      for (const rawWindow of array(view.windows ?? null)) {
        const window = record(rawWindow);
        if (!rexId(window.window_id, "window")) throw new Error("Invalid Rex window identity");
        for (const layer of array(window.layers)) for (const rawBlock of array(record(layer).blocks)) {
          const block = record(rawBlock);
          if (block.host_id !== this.server.hostId || block.creator_name !== "com.superlogical.terminal") continue;
          if (!rexId(block.block_id, "block") || (block.owner != null && !rexId(block.owner, "client")))
            throw new Error("Invalid Rex terminal identity");
          if (seen.has(block.block_id)) throw new Error("Rex terminal is ambiguous");
          seen.add(block.block_id);
          panes.push({ sessionId: session.session_id, windowId: window.window_id, blockId: block.block_id,
            ...(block.owner ? { owner: block.owner as string } : {}),
            sessionLabel: typeof session.label === "string" ? session.label : session.session_id,
            windowLabel: typeof window.label === "string" ? window.label : window.window_id,
            label: typeof block.label === "string" ? block.label : block.block_id });
          if (panes.length > 256) throw new Error("Too many Rex terminals to list agents safely");
        }
      }
    }
    return panes;
  }
  async terminalData(target: Target, method: "process" | "program_status" | "title", signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!rexId(target.sessionId, "session") || !rexId(target.blockId, "block")) throw new Error("Invalid Rex terminal target");
    return this.json(["block", "call", "-s", target.sessionId, "-b", target.blockId, method], signal);
  }
  async verifyProcess(target: Target, pid: number, signal?: AbortSignal): Promise<void> {
    const value = await this.terminalData(target, "process", signal);
    const processes = [value.foreground, value.child, ...array(value.ancestors ?? null)];
    if (!processes.some(p => p && record(p).pid === pid))
      throw new Error("The exact Pi process is no longer attached to this Rex pane");
  }
  async app(target: Target, configured?: string, signal?: AbortSignal): Promise<string> {
    const response = await this.json(["client", "ls", "--json"], signal);
    const apps = array(response.clients).map(record).filter(c => c.info && record(c.info).kind === "app");
    const desired = configured ?? target.owner;
    const matches = desired ? apps.filter(c => c.client_id === desired) : apps;
    if (matches.length !== 1 || !rexId(matches[0].client_id, "client"))
      throw new Error("Cannot select exactly one Rex app; set PI_REX_CLIENT to its full client ID");
    const id = matches[0].client_id;
    // Discover capability without invoking a UI action.
    const result = await this.run(["-C", id, "actions", "--json"], signal);
    const parsed: unknown = JSON.parse(result.stdout);
    const actions = Array.isArray(parsed) ? parsed : array(record(parsed).actions);
    if (!actions.some(a => record(a).name === "session.select")) throw new Error("Rex app does not offer session.select");
    return id;
  }
  async select(client: string, target: { sessionId: string; windowId?: string }, signal?: AbortSignal): Promise<void> {
    if (!rexId(client, "client") || !rexId(target.sessionId, "session")
        || (target.windowId !== undefined && !rexId(target.windowId, "window"))) throw new Error("Invalid exact Rex focus target");
    await this.run(["-C", client, "do", "session.select", "session_id=" + target.sessionId,
      ...(target.windowId ? ["window_id=" + target.windowId] : [])], signal);
  }
  async focus(target: Target, client: string | undefined, check: () => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    await check();
    if (client) {
      await this.select(client, target, signal);
      await check();
    }
    await this.api("session.focus_block", { session_id: target.sessionId, block_id: target.blockId }, signal);
    const view = await this.view(target.sessionId, signal);
    const windows = array(view.windows ?? null).map(record);
    if (view.active_window_id !== target.windowId
        || !windows.some(w => w.window_id === target.windowId && w.focused_block_id === target.blockId))
      throw new Error("Rex did not confirm focus on the exact origin pane");
    await check();
  }
  async create(options: CreateOptions, signal?: AbortSignal): Promise<Created> {
    const { source, placement, title, command, cwd, focus } = options;
    if (options.sessionName !== undefined && placement !== "session") throw new Error("sessionName applies only to a new Rex session");
    if (placement === "floating") {
      const value = await this.api("session.new_layer", {
        session_id: source.sessionId, window_id: source.windowId,
        bounds: options.bounds ?? [0.1, 0.1, 0.8, 0.8], focus,
        layout: { block: { flavor: "com.superlogical.terminal.shell", label: title,
          options: { shell: "none", command, cwd, exit: { on_completion: !options.keepOpen } } } },
      }, signal);
      const blocks = array(value.block_ids);
      if (blocks.length !== 1 || !rexId(blocks[0], "block") || !rexId(value.layer_id, "layer"))
        throw new Error("Rex floating creation response lacks exact layer/block IDs");
      return { sessionId: source.sessionId, windowId: source.windowId, blockId: blocks[0], layerId: value.layer_id };
    }
    const common = ["--cwd", cwd, "--shell=none", "--json", ...(options.keepOpen ? ["--keep-open"] : [])];
    const label = (options.labelPrefix ?? "Pi · ") + title;
    let args: string[];
    if (placement === "session") args = ["new", options.sessionName === undefined ? label : sessionName(options.sessionName), "--window", title, ...common];
    else if (placement === "tab") args = ["window", "new", "-s", source.sessionId, label, "--focus=" + focus, ...common];
    else args = ["split", "-s", source.sessionId, "-b", source.blockId, "--split=" + (placement === "down" ? "below" : "right"),
      "--label=" + title, "--focus=" + focus, ...common];
    const value = await this.json([...args, "--", ...command], signal);
    if (placement === "session") {
      const sessionId = value.session_id;
      const windows = array(value.initial_windows);
      if (!rexId(sessionId, "session") || windows.length !== 1) throw new Error("Rex creation response lacks an exact session/window");
      const window = record(windows[0]);
      const blocks = array(window.block_ids);
      if (blocks.length !== 1 || !rexId(blocks[0], "block") || !rexId(window.window_id, "window"))
        throw new Error("Rex creation response lacks exact block/window IDs");
      return { sessionId, windowId: window.window_id, blockId: blocks[0] };
    }
    const blocks = array(value.block_ids);
    if (blocks.length !== 1 || !rexId(blocks[0], "block") || (value.window_id !== undefined && !rexId(value.window_id, "window")))
      throw new Error("Rex creation response lacks an exact block ID");
    return { sessionId: source.sessionId, blockId: blocks[0],
      ...(value.window_id ? { windowId: value.window_id as string } : {}) };
  }
}
