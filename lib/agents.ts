import { Runtime } from "./runtime.ts";
import type { TerminalPane } from "./rex.ts";
import { isLive, record, type Binding, type Target } from "./state.ts";

export type AgentState = "idle" | "working" | "blocked" | "error" | "done" | "unknown";
export interface AgentRow extends TerminalPane {
  key: string;
  serverInstance: string;
  app: string;
  pid: number;
  processName: string;
  state: AgentState;
  title: string;
  conversationTitle?: string;
  message: string;
  cwd: string;
  /** Unmodified process path for safety checks; never render without sanitizing. */
  rawCwd?: string;
  current: boolean;
  binding?: Binding;
  native: boolean;
  processDetected?: boolean;
}
export interface AgentList { rows: AgentRow[]; unavailable: number }
interface Process { pid: number; name: string; cwd: string; rawCwd?: string; app?: string }
interface Report { app: string; pid: number; name: string; state: AgentState; title: string; message: string }
const APPS: Record<string, string> = { pi: "Pi", claude: "Claude", "claude-code": "Claude", codex: "Codex", opencode: "OpenCode", gemini: "Gemini" };
const ORDER: Record<AgentState, number> = { blocked: 0, error: 1, working: 2, idle: 3, done: 4, unknown: 5 };

/** Native labels/messages are untrusted terminal display data, not ANSI or instructions. */
export function agentText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 300) : fallback;
}
/** Identify a running CLI from process metadata, never from its terminal title. */
export function processAgent(value: Record<string, unknown>): string | undefined {
  const apps = new Set<string>();
  for (const field of ["argv0", "script", "invoked_path", "path", "name"]) {
    const raw = value[field];
    if (typeof raw !== "string" || raw.length > 4096) continue;
    const path = raw.replaceAll("\\", "/");
    const name = (path.split("/").at(-1) ?? "").toLowerCase().replace(/\.(?:exe|[cm]?js)$/, "");
    if (Object.hasOwn(APPS, name)) apps.add(APPS[name]);
    const packages: Array<[string, string]> = [
      ["@anthropic-ai/claude-code", "Claude"], ["@openai/codex", "Codex"],
      ["@earendil-works/pi-coding-agent", "Pi"], ["@mariozechner/pi-coding-agent", "Pi"],
      ["@google/gemini-cli", "Gemini"],
    ];
    for (const [pkg, app] of packages) if (path.includes("/node_modules/" + pkg + "/")) apps.add(app);
    if (/\/\.local\/share\/claude\/versions\/[^/]+$/.test(path)) apps.add("Claude");
  }
  return apps.size === 1 ? [...apps][0] : undefined;
}
function processes(value: Record<string, unknown>): Process[] {
  const ancestors = value.ancestors == null ? [] : value.ancestors;
  if (!Array.isArray(ancestors)) throw new Error("Invalid Rex process list");
  return [value.foreground, value.child, ...ancestors].flatMap(raw => {
    if (!raw) return [];
    const p = record(raw);
    return Number.isSafeInteger(p.pid) && Number(p.pid) > 0 && typeof p.name === "string"
      ? [{ pid: Number(p.pid), name: p.name, cwd: agentText(p.cwd), rawCwd: typeof p.cwd === "string" ? p.cwd : undefined, app: processAgent(p) }] : [];
  });
}
function reports(value: Record<string, unknown>): Report[] {
  if (!Array.isArray(value.records) || value.records.length > 1024) throw new Error("Invalid Rex program statuses");
  return value.records.flatMap(raw => {
    const r = record(raw);
    const app = typeof (r.effective_app ?? r.app) === "string" ? String(r.effective_app ?? r.app).toLowerCase() : "";
    if (!Object.hasOwn(APPS, app) || !r.owner) return [];
    const owner = record(r.owner);
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.name !== "string") return [];
    const state = typeof r.state === "string" && Object.hasOwn(ORDER, r.state) && r.state !== "unknown" ? r.state as AgentState : "idle";
    return [{ app: APPS[app], pid: Number(owner.pid), name: owner.name, state,
      title: agentText(r.title), message: agentText(r.msg) }];
  });
}

/** Read-only discovery while the overlay is open. No status writes, launch, or recovery. */
export class AgentBrowser {
  private readonly runtime: Runtime;
  private readonly client?: string;
  constructor(runtime: Runtime, client?: string) { this.runtime = runtime; this.client = client; }

  private async paneRows(pane: TerminalPane, serverInstance: string, bindings: Binding[], signal: AbortSignal): Promise<{ rows: AgentRow[]; unavailable: number }> {
    const live = processes(await this.runtime.rex.terminalData(pane, "process", signal));
    let native: Report[] = [], unavailable = 0;
    try { native = reports(await this.runtime.rex.terminalData(pane, "program_status", signal)); }
    catch (error) { signal.throwIfAborted(); unavailable++; }
    const bound = bindings.filter(b => b.blockId === pane.blockId && live.some(p => p.pid === b.pid));
    const binding = bound.length === 1 ? bound[0] : undefined;
    const grouped = new Map<string, Report>();
    for (const r of native) {
      if (!live.some(p => p.pid === r.pid && p.name === r.name)) continue;
      const key = r.pid + ":" + r.name + ":" + r.app;
      const previous = grouped.get(key);
      if (!previous || ORDER[r.state] < ORDER[previous.state]) grouped.set(key, r);
    }
    const rows: AgentRow[] = [...grouped.values()].map(r => ({ ...pane, key: pane.blockId + ":" + r.pid + ":" + r.name + ":" + r.app,
      serverInstance, app: r.app, pid: r.pid, processName: r.name, state: r.state,
      title: r.title || agentText(pane.label), message: r.message,
      cwd: live.find(p => p.pid === r.pid && p.name === r.name)?.cwd ?? "",
      rawCwd: live.find(p => p.pid === r.pid && p.name === r.name)?.rawCwd,
      current: pane.blockId === this.runtime.snapshot().blockId && r.pid === process.pid && r.app === "Pi", native: true,
      ...(r.app === "Pi" && binding?.pid === r.pid ? { binding } : {}) }));
    // Reporting is optional. A recognized live CLI is still an agent, but its
    // activity is unknown without native status. Keep the native process name
    // (including versioned Claude executables) for exact navigation checks.
    for (const p of live) {
      if (!p.app || rows.some(row => row.pid === p.pid && row.processName === p.name)) continue;
      rows.push({ ...pane, key: pane.blockId + ":" + p.pid + ":" + p.name + ":" + p.app, serverInstance,
        app: p.app, pid: p.pid, processName: p.name, state: "unknown", title: agentText(pane.label), message: "No native status",
        cwd: p.cwd, rawCwd: p.rawCwd, current: pane.blockId === this.runtime.snapshot().blockId && p.pid === process.pid && p.app === "Pi",
        native: false, processDetected: true, ...(p.app === "Pi" && binding?.pid === p.pid ? { binding } : {}) });
    }
    // A live Pi binding can identify older/wrapped Pi executables as well.
    if (binding && !rows.some(r => r.pid === binding.pid)) {
      const p = live.find(p => p.pid === binding.pid)!;
      rows.push({ ...pane, key: pane.blockId + ":" + p.pid + ":" + p.name + ":Pi", serverInstance,
        app: "Pi", pid: p.pid, processName: p.name, state: "unknown", title: agentText(pane.label), message: "No native status",
        cwd: p.cwd, rawCwd: p.rawCwd, current: pane.blockId === this.runtime.snapshot().blockId && p.pid === process.pid, native: false, binding });
    }
    if (rows.length) {
      // Titles are display enrichment only. Never attribute a shell/stale title
      // to an agent unless Rex reports that exact live process as its owner.
      try {
        const value = await this.runtime.rex.terminalData(pane, "title", signal);
        if (value.owner) {
          const owner = record(value.owner);
          for (const row of rows) if (row.pid === owner.pid && row.processName === owner.name)
            row.conversationTitle = agentText(value.title);
        }
      } catch { signal.throwIfAborted(); /* older Rex versions may omit title ownership */ }
    }
    return { rows, unavailable };
  }

  async list(signal?: AbortSignal): Promise<AgentList> {
    const own = this.runtime.snapshot();
    const combined = AbortSignal.any([own.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
    const source = await this.runtime.source(own, combined);
    const bindings = this.runtime.store.all().filter(b => isLive(b, own.server));
    const panes = await this.runtime.rex.terminals(combined);
    const rows: AgentRow[] = [];
    let next = 0, unavailable = 0;
    // Bounded read concurrency; a closed/unreadable pane doesn't hide the others.
    await Promise.all(Array.from({ length: Math.min(4, panes.length) }, async () => {
      while (next < panes.length) {
        const pane = panes[next++];
        try {
          const result = await this.paneRows(pane, own.server.instanceId, bindings, combined);
          rows.push(...result.rows); unavailable += result.unavailable;
        } catch (error) { combined.throwIfAborted(); unavailable++; }
      }
    }));
    await this.runtime.rex.checkServer(combined);
    this.runtime.assert(own);
    rows.sort((a, b) => Number(b.sessionId === source.sessionId) - Number(a.sessionId === source.sessionId)
      || agentText(a.sessionLabel).localeCompare(agentText(b.sessionLabel)) || a.sessionId.localeCompare(b.sessionId)
      || ORDER[a.state] - ORDER[b.state] || agentText(a.windowLabel).localeCompare(agentText(b.windowLabel)) || a.key.localeCompare(b.key));
    return { rows, unavailable };
  }

  async focus(row: AgentRow, signal?: AbortSignal): Promise<Target> {
    const own = this.runtime.snapshot();
    const combined = AbortSignal.any([own.signal, ...(signal ? [signal] : [])]);
    if (row.serverInstance !== own.server.instanceId) throw new Error("Agent belongs to an earlier Rex server instance");
    const source = await this.runtime.source(own, combined);
    const target = await this.runtime.rex.locate(row.blockId, combined);
    const check = () => {
      this.runtime.assert(own);
      if (row.binding) {
        const current = this.runtime.store.find(row.binding, own.server);
        if (!current || current.token !== row.binding.token || current.blockId !== row.blockId || current.pid !== row.pid)
          throw new Error("The selected Pi conversation changed or is no longer live");
      }
    };
    const verify = async () => {
      check();
      const live = processes(await this.runtime.rex.terminalData(target, "process", combined));
      if (!live.some(p => p.pid === row.pid && p.name === row.processName)) throw new Error("The selected agent process is no longer attached to this pane");
      if (row.processDetected && !live.some(p => p.pid === row.pid && p.name === row.processName && p.app === row.app))
        throw new Error("The selected process is no longer identifiable as that agent");
      if (row.native) {
        const status = reports(await this.runtime.rex.terminalData(target, "program_status", combined));
        if (!status.some(r => r.pid === row.pid && r.name === row.processName && r.app === row.app))
          throw new Error("The selected agent's native status is no longer available");
      }
      check();
    };
    await verify();
    const client = source.sessionId === target.sessionId ? undefined : await this.runtime.rex.app(source, this.client, combined);
    // Capability lookup may have taken time. Recheck process and location before
    // the first focus effect; never fall back to a nearby pane or title match.
    await this.runtime.rex.checkServer(combined);
    const current = await this.runtime.rex.locate(row.blockId, combined);
    if (current.sessionId !== target.sessionId || current.windowId !== target.windowId) throw new Error("Agent moved during selection; refresh and select it again");
    await verify();
    await this.runtime.rex.focus(target, client, verify, combined);
    return target;
  }
}
