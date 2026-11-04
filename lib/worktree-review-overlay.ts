import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import { plainPickerStyle, type PickerStyle } from "./picker-overlay.ts";
import type { WorktreeRow } from "./worktrees.ts";

/** Preserve full literal values, escaping terminal controls instead of dropping or truncating them. */
export function quotedWorktreeText(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}
export interface WorktreeReviewOptions {
  style?: PickerStyle;
  keybindings: Pick<KeybindingsManager, "matches">;
  terminalRows(): number | undefined;
  requestRender(): void;
  done(confirmed: boolean): void;
}

/** A bounded, wrapped document viewport. Overlay render() has no native ScrollView layout pass. */
export class WorktreeTextOverlay implements Component {
  readonly title: string;
  readonly message: string;
  protected readonly options: WorktreeReviewOptions;
  protected closed = false;
  private readonly style: PickerStyle;
  private offset = 0;
  private body = 1;
  private usable = false;
  private cachedWidth = 0;
  private lines: string[] = [];
  constructor(title: string, message: string, options: WorktreeReviewOptions) {
    this.title = title; this.message = message; this.options = options;
    this.style = options.style ?? plainPickerStyle;
  }
  invalidate(): void { this.cachedWidth = 0; }
  dispose(): void { this.closed = true; }
  protected finish(confirmed = false): void {
    if (this.closed) return;
    this.closed = true; this.options.done(confirmed);
  }
  protected confirm(): void { this.finish(); }
  protected actions(): string { return "enter back  esc back"; }
  protected canConfirm(): boolean { return this.usable; }
  protected minimumWidth(): number { return 24; }
  handleInput(data: string): void {
    if (this.closed) return;
    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) { this.finish(); return; }
    if (kb.matches(data, "tui.select.confirm")) { if (this.canConfirm()) this.confirm(); return; }
    if (kb.matches(data, "tui.select.up")) this.offset--;
    else if (kb.matches(data, "tui.select.down")) this.offset++;
    else if (kb.matches(data, "tui.select.pageUp")) this.offset -= this.body;
    else if (kb.matches(data, "tui.select.pageDown")) this.offset += this.body;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = this.lines.length;
    else return;
    this.clamp(); this.options.requestRender();
  }
  private clamp(): void { this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - this.body))); }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const rows = this.options.terminalRows();
    const budget = rows && Number.isFinite(rows) ? Math.max(1, Math.min(Math.floor(rows * 0.7), rows - 2)) : 22;
    const s = this.style;
    const paint = (line: string) => {
      const text = truncateToWidth(line, width, "");
      return s.surface(text + " ".repeat(Math.max(0, width - visibleWidth(text))));
    };
    this.usable = width >= this.minimumWidth() && budget >= 7;
    if (!this.usable) return [paint(s.muted("Resize terminal · Esc back"))];
    const inner = width - 4;
    if (this.cachedWidth !== inner) {
      this.lines = this.message.split("\n").flatMap(line => wrapTextWithAnsi(line, inner));
      this.cachedWidth = inner;
    }
    this.body = Math.max(1, budget - 5);
    this.clamp();
    const frame = (line: string) => {
      const text = truncateToWidth(line, inner, "");
      return s.muted("│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + s.muted(" │");
    };
    const position = `${this.offset + 1}–${Math.min(this.lines.length, this.offset + this.body)}/${this.lines.length}`;
    return [
      s.muted("╭ ") + s.title(truncateToWidth(this.title, width - 4, "…"))
        + s.muted(" " + "─".repeat(Math.max(0, width - 4 - visibleWidth(truncateToWidth(this.title, width - 4, "…")))) + "╮"),
      ...this.lines.slice(this.offset, this.offset + this.body).map(frame),
      frame(s.muted("")),
      frame(s.muted(truncateToWidth("↑↓ scroll  PgUp/PgDn  Home/End  " + position, inner, "…"))),
      frame(s.accent(this.actions())),
      s.muted("╰" + "─".repeat(width - 2) + "╯"),
    ].map(paint);
  }
}

/** All targets are scrollable, with an explicit choice defaulting to cancellation. */
export class WorktreeConfirmationOverlay extends WorktreeTextOverlay {
  readonly rows: readonly WorktreeRow[];
  private remove = false;
  constructor(rows: readonly WorktreeRow[], options: WorktreeReviewOptions) {
    super(`Remove ${rows.length} marked worktree${rows.length === 1 ? "" : "s"}?`, [
      "Branches are retained. Directory removal cannot be undone.",
      "Missing entries remove Git registrations only; existing worktrees remove directories.", "",
      ...rows.flatMap((row, index) => [
        `${index + 1}/${rows.length} · ${row.state === "missing" ? "Registration only" : "Directory"}:`,
        quotedWorktreeText(row.path), "",
      ]),
    ].join("\n"), options);
    this.rows = rows;
  }
  protected override minimumWidth(): number { return 48; }
  protected override confirm(): void { this.finish(this.remove); }
  protected override actions(): string { return this.remove ? "tab choose  Cancel  [Remove]  enter" : "tab choose  [Cancel]  Remove  enter"; }
  override handleInput(data: string): void {
    if (this.closed) return;
    if (this.canConfirm() && (this.options.keybindings.matches(data, "tui.input.tab")
        || matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.remove = !this.remove; this.options.requestRender();
    } else super.handleInput(data);
  }
}
