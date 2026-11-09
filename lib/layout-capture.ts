import type { Rex } from "./rex.ts";
import { rexId, uuid } from "./state.ts";
import { parseLayoutSpec, type LayoutNode, type LayoutSpec, type TerminalLeaf } from "./layouts.ts";

export interface CapturedLayout {
  spec: LayoutSpec;
  windowLabel: string;
  /** Titles for which Rex supplied no reusable declared launch configuration. */
  shellFallbacks: string[];
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(path + " must be an object");
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(path + " must be an array");
  return value;
}
function blockId(value: unknown): string {
  if (typeof value !== "string" || !rexId(value, "block")) throw new Error("Rex layout contains an invalid block ID");
  return value;
}
function validRect(value: unknown): void {
  const rect = array(value, "Rex layout rect");
  if (rect.length !== 4 || rect.some(part => typeof part !== "number" || !Number.isFinite(part)
      || part < 0 || part > 1) || (rect[2] as number) <= 0 || (rect[3] as number) <= 0)
    throw new Error("Rex layout contains invalid geometry");
}
function declaredTerminal(block: Record<string, unknown>, title: string, currentPi: boolean): {
  leaf: TerminalLeaf; fallback: boolean;
} {
  const leaf: TerminalLeaf = currentPi
    ? { type: "terminal", title, role: "pi", source: "current" }
    : { type: "terminal", title };
  if (currentPi) return { leaf, fallback: false };
  const options = block.options === undefined ? undefined : object(block.options, "Rex terminal options");
  // Current session.view versions expose no options. Only reuse an explicit direct-argv declaration;
  // foreground processes, scrollback, shell state, and terminal contents are never inspected.
  if (options && Array.isArray(options.command) && options.shell === "none") {
    leaf.command = options.command.map((part, index) => {
      if (typeof part !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(part))
        throw new Error("Rex declared command contains an invalid argv entry at " + index);
      return part;
    });
    if (typeof options.cwd === "string") leaf.cwd = options.cwd;
    const exit = options.exit === undefined ? undefined : object(options.exit, "Rex terminal exit options");
    if (exit && typeof exit.on_completion === "boolean") leaf.keepOpen = !exit.on_completion;
    return { leaf, fallback: false };
  }
  return { leaf, fallback: true };
}
export function captureRexWindow(value: unknown, currentBlockId: string): CapturedLayout {
  const current = blockId(currentBlockId);
  const view = object(value, "Rex session view");
  const activeId = view.active_window_id;
  if (typeof activeId !== "string" || !rexId(activeId, "window")) throw new Error("Rex session has no valid active window");
  const windows = array(view.windows, "Rex session windows").map(raw => object(raw, "Rex window"));
  const matches = windows.filter(window => window.window_id === activeId);
  if (matches.length !== 1) throw new Error("Rex active window is missing or ambiguous");
  const window = matches[0];
  const layers = array(window.layers, "Rex window layers").map(raw => object(raw, "Rex layer"));
  if (layers.length !== 1 || layers[0].kind !== "tiled")
    throw new Error("Cannot capture a window with floating, missing, or multiple layers");
  const layer = layers[0];
  const blocks = new Map<string, Record<string, unknown>>();
  for (const raw of array(layer.blocks, "Rex layer blocks")) {
    const block = object(raw, "Rex block"), id = blockId(block.block_id);
    if (blocks.has(id)) throw new Error("Rex layer contains duplicate blocks");
    if (block.creator_name !== "com.superlogical.terminal" || block.flavor !== "com.superlogical.terminal.shell")
      throw new Error("Cannot capture nonterminal block " + id);
    blocks.set(id, block);
  }
  const focused = window.focused_block_id === undefined ? undefined : blockId(window.focused_block_id);
  if (focused && !blocks.has(focused)) throw new Error("Rex focused block is absent from the tiled layout");
  const seen = new Set<string>(), shellFallbacks: string[] = [];
  const convert = (raw: unknown): LayoutNode => {
    const node = object(raw, "Rex layout node");
    validRect(node.rect);
    const hasBlock = node.block_id !== undefined, hasSplit = node.split !== undefined;
    if (hasBlock === hasSplit) throw new Error("Rex layout node must contain exactly one block or split");
    if (hasBlock) {
      const id = blockId(node.block_id), block = blocks.get(id);
      if (!block) throw new Error("Rex layout references an unknown block");
      if (seen.has(id)) throw new Error("Rex layout contains a duplicate block reference");
      seen.add(id);
      const title = typeof block.label === "string" && block.label.trim() ? block.label : "Terminal";
      const declared = declaredTerminal(block, title, id === current);
      if (id === focused) declared.leaf.focus = true;
      if (declared.fallback) shellFallbacks.push(title);
      return declared.leaf;
    }
    const split = object(node.split, "Rex split");
    if (typeof split.split_id !== "string" || !split.split_id.startsWith("split:")
        || !uuid(split.split_id.slice(6)))
      throw new Error("Rex split has an invalid identity");
    if (split.direction !== "horizontal" && split.direction !== "vertical")
      throw new Error("Rex split direction is unsupported");
    if (typeof split.ratio !== "number" || !Number.isFinite(split.ratio) || split.ratio <= 0 || split.ratio >= 1)
      throw new Error("Rex split ratio is invalid");
    return {
      type: "split", direction: split.direction === "horizontal" ? "row" : "column", ratio: split.ratio,
      before: convert(split.before), after: convert(split.after),
    };
  };
  const root = convert(layer.layout);
  if (seen.size !== blocks.size) throw new Error("Rex tiled layer contains blocks outside its layout");
  const windowLabel = typeof window.label === "string" && window.label.trim() ? window.label : "Captured layout";
  return { spec: parseLayoutSpec({ version: 1, root }), windowLabel, shellFallbacks };
}
export async function captureActiveLayout(rex: Pick<Rex, "locate" | "view">, currentBlockId: string,
  signal?: AbortSignal): Promise<CapturedLayout> {
  signal?.throwIfAborted();
  const target = await rex.locate(currentBlockId, signal);
  const view = await rex.view(target.sessionId, signal);
  return captureRexWindow(view, target.blockId);
}
