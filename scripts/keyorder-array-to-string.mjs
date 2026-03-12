#!/usr/bin/env node
/**
 * Convert keyOrder from array of strings to single string in chord-versions/*.json
 * Run from PinchordSite: node scripts/keyorder-array-to-string.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chordDir = path.join(__dirname, "..", "chord-versions");

const files = fs.readdirSync(chordDir).filter((f) => f.endsWith(".json"));

for (const file of files) {
  const filePath = path.join(chordDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(data.keyOrder)) {
    data.keyOrder = data.keyOrder.join("");
    fs.writeFileSync(filePath, JSON.stringify(data));
    console.log("Updated", file);
  } else if (typeof data.keyOrder === "string") {
    console.log("Already string", file);
  } else {
    console.warn("No keyOrder or invalid", file);
  }
}

console.log("Done.");
