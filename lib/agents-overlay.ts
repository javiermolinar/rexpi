import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, foregroundAnsi, getTerminalColorMode, Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";
import { agentText, type AgentList, type AgentRow, type AgentState } from "./agents.ts";

export interface AgentStyle {
  accent(text: string): string;
  muted(text: string): string;
  title(text: string): string;
  selected(text: string): string;
  surface(text: string): string;
  status(state: AgentState, text: string): string;
}
export function agentsStyle(theme: Theme): AgentStyle {
  return {
    accent: text => theme.fg("accent", text), muted: text => theme.fg("dim", text), title: text => theme.bold(text),
    selected: text => theme.bg("selectedBg", text),
    surface: text => {
      const mode = getTerminalColorMode();
      const fg = foregroundAnsi(theme.colors.text, mode), bg = backgroundAnsi(theme.colors.toolPendingBg, mode);
      // Paint a full neutral surface even over an already-colored transcript.
      // Inner styles (selection, cursor, dim text) may reset colors: restore the
      // base after their reset, without mistaking RGB channel zero for SGR 0.
      const painted = text.replace(/\x1b\[([0-9;:]*)m/g, (sequence, params: string) => {
        const fields = params.split(";");
        let resetFg = false, resetBg = false;
        for (let i = 0; i < fields.length; i++) {
          const code = Number(fields[i].split(":")[0]);
          if ([38, 48, 58].includes(code)) {
            if (code === 38) resetFg = false;
            if (code === 48) resetBg = false;
            if (!fields[i].includes(":")) i += fields[i + 1] === "2" ? 4 : fields[i + 1] === "5" ? 2 : 0;
          } else if (code === 0) { resetFg = true; resetBg = true; }
          else if (code === 39) resetFg = true;
          else if (code === 49) resetBg = true;
          else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) resetFg = false;
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) resetBg = false;
        }
        return sequence + (resetFg ? fg : "") + (resetBg ? bg : "");
      });
      return "\x1b[0m" + fg + bg + painted + "\x1b[0m";
    },
    status: (state, text) => theme.fg(state === "error" ? "error" : state === "blocked" ? "warning"
      : state === "working" ? "accent" : state === "done" ? "success" : "muted", text),
  };
}
const plain: AgentStyle = { accent: s => s, muted: s => s, title: s => s, selected: s => s, surface: s => s, status: (_state, s) => s };
const STATUS: Record<AgentState, string> = { working: "● Working", blocked: "? Waiting", error: "! Error", done: "✓ Done", idle: "○ Idle", unknown: "· Unknown" };
interface Options {
  style?: AgentStyle;
  keybindings: Pick<KeybindingsManager, "matches">;
  terminalRows(): number | undefined;
  done(row: AgentRow | undefined): void;
  refresh(): void;
  requestRender(): void;
}
interface Item { kind: "workspace" | "agent"; workspace: string; row?: AgentRow; lastAgent?: boolean; gap?: boolean }

function leaf(path: string): string { return agentText(path).replace(/\/+$/, "").split("/").at(-1) ?? ""; }
function useful(value: string, app: string): boolean {
  return !!value && value.toLowerCase() !== app.toLowerCase()
    && !/^(?:shell|bash|zsh|fish|sh|main|terminal|window(?:\s+[0-9a-f]+)?|(?:block|window|session):[0-9a-f-]+)$/i.test(value);
}
/** Prefer task/conversation names; never fill the list with generic "shell" labels. */
export function agentName(row: AgentRow): string {
  let conversation = agentText(row.conversationTitle).replace(/^π\s*[-–—]\s*/u, "");
  const folder = leaf(row.cwd), suffix = " - " + folder;
  if (folder && conversation.endsWith(suffix) && conversation.length > suffix.length)
    conversation = conversation.slice(0, -suffix.length);
  return [agentText(row.title), conversation, agentText(row.label), agentText(row.windowLabel), folder,
    agentText(row.sessionLabel)].find(value => useful(value, row.app)) || row.app;
}

/** One transient interaction. Navigation is performed only after it closes. */
export class AgentsOverlay implements Component, Focusable {
  readonly input = new Input({ prompt: "Search  " });
  private readonly style: AgentStyle;
  private readonly options: Options;
  private rows: AgentRow[] = [];
  private filtered: AgentRow[] = [];
  private selected = 0;
  private offset = 0;
  private loading = true;
  private error = "";
  private unavailable = 0;
  private closed = false;
  private width = 72;
  constructor(options: Options) { this.options = options; this.style = options.style ?? plain; }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  invalidate(): void { this.input.invalidate(); }
  selectedRow(): AgentRow | undefined { return this.filtered[this.selected]; }
  setList(result: AgentList): void {
    const previous = this.selectedRow()?.key;
    this.rows = result.rows; this.unavailable = result.unavailable; this.loading = false; this.error = "";
    this.filter();
    const index = this.filtered.findIndex(row => row.key === previous);
    this.selected = index >= 0 ? index : 0;
    this.invalidate(); this.options.requestRender();
  }
  setError(error: unknown): void {
    this.rows = []; this.filtered = []; this.loading = false;
    this.error = agentText(error instanceof Error ? error.message : error, "Cannot read Rex agents");
    this.invalidate(); this.options.requestRender();
  }
  private filter(): void {
    const words = agentText(this.input.getValue()).toLowerCase().split(/\s+/).filter(Boolean);
    const matched = this.rows.filter(row => {
      const text = [agentName(row), row.app, row.state, row.title, row.conversationTitle, row.message, row.sessionLabel,
        row.windowLabel, row.label, row.blockId, row.cwd, row.binding?.role, row.pid, row.current ? "you current" : ""]
        .map(v => agentText(String(v ?? ""))).join(" ").toLowerCase();
      return words.every(word => text.includes(word));
    });
    // Keep navigation in workspace order without introducing tab headings.
    const groups = new Map<string, AgentRow[]>();
    for (const row of matched) groups.set(row.sessionId, [...(groups.get(row.sessionId) ?? []), row]);
    this.filtered = [...groups.values()].flat();
  }
  private layout() {
    const rows = this.options.terminalRows();
    const budget = rows && Number.isFinite(rows) ? Math.max(1, Math.min(Math.floor(rows * 0.7), rows - 2)) : 22;
    const framed = this.width >= 38 && budget >= 9;
    const compact = budget < 6;
    const chrome = framed ? 6 : compact ? 1 : 3;
    return { budget, framed, compact, body: Math.min(20, Math.max(0, budget - chrome)) };
  }
  handleInput(data: string): void {
    if (this.closed) return;
    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) { this.finish(undefined); return; }
    if (matchesKey(data, Key.ctrl("r"))) { this.options.refresh(); return; }
    if (this.layout().body < 3) return;
    if (kb.matches(data, "tui.select.confirm")) {
      const row = this.selectedRow();
      if (row) this.finish(row);
      return;
    }
    if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + 1);
    else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) { this.filter(); this.selected = 0; this.offset = 0; }
    }
    this.invalidate(); this.options.requestRender();
  }
  private finish(row: AgentRow | undefined): void {
    if (this.closed) return;
    this.closed = true; this.options.done(row);
  }
  dispose(): void { this.closed = true; }

  private groupLabel(row: AgentRow): string {
    const name = agentText(row.sessionLabel, "Workspace");
    const same = [...new Set(this.rows.filter(r => agentText(r.sessionLabel) === name).map(r => r.sessionId))];
    return same.length > 1 ? `${name} (${same.indexOf(row.sessionId) + 1})` : name;
  }
  private rowLines(row: AgentRow, width: number, lastAgent: boolean): string[] {
    const s = this.style, selected = row.key === this.selectedRow()?.key;
    const name = agentName(row), status = s.status(row.state, STATUS[row.state]);
    const marker = selected ? s.accent("› ") : "  ";
    const branch = "  " + (lastAgent ? "└─ " : "├─ ");
    const continuation = "  " + (lastAgent ? "   " : "│  ");
    const prefix = marker + s.muted(branch), prefixWidth = visibleWidth(prefix);
    const nameWidth = Math.max(1, width - prefixWidth - visibleWidth(status) - 2);
    const clipped = truncateToWidth(name, nameWidth, "…");
    const first = prefix + s.title(clipped) + " ".repeat(Math.max(2, width - prefixWidth - visibleWidth(clipped) - visibleWidth(status))) + status;
    const details = [row.app, ...(row.current ? ["Current"] : []), ...(row.binding?.role === "review" ? ["Review"] : [])];
    const duplicates = this.rows.filter(r => r.sessionId === row.sessionId && agentName(r) === name);
    if (duplicates.length > 1) {
      const panes = [...new Set(duplicates.map(r => r.blockId))].sort();
      details.push("Pane " + (panes.indexOf(row.blockId) + 1));
      const peers = duplicates.filter(r => r.blockId === row.blockId).sort((a, b) => a.pid - b.pid);
      if (peers.length > 1) details.push("Agent " + (peers.findIndex(r => r.key === row.key) + 1));
    }
    const message = agentText(row.message);
    if (message && message !== "No native status" && message !== name) details.push(message);
    const unique = details.filter((value, index) => details.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index);
    const second = s.muted("  " + continuation + truncateToWidth(unique.join(" · "), Math.max(1, width - prefixWidth), "…"));
    const pad = (line: string) => {
      const text = truncateToWidth(line, width, "");
      return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
    };
    return selected ? [s.selected(pad(first)), s.selected(pad(second))] : [truncateToWidth(first, width, ""), second];
  }
  private bodyLines(width: number, budget: number): string[] {
    if (!this.filtered.length) {
      const text = this.loading ? "Reading Rex agents…" : this.error || (this.rows.length ? "No matching agents" : "No live reporting agents");
      return [this.error ? this.style.status("error", text) : this.style.muted(text)];
    }
    const workspaceLine = (text: string) => this.style.title(truncateToWidth("  ▾ " + text, width, "…"));
    const groups = new Map<string, AgentRow[]>();
    for (const row of this.filtered) groups.set(row.sessionId, [...(groups.get(row.sessionId) ?? []), row]);
    const items: Item[] = [];
    for (const rows of groups.values()) {
      const workspace = this.groupLabel(rows[0]);
      items.push({ kind: "workspace", workspace, gap: items.length > 0 });
      rows.forEach((row, index) => items.push({ kind: "agent", workspace, row, lastAgent: index === rows.length - 1 }));
    }
    const selected = items.findIndex(item => item.row?.key === this.selectedRow()?.key);
    const ancestors = (item: Item) => item.kind === "workspace" ? [] : [workspaceLine(item.workspace)];
    const height = (start: number, end: number) => ancestors(items[start]).length
      + items.slice(start, end + 1).reduce((sum, item) => sum + (item.kind === "agent" || item.gap ? 2 : 1), 0);
    this.offset = Math.max(0, Math.min(this.offset, selected));
    while (this.offset < selected && height(this.offset, selected) > budget) this.offset++;
    while (this.offset > 0 && height(this.offset - 1, selected) <= budget) this.offset--;
    const lines = ancestors(items[this.offset]);
    for (const item of items.slice(this.offset)) {
      const part = item.kind === "agent" ? this.rowLines(item.row!, width, item.lastAgent!)
        : [...(item.gap ? [""] : []), workspaceLine(item.workspace)];
      const descendants = item.kind === "workspace" ? 2 : 0;
      if (lines.length + part.length + descendants > budget) break;
      lines.push(...part);
    }
    return lines;
  }
  render(width: number): string[] {
    this.width = Math.max(1, Math.floor(width));
    const layout = this.layout(), s = this.style;
    const paint = (lines: string[]) => lines.map(line => {
      const text = truncateToWidth(line, this.width, "");
      return s.surface(text + " ".repeat(Math.max(0, this.width - visibleWidth(text))));
    });
    if (layout.body < 3) return paint([s.muted("Resize terminal · Esc closes")]);
    const inner = layout.framed ? this.width - 4 : this.width;
    const pad = (line: string) => {
      const text = truncateToWidth(line, inner, "");
      return text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
    };
    const body = this.bodyLines(inner, layout.body);
    const count = this.filtered.length === this.rows.length ? String(this.rows.length) : `${this.filtered.length}/${this.rows.length}`;
    const summary = count + (this.unavailable ? ` · ${this.unavailable} unavailable` : "");
    const input = this.input.render(inner);
    const position = this.filtered.length ? `${this.selected + 1}/${this.filtered.length}` : "";
    const hint = inner >= 62 ? "↑↓ select  enter jump  esc close  ^R refresh" : "↑↓ select  enter jump  esc close";
    const footer = s.muted(truncateToWidth(hint, Math.max(1, inner - position.length - 2), ""))
      + " ".repeat(Math.max(2, inner - Math.min(visibleWidth(hint), Math.max(1, inner - position.length - 2)) - position.length)) + s.muted(position);
    if (!layout.framed) {
      const lines = layout.compact ? [...input, ...body] : [s.title("Agents") + s.muted(" · " + summary), ...input, ...body, footer];
      return paint(lines.slice(0, layout.budget));
    }
    const left = " " + s.title("Agents") + " ", right = " " + summary + " ";
    const top = s.muted("╭") + left + s.muted("─".repeat(Math.max(0, this.width - 2 - visibleWidth(left) - visibleWidth(right)))) + s.muted(right + "╮");
    return paint([top, ...input, "", ...body, "", footer, s.muted("╰" + "─".repeat(this.width - 2) + "╯")]
      .map((line, index, all) => index === 0 || index === all.length - 1 ? line : s.muted("│ ") + pad(line) + s.muted(" │")));
  }
}
