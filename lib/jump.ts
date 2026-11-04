import { basename, isAbsolute } from "node:path";
import { executable } from "./executable.ts";
import { launchDirectory, validateOptions, type Launcher, type LaunchOptions, type LaunchResult } from "./launch.ts";
import type { Exec } from "./rex.ts";
import type { Runtime } from "./runtime.ts";

export interface ResolvedDirectory { directory: string; matchedBy: "path" | "zoxide" }
export interface JumpOptions extends Omit<LaunchOptions, "cwd" | "placement" | "sessionName"> { query: string }
export interface JumpResult extends ResolvedDirectory { launch: LaunchResult }
export type DirectoryResolver = (query: string, cwd: string, signal?: AbortSignal) => Promise<ResolvedDirectory>;

function validateQuery(query: unknown): asserts query is string {
  if (typeof query !== "string" || !query.trim() || query.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(query))
    throw new Error("query must be a nonempty local directory or zoxide search (maximum 4096 characters)");
}
function explicitPath(query: string): boolean { return isAbsolute(query) || query === "~" || query.includes("/"); }
/** Resolve only: never changes cwd, updates zoxide's database, or opens a terminal. */
export class ProjectResolver {
  private readonly exec: Exec;
  private readonly path: string;
  private readonly binary: string;
  constructor(exec: Exec, path = process.env.PATH ?? "", binary = "zoxide") {
    this.exec = exec; this.path = path; this.binary = binary;
  }
  async resolve(query: string, cwd: string, signal?: AbortSignal): Promise<ResolvedDirectory> {
    validateQuery(query); signal?.throwIfAborted();
    const input = query.trim();
    try { return { directory: launchDirectory(input, cwd), matchedBy: "path" }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (explicitPath(input)) throw new Error("The requested local directory does not exist; no zoxide fallback was used");
    }
    const binary = executable(this.binary, cwd, this.path);
    const result = await this.exec(binary, ["query", "--", ...input.split(/\s+/)], {
      cwd, signal, timeout: 5000, maxBuffer: 16 * 1024,
    });
    signal?.throwIfAborted();
    if (result.truncated) throw new Error("zoxide lookup exceeded its output limit; no tab was created");
    if (result.killed) throw new Error("zoxide lookup was interrupted or timed out; no tab was created");
    if (result.code !== 0) throw new Error("zoxide found no usable match or failed (exit " + result.code + "); no tab was created");
    const target = result.stdout.replace(/\r?\n$/, "");
    if (!isAbsolute(target) || target.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(target))
      throw new Error("zoxide did not return one absolute directory; no tab was created");
    return { directory: launchDirectory(target, cwd), matchedBy: "zoxide" };
  }
}
/** Directory lookup plus the existing guarded Pi launcher, always in a fresh tab. */
export class ProjectJumper {
  private readonly runtime: Runtime;
  private readonly launcher: Launcher;
  private readonly resolve: DirectoryResolver;
  private readonly requests = new Map<string, Promise<JumpResult>>();
  constructor(runtime: Runtime, launcher: Launcher, resolve: DirectoryResolver) {
    this.runtime = runtime; this.launcher = launcher; this.resolve = resolve;
  }
  jump(id: string, input: JumpOptions, cwd: string, signal?: AbortSignal): Promise<JumpResult> {
    const previous = this.requests.get(id);
    if (previous) return previous;
    if (this.requests.size >= 256) return Promise.reject(new Error("Jump request history is full; reload explicitly before more jumps"));
    const result = this.perform(id, input, cwd, signal);
    this.requests.set(id, result);
    return result;
  }
  private async perform(id: string, input: JumpOptions, cwd: string, signal?: AbortSignal): Promise<JumpResult> {
    validateQuery(input.query);
    const { query, ...options } = input;
    validateOptions(options);
    const own = this.runtime.snapshot();
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    await this.runtime.source(own, combined);
    const found = await this.resolve(query, cwd, combined);
    this.runtime.assert(own); combined.throwIfAborted();
    // Revalidate the resolved directory before handing it to the launcher's own preflight.
    const directory = launchDirectory(found.directory, cwd);
    const launch = await this.launcher.launch("jump:" + id, { ...options, cwd: directory,
      placement: "tab", title: options.title ?? (basename(directory) || "Project") }, cwd, combined);
    return { directory, matchedBy: found.matchedBy, launch };
  }
}
