import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export function executable(value: string, cwd: string, path = process.env.PATH ?? ""): string {
  if (!value || value.includes("\0") || /[\r\n]/.test(value)) throw new Error("Invalid executable");
  const candidates = value.includes("/") ? [isAbsolute(value) ? value : resolve(cwd, value)]
    : path.split(delimiter).map(dir => resolve(cwd, dir || ".", value));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* try the next PATH entry */ }
  }
  throw new Error("Executable not found or not executable: " + value);
}
