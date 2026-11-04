import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const documents = ["package.json", "LICENSE", "README.md", "CHANGELOG.md"];
const assets = ["assets/rexpi.jpg", "assets/agents.png", "assets/worktrees.png"];
const hostPackages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
const canonical = path => typeof path === "string" && path.length > 0 && !path.includes("\\")
  && !path.startsWith("/") && path.split("/").every(part => part && part !== "." && part !== "..");

/** Validate the actual artifact, without loading an extension or contacting Rex/providers. */
export function validatePackage(manifest, pack, read) {
  assert.equal(pack.name, manifest.name, "Packed name differs from manifest");
  assert.equal(pack.version, manifest.version, "Packed version differs from manifest");
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/index.ts"], "Declare only the package entry extension");
  assert(manifest.keywords?.includes("pi-package"), "Missing Pi package discovery keyword");
  for (const name of hostPackages) {
    assert.equal(manifest.peerDependencies?.[name], "*", `${name} must remain a host-provided wildcard peer`);
    assert(!manifest.dependencies?.[name], `${name} must not be bundled as a dependency`);
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert(!manifest.scripts?.[hook], `Unexpected automatic install hook: ${hook}`);
  }
  const paths = pack.files.map(file => file.path);
  const files = new Set(paths);
  assert.equal(files.size, paths.length, "Duplicate package paths");
  for (const path of files) {
    assert(canonical(path), `Unsafe package path: ${path}`);
    assert(documents.includes(path) || assets.includes(path) || /^(extensions|lib)\/.+\.ts$/.test(path), `Unexpected package file: ${path}`);
  }
  for (const path of [...documents, ...assets, "extensions/index.ts"]) assert(files.has(path), `Missing package file: ${path}`);
  for (const path of files) {
    if (!path.endsWith(".ts")) continue;
    for (const { fileName: specifier } of ts.preProcessFile(read(path), true, true).importedFiles) {
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        assert(canonical(target) && [target, `${target}.ts`, `${target}/index.ts`].some(candidate => files.has(candidate)),
          `Missing packaged import: ${path} -> ${specifier}`);
      } else if (!isBuiltin(specifier)) {
        const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
        assert(manifest.dependencies?.[name] || manifest.peerDependencies?.[name], `Undeclared runtime dependency: ${name}`);
      }
    }
  }
  return files;
}

export function checkPackage(root) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "rexpi-pack-"));
  const options = { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  try {
    const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", directory];
    const output = process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
      : execFileSync("npm", args, options);
    const packs = JSON.parse(output);
    assert.equal(packs.length, 1, "Expected exactly one package");
    const pack = packs[0];
    assert.equal(basename(pack.filename), pack.filename, "Unexpected tarball path");
    const artifact = join(directory, pack.filename);
    const listing = execFileSync("tar", ["-tzf", artifact], options).trim().split("\n");
    assert(listing.every(path => path.startsWith("package/") && canonical(path.slice(8))), "Unsafe archive entry");
    assert.deepEqual(listing.map(path => path.slice(8)).sort(), pack.files.map(file => file.path).sort(), "Tarball and npm file list differ");
    execFileSync("tar", ["-xzf", artifact, "-C", directory], options);
    const read = path => readFileSync(join(directory, "package", path), "utf8");
    const manifest = JSON.parse(read("package.json"));
    const files = validatePackage(manifest, pack, read);
    console.log(`Package checked: ${pack.name}@${pack.version} (${files.size} files). Runtime imports and artifact boundaries verified; no lifecycle scripts, Rex or model calls.`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkPackage(resolve(fileURLToPath(new URL("..", import.meta.url))));
}
