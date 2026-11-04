import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sessionName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120
      || value.trim().startsWith("-") || /[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw new Error("sessionName must be 1–120 characters, without control characters or a leading dash");
  return value.trim();
}
export function canonicalName(value: string): string { return value.trim().normalize("NFC").toLowerCase(); }
export class SessionExistsError extends Error {
  constructor() { super("A matching Rex session already exists; use rex_open_session to reuse it or choose a different name"); }
}
/** Cooperative local create reservation. Never steals or expires an uncertain writer's claim. */
export class SessionClaim {
  readonly path: string;
  private readonly token = randomUUID();
  constructor(directory: string, instanceId: string, name: string) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || realpathSync(directory) !== directory || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Session reservations require a private pi-rex state directory");
    const key = createHash("sha256").update(instanceId + "\0" + canonicalName(name)).digest("hex");
    this.path = join(directory, "session-" + key + ".claim.json");
    try {
      writeFileSync(this.path, JSON.stringify({ version: 1, instanceId, name, token: this.token, pid: process.pid }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Named-session creation is in progress or uncertain. Inspect Rex before another create; reservation retained at " + this.path);
      throw error;
    }
  }
  release(): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 2048 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return false;
      const value = JSON.parse(readFileSync(fd, "utf8"));
      if (value.token !== this.token) return false;
      unlinkSync(this.path);
      return true;
    } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  }
}
