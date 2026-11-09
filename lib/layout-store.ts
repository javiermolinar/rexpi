import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { builtInLayout, builtInLayouts, parseLayoutName, parseLayoutSpec,
  type Layout, type LayoutSpec } from "./layouts.ts";

const FILE = /^[a-z][a-z0-9-]{0,63}\.json$/;
const MAX_USER_LAYOUTS = 128;
const MAX_LAYOUT_BYTES = 256 * 1024;

/** Private, atomic layout definitions. No Rex or process execution belongs here. */
export class LayoutStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private ensure(): void {
    let current = parse(this.directory).root;
    for (const segment of this.directory.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      try { lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(current, { mode: 0o700 });
      }
      const ancestor = lstatSync(current);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
        throw new Error("Layout directory must contain no symlinks or non-directories");
    }
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || realpathSync(this.directory) !== this.directory
        || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Layout directory must be private, owned by you, and contain no symlinks");
  }
  private path(name: string): string { return join(this.directory, parseLayoutName(name) + ".json"); }
  private readFile(path: string, expectedName: string): Layout {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_LAYOUT_BYTES
          || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
        throw new Error("Layout files must be private regular files owned by you");
      const input = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)
          || (input as Record<string, unknown>).name !== expectedName)
        throw new Error("Layout filename and stored name differ");
      const { name: _name, ...storedSpec } = input as Record<string, unknown>;
      return { name: expectedName, origin: "user", ...parseLayoutSpec(storedSpec) };
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private userNames(): string[] {
    this.ensure();
    const names = readdirSync(this.directory).filter(name => FILE.test(name));
    if (names.length > MAX_USER_LAYOUTS) throw new Error("Too many user layout files");
    return names.map(name => name.slice(0, -5)).sort();
  }
  list(): Layout[] {
    const users = this.userNames().map(name => this.readFile(this.path(name), name));
    const builtIns = builtInLayouts();
    const names = new Set(users.map(layout => layout.name));
    for (const layout of builtIns) if (names.has(layout.name))
      throw new Error("User layout collides with built-in " + layout.name);
    return [...builtIns, ...users];
  }
  get(name: string): Layout {
    const normalized = parseLayoutName(name);
    const builtIn = builtInLayout(normalized);
    if (builtIn) return builtIn;
    this.ensure();
    return this.readFile(this.path(normalized), normalized);
  }
  save(name: string, value: LayoutSpec, options: { overwrite?: boolean } = {}): Layout {
    const normalized = parseLayoutName(name);
    if (builtInLayout(normalized)) throw new Error("Cannot overwrite built-in layout " + normalized);
    if (options.overwrite !== undefined && typeof options.overwrite !== "boolean")
      throw new Error("overwrite must be boolean");
    const spec = parseLayoutSpec(value);
    const serialized = JSON.stringify({ name: normalized, ...spec });
    if (Buffer.byteLength(serialized, "utf8") > MAX_LAYOUT_BYTES) throw new Error("Layout exceeds storage byte limit");
    this.ensure();
    const names = this.userNames();
    const exists = names.includes(normalized);
    if (exists && options.overwrite !== true) throw new Error("Layout already exists: " + normalized);
    if (!exists && names.length >= MAX_USER_LAYOUTS) throw new Error("User layout limit reached");
    const destination = this.path(normalized);
    if (exists) this.readFile(destination, normalized);
    const temporary = join(this.directory, randomUUID() + ".tmp");
    let created = false;
    try {
      writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
      created = true;
      // Link publishes without replacing a concurrently-created layout. Explicit overwrite uses rename.
      if (options.overwrite === true) renameSync(temporary, destination);
      else linkSync(temporary, destination);
    } finally {
      if (created) {
        try { unlinkSync(temporary); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return { name: normalized, origin: "user", ...spec };
  }
  remove(name: string): Layout {
    const normalized = parseLayoutName(name);
    if (builtInLayout(normalized)) throw new Error("Cannot delete built-in layout " + normalized);
    this.ensure();
    const existing = this.readFile(this.path(normalized), normalized);
    unlinkSync(this.path(normalized));
    return existing;
  }
}
