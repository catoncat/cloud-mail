#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const home = process.env.HOME;
if (!home) throw new Error("HOME is not set");

const binDir = resolve(home, "bin");
const skillDir = resolve(home, ".codex/skills/cloud-mail-intake");

mkdirSync(binDir, { recursive: true });
writeFileSync(
  resolve(binDir, "cloud-mail"),
  `#!/usr/bin/env bash\nset -euo pipefail\nexec node ${appRoot}/scripts/cli.mjs "$@"\n`,
  { mode: 0o755 },
);
chmodSync(resolve(binDir, "cloud-mail"), 0o755);

mkdirSync(skillDir, { recursive: true });
copyFileSync(resolve(repoRoot, "skills/cloud-mail-intake/SKILL.md"), resolve(skillDir, "SKILL.md"));

console.log(`[ok] installed CLI: ${resolve(binDir, "cloud-mail")}`);
console.log(`[ok] installed skill: ${resolve(skillDir, "SKILL.md")}`);
