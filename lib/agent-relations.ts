import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { parseAgentHandle } from "./agent.ts";
import { identity as parseIdentity, piSessionId, record, rexId, uuid } from "./state.ts";
import type { AgentLaunchRelation } from "./launch.ts";

const FILE = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json$/;
const FIELDS = ["handle", "endpointGeneration", "origin", "identity", "childBlockId", "childPid", "childBindingId",
  "serverInstance", "hostId", "parentBlockId", "parentGeneration", "parentBindingId", "parentName"] as const;

export function parseAgentLaunchRelation(input: unknown): AgentLaunchRelation {
  const value = record(input);
  if (Object.keys(value).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(value, field)))
    throw new Error("Invalid agent launch relation fields");
  const handle = parseAgentHandle(value.handle);
  if (value.endpointGeneration !== handle.endpointGeneration || !rexId(value.childBlockId, "block")
      || !rexId(value.parentBlockId, "block") || !uuid(value.serverInstance) || !uuid(value.hostId)
      || !Number.isSafeInteger(value.childPid) || Number(value.childPid) <= 0
      || typeof value.childBindingId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.childBindingId)
      || !Number.isSafeInteger(value.parentGeneration) || Number(value.parentGeneration) < 0
      || typeof value.parentBindingId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.parentBindingId)
      || !piSessionId(value.parentName)) throw new Error("Invalid agent launch relation fence");
  return Object.freeze({ handle, endpointGeneration: handle.endpointGeneration,
    origin: parseIdentity(value.origin), identity: parseIdentity(value.identity), childBlockId: value.childBlockId,
    childPid: Number(value.childPid), childBindingId: value.childBindingId, serverInstance: value.serverInstance, hostId: value.hostId,
    parentBlockId: value.parentBlockId, parentGeneration: Number(value.parentGeneration), parentBindingId: value.parentBindingId,
    parentName: value.parentName });
}

/** Local, nonsensitive launch history. It is evidence for revalidation, never a live registry. */
export class AgentRelationStore {
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
        throw new Error("Rexpi relation directory must contain no symlinks or non-directories");
    }
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || realpathSync(this.directory) !== this.directory
        || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Rexpi relation directory must be private, owned by you, and contain no symlinks");
  }
  private path(handle: AgentLaunchRelation["handle"]): string {
    return join(this.directory, handle.conversationId + "." + handle.runId + ".json");
  }
  private read(path: string): AgentLaunchRelation | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) !== 0
          || info.uid !== process.getuid?.()) return;
      return parseAgentLaunchRelation(JSON.parse(readFileSync(fd, "utf8")));
    } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
  }
  all(): AgentLaunchRelation[] {
    this.ensure();
    const names = readdirSync(this.directory).filter(name => FILE.test(name));
    if (names.length > 1024) throw new Error("Too many Rexpi agent relation records; inspect the state directory");
    return names.flatMap(name => {
      const value = this.read(join(this.directory, name));
      return value && name === value.handle.conversationId + "." + value.handle.runId + ".json" ? [value] : [];
    });
  }
  write(relation: AgentLaunchRelation): void {
    this.ensure();
    const value = parseAgentLaunchRelation(relation), destination = this.path(value.handle);
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
}
