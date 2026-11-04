import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { active } from "./fixtures.mjs";

const run = promisify(execFile);
export async function gitExec(binary, args, options = {}) {
  try {
    const result = await run(binary, args, { ...options, encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false, truncated: false };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "",
      killed: error.killed || error.name === "AbortError", truncated: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" };
  }
}
export function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
export async function worktreeFixture(t) {
  const a = await active(t), repo = join(a.root, "repo"), linked = join(a.root, "feature with spaces");
  mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "commit", "--allow-empty", "-qm", "initial");
  git(repo, "worktree", "add", "-qb", "feature", linked);
  a.w.processData.set(a.w.source.blockId, { foreground: { pid: process.pid, name: "node", cwd: repo } });
  const launches = [], launcher = { launch: async (...args) => {
    launches.push(args);
    return { creation: "confirmed", placement: "tab", startup: { state: "bound" }, target: a.w.next };
  } };
  return { ...a, repo, linked, launches, launcher, ctx: { ...a.ctx, cwd: repo } };
}
