import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalAgentName, generateAgentName, parseAgentName } from "./agent-name.ts";
import { identity as parseIdentity, record, sameIdentity, type Identity } from "./state.ts";
import type { BindingStore } from "./store.ts";

export interface AgentNameRecord extends Identity {
  version: 1;
  name: string;
}
const FILE = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){1,3}\.json$/;
const FIELDS = ["version", "taskId", "conversationId", "piSessionId", "role", "name"];

function parseNameRecord(value: unknown): AgentNameRecord {
  const input = record(value);
  if (Object.keys(input).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(input, field))
      || input.version !== 1) throw new Error("Invalid agent name record");
  return { version: 1, ...parseIdentity(input), name: parseAgentName(input.name) };
}

/** Persistent local aliases. Name files are retained after leases end, so aliases are never reused. */
export class AgentNameStore {
  readonly directory: string;
  private readonly bindings: BindingStore;
  private readonly generate: () => string;
  constructor(bindings: BindingStore, generate = generateAgentName) {
    this.bindings = bindings;
    this.directory = join(bindings.directory, "names");
    this.generate = generate;
  }
  private ensure(): void {
    // BindingStore pins the private parent and rejects symlink ancestors.
    this.bindings.all();
    try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(this.directory) !== this.directory
        || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Rexpi agent-name directory must be private and owned by you");
  }
  private read(path: string): AgentNameRecord | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) !== 0
          || info.uid !== process.getuid?.()) return;
      return parseNameRecord(JSON.parse(readFileSync(fd, "utf8")));
    } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
  }
  all(): AgentNameRecord[] {
    this.ensure();
    const names = readdirSync(this.directory).filter(name => FILE.test(name));
    if (names.length > 4096) throw new Error("Too many retained Rexpi agent names");
    return names.flatMap(filename => {
      const value = this.read(join(this.directory, filename));
      return value && filename === value.name + ".json" ? [value] : [];
    });
  }
  find(identity: Identity): AgentNameRecord | undefined {
    const matches = this.all().filter(value => value.conversationId === identity.conversationId);
    if (matches.length > 1) throw new Error("Conversation has multiple retained agent names");
    if (matches[0] && !sameIdentity(matches[0], identity))
      throw new Error("Retained agent name belongs to a different conversation identity");
    return matches[0];
  }
  assign(identity: Identity): string {
    const existing = this.find(identity);
    if (existing) return existing.name;
    for (let attempt = 0; attempt < 128; attempt++) {
      const name = parseAgentName(this.generate());
      const value: AgentNameRecord = { version: 1, ...parseIdentity(identity), name };
      try {
        writeFileSync(join(this.directory, name + ".json"), JSON.stringify(value), { flag: "wx", mode: 0o600 });
        return name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Could not allocate a unique agent name");
  }
  resolve(name: string): AgentNameRecord {
    const canonical = canonicalAgentName(name);
    const matches = this.all().filter(value => value.name === canonical);
    if (matches.length !== 1) throw new Error("Unknown or ambiguous agent name: " + canonical);
    return matches[0];
  }
}
