// Packs the backend + worker template into public/kernel-bundle.json so the
// browser can render a Kaggle worker script client-side (no server needed).
//
// Output: { version, worker } where `worker` is the template with the backend
// files (FILES) already injected and __CONFIG__ left for the browser to fill
// in per launch.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const backendDir = join(repoRoot, "backend");
const appDir = join(backendDir, "app");
const templatePath = join(backendDir, "kaggle_worker.py");
const outDir = join(here, "..", "public");
const outPath = join(outDir, "kernel-bundle.json");

function walkPy(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "__pycache__") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkPy(full));
    else if (name.endsWith(".py")) out.push(full);
  }
  return out;
}

const files = {};
for (const full of walkPy(appDir)) {
  const rel = "app/" + relative(appDir, full).split("\\").join("/");
  files[rel] = readFileSync(full).toString("base64");
}
if (!files["app/main.py"]) {
  console.error("build-kernel-bundle: app/main.py not found");
  process.exit(1);
}

const template = readFileSync(templatePath, "utf8");
// Inject FILES now; leave __CONFIG__ for the browser (renderWorker).
const worker = template.replace("__FILES__", JSON.stringify(files));

mkdirSync(outDir, { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ version: 3, worker }),
);
console.log(
  `build-kernel-bundle: wrote ${outPath} (${Object.keys(files).length} files, ${worker.length} bytes)`,
);
