import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";
import { renderLayoutPreview } from "./layout-preview.ts";
import type { Layout } from "./layouts.ts";
import { plainPickerStyle, type PickerStyle } from "./picker-overlay.ts";

export interface LayoutsOverlayOptions {
  mode: "picker" | "preview";
  keybindings: Pick<KeybindingsManager, "matches">;
  terminalRows(): number | undefined;
  requestRender(): void;
  refresh(): void;
  done(layout?: Layout): void;
  style?: PickerStyle;
}
/** Presentation only: opening and capture never run inside the component. */
export class LayoutsOverlay implements Component, Focusable {
  readonly input = new Input({ prompt: "Search  " });
  private rows: Layout[] = [];
  private index = 0;
  private error = "";
  private loading = true;
  private closed = false;
  private readonly options: LayoutsOverlayOptions;
  constructor(options: LayoutsOverlayOptions) { this.options = options; }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value && this.options.mode === "picker"; }
  invalidate(): void { this.input.invalidate(); }
  private filtered(): Layout[] {
    const words = this.input.getValue().toLowerCase().split(/\s+/).filter(Boolean);
    return this.rows.filter(row => words.every(word => `${row.name} ${row.origin}`.includes(word)));
  }
  selectedRow(): Layout | undefined { return this.filtered()[this.index]; }
  setList(rows: Layout[]): void {
    const previous = this.selectedRow();
    this.rows = [...rows].sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name));
    this.index = Math.max(0, this.filtered().findIndex(row => row.name === previous?.name && row.origin === previous?.origin));
    this.error = ""; this.loading = false; this.options.requestRender();
  }
  setError(error: unknown): void {
    this.rows = []; this.index = 0; this.loading = false;
    this.error = String(error instanceof Error ? error.message : error).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    this.options.requestRender();
  }
  private finish(row?: Layout): void { if (!this.closed) { this.closed = true; this.options.done(row); } }
  handleInput(data: string): void {
    if (this.closed) return;
    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel")) { this.finish(); return; }
    if (kb.matches(data, "tui.select.confirm")) {
      if (this.options.mode === "preview") this.finish();
      else if (this.selectedRow()) this.finish(this.selectedRow());
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) { this.options.refresh(); return; }
    if (this.options.mode === "preview") return;
    const count = this.filtered().length;
    if (kb.matches(data, "tui.select.up")) this.index = Math.max(0, this.index - 1);
    else if (kb.matches(data, "tui.select.down")) this.index = Math.min(Math.max(0, count - 1), this.index + 1);
    else { this.input.handleInput(data); this.index = 0; }
    this.options.requestRender();
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.floor((this.options.terminalRows() ?? 30) * 0.7));
    const style = this.options.style ?? plainPickerStyle;
    const clip = (line: string, w = width) => truncateToWidth(line, w);
    const rows = this.filtered(), selected = this.selectedRow();
    const list: string[] = [];
    let group = "";
    // Window the data before inserting headings, keeping selection visible in short terminals.
    const budget = Math.max(1, width >= 80 ? height - 7 : Math.floor((height - 5) / 2) - 2);
    const start = Math.max(0, this.index - Math.floor(budget / 2));
    for (const row of rows.slice(start, start + budget)) {
      if (group !== row.origin) { group = row.origin; list.push(group === "built-in" ? "Built-in layouts" : "User layouts"); }
      list.push((row === selected ? "› " : "  ") + row.name);
    }
    if (!list.length) list.push(this.loading ? "Loading layouts…" : this.error ? "Error: " + this.error : this.rows.length ? "No matching layouts" : "No layouts");
    const previewWidth = this.options.mode === "picker" && width >= 80 ? width - 29 : width;
    const preview = selected ? renderLayoutPreview(selected.name, { version: selected.version, root: selected.root }, { width: previewWidth, height: Math.max(3, height - 5) }).split("\n").map(line => clip(line, previewWidth)) : [];
    let body: string[];
    if (this.options.mode === "preview") body = preview.length ? preview : list;
    else if (width >= 80) body = Array.from({ length: Math.max(list.length, preview.length) }, (_, i) => {
      const left = clip(list[i] ?? "", 26);
      return left + " ".repeat(Math.max(0, 26 - visibleWidth(left))) + " │ " + (preview[i] ?? "");
    });
    else body = [...list.slice(0, Math.max(1, Math.floor((height - 5) / 2))), ...preview];
    const lines = [style.title(this.options.mode === "picker" ? "Rex layouts" : "Layout preview · read-only"),
      "Opening preserves the current Pi conversation", ...(this.options.mode === "picker" ? this.input.render(width) : []),
      ...body.slice(0, Math.max(0, height - 4)), this.options.mode === "picker" ? "↑↓ select · Enter open · Esc cancel · Ctrl-R refresh" : "Enter / Esc close · Ctrl-R refresh"];
    return lines.slice(0, height).map(line => style.surface(clip(line)));
  }
}
