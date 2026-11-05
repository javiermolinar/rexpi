import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { isLive, parseBinding, sameIdentity, uuid, type Binding, type Identity, type Server } from "./state.ts";

const FILE = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json$/;
/** Local expiring evidence, not authorization or a cross-machine registry. */
export class BindingStore {
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
        throw new Error("Rexpi state directory must contain no symlinks or non-directories");
    }
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || realpathSync(this.directory) !== this.directory
        || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Rexpi state directory must be private, owned by you, and contain no symlinks");
  }
  private path(conversationId: string, token: string): string {
    if (!uuid(conversationId) || !uuid(token)) throw new Error("Invalid binding file identity");
    return join(this.directory, conversationId + "." + token + ".json");
  }
  private readFile(path: string): Binding | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) !== 0
          || info.uid !== process.getuid?.()) return;
      return parseBinding(JSON.parse(readFileSync(fd, "utf8")));
    } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
  }
  all(): Binding[] {
    this.ensure();
    const names = readdirSync(this.directory).filter(name => FILE.test(name));
    if (names.length > 1024) throw new Error("Too many Rexpi binding files; inspect the state directory");
    return names.flatMap(name => {
      const value = this.readFile(join(this.directory, name));
      return value && name === value.conversationId + "." + value.token + ".json" ? [value] : [];
    });
  }
  write(binding: Binding): void {
    this.ensure();
    const value = parseBinding(binding);
    const destination = this.path(value.conversationId, value.token);
    const temporary = join(this.directory, randomUUID() + ".tmp");
    let created = false;
    try {
      writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      created = true;
      renameSync(temporary, destination);
    } finally {
      if (created) {
        try { unlinkSync(temporary); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  own(conversationId: string, token: string): Binding | undefined {
    this.ensure();
    return this.readFile(this.path(conversationId, token));
  }
  find(expected: Identity, server: Server): Binding | undefined {
    const live = this.all().filter(b => isLive(b, server));
    const matches = live.filter(b => sameIdentity(b, expected));
    if (matches.length > 1) throw new Error("Conversation is active in multiple Rex panes; refusing an ambiguous target");
    const match = matches[0];
    if (match && live.filter(b => b.blockId === match.blockId).length !== 1)
      throw new Error("Rex pane has competing live conversation bindings");
    return match;
  }
  remove(conversationId: string, token: string): void {
    if (!existsSync(this.directory)) return;
    this.ensure();
    const path = this.path(conversationId, token);
    const value = this.readFile(path);
    if (value?.token !== token) return;
    unlinkSync(path);
  }
}
