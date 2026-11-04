import type { LaunchResult } from "../lib/launch.ts";

export function launchText(result: LaunchResult): string {
  const project = result.project
    ? "Resolved " + JSON.stringify(result.project.directory) + " via " + result.project.matchedBy + ". " : "";
  const returns = result.returnSetup ? result.returnSetup.state === "registered"
    ? "Scoped result-return permission registered for request " + result.returnSetup.requestId + "; no send or processing is confirmed. "
    : "Result-return setup unavailable: " + result.returnSetup.reason + " " : "";
  if (result.creation === "unknown") return project + "Pi launch outcome unknown. " + result.startup.reason + " " + returns;
  return project + "Created a fresh Pi " + result.placement + " at " + result.target!.blockId + ". "
    + (result.startup.state === "bound" ? "Exact Pi initialization binding observed; prompt processing, task readiness and completion are not confirmed. " : result.startup.reason + " ")
    + (result.warning ? result.warning + " " : "") + returns + "The source conversation is unchanged. Ask to return to the parent in the child, or use the configured return shortcut. No history was copied.";
}
