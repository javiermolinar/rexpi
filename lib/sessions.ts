import { basename } from "node:path";
import type { DirectoryResolver } from "./jump.ts";
import { validateOptions, type Launcher, type LaunchResult } from "./launch.ts";
import type { Runtime, Snapshot } from "./runtime.ts";
import { SessionExistsError, sessionName } from "./session-name.ts";

export interface OpenSessionOptions { sessionName: string; query?: string; title?: string; focus?: boolean }
export type OpenSessionResult =
  | { outcome: "existing"; session: { sessionId: string; name: string }; focused: boolean }
  | { outcome: "created" | "unknown"; name: string; directory: string; launch: LaunchResult };

/** Reuse by name is UI navigation only. Never injects a task or restarts an existing Pi. */
export class SessionOpener {
  private readonly runtime: Runtime;
  private readonly launcher: Launcher;
  private readonly resolve: DirectoryResolver;
  private readonly client?: string;
  private readonly requests = new Map<string, Promise<OpenSessionResult>>();
  constructor(runtime: Runtime, launcher: Launcher, resolve: DirectoryResolver, client?: string) {
    this.runtime = runtime; this.launcher = launcher; this.resolve = resolve; this.client = client;
  }
  open(id: string, options: OpenSessionOptions, cwd: string, signal?: AbortSignal): Promise<OpenSessionResult> {
    const previous = this.requests.get(id);
    if (previous) return previous;
    if (this.requests.size >= 256) return Promise.reject(new Error("Session request history is full; reload explicitly before more requests"));
    const result = this.perform(id, options, cwd, signal);
    this.requests.set(id, result);
    return result;
  }
  private async existing(own: Snapshot, name: string, focus: boolean, signal: AbortSignal): Promise<OpenSessionResult | undefined> {
    this.runtime.assert(own);
    const matches = await this.runtime.rex.matchingSessions(name, signal);
    if (matches.length > 1) throw new Error("Multiple Rex sessions match this name; select one explicitly by ID or resolve their names manually");
    const session = matches[0];
    if (!session) return;
    if (focus) {
      const source = await this.runtime.source(own, signal);
      const client = await this.runtime.rex.app(source, this.client, signal);
      const current = await this.runtime.rex.matchingSessions(name, signal);
      this.runtime.assert(own);
      if (current.length !== 1 || current[0].sessionId !== session.sessionId)
        throw new Error("Named session changed before selection; no new session was created");
      await this.runtime.rex.select(client, session, signal);
      this.runtime.assert(own);
    }
    return { outcome: "existing", session, focused: focus };
  }
  private async perform(id: string, options: OpenSessionOptions, cwd: string, signal?: AbortSignal): Promise<OpenSessionResult> {
    if (Object.keys(options).some(key => !["sessionName", "query", "title", "focus"].includes(key)))
      throw new Error("Unsupported named-session option; existing sessions never receive prompts or model changes");
    const name = sessionName(options.sessionName);
    validateOptions({ title: options.title, focus: options.focus });
    if (options.query !== undefined && (typeof options.query !== "string" || !options.query.trim()
        || options.query.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(options.query))) throw new Error("Invalid creation directory query");
    const own = this.runtime.snapshot();
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    await this.runtime.source(own, combined);
    const reused = await this.existing(own, name, options.focus ?? true, combined);
    if (reused) return reused;
    if (options.query === undefined) throw new Error("No matching session exists. Supply query (a project/path, or . for the current directory) to create one");
    const found = await this.resolve(options.query, cwd, combined);
    this.runtime.assert(own); combined.throwIfAborted();
    // Recheck after directory lookup; the launcher additionally reserves and rechecks the name.
    const appeared = await this.existing(own, name, options.focus ?? true, combined);
    if (appeared) return appeared;
    try {
      const launch = await this.launcher.launch("named:" + id, {
        placement: "session", sessionName: name, cwd: found.directory,
        title: options.title ?? (basename(found.directory) || "Main"), focus: options.focus,
      }, cwd, combined);
      return { outcome: launch.creation === "confirmed" ? "created" : "unknown", name, directory: found.directory, launch };
    } catch (error) {
      if (!(error instanceof SessionExistsError)) throw error;
      const concurrent = await this.existing(own, name, options.focus ?? true, combined);
      if (concurrent) return concurrent;
      throw new Error("A matching session appeared and disappeared; inspect Rex before another explicit request");
    }
  }
}
