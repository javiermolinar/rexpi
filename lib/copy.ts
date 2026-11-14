import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOLLOWUP_CONTEXT } from "./messaging/receipts.ts";
import { PEER_MESSAGE_TYPE } from "./peer.ts";

type CopyContext = Pick<ExtensionContext, "sessionManager" | "ui">;
type Copy = (text: string) => Promise<void>;

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => typeof part === "object" && part !== null
    && (part as { type?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string")
    .map(part => (part as { text: string }).text).join("");
}

/** Return text only when the latest conversation message is a visible Rexpi custom message. */
export function latestRexpiMessageText(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { type?: unknown; customType?: unknown; display?: unknown; content?: unknown };
    if (candidate.type === "message") return undefined;
    if (candidate.type !== "custom_message") continue;
    if (candidate.display === false || (candidate.customType !== FOLLOWUP_CONTEXT
        && candidate.customType !== PEER_MESSAGE_TYPE)) return undefined;
    return textContent(candidate.content).trim() || undefined;
  }
  return undefined;
}

/**
 * Pi's built-in /copy selects only assistant messages. Intercept just its Enter key when the
 * latest conversation message is Rexpi's; all other input continues through Pi unchanged.
 */
export class MessageCopyRuntime {
  private unsubscribe?: () => void;
  private generation = 0;
  private readonly copy: Copy;
  constructor(copy: Copy = copyToClipboard) { this.copy = copy; }

  attach(ctx: CopyContext): void {
    this.detach();
    // Older/test UI contexts without raw-input support retain Pi's native behavior.
    if (typeof ctx.ui.onTerminalInput !== "function") return;
    const generation = this.generation;
    this.unsubscribe = ctx.ui.onTerminalInput(data => {
      if (data !== "\r" && data !== "\n") return undefined;
      let editor: string;
      try { editor = ctx.ui.getEditorText(); } catch { return undefined; }
      if (editor.trim() !== "/copy") return undefined;
      const text = latestRexpiMessageText(ctx.sessionManager.getBranch());
      if (!text) return undefined;
      ctx.ui.setEditorText("");
      void Promise.resolve().then(() => this.copy(text)).then(() => {
        if (generation === this.generation) ctx.ui.notify("Copied last Rexpi message to clipboard", "info");
      }, error => {
        if (generation === this.generation)
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      });
      return { consume: true };
    });
  }

  detach(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
