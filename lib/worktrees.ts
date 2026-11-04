import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { AgentBrowser, type AgentList } from "./agents.ts";
import { executable } from "./executable.ts";
import type { Launcher, LaunchResult } from "./launch.ts";
import type { Exec } from "./rex.ts";
import type { Runtime } from "./runtime.ts";

interface WorktreeRecord {
  path: string; head: string; branch: string; main: boolean; bare: boolean;
  locked?: string; prunable?: string;
}
export interface WorktreeRow extends WorktreeRecord {
  key: string; repository: string; commonDir: string; identity: string;
  current: boolean; state: "clean" | "dirty" | "missing" | "unavailable";
  agents: number; deletionIssue: string;
}
export interface WorktreeList { rows: WorktreeRow[]; unavailable: number }
export class WorktreeRemovalError extends Error {
  readonly outcome: "blocked" | "failed" | "unknown";
  readonly path?: string;
  constructor(outcome: "blocked" | "failed" | "unknown", message: string, path?: string) {
    super(message); this.name = "WorktreeRemovalError"; this.outcome = outcome; this.path = path;
  }
}

/** -z is essential: Git paths can contain tabs, quotes and newlines. */
export function parseWorktrees(output: string): WorktreeRecord[] {
  if (!output.endsWith("\0\0")) throw new Error("Incomplete Git worktree list");
  const records = output.slice(0, -2).split("\0\0");
  if (records.length > 256) throw new Error("Too many worktrees (maximum 256)");
  const rows = records.map((record, index) => {
    const fields = record.split("\0");
    const path = fields.shift()?.replace(/^worktree /, "");
    if (!path || !isAbsolute(path) || !record.startsWith("worktree ")) throw new Error("Invalid Git worktree path");
    const row: WorktreeRecord = { path, head: "", branch: "", main: index === 0, bare: false };
    const seen = new Set<string>();
    for (const field of fields) {
      const space = field.indexOf(" "), key = space < 0 ? field : field.slice(0, space), value = space < 0 ? "" : field.slice(space + 1);
      if (seen.has(key)) throw new Error("Duplicate Git worktree field");
      seen.add(key);
      if (key === "HEAD") row.head = value;
      else if (key === "branch") row.branch = value;
      else if (key === "bare") row.bare = true;
      else if (key === "locked") row.locked = value;
      else if (key === "prunable") row.prunable = value;
    }
    if (!row.bare && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.head)) throw new Error("Invalid Git worktree HEAD");
    if (row.branch && !row.branch.startsWith("refs/heads/")) throw new Error("Invalid Git worktree branch");
    return row;
  });
  if (new Set(rows.map(row => row.path)).size !== rows.length) throw new Error("Duplicate Git worktree paths");
  return rows;
}
function within(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!suffix.startsWith(".." + sep) && suffix !== ".." && !isAbsolute(suffix));
}
function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Unknown process directory");
  return realpathSync(path);
}
function directoryIdentity(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Worktree is not a local directory");
  return stat.dev + ":" + stat.ino;
}
function missing(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function same(left: WorktreeRow, right: WorktreeRow): boolean {
  return left.path === right.path && left.commonDir === right.commonDir && left.identity === right.identity
    && left.head === right.head && left.branch === right.branch && left.main === right.main && left.bare === right.bare;
}

/** Git operations stay separate from terminal creation, which uses the existing guarded launcher. */
export class WorktreeBrowser {
  private readonly git: string;
  private readonly agents: (signal: AbortSignal) => Promise<AgentList>;
  private readonly runtime: Runtime;
  private readonly launcher: Launcher;
  private readonly exec: Exec;
  private readonly cwd: string;
  constructor(runtime: Runtime, launcher: Launcher, exec: Exec, cwd: string, agents?: (signal: AbortSignal) => Promise<AgentList>) {
    this.runtime = runtime; this.launcher = launcher; this.exec = exec; this.cwd = cwd;
    this.git = executable("git", cwd);
    this.agents = agents ?? (signal => new AgentBrowser(runtime).list(signal));
  }
  private async command(cwd: string, args: string[], signal: AbortSignal, mutation = false, maxBuffer = 512 * 1024): Promise<string> {
    signal.throwIfAborted();
    let result;
    try {
      result = await this.exec(this.git, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
        { cwd, signal, timeout: 8000, maxBuffer });
    } catch (error) {
      if (mutation) throw new WorktreeRemovalError("unknown", "Worktree removal outcome unknown; inspect Git before any deliberate retry", args.at(-1));
      throw error;
    }
    if (result.killed || result.truncated || signal.aborted) {
      if (mutation) throw new WorktreeRemovalError("unknown", "Worktree removal outcome unknown; inspect Git before any deliberate retry", args.at(-1));
      throw new Error("Git read interrupted or exceeded its output limit");
    }
    if (result.code !== 0) {
      if (mutation) throw new WorktreeRemovalError("failed", "Git worktree removal failed (exit " + result.code
        + "); inspect for partial removal. No force or retry was attempted", args.at(-1));
      throw new Error("Cannot read Git worktrees/status (exit " + result.code + ")");
    }
    return result.stdout;
  }
  private async common(cwd: string, signal: AbortSignal): Promise<string> {
    const path = (await this.command(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).replace(/\n$/, "");
    return canonical(path);
  }
  /** Status intentionally trusts index flags; deletion must not. Never clear flags in the user's index. */
  private async indexIssue(cwd: string, signal: AbortSignal): Promise<string> {
    const output = await this.command(cwd, ["ls-files", "--stage", "-v", "-z"], signal, false, 8 * 1024 * 1024);
    if (output && !output.endsWith("\0")) throw new Error("Incomplete Git index inspection");
    let hidden = false, submodules = false;
    for (const entry of output ? output.slice(0, -1).split("\0") : []) {
      const match = /^([A-Za-z?]) ([0-7]{6}) (?:[a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(entry);
      if (!match) throw new Error("Invalid Git index inspection");
      if (match[3] !== "0") return "Unmerged index entries";
      hidden ||= match[1] !== match[1].toUpperCase() || match[1].toUpperCase() === "S";
      submodules ||= match[2] === "160000";
    }
    if (hidden) return "Assume-unchanged or skip-worktree index entries may hide local changes";
    if (submodules) return "Worktree contains submodules; non-force removal is unsupported";
    // Git also refuses removal when old submodule metadata remains, even with no current gitlinks.
    const modules = (await this.command(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "modules"], signal)).replace(/\n$/, "");
    if (!isAbsolute(modules) || modules.includes("\0")) throw new Error("Invalid Git modules path");
    return missing(modules) ? "" : "Worktree contains submodule metadata; non-force removal is unsupported";
  }
  async list(signal?: AbortSignal): Promise<WorktreeList> { return this.scan(signal); }
  private async scan(signal?: AbortSignal, paths?: ReadonlySet<string>): Promise<WorktreeList> {
    const own = this.runtime.snapshot();
    const combined = AbortSignal.any([own.signal, AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
    await this.runtime.source(own, combined);
    const current = canonical(this.cwd), commonDir = await this.common(this.cwd, combined);
    const records = parseWorktrees(await this.command(this.cwd, ["worktree", "list", "--porcelain", "-z"], combined));
    // Batch preflight scans every selected row once; per-effect checks scan only that target.
    // Keep main/repository metadata from the complete list, not the filtered subset.
    const selected = paths ? records.filter(record => paths.has(record.path)) : records;
    const rows = new Array<WorktreeRow>(selected.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++, record = selected[index];
        const row: WorktreeRow = { ...record, key: record.path, repository: records[0].path, commonDir, identity: "",
          current: false, state: "unavailable", agents: 0, deletionIssue: "" };
        try {
          // Only lstat ENOENT proves absence. A dangling symlink or a Git/status
          // failure is not a missing directory and must remain protected.
          if (missing(row.path)) { row.state = "missing"; row.identity = "missing"; }
          else {
            row.identity = directoryIdentity(row.path);
            const path = canonical(row.path);
            row.current = within(path, current);
            if (!row.bare && row.prunable === undefined) {
              if (await this.common(row.path, combined) !== commonDir) throw new Error("Worktree repository changed");
              const status = await this.command(row.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=matching", "--ignore-submodules=none"], combined);
              row.deletionIssue = status.length ? "" : await this.indexIssue(row.path, combined);
              row.state = status.length ? "dirty" : "clean";
            }
          }
        } catch { combined.throwIfAborted(); /* unreadable rows remain visible, but cannot be opened or removed */ }
        rows[index] = row;
      }
    }));
    // Read live locations after Git status, not before a potentially long scan.
    let agentPaths: string[] = [], agentIssue = "";
    try {
      const live = await this.agents(combined);
      if (live.unavailable) throw new Error("Incomplete Rex agent discovery");
      agentPaths = live.rows.map(row => canonical(row.rawCwd ?? ""));
    } catch { combined.throwIfAborted(); agentIssue = "Agent locations unavailable"; }
    for (const row of rows) {
      try { row.agents = agentPaths.filter(agent => within(row.state === "missing" ? row.path : canonical(row.path), agent)).length; }
      catch { row.state = "unavailable"; }
      row.deletionIssue = row.main ? "Main worktree" : row.bare ? "Bare repository" : row.current ? "Current worktree"
        : row.locked !== undefined ? "Locked worktree"
        : row.prunable !== undefined && row.state !== "missing" ? "Prunable worktree directory still exists"
        : row.state === "missing" && row.prunable === undefined ? "Missing worktree is not reported prunable"
        : row.state === "unavailable" ? "Worktree status unavailable" : row.state === "dirty" ? "Uncommitted, untracked or ignored files"
        : row.deletionIssue || (row.agents ? "Live Rex agents in this worktree" : agentIssue);
    }
    this.runtime.assert(own); combined.throwIfAborted();
    const availability = (row: WorktreeRow) => row.state === "unavailable" ? 2 : row.state === "missing" ? 1 : 0;
    rows.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.main) - Number(a.main)
      || availability(a) - availability(b) || a.path.localeCompare(b.path));
    return { rows, unavailable: rows.filter(row => row.state === "unavailable").length };
  }
  private async selected(row: WorktreeRow, signal?: AbortSignal): Promise<WorktreeRow> {
    const found = (await this.list(signal)).rows.find(candidate => candidate.path === row.path);
    if (!found || !same(row, found)) throw new Error("Worktree changed or disappeared; refresh and select it again");
    return found;
  }
  async open(id: string, row: WorktreeRow, signal?: AbortSignal): Promise<LaunchResult> {
    const own = this.runtime.snapshot();
    const combined = AbortSignal.any([own.signal, ...(signal ? [signal] : [])]);
    const found = await this.selected(row, combined);
    if (found.state === "missing") throw new Error("Worktree directory is missing; mark it to remove its Git registration instead");
    if (found.bare || found.prunable !== undefined || found.state === "unavailable") throw new Error("This worktree is unavailable");
    this.runtime.assert(own); combined.throwIfAborted();
    return this.launcher.launch("worktree:" + id, { cwd: found.path, placement: "tab", title: basename(found.path) || "Worktree" }, this.cwd, combined);
  }
  /** Validate the entire confirmed batch before its first effect; each removal checks again. */
  async checkRemoval(rows: WorktreeRow[], signal?: AbortSignal): Promise<WorktreeRow[]> {
    if (!rows.length || rows.length > 256 || new Set(rows.map(row => row.path)).size !== rows.length)
      throw new Error("Invalid worktree removal selection");
    const current = (await this.scan(signal, new Set(rows.map(row => row.path)))).rows;
    return rows.map(row => {
      const found = current.find(candidate => candidate.path === row.path);
      if (!found || !same(row, found)) throw new WorktreeRemovalError("blocked", "Worktree changed or disappeared; refresh and select it again", row.path);
      if (found.deletionIssue) throw new WorktreeRemovalError("blocked", "Cannot remove: " + found.deletionIssue, row.path);
      return found;
    });
  }
  /** Call only after explicit UI confirmation. Never forces, prunes or deletes branches. */
  async remove(row: WorktreeRow, signal?: AbortSignal): Promise<void> {
    const own = this.runtime.snapshot();
    const combined = AbortSignal.any([own.signal, ...(signal ? [signal] : [])]);
    const [found] = await this.checkRemoval([row], combined);
    if (found.state === "missing") {
      if (!missing(found.path)) throw new Error("Worktree directory reappeared; refresh and select it again");
    } else if (directoryIdentity(found.path) !== found.identity) throw new Error("Worktree directory changed");
    this.runtime.assert(own); combined.throwIfAborted();
    await this.command(this.cwd, ["worktree", "remove", "--", found.path], combined, true);
    try {
      const remaining = parseWorktrees(await this.command(this.cwd, ["worktree", "list", "--porcelain", "-z"], combined));
      if (remaining.some(row => row.path === found.path) || !missing(found.path))
        throw new Error("The Git registration or directory is still present");
      this.runtime.assert(own); combined.throwIfAborted();
    } catch (error) {
      throw new WorktreeRemovalError("unknown", "Git returned success but removal could not be verified: "
        + (error instanceof Error ? error.message : String(error)) + ". Inspect Git before retrying", found.path);
    }
  }
}
