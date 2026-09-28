#!/usr/bin/env node
import { chmodSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const home = process.env.HOME;
if (!home) throw new Error("HOME is not set");

const binPath = resolve(home, "bin/cloud-mail");
const skillSource = resolve(repoRoot, "skills/cloud-mail-intake");
const skillDirs = [resolve(home, ".agents/skills"), resolve(home, ".codex/skills")];

// Absolute node path: agent shells often run with a minimal PATH.
mkdirSync(dirname(binPath), { recursive: true });
writeFileSync(
  binPath,
  `#!/usr/bin/env bash\nset -euo pipefail\nexec ${process.execPath} ${appRoot}/scripts/cli.mjs "$@"\n`,
  { mode: 0o755 },
);
chmodSync(binPath, 0o755);
console.log(`[ok] installed CLI: ${binPath}`);

// Link, never copy: a copy goes stale, and these paths are often already links
// back to this repo, where copying would write the file onto itself.
for (const dir of skillDirs) {
  const target = resolve(dir, "cloud-mail-intake");
  if (!pathExists(target)) {
    mkdirSync(dir, { recursive: true });
    symlinkSync(skillSource, target);
    console.log(`[ok] linked skill: ${target} -> ${skillSource}`);
  } else if (sameFile(target, skillSource)) {
    console.log(`[ok] skill already linked: ${target}`);
  } else {
    console.log(`[skip] ${target} exists and is not this repo's skill; left untouched`);
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
