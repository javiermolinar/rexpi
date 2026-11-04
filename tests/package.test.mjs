import assert from "node:assert/strict";
import test from "node:test";
import { validatePackage } from "../scripts/check-package.mjs";

function fixture() {
  const sources = new Map([
    ["package.json", "{}"], ["LICENSE", "MIT"],
    ["extensions/index.ts", 'import { runtime } from "../lib/runtime.ts";'],
    ["lib/runtime.ts", 'import { readFileSync } from "node:fs"; import { Type } from "typebox";'],
  ]);
  const manifest = {
    name: "@example/pi-rex", version: "0.1.0", keywords: ["pi-package"],
    pi: { extensions: ["./extensions/index.ts"] },
    peerDependencies: { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*", typebox: "*" },
  };
  const pack = { name: manifest.name, version: manifest.version, files: [...sources.keys()].map(path => ({ path })) };
  return { manifest, pack, sources, check: () => validatePackage(manifest, pack, path => sources.get(path)) };
}

test("validates a scoped Pi package without prose documents and checks runtime imports", () => {
  const f = fixture();
  assert.equal(f.check().size, 4);
});

for (const path of ["package.json", "LICENSE", "extensions/index.ts", "lib/runtime.ts"]) {
  test(`missing required file or runtime import is rejected: ${path}`, () => {
    const f = fixture(); f.pack.files = f.pack.files.filter(file => file.path !== path);
    assert.throws(f.check, /Missing package|Missing packaged import/);
  });
}

for (const path of ["README.md", "CHANGELOG.md", "docs/local-result-mailbox.md", "docs/releasing.md", "plans/run/report.md", "tests/fixture.ts", "scripts/smoke.mjs", ".github/workflows/ci.yml", ".npmrc", "auth.json", "../secret", "/secret", "lib/../../secret.ts", "lib\\secret.ts"]) {
  test(`unexpected/private archive path is rejected: ${path}`, () => {
    const f = fixture(); f.pack.files.push({ path });
    assert.throws(f.check, /Unexpected package file|Unsafe package path/);
  });
}

test("duplicate files and mismatched registry identity/version are rejected", () => {
  let f = fixture(); f.pack.files.push(f.pack.files[0]); assert.throws(f.check, /Duplicate/);
  f = fixture(); f.pack.name = "other"; assert.throws(f.check, /Packed name/);
  f = fixture(); f.pack.version = "2.0.0"; assert.throws(f.check, /Packed version/);
});

test("missing re-export/dynamic import targets and undeclared dependencies are rejected", () => {
  for (const source of ['export { x } from "./missing.ts";', 'void import("./missing.ts");', 'import x from "undeclared/subpath";', 'import x from "@other/package/subpath";']) {
    const f = fixture(); f.sources.set("lib/runtime.ts", source);
    assert.throws(f.check, /Missing packaged import|Undeclared runtime dependency/);
  }
});

test("host-supplied modules remain wildcard peers, not bundled runtime dependencies", () => {
  let f = fixture(); f.manifest.peerDependencies.typebox = "^1"; assert.throws(f.check, /wildcard peer/);
  f = fixture(); f.manifest.dependencies = { typebox: "*" }; assert.throws(f.check, /must not be bundled/);
});

test("only the declared entry extension loads and automatic install hooks are forbidden", () => {
  let f = fixture(); f.manifest.pi.extensions.push("./extensions/another.ts"); assert.throws(f.check, /entry extension/);
  f = fixture(); f.manifest.keywords = []; assert.throws(f.check, /discovery keyword/);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    f = fixture(); f.manifest.scripts = { [hook]: "echo unexpected" }; assert.throws(f.check, /automatic install hook/);
  }
});
