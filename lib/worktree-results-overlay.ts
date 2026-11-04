import { basename } from "node:path";
import { WorktreeTextOverlay, quotedWorktreeText } from "./worktree-review-overlay.ts";
import { PickerOverlay, type PickerOptions, type PickerTone } from "./picker-overlay.ts";
import type { WorktreeRow } from "./worktrees.ts";

export type RemovalOutcome = "removed" | "cleaned" | "blocked" | "failed" | "unknown" | "not-attempted";
export interface WorktreeRemovalResult { key: string; row: WorktreeRow; outcome: RemovalOutcome; message: string }
export interface WorktreeRemovalReport { results: WorktreeRemovalResult[]; error?: string }
const LABELS: Record<RemovalOutcome, { tone: PickerTone; text: string }> = {
  removed: { tone: "done", text: "✓ Deleted" }, cleaned: { tone: "done", text: "✓ Cleaned" },
  blocked: { tone: "blocked", text: "! Blocked" }, failed: { tone: "error", text: "! Failed" },
  unknown: { tone: "blocked", text: "? Unknown" }, "not-attempted": { tone: "idle", text: "· Not attempted" },
};
export function removalCount(report: WorktreeRemovalReport): number {
  return report.results.filter(result => result.outcome === "removed" || result.outcome === "cleaned").length;
}

/** Static acknowledgement only: no refresh, retry, navigation, or deletion actions. */
export class WorktreeResultsOverlay extends PickerOverlay<WorktreeRemovalResult> {
  readonly report: WorktreeRemovalReport;
  private readonly close: () => void;
  private readonly confirms: (data: string) => boolean;
  private readonly reviewOptions: Omit<PickerOptions<WorktreeRemovalResult>, "done" | "remove" | "markIdentity" | "refresh">;
  private detail?: WorktreeTextOverlay;
  private acknowledged = false;
  constructor(report: WorktreeRemovalReport, options: Omit<PickerOptions<WorktreeRemovalResult>, "done" | "remove" | "markIdentity" | "refresh"> & { done(): void }) {
    const removed = removalCount(report), total = report.results.length;
    let closed = false;
    const close = () => { if (!closed) { closed = true; options.done(); } };
    super({ ...options, done: close, refresh() {} }, {
      title: "Deletion results", loading: "", empty: "No worktrees processed", noMatch: "No matching results", error: "Cannot show deletion results",
      hint: "↑↓ review  tab details  enter close  esc close",
      summary: () => `${removed}/${total} removed`,
      group: () => "results",
      groupLabel: () => report.error ? "Batch stopped · branches retained" : "Completed · branches retained",
      name: result => {
        const folder = basename(result.row.path), branch = result.row.branch.replace(/^refs\/heads\//, "");
        return folder + (branch && branch !== folder ? " · " + branch : "");
      },
      status: result => LABELS[result.outcome],
      details: result => quotedWorktreeText(result.row.path) + " · "
        + (result.outcome === "removed" || result.outcome === "cleaned" ? "Verified" : result.message),
      search: result => [result.row.path, result.row.branch, result.outcome, result.message].map(quotedWorktreeText).join(" "),
    });
    this.report = report; this.close = close; this.reviewOptions = options;
    this.confirms = data => options.keybindings.matches(data, "tui.select.confirm");
    this.setList({ rows: report.results, unavailable: 0 });
  }
  override handleInput(data: string): void {
    if (this.acknowledged) return;
    if (this.detail) { this.detail.handleInput(data); return; }
    if (this.confirms(data)) { this.close(); this.dispose(); }
    else if (this.reviewOptions.keybindings.matches(data, "tui.input.tab")) {
      const result = this.selectedRow();
      if (!result) return;
      this.detail = new WorktreeTextOverlay("Deletion result · " + LABELS[result.outcome].text, [
        "Path:", quotedWorktreeText(result.row.path), "",
        "Branch: " + quotedWorktreeText(result.row.branch), "",
        "Outcome: " + result.outcome, "Reason:", quotedWorktreeText(result.message),
      ].join("\n"), { ...this.reviewOptions, done: () => {
        this.detail = undefined; this.reviewOptions.requestRender();
      } });
      this.reviewOptions.requestRender();
    } else super.handleInput(data);
  }
  override render(width: number): string[] { return this.detail ? this.detail.render(width) : super.render(width); }
  override dispose(): void {
    this.acknowledged = true; this.detail?.dispose(); super.dispose();
  }
}
