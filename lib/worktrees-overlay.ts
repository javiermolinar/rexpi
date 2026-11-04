import { basename } from "node:path";
import { agentText } from "./agents.ts";
import { PickerOverlay, type PickerOptions } from "./picker-overlay.ts";
import type { WorktreeRow } from "./worktrees.ts";

export type WorktreeAction = { kind: "open"; row: WorktreeRow } | { kind: "remove"; rows: WorktreeRow[] };
export class WorktreesOverlay extends PickerOverlay<WorktreeRow> {
  constructor(options: Omit<PickerOptions<WorktreeRow>, "done" | "remove" | "markIdentity"> & { done(action: WorktreeAction | undefined): void }) {
    super({ ...options, done: row => options.done(row ? { kind: "open", row } : undefined),
      remove: rows => options.done({ kind: "remove", rows }),
      markIdentity: row => row.deletionIssue ? undefined : JSON.stringify([row.path, row.commonDir, row.identity, row.head, row.branch, row.main, row.bare, row.state === "missing"]),
    }, {
      title: "Worktrees", loading: "Reading Git worktrees…", empty: "No worktrees",
      noMatch: "No matching worktrees", error: "Cannot read Git worktrees",
      markBlocked: row => row.deletionIssue,
      summary: rows => {
        const missing = rows.filter(row => row.state === "missing").length;
        return missing ? `${missing} missing` : "";
      },
      group: row => row.commonDir,
      groupLabel: row => basename(row.repository) || row.repository,
      name: row => row.bare ? "Bare repository" : row.branch.replace(/^refs\/heads\//, "") || "Detached " + row.head.slice(0, 8),
      status: row => ({ tone: row.state === "clean" ? "done" : row.state === "dirty" ? "blocked" : row.state === "missing" ? "unknown" : "error",
        text: row.state === "clean" ? "✓ Clean" : row.state === "dirty" ? "● Dirty" : row.state === "missing" ? "· Missing" : "! Unavailable" }),
      details: row => [...(row.main ? ["Main"] : []), ...(row.current ? ["Current"] : []),
        ...(row.agents ? [row.agents + (row.agents === 1 ? " agent" : " agents")] : []),
        ...(row.locked !== undefined ? ["Locked"] : []),
        ...(row.state === "missing" ? ["Registration only"] : row.prunable !== undefined ? ["Prunable"] : []),
        ...(row.deletionIssue === "Agent locations unavailable" ? [row.deletionIssue] : []), row.path].join(" · "),
      search: row => [row.path, row.branch, row.head, row.state, row.main ? "main" : "", row.current ? "current" : "",
        row.locked !== undefined ? "locked" : "", row.prunable !== undefined ? "prunable" : "", row.deletionIssue]
        .map(value => agentText(value)).join(" "),
    });
  }
}
