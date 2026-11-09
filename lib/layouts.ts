export const LAYOUT_VERSION = 1;
export const MAX_LAYOUT_DEPTH = 16;
export const MAX_LAYOUT_PANES = 32;
export const MAX_LAYOUT_NAME_LENGTH = 64;

export type LayoutDirection = "row" | "column";
export type LayoutOrigin = "built-in" | "user";

export interface TerminalLeaf {
  type: "terminal";
  title: string;
  command?: string[];
  shell?: string;
  cwd?: string;
  keepOpen?: boolean;
  focus?: boolean;
  role?: "pi";
  source?: "current";
}
export interface LayoutSplit {
  type: "split";
  direction: LayoutDirection;
  ratio: number;
  before: LayoutNode;
  after: LayoutNode;
}
export type LayoutNode = TerminalLeaf | LayoutSplit;
export interface LayoutSpec {
  version: 1;
  root: LayoutNode;
}
export interface Layout extends LayoutSpec {
  name: string;
  origin: LayoutOrigin;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(path + " must be an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(path + " contains unsupported field " + JSON.stringify(key));
}
function text(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum
      || /[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw new Error(path + " must be a valid nonempty string of at most " + maximum + " characters");
  return value;
}
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(path + " must be boolean");
  return value;
}
export function parseLayoutName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value) || value.endsWith("-"))
    throw new Error("Layout name must be 1-64 lowercase letters, digits, or interior hyphens and start with a letter");
  return value;
}
function parseCommand(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128)
    throw new Error(path + " must contain 1-128 argv entries");
  const command = value.map((entry, index) => text(entry, path + "[" + index + "]", 4096, index > 0));
  if (command.reduce((size, entry) => size + entry.length, 0) > 32768)
    throw new Error(path + " exceeds total argv limit");
  return command;
}
function parseTerminal(value: Record<string, unknown>, path: string): TerminalLeaf {
  fields(value, ["type", "title", "command", "shell", "cwd", "keepOpen", "focus", "role", "source"], path);
  if (value.type !== "terminal") throw new Error(path + ".type must be terminal");
  const role = value.role === undefined ? undefined : value.role === "pi" ? "pi" as const : (() => {
    throw new Error(path + ".role must be pi");
  })();
  const source = value.source === undefined ? undefined : value.source === "current" ? "current" as const : (() => {
    throw new Error(path + ".source must be current");
  })();
  if ((role === undefined) !== (source === undefined))
    throw new Error(path + " must specify role=pi and source=current together");
  const result: TerminalLeaf = {
    type: "terminal",
    title: text(value.title, path + ".title", 120),
  };
  if (value.command !== undefined) result.command = parseCommand(value.command, path + ".command");
  if (value.shell !== undefined) result.shell = text(value.shell, path + ".shell", 4096);
  if (result.command && result.shell) throw new Error(path + " cannot specify both command and shell");
  if (value.cwd !== undefined) result.cwd = text(value.cwd, path + ".cwd", 4096);
  const keepOpen = optionalBoolean(value.keepOpen, path + ".keepOpen");
  const focus = optionalBoolean(value.focus, path + ".focus");
  if (keepOpen !== undefined) result.keepOpen = keepOpen;
  if (focus !== undefined) result.focus = focus;
  if (role) { result.role = role; result.source = source; }
  if (role && (result.command || result.shell || result.cwd || result.keepOpen !== undefined))
    throw new Error(path + " reuses the current Pi and cannot override command, shell, cwd, or keepOpen");
  return result;
}
function parseNode(value: unknown, path: string, state: { panes: number; pi: number; focus: number }, depth: number): LayoutNode {
  if (depth > MAX_LAYOUT_DEPTH) throw new Error("Layout exceeds maximum depth " + MAX_LAYOUT_DEPTH);
  const input = object(value, path);
  if (input.type === "terminal") {
    state.panes++;
    if (state.panes > MAX_LAYOUT_PANES) throw new Error("Layout exceeds maximum pane count " + MAX_LAYOUT_PANES);
    const terminal = parseTerminal(input, path);
    if (terminal.role === "pi") state.pi++;
    if (terminal.focus) state.focus++;
    return terminal;
  }
  if (input.type !== "split") throw new Error(path + ".type must be split or terminal");
  fields(input, ["type", "direction", "ratio", "before", "after"], path);
  if (input.direction !== "row" && input.direction !== "column")
    throw new Error(path + ".direction must be row or column");
  const ratio = input.ratio === undefined ? 0.5 : input.ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)
    throw new Error(path + ".ratio must be greater than 0 and less than 1");
  return {
    type: "split", direction: input.direction, ratio,
    before: parseNode(input.before, path + ".before", state, depth + 1),
    after: parseNode(input.after, path + ".after", state, depth + 1),
  };
}
export function parseLayoutSpec(value: unknown): LayoutSpec {
  const input = object(value, "Layout");
  fields(input, ["version", "root"], "Layout");
  if (input.version !== LAYOUT_VERSION) throw new Error("Layout version must be 1");
  const state = { panes: 0, pi: 0, focus: 0 };
  const root = parseNode(input.root, "Layout.root", state, 1);
  if (state.pi > 1) throw new Error("Layout can contain at most one current-Pi pane");
  if (state.focus > 1) throw new Error("Layout can contain at most one focused pane");
  return { version: LAYOUT_VERSION, root };
}
export function layoutTerminals(root: LayoutNode): TerminalLeaf[] {
  return root.type === "terminal" ? [root] : [...layoutTerminals(root.before), ...layoutTerminals(root.after)];
}
export function parseLayout(value: unknown): Layout {
  const input = object(value, "Layout");
  const name = parseLayoutName(input.name);
  const origin = input.origin;
  if (origin !== "built-in" && origin !== "user") throw new Error("Layout origin must be built-in or user");
  const spec = parseLayoutSpec({ version: input.version, root: input.root });
  return { name, origin, ...spec };
}
function freezeNode(node: LayoutNode): LayoutNode {
  if (node.type === "split") {
    freezeNode(node.before); freezeNode(node.after);
  } else if (node.command) Object.freeze(node.command);
  return Object.freeze(node);
}
function builtIn(name: string, root: LayoutNode): Layout {
  return Object.freeze({ name, origin: "built-in" as const, version: LAYOUT_VERSION, root: freezeNode(root) });
}
const BUILD = builtIn("build", {
  type: "split", direction: "row", ratio: 0.5,
  before: { type: "terminal", title: "Pi", role: "pi", source: "current", focus: true },
  after: {
    type: "split", direction: "column", ratio: 0.65,
    before: { type: "terminal", title: "Editor shell" },
    after: { type: "terminal", title: "Shell" },
  },
});
const INSPECT = builtIn("inspect", {
  type: "split", direction: "row", ratio: 0.5,
  before: { type: "terminal", title: "Pi", role: "pi", source: "current", focus: true },
  after: { type: "terminal", title: "Review shell" },
});
const OBSERVE = builtIn("observe", {
  type: "split", direction: "row", ratio: 0.5,
  before: {
    type: "split", direction: "column", ratio: 0.65,
    before: { type: "terminal", title: "Pi", role: "pi", source: "current", focus: true },
    after: { type: "terminal", title: "Shell" },
  },
  after: { type: "terminal", title: "Monitor shell" },
});
const BUILT_INS: readonly Layout[] = Object.freeze([BUILD, INSPECT, OBSERVE]);
export function builtInLayouts(): Layout[] {
  return BUILT_INS.map(layout => parseLayout(layout));
}
export function builtInLayout(name: string): Layout | undefined {
  const found = BUILT_INS.find(layout => layout.name === name);
  return found ? parseLayout(found) : undefined;
}
