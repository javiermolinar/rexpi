import { AsyncLocalStorage } from "node:async_hooks";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolGateResult } from "./capability-runtime.ts";

export interface CapabilityPathRuntime {
  allowsTool(name: string): boolean;
  guardTool(toolName: string, input: unknown): ToolGateResult | undefined;
  pathGrants(): { readPaths: string[]; writePaths: string[] };
}

/** Narrow seam for deterministic replacement tests; production uses only descriptor I/O after open. */
export interface CapabilityPathFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  mkdir(path: string, options: { mode: number }): Promise<void>;
}

const nativeFs: CapabilityPathFs = {
  realpath: path => fs.realpath(path),
  lstat: path => fs.lstat(path),
  stat: path => fs.stat(path),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  mkdir: async (path, options) => { await fs.mkdir(path, options); },
};

interface Identity { dev: number; ino: number }
interface GrantRoot { resolved: string; mode: "read" | "write" }
interface RootPin extends GrantRoot {
  canonical: string;
  pathIdentity: Identity;
  targetIdentity: Identity;
  directory: boolean;
}
interface ExistingTarget { canonical: string; identity: Identity; nlink: number }
interface CreatedPath { path: string }
interface CallState {
  tool: "read" | "write" | "edit";
  createdFiles: CreatedPath[];
  createdDirectories: CreatedPath[];
  read?: { path: string; content: Buffer };
  edit?: { path: string; handle: FileHandle; roots: RootPin[]; root: RootPin; target: ExistingTarget };
}
interface Options { fs?: CapabilityPathFs }

const denied = (reason: string): Error => new Error("Capability path denied: " + reason);
const identity = (stat: Stats): Identity => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown): boolean => (error as { code?: unknown })?.code === "ENOENT";
const existsAlready = (error: unknown): boolean => (error as { code?: unknown })?.code === "EEXIST";
async function writeContents(handle: FileHandle, content: string): Promise<void> {
  const data = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("Capability path write made no progress");
    offset += bytesWritten;
  }
  await handle.truncate(data.length);
}

function contained(root: string, candidate: string, directory: boolean): boolean {
  const child = relative(root, candidate);
  if (child === "") return directory;
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}
function canonicalContained(root: RootPin, candidate: string): boolean {
  if (candidate === root.canonical) return true;
  return root.directory && contained(root.canonical, candidate, true);
}
function rejectLexicalTraversal(path: unknown): void {
  // Check the original tool input before Pi normalizes it for its operations.
  if (typeof path === "string" && path.split(/[\\/]+/).includes(".."))
    throw denied("lexical .. traversal is not allowed");
}

/**
 * Per-incarnation filesystem authority. Node on the supported host has no portable openat:
 * the pre/post path and inode fences below are deliberate, but cannot make ancestor lookup atomic.
 */
export class CapabilityPathCoordinator {
  private readonly cwd: string;
  private readonly runtime: CapabilityPathRuntime;
  private readonly fs: CapabilityPathFs;
  private readonly roots: GrantRoot[];
  private readonly calls = new AsyncLocalStorage<CallState>();

  constructor(cwd: string, runtime: CapabilityPathRuntime, options: Options = {}) {
    this.cwd = resolve(cwd);
    this.runtime = runtime;
    this.fs = options.fs ?? nativeFs;
    const grants = runtime.pathGrants();
    this.roots = [
      ...grants.readPaths.map(path => ({ resolved: resolve(this.cwd, path), mode: "read" as const })),
      ...grants.writePaths.map(path => ({ resolved: resolve(this.cwd, path), mode: "write" as const })),
    ];
  }

  async invoke<T>(tool: CallState["tool"], params: unknown, operation: () => Promise<T>): Promise<T> {
    rejectLexicalTraversal((params as { path?: unknown } | null)?.path);
    this.assertActive(tool);
    const state: CallState = { tool, createdFiles: [], createdDirectories: [] };
    return this.calls.run(state, async () => {
      try {
        return await operation();
      } catch (error) {
        await this.closeEdit(state);
        const cleanupError = await this.cleanup(state);
        if (cleanupError) {
          const operation = error instanceof Error ? error.message : String(error);
          const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new Error("Capability path operation failed and coordinator-created path cleanup was incomplete: "
            + operation + "; " + cleanup);
        }
        throw error;
      } finally {
        await this.closeEdit(state);
      }
    });
  }

  private assertActive(tool: CallState["tool"]): void {
    const result = this.runtime.guardTool(tool, {});
    if (result) throw new Error(result.reason);
  }

  private state(tool: CallState["tool"]): CallState {
    const state = this.calls.getStore();
    if (!state || state.tool !== tool) throw denied("operation is outside its authorized tool call");
    this.assertActive(tool);
    return state;
  }

  private candidate(path: string): string {
    if (typeof path !== "string" || !path.length || path.includes("\0")) throw denied("invalid path");
    rejectLexicalTraversal(path);
    return resolve(this.cwd, path);
  }

  private async pinRoots(): Promise<RootPin[]> {
    const pins: RootPin[] = [];
    for (const root of this.roots) {
      let pathStat: Stats, canonical: string, targetStat: Stats;
      try {
        pathStat = await this.fs.lstat(root.resolved);
        canonical = await this.fs.realpath(root.resolved);
        targetStat = await this.fs.stat(canonical);
      } catch (error) { throw denied("a grant root is unavailable: " + String(error)); }
      const directory = targetStat.isDirectory();
      if (!directory && !targetStat.isFile()) throw denied("grant roots must be regular files or directories");
      pins.push({ ...root, canonical, pathIdentity: identity(pathStat), targetIdentity: identity(targetStat), directory });
    }
    return pins;
  }

  private async verifyRoots(pins: RootPin[]): Promise<void> {
    for (const pin of pins) {
      let pathStat: Stats, canonical: string, targetStat: Stats;
      try {
        pathStat = await this.fs.lstat(pin.resolved);
        canonical = await this.fs.realpath(pin.resolved);
        targetStat = await this.fs.stat(canonical);
      } catch { throw denied("a grant root changed or became unavailable"); }
      if (canonical !== pin.canonical || !sameIdentity(identity(pathStat), pin.pathIdentity)
          || !sameIdentity(identity(targetStat), pin.targetIdentity)
          || targetStat.isDirectory() !== pin.directory)
        throw denied("a grant root was replaced during the operation");
    }
  }

  private selectRoot(pins: RootPin[], candidate: string, mode: "read" | "write"): RootPin {
    for (const root of pins) {
      if (root.mode !== mode) continue;
      if (candidate === root.resolved || (root.directory && contained(root.resolved, candidate, true))) return root;
    }
    throw denied("path is not an exact granted file or a descendant of a granted directory");
  }

  private async inspectExisting(candidate: string, root: RootPin): Promise<ExistingTarget> {
    let finalStat: Stats, canonical: string, targetStat: Stats;
    try {
      finalStat = await this.fs.lstat(candidate);
      if (finalStat.isSymbolicLink()) throw denied("a symbolic-link final target is not allowed");
      if (!finalStat.isFile()) throw denied("target must be a regular file");
      canonical = await this.fs.realpath(candidate);
      targetStat = await this.fs.stat(canonical);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Capability path denied:")) throw error;
      throw denied("existing target cannot be canonicalized: " + String(error));
    }
    if (!targetStat.isFile() || !sameIdentity(identity(finalStat), identity(targetStat)))
      throw denied("target changed during canonicalization or is not regular");
    if (!canonicalContained(root, canonical)) throw denied("canonical target escapes its grant root");
    return { canonical, identity: identity(targetStat), nlink: targetStat.nlink };
  }

  private async verifyOpen(handle: FileHandle, candidate: string, root: RootPin, roots: RootPin[],
      expected: ExistingTarget, writing: boolean, tool: CallState["tool"]): Promise<void> {
    // No read, truncation, or write precedes these post-open path and descriptor checks.
    const opened = await handle.stat();
    const current = await this.inspectExisting(candidate, root);
    await this.verifyRoots(roots);
    this.assertActive(tool);
    if (!opened.isFile() || !sameIdentity(identity(opened), expected.identity)
        || current.canonical !== expected.canonical || !sameIdentity(current.identity, expected.identity))
      throw denied("target was replaced between authorization and open");
    if (writing && (opened.nlink > 1 || current.nlink > 1))
      throw denied("writing an existing hardlinked file is not allowed");
  }

  private async openExisting(candidate: string, root: RootPin, roots: RootPin[], flags: number,
      writing: boolean, tool: CallState["tool"]): Promise<{ handle: FileHandle; target: ExistingTarget }> {
    const target = await this.inspectExisting(candidate, root);
    if (writing && target.nlink > 1) throw denied("writing an existing hardlinked file is not allowed");
    await this.verifyRoots(roots);
    this.assertActive(tool);
    let handle: FileHandle;
    try {
      // O_NONBLOCK also prevents a replaced FIFO from blocking before the regular-file check.
      handle = await this.fs.open(candidate, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) { throw denied("safe target open failed: " + String(error)); }
    try {
      await this.verifyOpen(handle, candidate, root, roots, target, writing, tool);
      return { handle, target };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const state = this.state("read"), candidate = this.candidate(path);
    if (state.read?.path === candidate) return state.read.content;
    const roots = await this.pinRoots();
    const root = this.selectRoot(roots, candidate, "read");
    const { handle } = await this.openExisting(candidate, root, roots,
      constants.O_RDONLY, false, "read");
    try {
      this.assertActive("read");
      const content = await handle.readFile();
      state.read = { path: candidate, content };
      return content;
    } finally { await handle.close(); }
  }

  /** Detect from the authorized buffer; never use Pi's path-reopening MIME helper. */
  async detectImageMimeType(path: string): Promise<string | null> {
    const buffer = await this.readFile(path);
    const starts = (bytes: number[]) => buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
    const ascii = (offset: number, text: string) => buffer.length >= offset + text.length
      && [...text].every((char, index) => buffer[offset + index] === text.charCodeAt(index));
    const u16 = (offset: number) => (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
    const u32 = (offset: number, little = false) => little
      ? (buffer[offset] ?? 0) + (buffer[offset + 1] ?? 0) * 0x100 + (buffer[offset + 2] ?? 0) * 0x10000
        + (buffer[offset + 3] ?? 0) * 0x1000000
      : (buffer[offset] ?? 0) * 0x1000000 + (buffer[offset + 1] ?? 0) * 0x10000
        + (buffer[offset + 2] ?? 0) * 0x100 + (buffer[offset + 3] ?? 0);
    if (starts([0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? null : "image/jpeg";
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      if (buffer.length < 16 || u32(8) !== 13 || !ascii(12, "IHDR")) return null;
      let offset = 8;
      while (offset + 8 <= buffer.length) {
        const length = u32(offset), type = offset + 4;
        if (ascii(type, "acTL")) return null;
        if (ascii(type, "IDAT")) return "image/png";
        const next = offset + 12 + length;
        if (next <= offset || next > buffer.length) return null;
        offset = next;
      }
      return null;
    }
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
    if (ascii(0, "BM") && buffer.length >= 26) {
      const declared = u32(2, true), pixels = u32(10, true), dib = u32(14, true);
      if ((declared !== 0 && declared < 26) || pixels < 14 + dib || (declared !== 0 && pixels >= declared)) return null;
      const planes = dib === 12 ? u16(22) : dib >= 40 && dib <= 124 ? u16(26) : 0;
      const bits = dib === 12 ? u16(24) : dib >= 40 && dib <= 124 ? u16(28) : 0;
      if (planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits)) return "image/bmp";
    }
    return null;
  }

  private async createParents(candidate: string, root: RootPin, roots: RootPin[], state: CallState): Promise<void> {
    if (!root.directory) throw denied("a new target requires a granted directory");
    const parent = dirname(candidate), suffix = relative(root.resolved, parent);
    if (suffix === "" || suffix === ".") { await this.verifyRoots(roots); return; }
    if (suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix)) throw denied("parent escapes its grant root");
    let current = root.resolved;
    for (const component of suffix.split(sep)) {
      if (!component || component === "." || component === "..") throw denied("unsafe parent component");
      current = resolve(current, component);
      let stat: Stats | undefined;
      try { stat = await this.fs.lstat(current); }
      catch (error) {
        if (!missing(error)) throw denied("parent inspection failed: " + String(error));
        await this.verifyRoots(roots);
        this.assertActive("write");
        try {
          await this.fs.mkdir(current, { mode: 0o777 });
          const createdPath: CreatedPath = { path: current };
          state.createdDirectories.push(createdPath);
          const created = await this.fs.lstat(current);
          if (!created.isDirectory() || created.isSymbolicLink()) throw denied("created parent is not a real directory");
          stat = created;
        } catch (error) {
          if (!existsAlready(error)) throw error;
        }
      }
      if (!stat) {
        try { stat = await this.fs.lstat(current); }
        catch (error) { throw denied("parent disappeared during creation: " + String(error)); }
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw denied("new-file parents must not contain symbolic links");
      let canonical: string;
      try { canonical = await this.fs.realpath(current); }
      catch (error) { throw denied("parent canonicalization failed: " + String(error)); }
      if (!canonicalContained(root, canonical)) throw denied("created parent escapes its grant root");
    }
    await this.verifyRoots(roots);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const state = this.state("write");
    const candidate = this.candidate(path), roots = await this.pinRoots();
    const root = this.selectRoot(roots, candidate, "write");
    let exists = true;
    try { await this.fs.lstat(candidate); }
    catch (error) { if (missing(error)) exists = false; else throw denied("target inspection failed: " + String(error)); }
    if (exists) {
      const { handle } = await this.openExisting(candidate, root, roots, constants.O_WRONLY, true, "write");
      try {
        // Authorization is complete before this effect. Positional I/O ignores a prior read offset.
        this.assertActive("write");
        await writeContents(handle, content);
      } finally { await handle.close(); }
      return;
    }

    await this.createParents(candidate, root, roots, state);
    let handle: FileHandle;
    try {
      handle = await this.fs.open(candidate,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
    } catch (error) { throw denied("safe new-file open failed: " + String(error)); }
    try {
      const createdPath: CreatedPath = { path: candidate };
      state.createdFiles.push(createdPath);
      const opened = await handle.stat();
      const target: ExistingTarget = { canonical: await this.fs.realpath(candidate), identity: identity(opened), nlink: opened.nlink };
      await this.verifyOpen(handle, candidate, root, roots, target, true, "write");
      this.assertActive("write");
      await writeContents(handle, content);
    } finally { await handle.close(); }
  }

  async editReadFile(path: string): Promise<Buffer> {
    const state = this.state("edit");
    if (state.edit) throw denied("edit attempted to read more than one target");
    const candidate = this.candidate(path), roots = await this.pinRoots();
    const root = this.selectRoot(roots, candidate, "read");
    const writeRoot = this.selectRoot(roots, candidate, "write");
    // Edit needs both grants, but only the whitelisted edit tool name is required at the tool gate.
    const writeTarget = await this.inspectExisting(candidate, writeRoot);
    const { handle, target } = await this.openExisting(candidate, root, roots, constants.O_RDWR, true, "edit");
    if (!sameIdentity(writeTarget.identity, target.identity)) {
      await handle.close().catch(() => undefined);
      throw denied("edit read/write grant targets changed during authorization");
    }
    try {
      this.assertActive("edit");
      const content = await handle.readFile();
      state.edit = { path: candidate, handle, roots, root, target };
      return content;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async editWriteFile(path: string, content: string): Promise<void> {
    const state = this.state("edit"), edit = state.edit;
    if (!edit || this.candidate(path) !== edit.path) throw denied("edit write does not match its verified read target");
    // Recheck the same descriptor and every root immediately before the first modifying operation.
    await this.verifyOpen(edit.handle, edit.path, edit.root, edit.roots, edit.target, true, "edit");
    this.assertActive("edit");
    await writeContents(edit.handle, content);
  }

  /** Pi calls access before readFile; readFile performs the sole open and all filesystem authorization. */
  access(path: string): void { this.state("read"); this.candidate(path); }
  /** Edit performs its combined read/write authorization when it opens the sole descriptor. */
  editAccess(path: string): void { this.state("edit"); this.candidate(path); }
  /** Parent creation is coordinated by writeFile so a denied mkdir preflight cannot leave effects. */
  prepareWriteDirectory(path: string): void { this.state("write"); this.candidate(path); }

  private async closeEdit(state: CallState): Promise<void> {
    const edit = state.edit;
    state.edit = undefined;
    if (edit) await edit.handle.close().catch(() => undefined);
  }

  private async cleanup(state: CallState): Promise<unknown> {
    const paths = [...state.createdFiles, ...state.createdDirectories].map(created => created.path);
    if (!paths.length) return undefined;
    // Node/POSIX has no atomic compare-identity-and-delete operation. Preserve every pathname
    // rather than risking another writer's replacement between an identity check and deletion.
    return new Error("Automatic cleanup is unavailable; created paths were preserved: " + paths.join(", "));
  }
}

type BuiltinDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type Factory = (cwd: string, options: { operations: unknown }) => BuiltinDefinition;

/** Preserve Pi's schemas/results, replacing only its narrow operations and adding per-call cleanup. */
export function capabilityPathToolDefinitions(cwd: string, runtime: CapabilityPathRuntime,
    options: Options = {}): BuiltinDefinition[] {
  const coordinator = new CapabilityPathCoordinator(cwd, runtime, options);
  const definitions: BuiltinDefinition[] = [];
  const wrap = (definition: BuiltinDefinition, tool: "read" | "write" | "edit"): BuiltinDefinition => {
    const execute = definition.execute;
    return { ...definition, execute: function (...args: Parameters<typeof execute>) {
      return coordinator.invoke(tool, args[1], () => execute.apply(this, args));
    } };
  };
  if (runtime.allowsTool("read")) {
    const definition = (createReadToolDefinition as unknown as Factory)(resolve(cwd), { operations: {
      access: async (path: string) => { coordinator.access(path); },
      detectImageMimeType: (path: string) => coordinator.detectImageMimeType(path),
      readFile: (path: string) => coordinator.readFile(path),
    } });
    definitions.push(wrap(definition, "read"));
  }
  if (runtime.allowsTool("write")) {
    const definition = (createWriteToolDefinition as unknown as Factory)(resolve(cwd), { operations: {
      mkdir: async (path: string) => { coordinator.prepareWriteDirectory(path); },
      writeFile: (path: string, content: string) => coordinator.writeFile(path, content),
    } });
    definitions.push(wrap(definition, "write"));
  }
  if (runtime.allowsTool("edit")) {
    const definition = (createEditToolDefinition as unknown as Factory)(resolve(cwd), { operations: {
      access: async (path: string) => { coordinator.editAccess(path); },
      readFile: (path: string) => coordinator.editReadFile(path),
      writeFile: (path: string, content: string) => coordinator.editWriteFile(path, content),
    } });
    definitions.push(wrap(definition, "edit"));
  }
  return definitions;
}

export function registerCapabilityPathTools(pi: Pick<ExtensionAPI, "registerTool">, cwd: string,
    runtime: CapabilityPathRuntime, options: Options = {}): void {
  for (const definition of capabilityPathToolDefinitions(cwd, runtime, options)) pi.registerTool(definition);
}
