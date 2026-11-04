import type { AgentRow } from "./agents.ts";
import { agentText } from "./agents.ts";
import { PickerOverlay, pickerStyle, type PickerOptions, type PickerStyle } from "./picker-overlay.ts";

export { pickerStyle as agentsStyle };
export type AgentStyle = PickerStyle;
const STATUS = { working: "● Working", blocked: "? Waiting", error: "! Error", done: "✓ Done", idle: "○ Idle", unknown: "· Unknown" };
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


/** The agents view uses the same tree picker as the worktree view. */
export class AgentsOverlay extends PickerOverlay<AgentRow> {
  constructor(options: PickerOptions<AgentRow>) {
    super(options, {
      title: "Agents", loading: "Reading Rex agents…", empty: "No live reporting agents",
      noMatch: "No matching agents", error: "Cannot read Rex agents",
      group: row => row.sessionId,
      groupLabel: (row, rows) => {
        const name = agentText(row.sessionLabel, "Workspace");
        const same = [...new Set(rows.filter(r => agentText(r.sessionLabel) === name).map(r => r.sessionId))];
        return same.length > 1 ? `${name} (${same.indexOf(row.sessionId) + 1})` : name;
      },
      name: agentName,
      status: row => ({ tone: row.state, text: STATUS[row.state] }),
      details: (row, rows) => {
        const name = agentName(row);
        const details = [row.app, ...(row.current ? ["Current"] : []), ...(row.binding?.role === "review" ? ["Review"] : [])];
        const duplicates = rows.filter(r => r.sessionId === row.sessionId && agentName(r) === name);
        if (duplicates.length > 1) {
          const panes = [...new Set(duplicates.map(r => r.blockId))].sort();
          details.push("Pane " + (panes.indexOf(row.blockId) + 1));
          const peers = duplicates.filter(r => r.blockId === row.blockId).sort((a, b) => a.pid - b.pid);
          if (peers.length > 1) details.push("Agent " + (peers.findIndex(r => r.key === row.key) + 1));
        }
        const message = agentText(row.message);
        if (message && message !== "No native status" && message !== name) details.push(message);
        return details.filter((value, index) => details.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index).join(" · ");
      },
      search: row => [agentName(row), row.app, row.state, row.title, row.conversationTitle, row.message, row.sessionLabel,
        row.windowLabel, row.label, row.blockId, row.cwd, row.binding?.role, row.pid, row.current ? "you current" : ""]
        .map(v => agentText(String(v ?? ""))).join(" "),
    });
  }
}
