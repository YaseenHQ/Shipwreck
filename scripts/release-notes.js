/* Prints the CHANGELOG.md section for one version, for the GitHub release body. */
"use strict";
const fs = require("fs");
const path = require("path");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-notes.js <version>");
  process.exit(2);
}
const lines = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end < 0) end = lines.length;
process.stdout.write(lines.slice(start + 1, end).join("\n").trim() + "\n");
