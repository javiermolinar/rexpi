import { record } from "./state.ts";
import { validateTerminal, type Command, type TerminalOptions } from "./terminal.ts";

export interface ConfiguredCommand extends Omit<TerminalOptions, "command"> {
  run: Command;
  acceptArgs: boolean;
  description: string;
}
// Pi 1.5 interactive built-ins are intentionally absent from pi.getCommands().
const BUILTINS = new Set(["settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug",
  "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact",
  "resume", "reload", "quit", "skill", "template"]);
const FIELDS = new Set(["run", "acceptArgs", "description", "placement", "cwd", "title", "focus", "keepOpen", "bounds", "disabled"]);

export function configuredCommands(settings: unknown, reserved: Iterable<string>, warn: (message: string) => void): Map<string, ConfiguredCommand> {
  const result = new Map<string, ConfiguredCommand>();
  let entries: Record<string, unknown>;
  try {
    const section = record(settings)["pi-rex"];
    if (section === undefined) return result;
    const commands = record(section).commands;
    if (commands === undefined) return result;
    entries = record(commands);
  } catch { warn("pi-rex.commands must be an object"); return result; }
  const occupied = new Set([...BUILTINS, ...[...reserved].map(name => name.split(":")[0].toLowerCase())]);
  const values = Object.entries(entries);
  if (values.length > 64) warn("pi-rex.commands is limited to 64 entries");
  for (const [name, input] of values.slice(0, 64)) {
    try {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error("invalid command name");
      const value = typeof input === "string" || Array.isArray(input) ? { run: input } : record(input);
      if (value.disabled === true) continue;
      if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error("disabled must be boolean");
      if (occupied.has(name)) throw new Error("name is already reserved by Pi or another registered command");
      if (Object.keys(value).some(key => !FIELDS.has(key))) throw new Error("unknown configuration field");
      if (value.acceptArgs !== undefined && typeof value.acceptArgs !== "boolean") throw new Error("acceptArgs must be boolean");
      if (value.description !== undefined && (typeof value.description !== "string" || !value.description.trim()
          || value.description.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value.description))) throw new Error("invalid description");
      const { run, acceptArgs, description, disabled: _disabled, ...options } = value;
      const normalized = { ...options, command: run } as TerminalOptions;
      validateTerminal(normalized);
      result.set(name, { ...options, run: Array.isArray(run) ? [...run] : run,
        acceptArgs: acceptArgs === true, description: description as string | undefined ?? "Open /" + name + " in Rex" } as ConfiguredCommand);
    } catch (error) {
      warn("Skipping pi-rex.commands." + JSON.stringify(name.slice(0, 32)) + ": " + (error instanceof Error ? error.message : "invalid configuration"));
    }
  }
  return result;
}
/** Shell-like word/quote parsing only: no variable, tilde, glob or command expansion. */
export function argumentWords(raw: string): string[] {
  if (raw.length > 8192 || raw.includes("\0")) throw new Error("Command arguments are too long or invalid");
  const words: string[] = [];
  let word = "", started = false, quote = "", escaped = false;
  for (const char of raw) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = ""; else word += char;
      started = true; continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error("Unclosed quote or trailing escape in command arguments");
  if (started) words.push(word);
  if (words.length > 128) throw new Error("Too many command arguments");
  return words;
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function configuredInvocation(name: string, spec: ConfiguredCommand, raw: string): TerminalOptions {
  const trimmed = raw.trim();
  if (trimmed && !spec.acceptArgs) throw new Error("Usage: /" + name + " (arguments are disabled)");
  const args = argumentWords(trimmed);
  const { run, acceptArgs: _acceptArgs, description: _description, ...options } = spec;
  const command = Array.isArray(run) ? [...run, ...args] : run + (args.length ? " " + args.map(shellQuote).join(" ") : "");
  const invocation = { ...options, command, title: options.title ?? name };
  validateTerminal(invocation);
  return invocation;
}
