import type { AgentRow } from "./agents.ts";
import { createHash } from "node:crypto";
import { agentText } from "./agents.ts";
import type { AgentStatus } from "./agent-runtime.ts";
import type { AgentLaunchRelation } from "./launch.ts";
import { PickerOverlay, pickerStyle, type PickerBadge, type PickerOptions, type PickerRowMeta, type PickerStyle } from "./picker-overlay.ts";
import type { Snapshot } from "./runtime.ts";
import { sameIdentity } from "./state.ts";

export { pickerStyle as agentsStyle };
export type AgentStyle = PickerStyle;
const STATUS = { working: "● Working", blocked: "? Waiting", error: "! Error", done: "✓ Done", idle: "○ Idle", unknown: "· Unknown" };
function leaf(path: string): string { return agentText(path).replace(/\/+$/, "").split("/").at(-1) ?? ""; }
function useful(value: string, app: string): boolean {
  return !!value && value.toLowerCase() !== app.toLowerCase()
    && !/^(?:shell|bash|zsh|fish|sh|main|terminal|window(?:\s+[0-9a-f]+)?|(?:block|window|session):[0-9a-f-]+)$/i.test(value);
}
/** Prefer task/conversation names; never fill the list with generic "shell" labels. */
function conversationName(row: AgentRow): string {
  let conversation = agentText(row.conversationTitle).replace(/^π\s*[-–—]\s*/u, "");
  const folder = leaf(row.cwd), suffix = " - " + folder;
  if (folder && conversation.endsWith(suffix) && conversation.length > suffix.length)
    conversation = conversation.slice(0, -suffix.length);
  return [agentText(row.title), conversation, agentText(row.label), agentText(row.windowLabel), folder,
    agentText(row.sessionLabel)].find(value => useful(value, row.app)) || row.app;
}
export function agentName(row: AgentRow): string {
  return row.binding?.name ?? conversationName(row);
}


export interface AgentBrowserEvidence {
  readonly relations: readonly AgentLaunchRelation[];
  readonly statuses: readonly AgentStatus[];
}
export interface AgentsEvidenceOptions {
  readonly snapshot: () => Pick<Snapshot, "state" | "server" | "blockId" | "generation">;
  readonly evidence: () => AgentBrowserEvidence;
  readonly ascii?: boolean;
}
export interface AgentPresentation extends PickerRowMeta { readonly depth: number }
interface RelationCandidate {
  readonly record: AgentLaunchRelation;
  readonly parentKey?: string;
  readonly parentName: string;
  readonly historical: boolean;
  readonly ambiguous: boolean;
  readonly status?: AgentStatus;
}

/** The agents view uses the same tree picker as the worktree view. */
export class AgentsOverlay extends PickerOverlay<AgentRow> {
  private readonly evidenceOptions?: AgentsEvidenceOptions;
  private readonly presentations: Map<string, AgentPresentation>;
  constructor(options: PickerOptions<AgentRow>, evidenceOptions?: AgentsEvidenceOptions) {
    const presentations = new Map<string, AgentPresentation>();
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
        const name = agentName(row), conversation = conversationName(row);
        const details = [row.app, ...(conversation !== name ? [conversation] : []),
          ...(row.current ? ["Current"] : []), ...(row.binding?.role === "review" ? ["Review"] : [])];
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
      search: row => {
        const meta = presentations.get(row.key);
        return [agentName(row), row.binding?.name, row.app, row.state, row.title, row.conversationTitle, row.message,
          row.sessionLabel, row.windowLabel, row.label, row.blockId, row.cwd, row.binding?.role, row.pid,
          row.current ? "you current" : "",
          meta?.parent, meta?.activity?.text, meta?.result?.text]
          .map(v => agentText(String(v ?? ""))).join(" ");
      },
      meta: row => presentations.get(row.key),
    });
    this.evidenceOptions = evidenceOptions;
    this.presentations = presentations;
  }
  override setList(result: { rows: AgentRow[]; unavailable: number }): void {
    let presented: Array<{ row: AgentRow; presentation?: AgentPresentation }> = result.rows.map(row => ({ row }));
    if (this.evidenceOptions) {
      try {
        presented = presentAgentRows(result.rows, this.evidenceOptions.snapshot(), this.evidenceOptions.evidence(), this.evidenceOptions.ascii);
      } catch { presented = result.rows.map(row => ({ row })); }
    }
    this.presentations.clear();
    for (const item of presented) if (item.presentation) this.presentations.set(item.row.key, item.presentation);
    super.setList({ ...result, rows: presented.map(item => item.row) });
  }
}

function handleKey(status: AgentStatus["handle"]): string {
  return [status.version, status.taskId, status.conversationId, status.runtimeId, status.runId,
    status.requestId, status.messageId, status.endpointGeneration].join(":");
}
function activityBadge(status?: AgentStatus): PickerBadge {
  const activity = status?.lifecycle.activity ?? "unknown";
  const text = activity === "unknown" ? "act:?" : "act:" + activity;
  const compact = activity === "unknown" ? "A:?" : activity === "running" ? "A:r" : activity === "idle" ? "A:i" : "A:s";
  return { text, compact, tone: activity === "running" ? "working" : "idle" };
}
function resultBadge(status?: AgentStatus): PickerBadge {
  const result = status?.lifecycle.result;
  const text = result === "ready" || result === "failed" || result === "cancelled" ? "result:" + result
    : result === "pending" || result === "cancelling" ? "result:pending" : "result:?";
  const compact = text === "result:?" ? "R:?" : result === "pending" || result === "cancelling" ? "R:p"
    : result === "ready" ? "R:ok" : result === "failed" ? "R:f" : "R:c";
  return { text, compact, tone: result === "ready" ? "done" : result === "failed" ? "error"
    : result === "cancelled" ? "blocked" : "unknown" };
}
function relatedRows(row: AgentRow, relation: AgentLaunchRelation): boolean {
  return !!row.binding && sameIdentity(row.binding, relation.identity)
    && row.blockId === relation.childBlockId && row.serverInstance === relation.serverInstance
    && row.binding.serverInstance === relation.serverInstance && row.binding.hostId === relation.hostId;
}
function parentRows(row: AgentRow, relation: AgentLaunchRelation, rows: AgentRow[]): AgentRow[] {
  return rows.filter(candidate => candidate.key !== row.key && !!candidate.binding
    && sameIdentity(candidate.binding, relation.origin) && candidate.blockId === relation.parentBlockId
    && candidate.serverInstance === relation.serverInstance && candidate.binding.hostId === relation.hostId);
}

/** Revalidate retained launch records against the exact current rows. No I/O or lifecycle inference. */
export function presentAgentRows(rows: AgentRow[], own: Pick<Snapshot, "state" | "server" | "blockId" | "generation">,
    evidence: AgentBrowserEvidence, ascii = false): Array<{ row: AgentRow; presentation?: AgentPresentation }> {
  const candidates = new Map<string, RelationCandidate>();
  for (const row of rows) {
    const matches = evidence.relations.filter(relation => relatedRows(row, relation));
    if (!matches.length) continue;
    const unique = [...new Map(matches.map(relation => [JSON.stringify(relation), relation])).values()];
    const record = unique[0], statuses = evidence.statuses.filter(status => handleKey(status.handle) === handleKey(record.handle));
    const status = unique.length === 1 && statuses.length === 1 ? statuses[0] : undefined;
    const liveChild = row.pid === record.childPid && row.binding?.pid === record.childPid
      && "sha256:" + createHash("sha256").update(row.binding.token).digest("hex") === record.childBindingId
      && record.endpointGeneration === record.handle.endpointGeneration
      && status?.lifecycle.binding !== "replaced" && status?.lifecycle.binding !== "exited";
    const parents = parentRows(row, record, rows);
    const ownParent = own.blockId === record.parentBlockId && sameIdentity(own.state, record.origin);
    const generationFence = (!ownParent || own.generation === record.parentGeneration)
      && own.server.instanceId === record.serverInstance && own.server.hostId === record.hostId;
    const exactParents = parents.filter(parent => parent.pid === parent.binding?.pid
      && "sha256:" + createHash("sha256").update(parent.binding.token).digest("hex") === record.parentBindingId);
    const parent = generationFence && liveChild && unique.length === 1 && parents.length === 1 && exactParents.length === 1
      && parents[0].sessionId === row.sessionId ? parents[0] : undefined;
    candidates.set(row.key, { record, parentKey: parent?.key, parentName: parent ? agentName(parent) : agentText(record.parentName, "parent"),
      historical: !generationFence || !liveChild || (parents.length === 1 && exactParents.length !== 1),
      ambiguous: unique.length !== 1 || parents.length > 1, status });
  }
  const depths = new Map<string, number>(), visiting = new Set<string>();
  const depth = (key: string): number => {
    if (depths.has(key)) return depths.get(key)!;
    const candidate = candidates.get(key);
    if (!candidate?.parentKey || candidate.ambiguous || candidate.historical) { depths.set(key, 0); return 0; }
    if (visiting.has(key)) return -1;
    visiting.add(key);
    const parentDepth = depth(candidate.parentKey);
    visiting.delete(key);
    const value = parentDepth < 0 ? -1 : parentDepth + 1;
    depths.set(key, value); return value;
  };
  const presentations = new Map<string, AgentPresentation>();
  for (const [key, candidate] of candidates) {
    const level = depth(key), nested = level >= 1 && level <= 4;
    presentations.set(key, { depth: nested ? level : 0,
      prefix: nested ? "  ".repeat(level - 1) + (ascii ? "+- " : "↳ ") : "",
      parent: (candidate.historical ? "history:" : "parent:") + candidate.parentName,
      activity: activityBadge(candidate.status), result: resultBadge(candidate.status) });
  }
  const children = new Map<string, AgentRow[]>();
  for (const row of rows) {
    const presentation = presentations.get(row.key);
    if (!presentation?.depth) continue;
    const parentKey = candidates.get(row.key)!.parentKey!;
    children.set(parentKey, [...(children.get(parentKey) ?? []), row]);
  }
  const emitted = new Set<string>();
  const result: Array<{ row: AgentRow; presentation?: AgentPresentation }> = [];
  const visit = (row: AgentRow) => {
    if (emitted.has(row.key)) return;
    emitted.add(row.key); result.push({ row, presentation: presentations.get(row.key) });
    for (const child of children.get(row.key) ?? []) visit(child);
  };
  for (const row of rows) if (!presentations.get(row.key)?.depth) visit(row);
  return result;
}
