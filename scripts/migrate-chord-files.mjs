#!/usr/bin/env node
/**
 * One-time migration: remove "suffix" from chord JSONs and add "keyOrder" from key-orders.json.
 * Run from PinchordSite: node scripts/migrate-chord-files.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const keyOrdersPath = path.join(root, "key-orders.json");
const chordDir = path.join(root, "chord-versions");

const versions = [
  "v16.6", "v17.0", "v17.1", "v17.2", "v18.0", "v19.0", "v20.0",
  "v21.0", "v21.1", "v22.0", "v22.1", "v23.0", "v24.0", "v24.1",
  "v25.0", "v26.0",
];

const keyOrders = JSON.parse(fs.readFileSync(keyOrdersPath, "utf8"));

for (const version of versions) {
  const keyOrder = keyOrders[version];
  if (!keyOrder || !Array.isArray(keyOrder)) {
    console.warn("No keyOrder for", version);
    continue;
  }
  const chordPath = path.join(chordDir, `pinchord-chords-${version}.json`);
  if (!fs.existsSync(chordPath)) {
    console.warn("No chord file for", version);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(chordPath, "utf8"));
  delete data.suffix;
  data.keyOrder = keyOrder;
  fs.writeFileSync(chordPath, JSON.stringify(data));
  console.log("Updated", version);
}

console.log("Done.");
