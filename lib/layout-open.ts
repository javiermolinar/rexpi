import { launchDirectory } from "./launch.ts";
import { terminalArgv } from "./terminal.ts";
import { parseLayoutName, parseLayoutSpec, layoutTerminals, type LayoutNode, type LayoutSpec } from "./layouts.ts";
import { OutcomeCache } from "./outcome-cache.ts";
import type { Runtime } from "./runtime.ts";
import { record, rexId } from "./state.ts";

export interface LayoutOpenResult {
  requestId: string;
  name: string;
  state: "confirmed" | "unknown";
  sessionId: string;
  windowId?: string;
  createdBlockIds: string[];
  currentPiBlockId: string;
  piMove: "not-requested" | "not-attempted" | "confirmed" | "unknown";
  placeholderClosed: boolean;
  reason?: string;
}
function ids(value: unknown, count: number): string[] {
  if (!Array.isArray(value) || value.length !== count || !value.every(id => rexId(id, "block"))
      || new Set(value).size !== count) throw new Error("Rex did not return exact layout block IDs");
  return value as string[];
}
function allBlocks(value: unknown): string[] {
  const view = record(value);
  if (!Array.isArray(view.windows)) throw new Error("Rex session has no windows");
  return view.windows.flatMap(raw => {
    const window = record(raw);
    if (!Array.isArray(window.layers)) throw new Error("Invalid Rex layers");
    return window.layers.flatMap(raw => {
      const layer = record(raw);
      if (!Array.isArray(layer.blocks)) throw new Error("Invalid Rex blocks");
      return layer.blocks.map(raw => {
        const block = record(raw);
        if (!rexId(block.block_id, "block")) throw new Error("Invalid Rex block ID");
        return block.block_id;
      });
    });
  });
}
function verifyTree(raw: unknown, node: LayoutNode, expected: string[], index: { value: number }): void {
  const actual = record(raw);
  if (node.type === "terminal") {
    if (actual.block_id !== expected[index.value++] || actual.split != null)
      throw new Error("Rex layout leaf does not match the requested pane");
    return;
  }
  const split = record(actual.split);
  if (split.direction !== (node.direction === "row" ? "horizontal" : "vertical")
      || typeof split.ratio !== "number" || Math.abs(split.ratio - node.ratio) > 0.000001)
    throw new Error("Rex layout topology or ratio differs from the request");
  verifyTree(split.before, node.before, expected, index);
  verifyTree(split.after, node.after, expected, index);
}
export function layoutOpenText(result: LayoutOpenResult): string {
  return result.state === "confirmed"
    ? `Opened layout ${result.name} in ${result.windowId}. Current Pi conversation preserved. Pane creation does not prove command readiness.`
    : `Layout ${result.name} has a partial or unknown outcome (${result.piMove} Pi move). ${result.reason} Inspect Rex before a deliberate new request; no retry or rollback was attempted.`;
}
/** One local, sequential operation. Never launches Pi or infers permission from a saved layout. */
export class LayoutOpener {
  private readonly calls = new OutcomeCache<LayoutOpenResult>(1024, "Layout request history is full; inspect prior outcomes");
  private busy = false;
  private readonly runtime: Runtime;
  private readonly path: string;
  private readonly shell: string;
  constructor(runtime: Runtime, path = process.env.PATH ?? "", shell = process.env.SHELL ?? "/bin/sh") {
    this.runtime = runtime; this.path = path; this.shell = shell;
  }
  open(id: string, name: string, value: LayoutSpec, cwd: string, signal?: AbortSignal): Promise<LayoutOpenResult> {
    return this.calls.run(id, async () => {
      if (this.busy) throw new Error("Another layout is being opened");
      this.busy = true;
      try { return await this.perform(id, name, value, cwd, signal); }
      finally { this.busy = false; }
    });
  }
  private async perform(id: string, name: string, value: LayoutSpec, cwd: string, signal?: AbortSignal): Promise<LayoutOpenResult> {
    parseLayoutName(name);
    const spec = parseLayoutSpec(value), leaves = layoutTerminals(spec.root);
    const own = this.runtime.snapshot();
    const combined = signal ? AbortSignal.any([own.signal, signal]) : own.signal;
    const check = () => { this.runtime.assert(own); combined.throwIfAborted(); };
    check();
    const source = await this.runtime.source(own, combined);
    const previousIds = new Set(allBlocks(await this.runtime.rex.view(source.sessionId, combined)));
    const piIndex = leaves.findIndex(leaf => leaf.role === "pi");
    // Preflight every cwd/executable before any Rex mutation.
    const makeNode = (node: LayoutNode): Record<string, unknown> => {
      if (node.type === "split") return { split: {
        direction: node.direction === "row" ? "horizontal" : "vertical", ratio: node.ratio,
        before: makeNode(node.before), after: makeNode(node.after),
      } };
      const directory = launchDirectory(node.cwd, cwd);
      const command = node.role === "pi" ? ["/bin/cat"]
        : terminalArgv(node.command ?? (node.shell ? ["/bin/sh", "-c", node.shell] : [this.shell, "-l"]), directory, this.path);
      return { block: { flavor: "com.superlogical.terminal.shell",
        label: node.role === "pi" ? "Rexpi layout placeholder" : node.title,
        options: { shell: "none", command, cwd: directory,
          exit: { on_completion: node.role === "pi" ? false : !node.keepOpen } } } };
    };
    const layout = makeNode(spec.root);
    const result: LayoutOpenResult = {
      requestId: id, name, state: "unknown", sessionId: source.sessionId,
      createdBlockIds: [], currentPiBlockId: own.blockId,
      piMove: piIndex >= 0 ? "not-attempted" : "not-requested", placeholderClosed: false,
    };
    check();
    try {
      const created = await this.runtime.rex.api("session.new_window", {
        session_id: source.sessionId, window_label: name, focus: false, layout,
      }, combined);
      if (!rexId(created.window_id, "window")) throw new Error("Rex did not return an exact layout window");
      result.windowId = created.window_id;
      result.createdBlockIds = ids(created.block_ids, leaves.length);
      if (result.createdBlockIds.some(id => previousIds.has(id))) throw new Error("Rex returned a pre-existing block as created");
      const expected = [...result.createdBlockIds];
      if (piIndex >= 0) {
        const placeholder = result.createdBlockIds[piIndex];
        check();
        const beforeMove = await this.runtime.source(own, combined);
        if (beforeMove.sessionId !== source.sessionId || beforeMove.windowId !== source.windowId)
          throw new Error("Current Pi moved during layout preparation");
        const slot = await this.runtime.rex.locate(placeholder, combined);
        if (slot.sessionId !== source.sessionId || slot.windowId !== result.windowId)
          throw new Error("Layout placeholder moved before swap");
        check();
        result.piMove = "unknown";
        await this.runtime.rex.api("session.swap_blocks", {
          session_id: source.sessionId, block_id: own.blockId, other_block_id: placeholder,
        }, combined);
        const moved = await this.runtime.source(own, combined);
        if (moved.sessionId !== source.sessionId || moved.windowId !== result.windowId)
          throw new Error("Rex did not confirm current Pi in the new window");
        result.piMove = "confirmed";
        expected[piIndex] = own.blockId;
        const displaced = await this.runtime.rex.locate(placeholder, combined);
        if (displaced.sessionId !== source.sessionId || displaced.windowId !== source.windowId)
          throw new Error("Displaced placeholder is not in the original window");
        check();
        const closed = await this.runtime.rex.api("block.close", {
          session_id: source.sessionId, block_id: placeholder,
        }, combined);
        if (closed.block_id !== placeholder) throw new Error("Rex did not confirm closing the exact placeholder");
        result.placeholderClosed = true;
      }
      check();
      const focusedIndex = leaves.findIndex(leaf => leaf.focus);
      const focusId = expected[focusedIndex >= 0 ? focusedIndex : piIndex >= 0 ? piIndex : 0];
      await this.runtime.rex.api("session.focus_block", { session_id: source.sessionId, block_id: focusId }, combined);
      const view = await this.runtime.rex.view(source.sessionId, combined);
      if (!Array.isArray(view.windows)) throw new Error("Rex returned no windows");
      const windows = view.windows.map(record).filter(window => window.window_id === result.windowId);
      if (windows.length !== 1 || view.active_window_id !== result.windowId || windows[0].focused_block_id !== focusId)
        throw new Error("Rex did not confirm layout focus");
      const layers = windows[0].layers;
      if (!Array.isArray(layers) || layers.length !== 1 || record(layers[0]).kind !== "tiled")
        throw new Error("Rex did not confirm a single tiled layout");
      verifyTree(record(layers[0]).layout, spec.root, expected, { value: 0 });
      const remaining = new Set(allBlocks(view));
      if ([...previousIds].some(id => !remaining.has(id))) throw new Error("A pre-existing pane disappeared during layout opening");
      await this.runtime.source(own, combined);
      check();
      result.state = "confirmed";
      return result;
    } catch {
      result.reason = "A Rex mutation or verification failed or was interrupted; commands may already be running. Confirmed IDs are retained for inspection.";
      return result;
    }
  }
}
