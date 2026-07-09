import { readFileSync } from "node:fs";

const exactBlocks = new Map([
  ["ansi-regex", new Set(["6.2.1"])],
  ["ansi-styles", new Set(["6.2.2"])],
  ["axios", new Set(["0.30.4", "1.14.1"])],
  ["backslash", new Set(["0.2.1"])],
  ["chalk", new Set(["5.6.1"])],
  ["chalk-template", new Set(["1.1.1"])],
  ["color", new Set(["5.0.1"])],
  ["color-convert", new Set(["3.1.1"])],
  ["color-name", new Set(["2.0.1"])],
  ["color-string", new Set(["2.1.1"])],
  ["debug", new Set(["4.4.2"])],
  ["duckdb", new Set(["1.3.3"])],
  ["error-ex", new Set(["1.3.3"])],
  ["has-ansi", new Set(["6.0.1"])],
  ["is-arrayish", new Set(["0.3.3"])],
  ["plain-crypto-js", new Set(["4.2.1"])],
  ["simple-swizzle", new Set(["0.2.3"])],
  ["slice-ansi", new Set(["7.1.1"])],
  ["strip-ansi", new Set(["7.1.1"])],
  ["supports-color", new Set(["10.2.1"])],
  ["supports-hyperlinks", new Set(["4.1.1"])],
  ["wrap-ansi", new Set(["9.0.1"])]
]);

const blockedNames = new Set([
  "@opensearch-project/opensearch",
  "@uipath/robot",
  "@ctrl/tinycolor",
  "eslint-config-prettier"
]);

const blockedPrefixes = [
  "@tanstack/",
  "@mistralai/"
];

const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const findings = [];

for (const [path, info] of Object.entries(lockfile.packages ?? {})) {
  if (!path.startsWith("node_modules/") || !info || typeof info !== "object") {
    continue;
  }
  const name = path.slice("node_modules/".length);
  const version = info.version;
  if (typeof version !== "string") {
    continue;
  }
  const exactVersions = exactBlocks.get(name);
  if (exactVersions?.has(version)) {
    findings.push(`${name}@${version}`);
  }
  if (blockedNames.has(name) || blockedPrefixes.some((prefix) => name.startsWith(prefix))) {
    findings.push(`${name}@${version}`);
  }
}

if (findings.length > 0) {
  console.error("Blocked npm supply-chain packages found:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("No blocked npm supply-chain packages found.");
