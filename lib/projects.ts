import { isAbsolute } from "node:path";
import { executable } from "./executable.ts";
import { launchDirectory } from "./launch.ts";
import type { Exec } from "./rex.ts";

export interface ResolvedDirectory { directory: string; matchedBy: "path" | "zoxide" }
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
    if (result.truncated) throw new Error("zoxide lookup exceeded its output limit; no Pi was launched");
    if (result.killed) throw new Error("zoxide lookup was interrupted or timed out; no Pi was launched");
    if (result.code !== 0) throw new Error("zoxide found no usable match or failed (exit " + result.code + "); no Pi was launched");
    const target = result.stdout.replace(/\r?\n$/, "");
    if (!isAbsolute(target) || target.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(target))
      throw new Error("zoxide did not return one absolute directory; no Pi was launched");
    return { directory: launchDirectory(target, cwd), matchedBy: "zoxide" };
  }
}
