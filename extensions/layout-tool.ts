import { Type } from "typebox";
import { truncateHead, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { LayoutState } from "./layouts.ts";
import { captureActiveLayout } from "../lib/layout-capture.ts";
import { renderLayoutPreview } from "../lib/layout-preview.ts";
import { layoutOpenText } from "../lib/layout-open.ts";
import { parseLayoutName, parseLayoutSpec, type LayoutSpec } from "../lib/layouts.ts";
import { OutcomeCache } from "../lib/outcome-cache.ts";
import { requireFeature } from "../lib/runtime.ts";
import { literalUnion } from "./schemas.ts";

const schema = Type.Object({
  action: literalUnion(["save", "capture", "list", "show", "open", "delete"] as const),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  layout: Type.Optional(Type.Object({ version: Type.Literal(1), root: Type.Unknown() }, { additionalProperties: false })),
  overwrite: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
interface ToolResult { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }
export function registerLayoutTool(pi: ExtensionAPI, current: () => LayoutState): void {
  const calls = new OutcomeCache<ToolResult>(2048, "Layout tool history is full; inspect prior outcomes");
  pi.registerTool({
    name: "rexpi_layout", label: "Rex layouts", description: "Manage layouts; show built-ins for spec format.",
    executionMode: "sequential", parameters: schema,
    async execute(id, params, signal, _update, ctx) {
      // Capture this incarnation before caching: old IDs must never acquire a replacement runtime.
      const state = current();
      return calls.run(id, async () => {
        const runtime = state.runtime;
        const store = requireFeature(runtime, state.store, ctx.sessionManager.getSessionId());
        const own = runtime!.snapshot();
        const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
        const verify = () => {
          combined.throwIfAborted(); runtime!.assert(own);
          if (current().runtime !== runtime || ctx.sessionManager.getSessionId() !== own.state.piSessionId)
            throw new Error("Pi source conversation changed");
        };
        verify();
        if (params.action === "list") {
          if (params.name !== undefined || params.layout !== undefined || params.overwrite !== undefined)
            throw new Error("list accepts no name, layout or overwrite");
          const layouts = store.list().map(({ name, origin }) => ({ name, origin }));
          return result(layouts);
        }
        const name = parseLayoutName(params.name);
        if (params.action !== "save" && params.layout !== undefined) throw new Error("layout applies only to save");
        if (!["save", "capture"].includes(params.action) && params.overwrite !== undefined)
          throw new Error("overwrite applies only to save or capture");
        if (params.action === "show") {
          const layout = store.get(name);
          return result(layout, renderLayoutPreview(name, { version: layout.version, root: layout.root }));
        }
        if (params.action === "open") {
          const opener = requireFeature(runtime, state.opener, ctx.sessionManager.getSessionId());
          const layout = store.get(name); verify();
          const opened = await opener.open(id, name, { version: layout.version, root: layout.root }, ctx.cwd, combined);
          return { ...result(opened, layoutOpenText(opened)), ...(opened.state === "unknown" ? { isError: true } : {}) };
        }
        let spec: LayoutSpec | undefined, shellFallbacks: string[] = [];
        if (params.action === "save") spec = parseLayoutSpec(params.layout);
        if (params.action === "capture") {
          await runtime!.source(own, combined);
          const captured = await captureActiveLayout(runtime!.rex, own.blockId, combined);
          spec = captured.spec; shellFallbacks = captured.shellFallbacks;
        }
        return withFileMutationQueue(join(store.directory, name + ".json"), async () => {
          verify();
          if (params.action === "delete") return result({ deleted: store.remove(name).name });
          if (!spec) throw new Error("Invalid layout action");
          const saved = store.save(name, spec, { overwrite: params.overwrite });
          return result({ layout: saved, shellFallbacks }, `Saved layout ${name}; no panes opened.`);
        });
      });
    },
  });
}
function result(details: unknown, summary?: string): ToolResult {
  const output = (summary ? summary + "\n" : "") + JSON.stringify(details, null, 2);
  const truncated = truncateHead(output, { maxBytes: 50 * 1024, maxLines: 2000 });
  return { content: [{ type: "text", text: truncated.content + (truncated.truncated ? "\n[Layout output truncated]" : "") }], details };
}
