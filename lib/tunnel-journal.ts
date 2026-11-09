import { createHash, randomUUID } from "node:crypto";
import { link, open, lstat, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TunnelJournal, TunnelJournalRecord } from "./ssh-transport.ts";

/** Private, atomic per-attempt files. Construction performs no I/O. */
export class NodeTunnelJournal implements TunnelJournal {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  private async ready(): Promise<void> {
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) {
      if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    const stats = await lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || (stats.mode & 0o022) || (process.getuid && stats.uid !== process.getuid()))
      throw new Error("Unsafe tunnel journal directory");
  }

  private path(hostId: string, attemptId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw new Error("Invalid tunnel attempt identity");
    const host = createHash("sha256").update(hostId).digest("hex");
    return join(this.directory, host + "-" + attemptId + ".json");
  }

  private async write(record: TunnelJournalRecord, replace: boolean): Promise<void> {
    await this.ready();
    const destination = this.path(record.hostId, record.attemptId);
    const temporary = join(this.directory, ".tmp-" + randomUUID());
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try {
      if (replace) await rename(temporary, destination);
      else {
        await link(temporary, destination); // Atomic no-replace creation.
        await unlink(temporary);
      }
    } catch (error) {
      try { await unlink(temporary); } catch { /* Preserve the journal failure. */ }
      throw error;
    }
  }

  create(record: TunnelJournalRecord): Promise<void> { return this.write(record, false); }
  update(record: TunnelJournalRecord): Promise<void> { return this.write(record, true); }

  async read(hostId: string): Promise<TunnelJournalRecord[]> {
    await this.ready();
    const prefix = createHash("sha256").update(hostId).digest("hex") + "-";
    const names = (await readdir(this.directory)).filter(name => name.startsWith(prefix) && name.endsWith(".json"));
    if (names.length > 8) throw new Error("Too many tunnel journal records");
    const records: TunnelJournalRecord[] = [];
    for (const name of names.sort()) {
      const path = join(this.directory, name), stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 64 * 1024
          || (stats.mode & 0o077) || (process.getuid && stats.uid !== process.getuid()))
        throw new Error("Unsafe tunnel journal record");
      records.push(JSON.parse(await readFile(path, "utf8")) as TunnelJournalRecord);
    }
    return records;
  }

  async remove(record: TunnelJournalRecord): Promise<void> {
    await this.ready();
    try { await unlink(this.path(record.hostId, record.attemptId)); }
    catch (error) {
      if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "ENOENT") throw error;
    }
  }
}
