import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { argumentWords, configuredCommands, configuredInvocation } from "../lib/commands.ts";
import { terminalArgv } from "../lib/terminal.ts";

function parse(commands, reserved = []) {
  const warnings = [];
  const result = configuredCommands({ "pi-rex": { commands } }, reserved, message => warnings.push(message));
  return { result, warnings };
}
test("named tools are distinct configuration with executable arrays or shell strings", () => {
  const { result, warnings } = parse({
    ch: { run: ["hx"], acceptArgs: true, placement: "right" },
    cl: { run: ["lazygit"], placement: "floating", bounds: [0.1,0.1,0.8,0.8], focus: false },
    logs: "tail -f app.log",
  });
  assert.equal(warnings.length, 0);
  assert.equal(result.size, 3);
  assert.deepEqual(configuredInvocation("ch", result.get("ch"), '"file with spaces.ts"').command, ["hx", "file with spaces.ts"]);
  assert.equal(configuredInvocation("cl", result.get("cl"), "").placement, "floating");
  assert.throws(() => configuredInvocation("logs", result.get("logs"), "extra"), /arguments are disabled/);
});
test("disabled entries and reserved or already-registered names cannot override other commands", () => {
  const { result, warnings } = parse({
    model: { run: "anything" }, rxn: { run: "anything" }, existing: "anything",
    gone: { disabled: true }, valid: ["hx"],
  }, ["rxn", "existing:1"]);
  assert.deepEqual([...result.keys()], ["valid"]);
  assert.equal(warnings.length, 3);
});
test("malformed personal config is rejected entry by entry without executing anything", () => {
  const { result, warnings } = parse({
    valid: "hx", invalid: { run: ["hx"], placement: "diagonal" }, remote: { run: "ls", target: "remote" },
    args: { run: "hx", acceptArgs: "yes" }, bad: { run: [] }, disabled: { disabled: "yes" },
  });
  assert.deepEqual([...result.keys()], ["valid"]);
  assert.equal(warnings.length, 5);
});
test("non-object command settings cannot become registrations", () => {
  const warnings = [];
  const parsed = configuredCommands({ "pi-rex": { commands: ["hx"] } }, [], m => warnings.push(m));
  assert.equal(parsed.size, 0);
  assert.equal(warnings.length, 1);
});
test("argument parsing preserves quoted words without shell expansions", () => {
  assert.deepEqual(argumentWords(`one "two three" '' four\\ five '$HOME' "$(echo literal)"`),
    ["one", "two three", "", "four five", "$HOME", "$(echo literal)"]);
  assert.throws(() => argumentWords("'unfinished"), /Unclosed/);
  assert.throws(() => argumentWords("unfinished\\"), /trailing escape/);
});
test("forwarded arguments cannot become shell operators or command substitutions", () => {
  const { result } = parse({ inspect: { run: "printf '%s\\n'", acceptArgs: true } });
  const invocation = configuredInvocation("inspect", result.get("inspect"), `'$(echo injected)' ';' 'a"b' "a'b"`);
  const argv = terminalArgv(invocation.command, "/", "/bin");
  const output = execFileSync(argv[0], argv.slice(1), { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(output, ["$(echo injected)", ";", 'a"b', "a'b"]);
});
