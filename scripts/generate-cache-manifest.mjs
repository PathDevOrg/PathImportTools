// Scans the web/dist directory and emits cache-manifest.json next to sw.js
// so the service worker can precache all hashed assets on install.
// Run after `vite build` so the dist tree already exists.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(new URL("../web/dist/", import.meta.url));

function relativePaths(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = `${d}/${name}`;
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else {
        out.push(`/${relative(distPath, full).split(sep).join("/")}`);
      }
    }
  };
  walk(dir);
  return out;
}

const all = relativePaths(distPath).sort();
writeFileSync(`${distPath}/cache-manifest.json`, JSON.stringify(all, null, 2));
console.log(`cache-manifest.json: ${all.length} entries`);
