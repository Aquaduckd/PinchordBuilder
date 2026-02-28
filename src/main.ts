// Pinchord site – chord spelling via Web Worker

import { LayoutVisual } from "./LayoutVisual.js";

const versionEl = document.getElementById("version") as HTMLSelectElement;
const inputEl = document.getElementById("text-input") as HTMLInputElement;
const maxEntriesEl = document.getElementById("max-entries") as HTMLInputElement;
const outputEl = document.getElementById("chord-output")!;
const outputCountEl = document.getElementById("chord-output-count")!;

const URL_PARAM_VERSION = "version";
const URL_PARAM_TEXT = "text";
const URL_PARAM_MAX = "max";

const DEFAULT_VERSION = "v26.0";
const DEFAULT_MAX = "100";

function getUrlParams(): { version?: string; text?: string; max?: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    version: params.get(URL_PARAM_VERSION) ?? undefined,
    text: params.get(URL_PARAM_TEXT) ?? undefined,
    max: params.get(URL_PARAM_MAX) ?? undefined,
  };
}

function applyUrlParams(): void {
  const { version, text, max } = getUrlParams();
  if (version != null) {
    const option = Array.from(versionEl.options).find((o) => o.value === version);
    if (option) versionEl.value = version;
  }
  if (text != null) inputEl.value = text;
  if (max != null) {
    const n = parseInt(max, 10);
    if (Number.isInteger(n) && n >= 1) maxEntriesEl.value = String(n);
    else if (max === "" || max.toLowerCase() === "none") maxEntriesEl.value = "";
  }
}

function syncUrlFromControls(): void {
  const params = new URLSearchParams();
  const version = versionEl.value;
  const text = inputEl.value.trim();
  const max = maxEntriesEl?.value.trim() ?? "";
  if (version && version !== DEFAULT_VERSION) params.set(URL_PARAM_VERSION, version);
  if (text) params.set(URL_PARAM_TEXT, text);
  if (max && max !== DEFAULT_MAX) params.set(URL_PARAM_MAX, max);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

const worker = new Worker("dist/chord-worker.js");

let requestId = 0;
let totalShownForRequest = 0;

function setOutput(html: string) {
  outputEl.innerHTML = html;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

const keyNamesSorted = (keyNames: string[]) =>
  [...keyNames].filter((k) => k.length > 0).sort((a, b) => b.length - a.length);

/** Parse a chord string into the set of key names using keyNames (longest-first). */
function parseChordToKeys(chordStr: string, keyNames: string[]): Set<string> {
  const keys = new Set<string>();
  const sorted = keyNamesSorted(keyNames);
  let rest = chordStr;
  while (rest) {
    let matched = false;
    for (const key of sorted) {
      if (rest.startsWith(key)) {
        keys.add(key);
        rest = rest.slice(key.length);
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  return keys;
}

/** [initial, vowel, final, suffix] stroke parts from worker */
type Stroke = [string, string, string, string];

function buildRow(display: string, strokes: Stroke[]): string {
  const chords = display.split(" / ");
  const slash = '<span class="text-gray-400 text-sm px-0.5">/</span>';
  const boxes = chords
    .map((c, chordIndex) => {
      const stroke = strokes[chordIndex] ?? ["", "", "", ""];
      const [initial, vowel, final, suffix] = stroke;
      const attrs = `data-initial="${escapeHtml(initial)}" data-vowel="${escapeHtml(vowel)}" data-final="${escapeHtml(final)}" data-suffix="${escapeHtml(suffix)}" data-chord-index="${chordIndex}"`;
      return `<span class="chord-box inline-block rounded border border-gray-300 bg-white px-2 py-0.5 text-sm font-medium text-gray-800 cursor-pointer hover:bg-gray-100" ${attrs}>${escapeHtml(c)}</span>`;
    })
    .join(slash);
  return `<div class="flex flex-wrap gap-1.5 items-center">${boxes}</div>`;
}

function buildChunkLines(spellings: string[], ways: Stroke[][]): string {
  return spellings
    .map((s, wayIndex) => buildRow(s, ways[wayIndex] ?? []))
    .join("");
}

function getOrCreateBucket(container: Element, chordCount: number): HTMLElement {
  const existing = container.querySelector(`.chord-bucket[data-chord-count="${chordCount}"]`);
  if (existing) return existing as HTMLElement;
  const bucket = document.createElement("div");
  bucket.className = "chord-bucket flex flex-col gap-2";
  bucket.dataset.chordCount = String(chordCount);
  const children = container.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i] as HTMLElement;
    const n = parseInt(c.dataset.chordCount ?? "0", 10);
    if (n > chordCount) {
      container.insertBefore(bucket, c);
      return bucket;
    }
  }
  container.appendChild(bucket);
  return bucket;
}

function renderSpellings(target: string, spellings: string[], ways: Stroke[][]) {
  if (!target.trim()) {
    outputCountEl.textContent = "";
    setOutput('<span class="text-gray-400">—</span>');
    return;
  }
  if (spellings.length === 0) {
    outputCountEl.textContent = "";
    setOutput(
      '<span class="text-amber-600">No chord spellings found for "' +
        escapeHtml(target) +
        '".</span>'
    );
    return;
  }
  outputCountEl.textContent = `${spellings.length} way(s)`;
  setOutput(
    '<div class="chord-output-inner flex flex-col gap-2">' +
      buildChunkLines(spellings, ways) +
      "</div>"
  );
}

function appendChunk(spellings: string[], ways: Stroke[][]): void {
  let container = outputEl.querySelector(".chord-output-inner");
  if (!container) {
    outputEl.innerHTML = '<div class="chord-output-inner flex flex-col gap-2"></div>';
    container = outputEl.querySelector(".chord-output-inner")!;
  }
  for (let i = 0; i < spellings.length; i++) {
    const chordCount = (ways[i] ?? []).length;
    const bucket = getOrCreateBucket(container, chordCount);
    bucket.insertAdjacentHTML("beforeend", buildRow(spellings[i], ways[i] ?? []));
  }
}

function requestUpdate() {
  const version = versionEl.value;
  const target = inputEl.value.trim().toLowerCase();
  const id = ++requestId;

  if (!target) {
    outputCountEl.textContent = "";
    setOutput('<span class="text-gray-400">—</span>');
    return;
  }

  const maxEntriesRaw = maxEntriesEl?.value.trim();
  const maxEntries =
    maxEntriesRaw === "" ? undefined : Math.max(1, parseInt(maxEntriesRaw, 10) || 0) || undefined;

  totalShownForRequest = 0;
  outputCountEl.textContent = "";
  setOutput('<span class="text-gray-500">Computing…</span>');
  worker.postMessage({ type: "compute", id, version, target, maxEntries });
}

worker.onmessage = (e: MessageEvent<{ type: string; id: number; spellings?: string[]; ways?: Stroke[][]; total?: number; message?: string }>) => {
  const { type, id } = e.data;
  if (id !== requestId) return;
  if (type === "chunk" && e.data.spellings !== undefined && e.data.ways !== undefined) {
    appendChunk(e.data.spellings, e.data.ways);
    totalShownForRequest += e.data.spellings.length;
    outputCountEl.textContent = `${totalShownForRequest} way(s) so far…`;
  } else if (type === "resultDone" && e.data.total !== undefined) {
    const total = e.data.total;
    outputCountEl.textContent = `${total} way(s)`;
    if (total === 0) {
      const target = inputEl.value.trim().toLowerCase();
      setOutput(
        '<span class="text-amber-600">No chord spellings found for "' +
          escapeHtml(target) +
          '".</span>'
      );
    }
  } else if (type === "error" && e.data.message !== undefined) {
    outputCountEl.textContent = "";
    setOutput(
      '<span class="text-red-600">Error: ' + escapeHtml(e.data.message) + "</span>"
    );
  }
};

let layoutVisual: LayoutVisual | null = null;
let keyOrders: Record<string, string[]> = {};

function updateLayoutLabelsForVersion(version: string): void {
  const keys = keyOrders[version];
  if (keys && keys.length >= 24) layoutVisual?.setKeyLabels(keys.slice(0, 24));
  else layoutVisual?.setKeyLabels([]);
}

function applyChordHighlight(el: HTMLElement): void {
  if (!layoutVisual) return;
  const initial = el.getAttribute("data-initial") ?? "";
  const vowel = el.getAttribute("data-vowel") ?? "";
  let final = el.getAttribute("data-final") ?? "";
  const suffix = el.getAttribute("data-suffix") ?? "";
  const chordIndex = parseInt(el.getAttribute("data-chord-index") ?? "0", 10);
  if (final.startsWith("-")) final = final.slice(1);
  const keyNames = keyOrders[versionEl.value];
  if (!keyNames?.length) return;
  const initialKeys = parseChordToKeys(initial, keyNames);
  const centerKeys = parseChordToKeys(vowel, keyNames);
  const finalKeys = parseChordToKeys(final, keyNames);
  const suffixKeys = parseChordToKeys(suffix, keyNames);
  // Initial on left, final on right; prefix/suffix (when we have prefix) highlight both sides
  const leftKeys = new Set<string>([...initialKeys, ...suffixKeys]);
  const rightKeys = new Set<string>([...finalKeys, ...suffixKeys]);
  if (chordIndex > 0 && keyNames.includes("+")) {
    const joinerIdx = keyNames.indexOf("+");
    if (joinerIdx < 12) leftKeys.add("+");
    else rightKeys.add("+");
  }
  layoutVisual.setHighlightedKeys(leftKeys, rightKeys, centerKeys);
}

function clearChordHighlight(): void {
  layoutVisual?.setHighlightedKeys([], [], []);
}

outputEl.addEventListener("mouseover", (e: Event) => {
  const el = (e.target as HTMLElement).closest(".chord-box");
  if (el) applyChordHighlight(el as HTMLElement);
  else clearChordHighlight();
});

outputEl.addEventListener("mouseleave", () => {
  clearChordHighlight();
});

versionEl.addEventListener("change", () => {
  syncUrlFromControls();
  requestUpdate();
  updateLayoutLabelsForVersion(versionEl.value);
});
inputEl.addEventListener("input", () => {
  syncUrlFromControls();
  requestUpdate();
});
maxEntriesEl?.addEventListener("input", () => {
  syncUrlFromControls();
  requestUpdate();
});

applyUrlParams();
updateLayoutLabelsForVersion(versionEl.value);
requestUpdate();

(async function initLayoutVisual(): Promise<void> {
  const canvas = document.getElementById("layout-canvas") as HTMLCanvasElement;
  const container = document.getElementById("layout-visual");
  if (!canvas || !container) return;
  try {
    const res = await fetch("key-orders.json");
    if (res.ok) keyOrders = (await res.json()) as Record<string, string[]>;
  } catch {
    // leave keyOrders empty; layout will show indices
  }
  layoutVisual = new LayoutVisual(canvas, container);
  updateLayoutLabelsForVersion(versionEl.value);
  layoutVisual.attach();
})();
