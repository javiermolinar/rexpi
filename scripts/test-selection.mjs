import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const selection = process.argv[2];
const patterns = {
  all: /\.test\.mjs$/,
  orchestration: /^(?:agent-|capability-|delegation|fanout|join|launch|messaging-|message-|conversation|peer|extension).*\.test\.mjs$/,
  "agents-ui": /^agents.*\.test\.mjs$/,
  layouts: /^layout.*\.test\.mjs$/,
};
if (!Object.hasOwn(patterns, selection)) {
  console.error("Usage: node scripts/test-selection.mjs all|orchestration|agents-ui|layouts");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(repo, "tests")).filter(name => patterns[selection].test(name)).sort();
if (!files.length) throw new Error("No tests matched " + selection);
const directory = join(tmpdir(), "rexpi-test-logs");
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-");
const log = join(directory, stamp + "-" + selection + ".log");
const output = createWriteStream(log);
let captured = "";
const child = spawn(process.execPath, ["--test", ...files.map(name => join("tests", name))], {
  cwd: repo, stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(output); child.stderr.pipe(output);
child.stdout.on("data", chunk => { captured += chunk; });
child.stderr.on("data", chunk => { captured += chunk; });
child.on("error", error => { output.end(); console.error(error); process.exitCode = 1; });
child.on("close", code => {
  output.end();
  const text = captured;
  if (code !== 0) {
    process.stderr.write(text);
    console.error(`\n${selection} failed with exit ${code}. Full output: ${log}`);
    process.exitCode = code ?? 1;
    return;
  }
  const summary = text.split("\n").filter(line => /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line));
  console.log(`${selection}: ${summary.join(" | ")}`);
  console.log(`Full output: ${log}`);
});
