// Pinchord site – chord spelling via Web Worker

import { LayoutVisual } from "./LayoutVisual.js";

const versionEl = document.getElementById("version") as HTMLSelectElement;
const inputEl = document.getElementById("text-input") as HTMLInputElement;
const maxEntriesEl = document.getElementById("max-entries") as HTMLInputElement;
const outputEl = document.getElementById("chord-output")!;
const outputCountEl = document.getElementById("chord-output-count")!;

const configCustomJson = document.getElementById("config-custom-json") as HTMLTextAreaElement;
const configCustomStatus = document.getElementById("config-custom-status")!;
const configDownloadOrthospellingBtn = document.getElementById("config-download-orthospelling");
const configDownloadSystemBtn = document.getElementById("config-download-system");
const configKeymapSelect = document.getElementById("config-keymap") as HTMLSelectElement | null;
const configDownloadLayoutBtn = document.getElementById("config-download-layout");

const JAVELIN_KEYMAPS: Record<string, { url: string; filename: string }> = {
  starboard: { url: "Javelin/Layouts/Starboard.javelin-layout", filename: "Starboard.javelin-layout" },
};

const URL_PARAM_VERSION = "version";
const URL_PARAM_TEXT = "text";
const URL_PARAM_MAX = "max";
const URL_PARAM_TAB = "tab";
const URL_PARAM_SEARCH = "search";

const DEFAULT_VERSION = "pinechord-v2.0";
const DEFAULT_MAX = "100";

/** Chord JSON: initials, vowels, finals, prefixes, suffixes, briefs, banks, and keyOrder. */
type ChordData = {
  initials?: Record<string, string>;
  vowels?: Record<string, string>;
  finals?: Record<string, string>;
  prefixes?: Record<string, string>;
  suffixes?: Record<string, string>;
  briefs?: Record<string, string>;
  banks?: { initials?: string; vowels?: string; finals?: string; prefixes?: string };
  keyOrder?: string;
};

let customChordData: ChordData | null = null;

function getUrlParams(): {
  version?: string;
  text?: string;
  max?: string;
  tab?: string;
  search?: string;
} {
  const params = new URLSearchParams(window.location.search);
  return {
    version: params.get(URL_PARAM_VERSION) ?? undefined,
    text: params.get(URL_PARAM_TEXT) ?? undefined,
    max: params.get(URL_PARAM_MAX) ?? undefined,
    tab: params.get(URL_PARAM_TAB) ?? undefined,
    search: params.get(URL_PARAM_SEARCH) ?? undefined,
  };
}

function getTabFromHash(): "lookup" | "chords" | "csv" | "config" | "jsonbuilder" {
  const hash = window.location.hash.slice(1).toLowerCase();
  if (hash === "chords") return "chords";
  if (hash === "csv") return "csv";
  if (hash === "config") return "config";
  if (hash === "jsonbuilder") return "jsonbuilder";
  return "lookup";
}

function applyUrlParams(): void {
  const { version, text, max, tab, search } = getUrlParams();
  if (tab === "chords") {
    window.location.hash = "chords";
    if (chordsSearchInput) {
      chordsSearchInput.value = search ?? "";
      chordsSearchQuery = search ?? "";
    }
  }
  if (tab === "csv") window.location.hash = "csv";
  if (tab === "config") window.location.hash = "config";
  if (tab === "jsonbuilder") window.location.hash = "jsonbuilder";
  if (version != null) {
    const option = Array.from(versionEl.options).find((o) => o.value === version);
    if (option) {
      versionEl.value = version;
      updateConfigCustomVisibility();
    }
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
  const tab = getTabFromHash();
  const text = inputEl.value.trim();
  const max = maxEntriesEl?.value.trim() ?? "";
  const search = chordsSearchInput?.value.trim() ?? "";
  if (version && version !== DEFAULT_VERSION) params.set(URL_PARAM_VERSION, version); // includes "custom"
  params.set(URL_PARAM_TAB, tab);
  if (tab === "lookup" && text) params.set(URL_PARAM_TEXT, text);
  if (tab === "chords" && search) params.set(URL_PARAM_SEARCH, search);
  if (max && max !== DEFAULT_MAX) params.set(URL_PARAM_MAX, max);
  const query = params.toString();
  const path = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState(null, "", path + window.location.hash);
}

const worker = new Worker("dist/chord-worker.js");

let requestId = 0;
let totalShownForRequest = 0;

function setOutput(html: string) {
  if (pinnedChordEl) {
    pinnedChordEl.classList.remove("chord-box-pinned");
    pinnedChordEl = null;
    layoutVisual?.setHighlightedKeys([], [], []);
  }
  outputEl.innerHTML = html;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

const keyNamesSorted = (keyNames: string[]) =>
  [...keyNames].filter((k) => k.length > 0).sort((a, b) => b.length - a.length);

/** Parse a chord string into the set of key names using keyNames (longest-first). Hyphens are stripped so keys after a separator (e.g. "%AOE^#-NCH") are still parsed. */
function parseChordToKeys(chordStr: string, keyNames: string[]): Set<string> {
  const keys = new Set<string>();
  const sorted = keyNamesSorted(keyNames);
  let rest = chordStr.replace(/-/g, "");
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

function buildRow(display: string, strokes: Stroke[], segmentOutputs?: string[], isBrief?: boolean[]): string {
  const chords = display.split(" / ");
  const slash = '<span class="text-gray-400 text-sm px-0.5">/</span>';
  const boxes = chords
    .map((c, chordIndex) => {
      const stroke = strokes[chordIndex] ?? ["", "", "", ""];
      const [initial, vowel, final, suffix] = stroke;
      const brief = (isBrief?.[chordIndex] ?? false) ? "true" : "false";
      const attrs = `data-initial="${escapeHtml(initial)}" data-vowel="${escapeHtml(vowel)}" data-final="${escapeHtml(final)}" data-suffix="${escapeHtml(suffix)}" data-chord-index="${chordIndex}" data-brief="${brief}"`;
      const label = chordIndex > 0 ? "+" + c : c;
      const out = segmentOutputs?.[chordIndex];
      const outputHtml = out !== undefined ? `<span class="block text-xs text-gray-500 mt-0.5">${escapeHtml(out)}</span>` : "";
      return `<span class="chord-box-wrapper inline-flex flex-col items-start"><span class="chord-box inline-block rounded border border-gray-300 bg-white px-2 py-0.5 text-sm font-medium text-gray-800 cursor-pointer hover:bg-gray-100" ${attrs}>${escapeHtml(label)}</span>${outputHtml}</span>`;
    })
    .join(slash);
  return `<div class="flex flex-wrap gap-1.5 items-center min-h-[2.25rem] border-b border-gray-200 py-1">${boxes}</div>`;
}

function buildChunkLines(spellings: string[], ways: Stroke[][], outputSegments?: string[][], waysIsBrief?: boolean[][]): string {
  return spellings
    .map((s, wayIndex) => buildRow(s, ways[wayIndex] ?? [], outputSegments?.[wayIndex], waysIsBrief?.[wayIndex]))
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

function renderSpellings(target: string, spellings: string[], ways: Stroke[][], waysIsBrief?: boolean[][]) {
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
      buildChunkLines(spellings, ways, undefined, waysIsBrief) +
      "</div>"
  );
}

function appendChunk(spellings: string[], ways: Stroke[][], outputSegments?: string[][], waysIsBrief?: boolean[][]): void {
  let container = outputEl.querySelector(".chord-output-inner");
  if (!container) {
    outputEl.innerHTML = '<div class="chord-output-inner flex flex-col gap-2"></div>';
    container = outputEl.querySelector(".chord-output-inner")!;
  }
  for (let i = 0; i < spellings.length; i++) {
    const chordCount = (ways[i] ?? []).length;
    const bucket = getOrCreateBucket(container, chordCount);
    bucket.insertAdjacentHTML("beforeend", buildRow(spellings[i], ways[i] ?? [], outputSegments?.[i], waysIsBrief?.[i]));
  }
}

function requestUpdate() {
  const source = versionEl.value;
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

  if (source === "custom") {
    if (!customChordData) {
      outputCountEl.textContent = "";
      setOutput('<span class="text-amber-600">Paste valid chord JSON in the Config tab.</span>');
      return;
    }
    totalShownForRequest = 0;
    outputCountEl.textContent = "";
    setOutput('<span class="text-gray-500">Computing…</span>');
    worker.postMessage({ type: "compute", id, data: customChordData, target, maxEntries });
    return;
  }

  totalShownForRequest = 0;
  outputCountEl.textContent = "";
  setOutput('<span class="text-gray-500">Computing…</span>');
  worker.postMessage({ type: "compute", id, version: source, target, maxEntries });
}

const CSV_REQUEST_ID = -1;
const CSV_ROW_BATCH_SIZE = 100;
const CSV_COL_LABELS = ["Index", "Word", "Chord output", "Output", "Word length", "Chord count"] as const;
type CsvSortCol = 0 | 1 | 2 | 3 | 4 | 5;
let csvSortCol: CsvSortCol = 0;
let csvSortDir: 1 | -1 = 1;

let csvTableData: { word: string; chordOutput: string; output: string; strokes?: Stroke[] }[] = [];
let csvRowBuffer: { index: number; word: string; chordOutput: string; output: string; strokes?: Stroke[] }[] = [];
let csvWordQueue: string[] = [];
let csvCurrentWord = "";
let csvTotalWords = 0;

const csvTable = document.getElementById("csv-table")!;
const csvChordsTable = document.getElementById("csv-chords-table")!;
const csvChordsTbody = document.getElementById("csv-chords-tbody")!;

type CsvChordsRow = { key: string; output: string; type: string; count: number; pct: number; examples: string[] };
const CSV_CHORDS_COL_LABELS = ["Index", "Key", "Output", "Type", "Pct", "Examples"] as const;
type CsvChordsSortCol = 0 | 1 | 2 | 3 | 4 | 5;
let csvChordsSortCol: CsvChordsSortCol = 4;
let csvChordsSortDir: 1 | -1 = -1;
let csvChordsTableData: CsvChordsRow[] = [];

function getCsvChordCount(r: { chordOutput: string }): number {
  return r.chordOutput ? r.chordOutput.split(" / ").length : 0;
}

function csvSortCompare(
  a: { r: typeof csvTableData[0]; i: number },
  b: { r: typeof csvTableData[0]; i: number },
  col: CsvSortCol,
  dir: 1 | -1
): number {
  let c: number;
  switch (col) {
    case 0:
      c = a.i - b.i;
      break;
    case 1:
      c = (a.r.word || "").localeCompare(b.r.word || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 2:
      c = (a.r.chordOutput || "").localeCompare(b.r.chordOutput || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 3:
      c = (a.r.output || "").localeCompare(b.r.output || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 4:
      c = a.r.word.length - b.r.word.length;
      break;
    case 5:
      c = getCsvChordCount(a.r) - getCsvChordCount(b.r);
      break;
    default:
      c = 0;
  }
  return c * dir;
}

function renderCsvTableSorted(): void {
  const withIndex = csvTableData.map((r, i) => ({ r, i: i + 1 }));
  const sorted = withIndex.sort((a, b) => csvSortCompare(a, b, csvSortCol, csvSortDir));
  csvTbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  sorted.forEach(({ r }, displayIdx) => {
    const chordCount = getCsvChordCount(r);
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    tr.innerHTML = `<td class="px-3 py-1.5 text-gray-600">${displayIdx + 1}</td><td class="px-3 py-1.5 text-gray-800">${escapeHtml(r.word)}</td><td class="px-3 py-1.5 text-gray-700 font-mono">${escapeHtml(r.chordOutput)}</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(r.output)}</td><td class="px-3 py-1.5 text-gray-600">${r.word.length}</td><td class="px-3 py-1.5 text-gray-600">${chordCount}</td>`;
    frag.appendChild(tr);
  });
  csvTbody.appendChild(frag);
}

function updateCsvSortIndicators(): void {
  const ths = csvTable.querySelectorAll("thead th");
  const arrow = csvSortDir === 1 ? " ↑" : " ↓";
  ths.forEach((th, i) => {
    th.textContent = CSV_COL_LABELS[i] + (i === csvSortCol ? arrow : "");
  });
}

function flushCsvRowBuffer(): void {
  if (csvRowBuffer.length === 0) return;
  const frag = document.createDocumentFragment();
  for (const { index, word, chordOutput, output } of csvRowBuffer) {
    const chordCount = getCsvChordCount({ chordOutput });
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    tr.innerHTML = `<td class="px-3 py-1.5 text-gray-600">${index}</td><td class="px-3 py-1.5 text-gray-800">${escapeHtml(word)}</td><td class="px-3 py-1.5 text-gray-700 font-mono">${escapeHtml(chordOutput)}</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(output)}</td><td class="px-3 py-1.5 text-gray-600">${word.length}</td><td class="px-3 py-1.5 text-gray-600">${chordCount}</td>`;
    frag.appendChild(tr);
  }
  csvTbody.appendChild(frag);
  csvRowBuffer.length = 0;
}

csvTable.addEventListener("click", (ev: Event) => {
  const th = (ev.target as HTMLElement).closest("th");
  if (!th?.classList.contains("csv-th")) return;
  const col = th.cellIndex as CsvSortCol;
  const newDir: 1 | -1 = csvSortCol === col ? (csvSortDir === 1 ? -1 : 1) : 1;
  csvSortCol = col;
  csvSortDir = newDir;
  updateCsvSortIndicators();
  renderCsvTableSorted();
});

function applyCsvChordsSort(col: CsvChordsSortCol): void {
  const newDir: 1 | -1 = csvChordsSortCol === col ? (csvChordsSortDir === 1 ? -1 : 1) : 1;
  csvChordsSortCol = col;
  csvChordsSortDir = newDir;
  updateCsvChordsSortIndicators();
  renderCsvChordsTable();
}

csvChordsTable.addEventListener("click", (ev: Event) => {
  const th = (ev.target as HTMLElement).closest("th");
  if (!th?.classList.contains("csv-chords-th")) return;
  const col = Math.min(5, th.cellIndex) as CsvChordsSortCol;
  applyCsvChordsSort(col);
});

updateCsvSortIndicators();
updateCsvChordsSortIndicators();

function csvRunningAvgText(): string {
  if (csvTableData.length === 0) return "";
  const totalChords = csvTableData.reduce((s, r) => s + getCsvChordCount(r), 0);
  const avg = totalChords / csvTableData.length;
  return ` — avg ${avg.toFixed(2)} chords/word`;
}

function csvChordsSortCompare(a: CsvChordsRow, b: CsvChordsRow, col: CsvChordsSortCol, dir: 1 | -1): number {
  let c: number;
  switch (col) {
    case 0:
      c = (a.key || "").localeCompare(b.key || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 1:
      c = (a.key || "").localeCompare(b.key || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 2:
      c = (a.output || "").localeCompare(b.output || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 3:
      c = (a.type || "").localeCompare(b.type || "", undefined, { sensitivity: "base", numeric: true });
      break;
    case 4:
      c = a.pct - b.pct;
      break;
    case 5:
      c = (a.examples.join(", ") || "").localeCompare(b.examples.join(", ") || "", undefined, { sensitivity: "base", numeric: true });
      break;
    default:
      c = 0;
  }
  return c * dir;
}

function updateCsvChordsSortIndicators(): void {
  const ths = csvChordsTable.querySelectorAll("thead th");
  const arrow = csvChordsSortDir === 1 ? " ↑" : " ↓";
  ths.forEach((th, i) => {
    th.textContent = CSV_CHORDS_COL_LABELS[i] + (i === csvChordsSortCol ? arrow : "");
  });
}

function renderCsvChordsTable(): void {
  const sorted = [...csvChordsTableData].sort((a, b) => csvChordsSortCompare(a, b, csvChordsSortCol, csvChordsSortDir));
  csvChordsTbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  sorted.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    const examplesStr = row.examples.slice(0, 5).join(", ");
    tr.innerHTML = `<td class="px-3 py-1.5 text-gray-600">${i + 1}</td><td class="px-3 py-1.5 font-mono text-gray-800">${escapeHtml(row.key)}</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(row.output)}</td><td class="px-3 py-1.5 text-gray-600">${escapeHtml(row.type)}</td><td class="px-3 py-1.5 text-gray-600">${row.pct.toFixed(1)}%</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(examplesStr)}</td>`;
    frag.appendChild(tr);
  });
  csvChordsTbody.appendChild(frag);
  updateCsvChordsSortIndicators();
}

async function buildChordsTableAndRender(): Promise<void> {
  const version = versionEl.value;
  let data: ChordData | null = null;
  if (version === "custom") {
    data = customChordData;
  } else {
    try {
      const res = await fetch(`chord-versions/${chordFileName(version)}`);
      if (!res.ok) throw new Error(res.statusText);
      data = (await res.json()) as ChordData;
    } catch {
      csvChordsTableData = [];
      renderCsvChordsTable();
      return;
    }
  }
  if (!data) {
    csvChordsTableData = [];
    renderCsvChordsTable();
    return;
  }
  const totalWords = csvTableData.filter((r) => r.strokes && r.strokes.length > 0).length;
  const rows: CsvChordsRow[] = [];
  const add = (key: string, output: string, type: string, strokeIndex: 0 | 1 | 2 | 3) => {
    const examples: string[] = [];
    let count = 0;
    for (const row of csvTableData) {
      const strokes = row.strokes;
      if (!strokes) continue;
      for (const stroke of strokes) {
        if (stroke[strokeIndex] === key) {
          count++;
          if (examples.length < 5) examples.push(row.word);
          break;
        }
      }
    }
    if (count > 0) rows.push({ key, output, type, count, pct: totalWords > 0 ? (count / totalWords) * 100 : 0, examples });
  };
  const addBrief = (key: string, output: string) => {
    const examples: string[] = [];
    let count = 0;
    for (const row of csvTableData) {
      const strokes = row.strokes;
      if (!strokes) continue;
      for (const stroke of strokes) {
        if (stroke[0] === key && stroke[1] === "" && stroke[2] === "" && stroke[3] === "") {
          count++;
          if (examples.length < 5) examples.push(row.word);
          break;
        }
      }
    }
    if (count > 0) rows.push({ key, output, type: "brief", count, pct: totalWords > 0 ? (count / totalWords) * 100 : 0, examples });
  };
  for (const [key, output] of Object.entries(data.initials ?? {})) add(key, output, "initial", 0);
  for (const [key, output] of Object.entries(data.vowels ?? {})) add(key, output, "vowel", 1);
  for (const [key, output] of Object.entries(data.finals ?? {})) add(key, output, "final", 2);
  for (const [key, output] of Object.entries(data.suffixes ?? {})) add(key, output, "suffix", 3);
  for (const [key, output] of Object.entries(data.briefs ?? {})) addBrief(key, output);
  rows.sort((a, b) => b.count - a.count);
  csvChordsTableData = rows;
  renderCsvChordsTable();
}

function processNextCsvWord(): void {
  if (csvWordQueue.length === 0) {
    flushCsvRowBuffer();
    const avgText = csvTableData.length > 0 ? csvRunningAvgText() : "";
    csvStatusEl.textContent = `Done. ${csvTableData.length} word(s).${avgText}`;
    csvComputeBtn.removeAttribute("disabled");
    buildChordsTableAndRender();
    return;
  }
  csvCurrentWord = csvWordQueue.shift()!;
  const m = csvTableData.length + 1;
  const avgText = csvTableData.length > 0 ? csvRunningAvgText() : "";
  csvStatusEl.textContent = `Computing: ${escapeHtml(csvCurrentWord)}… (${m} of ${csvTotalWords} entries)${avgText}`;
  const source = versionEl.value;
  if (source === "custom" && customChordData) {
    worker.postMessage({
      type: "compute",
      id: CSV_REQUEST_ID,
      data: customChordData,
      target: csvCurrentWord.trim().toLowerCase(),
      maxEntries: 1,
    });
  } else if (source !== "custom") {
    worker.postMessage({
      type: "compute",
      id: CSV_REQUEST_ID,
      version: source,
      target: csvCurrentWord.trim().toLowerCase(),
      maxEntries: 1,
    });
  } else {
    csvWordQueue = [];
    csvStatusEl.textContent = "Paste valid chord JSON in the Config tab.";
    csvComputeBtn.removeAttribute("disabled");
  }
}

function chordOutputWithJoiner(display: string): string {
  const chords = display.split(" / ");
  return chords.map((c, i) => (i > 0 ? "+" + c : c)).join(" / ");
}

worker.onmessage = (e: MessageEvent<{ type: string; id: number; spellings?: string[]; ways?: Stroke[][]; output?: string; outputSegments?: string[][]; waysIsBrief?: boolean[][]; total?: number; message?: string }>) => {
  const { type, id } = e.data;
  if (id === CSV_REQUEST_ID) {
    const pushRow = (chordOutput: string, output = "", strokes?: Stroke[]) => {
      csvTableData.push({ word: csvCurrentWord, chordOutput, output, strokes });
      csvRowBuffer.push({ index: csvTableData.length, word: csvCurrentWord, chordOutput, output, strokes });
      if (csvRowBuffer.length >= CSV_ROW_BATCH_SIZE) flushCsvRowBuffer();
      processNextCsvWord();
    };
    if (type === "chunk" && e.data.spellings !== undefined && e.data.spellings.length > 0) {
      const ways = e.data.ways;
      const strokeSeq = ways?.[0]; // one way per word: array of [i,v,f,s]
      pushRow(chordOutputWithJoiner(e.data.spellings[0]), e.data.output ?? "", strokeSeq);
    } else if (type === "resultDone" && e.data.total === 0) {
      pushRow("", "");
    } else if (type === "error" && e.data.message !== undefined) {
      pushRow("", "");
    }
    return;
  }
  if (id !== requestId) return;
  if (type === "chunk" && e.data.spellings !== undefined && e.data.ways !== undefined) {
    appendChunk(e.data.spellings, e.data.ways, e.data.outputSegments, e.data.waysIsBrief);
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
let layoutBanks: Record<string, { initials: string; vowels: string; finals: string }> = {};

function updateLayoutLabelsForVersion(version: string): void {
  const keys = keyOrders[version];
  if (keys && keys.length >= 24) {
    layoutVisual?.setKeyLabels(keys.slice(0, 24));
    layoutVisual?.setBanks(layoutBanks[version] ?? null);
  } else {
    layoutVisual?.setKeyLabels([]);
    layoutVisual?.setBanks(null);
  }
}

/** Split key names into left (keyOrder indices 0–11) and right (12–23). Used when banks are not available. */
function splitKeysByHand(keys: Set<string>, keyNames: string[]): { left: Set<string>; right: Set<string> } {
  const left = new Set<string>();
  const right = new Set<string>();
  for (let i = 0; i < keyNames.length; i++) {
    const k = keyNames[i];
    if (keys.has(k)) {
      if (i < 12) left.add(k);
      else right.add(k);
    }
  }
  return { left, right };
}

/** Assign keys to left/center/right by bank (initials → left, vowels → center, finals → right), first occurrence wins. */
function splitKeysByBanks(
  keys: Set<string>,
  banks: { initials: string; vowels: string; finals: string } | undefined
): { left: Set<string>; center: Set<string>; right: Set<string> } {
  const left = new Set<string>();
  const center = new Set<string>();
  const right = new Set<string>();
  if (!banks) return { left, center, right };
  for (const k of keys) {
    if (banks.initials.includes(k)) left.add(k);
    else if (banks.vowels.includes(k)) center.add(k);
    else if (banks.finals.includes(k)) right.add(k);
  }
  return { left, center, right };
}

function clearChordHighlight(): void {
  layoutVisual?.setHighlightedKeys([], [], []);
}

let pinnedChordEl: HTMLElement | null = null;

function applyChordHighlight(el: HTMLElement, pinned = false): void {
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
  let leftKeys: Set<string>;
  let rightKeys: Set<string>;
  const isBrief = el.getAttribute("data-brief") === "true";
  let effectiveCenterKeys = centerKeys;
  if (isBrief) {
    if (initial.includes("-")) {
      const idx = initial.indexOf("-");
      const leftHalf = initial.slice(0, idx);
      const rightHalf = initial.slice(idx + 1);
      const leftHalfKeys = parseChordToKeys(leftHalf, keyNames);
      leftKeys = new Set([...leftHalfKeys, ...suffixKeys]);
      rightKeys = new Set([...parseChordToKeys(rightHalf, keyNames), ...suffixKeys]);
      const banks = layoutBanks[versionEl.value];
      effectiveCenterKeys = new Set(
        [...leftHalfKeys].filter((k) => (banks?.vowels?.includes(k) ?? false))
      );
    } else {
      const banks = layoutBanks[versionEl.value];
      const byBank = splitKeysByBanks(initialKeys, banks);
      if (byBank.left.size > 0 || byBank.center.size > 0 || byBank.right.size > 0) {
        leftKeys = new Set([...byBank.left, ...suffixKeys]);
        rightKeys = new Set([...byBank.right, ...suffixKeys]);
        effectiveCenterKeys = new Set([...byBank.center, ...centerKeys]);
      } else {
        const byHand = splitKeysByHand(initialKeys, keyNames);
        leftKeys = new Set([...byHand.left, ...suffixKeys]);
        rightKeys = new Set([...byHand.right, ...suffixKeys]);
      }
    }
  } else {
    leftKeys = new Set<string>([...initialKeys, ...suffixKeys]);
    rightKeys = new Set<string>([...finalKeys, ...suffixKeys]);
  }
  if (chordIndex > 0 && keyNames.includes("+")) {
    const joinerIdx = keyNames.indexOf("+");
    if (joinerIdx < 12) leftKeys.add("+");
    else rightKeys.add("+");
  }
  layoutVisual.setHighlightedKeys(leftKeys, rightKeys, effectiveCenterKeys);
}

function updateChordHighlightForEl(el: HTMLElement): void {
  applyChordHighlight(el, false);
}

outputEl.addEventListener("mouseover", (e: Event) => {
  const el = (e.target as HTMLElement).closest(".chord-box");
  if (el) {
    updateChordHighlightForEl(el as HTMLElement);
  } else {
    if (pinnedChordEl) applyChordHighlight(pinnedChordEl, true);
    else clearChordHighlight();
  }
});

outputEl.addEventListener("mouseleave", () => {
  if (pinnedChordEl) applyChordHighlight(pinnedChordEl, true);
  else clearChordHighlight();
});

outputEl.addEventListener("click", (e: Event) => {
  const el = (e.target as HTMLElement).closest(".chord-box");
  if (!el) return;
  const chordEl = el as HTMLElement;
  if (chordEl === pinnedChordEl) {
    pinnedChordEl.classList.remove("chord-box-pinned");
    pinnedChordEl = null;
    clearChordHighlight();
    return;
  }
  if (pinnedChordEl) pinnedChordEl.classList.remove("chord-box-pinned");
  pinnedChordEl = chordEl;
  pinnedChordEl.classList.add("chord-box-pinned");
  applyChordHighlight(pinnedChordEl, true);
});

versionEl.addEventListener("change", () => {
  updateConfigCustomVisibility();
  syncUrlFromControls();
  requestUpdate();
  updateLayoutLabelsForVersion(versionEl.value);
  if (getTabFromHash() === "chords") loadAndRenderChords();
});

if (configCustomJson) {
  configCustomJson.addEventListener("input", () => {
    parseCustomJson();
    requestUpdate();
  });
  configCustomJson.addEventListener("blur", () => parseCustomJson());
}

/** Build avoidMask string: bank minus stroke letters, in bank order. Optionally prefix (e.g. '-' for finals). */
function avoidMaskForStroke(strokeLetters: string, bank: string, prefix = ""): string {
  let rest = bank;
  for (const c of strokeLetters) rest = rest.replace(c, "");
  return prefix + rest;
}

/** Reorder stroke characters to match bank order (e.g. "A^" with bank "^AIOE" → "^A"). */
function strokeInBankOrder(stroke: string, bank: string): string {
  const result: string[] = [];
  for (const c of bank) {
    if (stroke.includes(c)) result.push(c);
  }
  return result.join("");
}

function buildJavelinOrthospellingYaml(data: ChordData, displayName: string): string {
  const banks = data.banks ?? {};
  const initialsBank = banks.initials ?? "";
  const vowelsBank = banks.vowels ?? "";
  const finalsBank = banks.finals ?? "";
  const initials = data.initials ?? {};
  const vowels = data.vowels ?? {};
  const finals = data.finals ?? {};
  const escapeYaml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines: string[] = [];
  lines.push(`name: "${escapeYaml(displayName)}"`);
  lines.push("maximumOutlineLength: 1");
  lines.push("starters:");
  lines.push("- {stroke: '', definition: '{}', mask: ''}");
  lines.push("letters:");
  lines.push("- {stroke: '+', data: '{^}', order: 1}");
  lines.push("- {stroke: '-', data: '{^}', order: 4}");
  const sortByStroke = (a: [string, string], b: [string, string]) =>
    a[0].length !== b[0].length ? a[0].length - b[0].length : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (const [stroke, output] of Object.entries(initials).sort(sortByStroke)) {
    const ordered = strokeInBankOrder(stroke, initialsBank);
    const avoid = avoidMaskForStroke(stroke, initialsBank);
    lines.push(`- {stroke: "${escapeYaml(ordered)}", data: "${escapeYaml(output)}", order: 2, avoidMask: "${escapeYaml(avoid)}"}`);
  }
  for (const [stroke, output] of Object.entries(vowels).sort(sortByStroke)) {
    const ordered = strokeInBankOrder(stroke, vowelsBank);
    const avoid = avoidMaskForStroke(stroke, vowelsBank);
    lines.push(`- {stroke: "${escapeYaml(ordered)}", data: "${escapeYaml(output)}", order: 3, avoidMask: "${escapeYaml(avoid)}"}`);
  }
  for (const [stroke, output] of Object.entries(finals).sort(sortByStroke)) {
    const ordered = strokeInBankOrder(stroke, finalsBank);
    const avoid = avoidMaskForStroke(stroke, finalsBank, "-");
    lines.push(`- {stroke: "${escapeYaml("-" + ordered)}", data: "${escapeYaml(output)}", order: 4, avoidMask: "${escapeYaml(avoid)}"}`);
  }
  return lines.join("\n") + "\n";
}

function buildJavelinSystemYaml(data: ChordData, baseYaml: string, displayName: string): string {
  const keyOrder = (data.keyOrder ?? "").trim();
  if (keyOrder.length !== 24) throw new Error("keyOrder must be 24 characters");
  const banks = data.banks ?? {};
  const vowels = banks.vowels ?? "";
  const finals = banks.finals ?? "";
  const keyOrderArr = keyOrder.split("");
  const escapedName = displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const maskForIndex = (i: number) => (i <= 0xff ? `0x${(1 << i).toString(16).toUpperCase().padStart(2, "0")}` : `0x${(1 << i).toString(16).toUpperCase()}`);

  let keysSection = "keys:\n";
  for (let i = 0; i < 12; i++) {
    keysSection += `  - name: "${keyOrderArr[i]}"\n`;
    keysSection += `    mask: ${maskForIndex(i)}\n`;
  }
  const absentMask = keyOrderArr.reduce((sum, c, i) => (vowels.includes(c) ? sum + (1 << i) : sum), 0);
  // presentMask: only finals bank, and only keys in right-hand positions 12–23 (exclude initials side)
  const presentMask = keyOrderArr.reduce((sum, c, i) => (i >= 12 && finals.includes(c) ? sum + (1 << i) : sum), 0);
  keysSection += `  - name: "-"\n`;
  keysSection += `    mask: 0\n`;
  keysSection += `    absentMask: ${absentMask}\n`;
  keysSection += `    presentMask: ${presentMask}\n`;
  for (let i = 12; i < 24; i++) {
    keysSection += `  - name: "${keyOrderArr[i]}"\n`;
    keysSection += `    mask: ${maskForIndex(i)}\n`;
  }
  const undo = "-" + keyOrderArr[15] + keyOrderArr[16];
  keysSection += `\nundo: "${undo}"\n`;

  const keysStart = baseYaml.indexOf("keys:");
  if (keysStart === -1) throw new Error("Base YAML has no keys section");
  const afterKeysEnd = baseYaml.indexOf("\nlayout:", keysStart);
  if (afterKeysEnd === -1) throw new Error("Base YAML has no layout section");
  let header = baseYaml.slice(0, keysStart);
  header = header.replace(/^name: .+$/m, `name: "${escapedName}"`);
  return header + keysSection + baseYaml.slice(afterKeysEnd);
}

if (configDownloadOrthospellingBtn) {
  configDownloadOrthospellingBtn.addEventListener("click", async () => {
    const version = versionEl.value;
    try {
      let data: ChordData;
      if (version === "custom") {
        if (!customChordData) {
          configCustomStatus.textContent = "Paste valid chord JSON in Config first.";
          configCustomStatus.classList.add("text-red-600");
          return;
        }
        data = customChordData;
      } else {
        const res = await fetch(`chord-versions/${chordFileName(version)}`);
        if (!res.ok) throw new Error(res.statusText);
        data = (await res.json()) as ChordData;
      }
      const displayName =
        version === "custom"
          ? "Pinchord (custom)"
          : version.startsWith("pinechord-")
            ? `Pinechord ${version.slice(10)}`
            : `Pinchord ${version}`;
      const yaml = buildJavelinOrthospellingYaml(data, displayName);
      const systemName = version.startsWith("pinechord-") ? "Pinechord" : "Pinchord";
      const versionSuffix = version === "custom" ? "custom" : version;
      const filename = `${systemName.toLowerCase()}-javelin-dictionary-${versionSuffix}.yaml`;
      const blob = new Blob([yaml], { type: "application/x-yaml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      configCustomStatus.textContent = `Downloaded ${filename}.`;
      configCustomStatus.classList.remove("text-red-600");
    } catch (e) {
      configCustomStatus.textContent = e instanceof Error ? e.message : "Failed to build orthospelling YAML.";
      configCustomStatus.classList.add("text-red-600");
    }
  });
}

if (configDownloadSystemBtn) {
  configDownloadSystemBtn.addEventListener("click", async () => {
    const version = versionEl.value;
    try {
      let data: ChordData;
      if (version === "custom") {
        if (!customChordData) {
          configCustomStatus.textContent = "Paste valid chord JSON in Config first.";
          configCustomStatus.classList.add("text-red-600");
          return;
        }
        data = customChordData;
      } else {
        const res = await fetch(`chord-versions/${chordFileName(version)}`);
        if (!res.ok) throw new Error(res.statusText);
        data = (await res.json()) as ChordData;
      }
      const baseRes = await fetch("Javelin/javelin-system-base.yaml");
      if (!baseRes.ok) throw new Error(baseRes.statusText);
      const baseYaml = await baseRes.text();
      const displayName =
        version === "custom"
          ? "Pinchord (custom)"
          : version.startsWith("pinechord-")
            ? `Pinechord ${version.slice(10)}`
            : `Pinchord ${version}`;
      const yaml = buildJavelinSystemYaml(data, baseYaml, displayName);
      const systemName = version.startsWith("pinechord-") ? "Pinechord" : "Pinchord";
      const versionSuffix = version === "custom" ? "custom" : version;
      const filename = `${systemName.toLowerCase()}-javelin-system-${versionSuffix}.yaml`;
      const blob = new Blob([yaml], { type: "application/x-yaml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      configCustomStatus.textContent = `Downloaded ${filename}.`;
      configCustomStatus.classList.remove("text-red-600");
    } catch (e) {
      configCustomStatus.textContent = e instanceof Error ? e.message : "Failed to build system YAML.";
      configCustomStatus.classList.add("text-red-600");
    }
  });
}

if (configDownloadLayoutBtn && configKeymapSelect) {
  configDownloadLayoutBtn.addEventListener("click", async () => {
    const keymapId = configKeymapSelect.value;
    const keymap = JAVELIN_KEYMAPS[keymapId];
    if (!keymap) {
      configCustomStatus.textContent = `Unknown keymap: ${keymapId}.`;
      configCustomStatus.classList.add("text-red-600");
      return;
    }
    const { url, filename } = keymap;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      configCustomStatus.textContent = `Failed to download ${filename}.`;
      configCustomStatus.classList.add("text-red-600");
    }
  });
}

inputEl.addEventListener("input", () => {
  syncUrlFromControls();
  requestUpdate();
});
maxEntriesEl?.addEventListener("input", () => {
  syncUrlFromControls();
  requestUpdate();
});

// Tab navigation
const tabLookup = document.getElementById("tab-lookup")!;
const tabChords = document.getElementById("tab-chords")!;
const tabCsv = document.getElementById("tab-csv")!;
const tabConfig = document.getElementById("tab-config")!;
const tabJsonBuilder = document.getElementById("tab-jsonbuilder")!;
const panelLookup = document.getElementById("panel-lookup")!;
const panelChords = document.getElementById("panel-chords")!;
const panelCsv = document.getElementById("panel-csv")!;
const panelConfig = document.getElementById("panel-config")!;
const panelJsonBuilder = document.getElementById("panel-jsonbuilder")!;
const headerSaveCsvBtn = document.getElementById("header-save-csv-btn")!;

function chordFileName(version: string): string {
  if (version.startsWith("pinechord-")) return `pinechord-chords-${version.slice(10)}.json`;
  return `pinchord-chords-${version}.json`;
}

async function loadConfigJsonForVersion(version: string): Promise<void> {
  if (!configCustomJson || !configCustomStatus) return;
  configCustomStatus.textContent = "Loading…";
  configCustomStatus.classList.remove("text-red-600");
  try {
    const res = await fetch(`chord-versions/${chordFileName(version)}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = (await res.json()) as ChordData;
    configCustomJson.value = JSON.stringify(data, null, 2);
    configCustomJson.readOnly = true;
    if (typeof data.keyOrder === "string" && data.keyOrder.length === 24) {
      keyOrders[version] = data.keyOrder.split("");
      layoutBanks[version] = {
        initials: data.banks?.initials ?? "",
        vowels: data.banks?.vowels ?? "",
        finals: data.banks?.finals ?? "",
      };
      if (versionEl.value === version) updateLayoutLabelsForVersion(version);
    }
    configCustomStatus.textContent = `Showing chord data for ${version}.`;
  } catch {
    configCustomJson.value = "";
    configCustomJson.readOnly = false;
    configCustomStatus.textContent = `Failed to load chord data for ${version}.`;
    configCustomStatus.classList.add("text-red-600");
  }
}

function updateConfigCustomVisibility(): void {
  const version = versionEl.value;
  const isCustom = version === "custom";
  if (isCustom) {
    configCustomJson.readOnly = false;
    parseCustomJson();
  } else {
    loadConfigJsonForVersion(version);
  }
}

function parseCustomJson(): boolean {
  if (!configCustomJson) return false;
  const raw = configCustomJson.value.trim();
  if (!raw) {
    customChordData = null;
    delete keyOrders["custom"];
    delete layoutBanks["custom"];
    if (versionEl.value === "custom") updateLayoutLabelsForVersion("custom");
    configCustomStatus.textContent = "Paste chord JSON with initials/vowels/finals, suffixes, and keyOrder.";
    configCustomStatus.classList.remove("text-red-600");
    return false;
  }
  try {
    const data = JSON.parse(raw) as ChordData;
    if (
      data &&
      typeof data === "object" &&
      (Object.keys(data.initials ?? {}).length > 0 ||
        Object.keys(data.vowels ?? {}).length > 0 ||
        Object.keys(data.finals ?? {}).length > 0)
    ) {
      if (typeof data.keyOrder !== "string" || data.keyOrder.length === 0) {
        customChordData = null;
        delete keyOrders["custom"];
        delete layoutBanks["custom"];
        if (versionEl.value === "custom") updateLayoutLabelsForVersion("custom");
        configCustomStatus.textContent = "JSON must include a non-empty keyOrder string.";
        configCustomStatus.classList.add("text-red-600");
        return false;
      }
      const EXPECTED_KEY_ORDER_LENGTH = 24;
      if (data.keyOrder.length !== EXPECTED_KEY_ORDER_LENGTH) {
        customChordData = null;
        delete keyOrders["custom"];
        delete layoutBanks["custom"];
        if (versionEl.value === "custom") updateLayoutLabelsForVersion("custom");
        configCustomStatus.textContent = `keyOrder must be exactly ${EXPECTED_KEY_ORDER_LENGTH} characters (got ${data.keyOrder.length}).`;
        configCustomStatus.classList.add("text-red-600");
        return false;
      }
      customChordData = data;
      keyOrders["custom"] = data.keyOrder.split("");
      layoutBanks["custom"] = {
        initials: data.banks?.initials ?? "",
        vowels: data.banks?.vowels ?? "",
        finals: data.banks?.finals ?? "",
      };
      if (versionEl.value === "custom") updateLayoutLabelsForVersion("custom");
      configCustomStatus.textContent = "Valid. Chord data in use.";
      configCustomStatus.classList.remove("text-red-600");
      return true;
    }
    customChordData = null;
    delete keyOrders["custom"];
    delete layoutBanks["custom"];
    configCustomStatus.textContent = "JSON must include at least one of: initials, vowels, finals.";
    configCustomStatus.classList.add("text-red-600");
    return false;
  } catch {
    customChordData = null;
    delete keyOrders["custom"];
    delete layoutBanks["custom"];
    if (versionEl.value === "custom") updateLayoutLabelsForVersion("custom");
    configCustomStatus.textContent = "Invalid JSON.";
    configCustomStatus.classList.add("text-red-600");
    return false;
  }
}

// CSV tab
const csvWordlistEl = document.getElementById("csv-wordlist") as HTMLSelectElement;
const csvWordsEl = document.getElementById("csv-words") as HTMLTextAreaElement;
const csvComputeBtn = document.getElementById("csv-compute")!;
const csvStatusEl = document.getElementById("csv-status")!;
const csvTbody = document.getElementById("csv-tbody")!;
const csvTabWords = document.getElementById("csv-tab-words")!;
const csvTabChords = document.getElementById("csv-tab-chords")!;
const csvPanelWords = document.getElementById("csv-panel-words")!;
const csvPanelChords = document.getElementById("csv-panel-chords")!;

let csvActiveTableTab: "words" | "chords" = "words";

function setCsvTableTab(active: "words" | "chords"): void {
  csvActiveTableTab = active;
  const isWords = active === "words";
  csvTabWords.classList.toggle("border-gray-200", isWords);
  csvTabWords.classList.toggle("border-transparent", !isWords);
  csvTabWords.classList.toggle("bg-white", isWords);
  csvTabWords.classList.toggle("text-indigo-600", isWords);
  csvTabWords.classList.toggle("bg-gray-100", !isWords);
  csvTabWords.classList.toggle("text-gray-600", !isWords);
  csvTabWords.setAttribute("aria-current", isWords ? "page" : "false");
  csvTabChords.classList.toggle("border-gray-200", !isWords);
  csvTabChords.classList.toggle("border-transparent", isWords);
  csvTabChords.classList.toggle("bg-white", !isWords);
  csvTabChords.classList.toggle("text-indigo-600", !isWords);
  csvTabChords.classList.toggle("bg-gray-100", isWords);
  csvTabChords.classList.toggle("text-gray-600", isWords);
  csvTabChords.setAttribute("aria-current", !isWords ? "page" : "false");
  csvPanelWords.classList.toggle("hidden", !isWords);
  csvPanelChords.classList.toggle("hidden", isWords);
}

csvTabWords.addEventListener("click", () => setCsvTableTab("words"));
csvTabChords.addEventListener("click", () => setCsvTableTab("chords"));

const WORDLISTS_DIR = "wordlists";

csvWordlistEl.addEventListener("change", async () => {
  const file = csvWordlistEl.value;
  if (!file) return;
  csvStatusEl.textContent = `Loading ${file}…`;
  csvStatusEl.classList.remove("text-red-600");
  try {
    const res = await fetch(`${WORDLISTS_DIR}/${file}`);
    if (!res.ok) throw new Error(res.statusText);
    const text = await res.text();
    csvWordsEl.value = text.trim();
    const count = text.trim().split(/\s+/).filter(Boolean).length;
    csvStatusEl.textContent = `Loaded ${file}. ${count.toLocaleString()} word(s).`;
  } catch (e) {
    csvStatusEl.textContent = `Failed to load ${file}.`;
    csvStatusEl.classList.add("text-red-600");
  }
});

csvWordsEl.addEventListener("input", () => {
  csvWordlistEl.value = "";
});

// Chords tab tables
const chordsStatus = document.getElementById("chords-status")!;
const chordsSearch = document.getElementById("chords-search")!;
const chordsSubtabs = document.getElementById("chords-subtabs")!;
const chordsSearchInput = document.getElementById("chords-search-input") as HTMLInputElement;
const chordsColumnizeInput = document.getElementById("chords-columnize-input") as HTMLInputElement;
const chordsTables = document.getElementById("chords-tables")!;
const chordsInitialsTbody = document.getElementById("chords-initials-tbody")!;
const chordsVowelsTbody = document.getElementById("chords-vowels-tbody")!;
const chordsFinalsTbody = document.getElementById("chords-finals-tbody")!;

const chordsBriefsTbody = document.getElementById("chords-briefs-tbody")!;
const chordsBriefsTab = document.getElementById("chords-tab-briefs")!;
const chordsPanelInitials = document.getElementById("chords-panel-initials")!;
const chordsPanelVowels = document.getElementById("chords-panel-vowels")!;
const chordsPanelFinals = document.getElementById("chords-panel-finals")!;
const chordsPanelBriefs = document.getElementById("chords-panel-briefs")!;

type ChordsTableId = "initials" | "vowels" | "finals" | "briefs";
const chordsTbodies: Record<ChordsTableId, HTMLElement> = {
  initials: chordsInitialsTbody,
  vowels: chordsVowelsTbody,
  finals: chordsFinalsTbody,
  briefs: chordsBriefsTbody,
};

let chordsTableData: Record<ChordsTableId, Record<string, string>> = {
  initials: {},
  vowels: {},
  finals: {},
  briefs: {},
};

let chordsSortState: Record<ChordsTableId, { col: number; dir: 1 | -1 }> = {
  initials: { col: 2, dir: 1 },
  vowels: { col: 2, dir: 1 },
  finals: { col: 2, dir: 1 },
  briefs: { col: 2, dir: 1 },
};

let columnizeChar: Record<ChordsTableId, string> = {
  initials: "",
  vowels: "",
  finals: "",
  briefs: "",
};

let chordsSearchQuery = "";
let chordsSearchBy: "stroke" | "outline" = "outline";
let chordsActiveSubTab: ChordsTableId = "initials";

const chordsSubTabButtons: Record<ChordsTableId, HTMLElement> = {
  initials: document.getElementById("chords-tab-initials")!,
  vowels: document.getElementById("chords-tab-vowels")!,
  finals: document.getElementById("chords-tab-finals")!,
  briefs: document.getElementById("chords-tab-briefs")!,
};
const chordsPanels: Record<ChordsTableId, HTMLElement> = {
  initials: document.getElementById("chords-panel-initials")!,
  vowels: document.getElementById("chords-panel-vowels")!,
  finals: document.getElementById("chords-panel-finals")!,
  briefs: document.getElementById("chords-panel-briefs")!,
};

function setChordsSubTab(active: ChordsTableId): void {
  chordsActiveSubTab = active;
  if (chordsColumnizeInput) chordsColumnizeInput.value = columnizeChar[active] ?? "";
  (["initials", "vowels", "finals", "briefs"] as const).forEach((id) => {
    const isActive = active === id;
    const btn = chordsSubTabButtons[id];
    const panel = chordsPanels[id];
    if (!btn || !panel) return;
    btn.classList.toggle("border-gray-200", isActive);
    btn.classList.toggle("border-transparent", !isActive);
    btn.classList.toggle("bg-white", isActive);
    btn.classList.toggle("text-indigo-600", isActive);
    btn.classList.toggle("bg-gray-100", !isActive);
    btn.classList.toggle("text-gray-600", !isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
    panel.classList.toggle("hidden", !isActive);
  });
  renderChordsTable(active);
}

const CHORDS_COL_LABELS = ["Index", "Stroke", "Translation"] as const;
const MAX_CHORD_TABLE_ROWS = 1000;
const CHORDS_SEARCH_DEBOUNCE_MS = 150;

function filterChordsData(data: Record<string, string>, query: string, by: "stroke" | "outline"): Record<string, string> {
  const q = query.trim().toLowerCase();
  if (!q) return data;
  const col = by === "stroke" ? 0 : 1;
  return Object.fromEntries(
    Object.entries(data).filter(([stroke, outline]) => {
      const val = col === 0 ? stroke : outline;
      return (val ?? "").toLowerCase().includes(q);
    })
  );
}

const MAX_COLUMNIZE_CHARS = 6;

/** Unique columnize characters in order, capped to avoid 2^n explosion. */
function getColumnizeChars(str: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of str) {
    if (!seen.has(ch) && out.length < MAX_COLUMNIZE_CHARS) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

/** Column label for combination index k (0 = none, else chars whose bits are set). */
function columnizeLabel(k: number, chars: string[]): string {
  if (k === 0) return "none";
  return chars.filter((_, i) => (k >> i) & 1).join("");
}

/** Combination index for a stroke: which columnize chars are present (bits set). */
function strokeComboIndex(stroke: string, chars: string[]): number {
  let k = 0;
  for (let i = 0; i < chars.length; i++) {
    if (stroke.includes(chars[i]!)) k |= 1 << i;
  }
  return k;
}

/** Base stroke with all columnize chars removed. */
function baseStroke(stroke: string, chars: string[]): string {
  let base = stroke;
  for (const ch of chars) {
    base = base.replace(new RegExp(ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
  }
  return base;
}

/** Group by base stroke; each base has 2^n slots (one per combination). */
function buildColumnizedRows(
  data: Record<string, string>,
  chars: string[]
): (string | string)[][] {
  const numCombos = 1 << chars.length;
  const map = new Map<string, string[]>();
  for (const [stroke, translation] of Object.entries(data)) {
    const base = baseStroke(stroke, chars);
    let row = map.get(base);
    if (!row) {
      row = [base, ...Array.from({ length: numCombos }, () => "")];
      map.set(base, row);
    }
    const k = strokeComboIndex(stroke, chars);
    row[k + 1] = translation;
  }
  return Array.from(map.values());
}

/** Filter columnized rows by search query. row[0] = base stroke, row[1..] = translations. */
function filterColumnizedRows(
  rows: (string | string)[][],
  query: string,
  by: "stroke" | "outline"
): (string | string)[][] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  if (by === "stroke") {
    return rows.filter((row) => (String(row[0] ?? "").toLowerCase().includes(q)));
  }
  return rows.filter((row) =>
    row.some((cell, j) => j > 0 && String(cell ?? "").toLowerCase().includes(q))
  );
}

function fillChordTable(
  tbody: HTMLElement,
  data: Record<string, string>,
  sortCol: 0 | 1 | 2 = 1,
  sortDir: 1 | -1 = 1,
  maxRows = MAX_CHORD_TABLE_ROWS
): void {
  tbody.innerHTML = "";
  const entries = Object.entries(data);
  const dataCol = sortCol === 0 ? 1 : sortCol;
  entries.sort((a, b) => {
    const va = a[dataCol - 1];
    const vb = b[dataCol - 1];
    const c = (va || "").localeCompare(vb || "", undefined, { sensitivity: "base", numeric: true });
    return c * sortDir;
  });
  const total = entries.length;
  const toRender = total <= maxRows ? entries : entries.slice(0, maxRows);
  const frag = document.createDocumentFragment();
  toRender.forEach(([stroke, outline], i) => {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    tr.innerHTML = `<td class="px-3 py-1.5 text-gray-600">${i + 1}</td><td class="px-3 py-1.5 font-mono text-gray-800">${escapeHtml(stroke || "∅")}</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(outline)}</td>`;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  if (total > maxRows) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 bg-gray-50";
    tr.innerHTML = `<td colspan="3" class="px-3 py-2 text-sm text-gray-500">Showing first ${maxRows.toLocaleString()} of ${total.toLocaleString()} entries. Narrow the search to see more.</td>`;
    tbody.appendChild(tr);
  }
}

function fillChordTableColumnized(
  tbody: HTMLElement,
  rows: (string | string)[][],
  numCols: number,
  sortCol: number,
  sortDir: 1 | -1,
  maxRows = MAX_CHORD_TABLE_ROWS
): void {
  tbody.innerHTML = "";
  const dataCol = sortCol === 0 ? 0 : sortCol - 1;
  const sorted = [...rows].sort((a, b) => {
    const va = String(a[dataCol] ?? "");
    const vb = String(b[dataCol] ?? "");
    const c = va.localeCompare(vb, undefined, { sensitivity: "base", numeric: true });
    return c * sortDir;
  });
  const total = sorted.length;
  const toRender = total <= maxRows ? sorted : sorted.slice(0, maxRows);
  const frag = document.createDocumentFragment();
  toRender.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    const indexCell = `<td class="px-3 py-1.5 text-gray-600">${i + 1}</td>`;
    const dataCells = row.map((val, j) => {
      const css = j === 0 ? "font-mono text-gray-800" : "text-gray-700";
      return `<td class="px-3 py-1.5 ${css}">${escapeHtml(String(val ?? ""))}</td>`;
    });
    tr.innerHTML = indexCell + dataCells.join("");
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  if (total > maxRows) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 bg-gray-50";
    tr.innerHTML = `<td colspan="${numCols}" class="px-3 py-2 text-sm text-gray-500">Showing first ${maxRows.toLocaleString()} of ${total.toLocaleString()} entries. Narrow the search to see more.</td>`;
    tbody.appendChild(tr);
  }
}

function updateChordsSortIndicators(
  section: Element,
  col: number,
  dir: 1 | -1,
  labels?: string[]
): void {
  const ths = section.querySelectorAll("thead th");
  const arrow = dir === 1 ? " ↑" : " ↓";
  const names = labels ?? CHORDS_COL_LABELS;
  ths.forEach((th, i) => {
    th.textContent = (names[i] ?? "") + (i === col ? arrow : "");
  });
}

function renderChordsTable(tableId: ChordsTableId): void {
  const { col, dir } = chordsSortState[tableId];
  const section = chordsTables.querySelector(`[data-chords-table="${tableId}"]`);
  const theadRow = section?.querySelector("thead tr");
  const chars = getColumnizeChars(columnizeChar[tableId] ?? "");
  const numCols = chars.length ? 2 + (1 << chars.length) : 3;
  if (chars.length > 0 && theadRow) {
    // Columnize first, then filter (so stroke search matches base stroke, e.g. "TB" shows -TB row with all H/R variants).
    const rows = filterColumnizedRows(
      buildColumnizedRows(chordsTableData[tableId], chars),
      chordsSearchQuery,
      chordsSearchBy
    );
    const stateCol = Math.max(0, Math.min(col, numCols - 1));
    const thClass =
      "chords-th text-left px-3 py-2 border-b border-gray-200 font-medium cursor-pointer select-none hover:bg-gray-200";
    const labels = ["Index", "Stroke", ...Array.from({ length: 1 << chars.length }, (_, k) => columnizeLabel(k, chars))];
    (theadRow as HTMLElement).innerHTML = labels
      .map((label) => `<th class="${thClass}" scope="col">${escapeHtml(label)}</th>`)
      .join("");
    fillChordTableColumnized(chordsTbodies[tableId], rows, numCols, stateCol, dir, MAX_CHORD_TABLE_ROWS);
    if (section) updateChordsSortIndicators(section, stateCol, dir, labels);
  } else {
    const data = filterChordsData(chordsTableData[tableId], chordsSearchQuery, chordsSearchBy);
    if (theadRow) {
      (theadRow as HTMLElement).innerHTML =
        '<th class="chords-th text-left px-3 py-2 border-b border-gray-200 font-medium cursor-pointer select-none hover:bg-gray-200" scope="col">Index</th><th class="chords-th text-left px-3 py-2 border-b border-gray-200 font-medium cursor-pointer select-none hover:bg-gray-200" scope="col">Stroke</th><th class="chords-th text-left px-3 py-2 border-b border-gray-200 font-medium cursor-pointer select-none hover:bg-gray-200" scope="col">Translation</th>';
    }
    const sortCol = Math.max(0, Math.min(col, 2)) as 0 | 1 | 2;
    fillChordTable(chordsTbodies[tableId], data, sortCol, dir);
    if (section) updateChordsSortIndicators(section, sortCol, dir);
  }
}

function renderAllChordsTables(): void {
  renderChordsTable(chordsActiveSubTab);
}

function handleChordsThClick(ev: Event): void {
  const th = (ev.target as HTMLElement).closest("th");
  if (!th?.classList.contains("chords-th")) return;
  const section = th.closest("section");
  const tableId = section?.getAttribute("data-chords-table") as ChordsTableId | null;
  if (!tableId || !chordsTbodies[tableId]) return;
  const chars = getColumnizeChars(columnizeChar[tableId] ?? "");
  const numCols = chars.length ? 2 + (1 << chars.length) : 3;
  const col = Math.min(th.cellIndex, numCols - 1);
  const state = chordsSortState[tableId];
  const newDir: 1 | -1 = state.col === col ? (state.dir === 1 ? -1 : 1) : 1;
  chordsSortState[tableId] = { col, dir: newDir };
  renderChordsTable(tableId);
}

chordsTables.addEventListener("click", handleChordsThClick);

(["initials", "vowels", "finals", "briefs"] as const).forEach((id) => {
  chordsSubTabButtons[id]?.addEventListener("click", () => setChordsSubTab(id));
});

let chordsSearchDebounce: ReturnType<typeof setTimeout> | null = null;
function scheduleChordsSearchUpdate(): void {
  if (chordsSearchDebounce != null) clearTimeout(chordsSearchDebounce);
  chordsSearchDebounce = setTimeout(() => {
    chordsSearchDebounce = null;
    chordsSearchQuery = chordsSearchInput.value;
    renderAllChordsTables();
    syncUrlFromControls();
  }, CHORDS_SEARCH_DEBOUNCE_MS);
}

chordsSearchInput.addEventListener("input", () => {
  scheduleChordsSearchUpdate();
});
chordsSearchInput.addEventListener("change", () => {
  if (chordsSearchDebounce != null) {
    clearTimeout(chordsSearchDebounce);
    chordsSearchDebounce = null;
  }
  chordsSearchQuery = chordsSearchInput.value;
  renderAllChordsTables();
  syncUrlFromControls();
});
document.querySelectorAll<HTMLInputElement>('input[name="chords-search-by"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    chordsSearchBy = radio.value as "stroke" | "outline";
    renderAllChordsTables();
  });
});

chordsColumnizeInput.addEventListener("input", () => {
  const raw = chordsColumnizeInput.value;
  columnizeChar[chordsActiveSubTab] = raw;
  renderAllChordsTables();
});
chordsColumnizeInput.addEventListener("change", () => {
  const raw = chordsColumnizeInput.value.trim();
  columnizeChar[chordsActiveSubTab] = raw;
  chordsColumnizeInput.value = raw;
  renderAllChordsTables();
});

async function loadAndRenderChords(): Promise<void> {
  const source = versionEl.value;
  chordsStatus.textContent = "Loading…";
  chordsStatus.classList.remove("hidden");
  chordsSearch.classList.add("hidden");
  chordsSubtabs.classList.add("hidden");
  chordsTables.classList.add("hidden");
  try {
    let data: ChordData;
    if (source === "custom") {
      if (!customChordData) {
        chordsStatus.textContent = "Paste valid chord JSON in Config, or choose a version.";
        chordsStatus.classList.remove("hidden");
        return;
      }
      data = customChordData;
    } else {
      const res = await fetch(`chord-versions/${chordFileName(source)}`);
      if (!res.ok) throw new Error(res.statusText);
      data = (await res.json()) as ChordData;
    }
    const rawInitials = data.initials ?? {};
    const rawBriefs = data.briefs ?? {};
    const hasBriefs = Object.keys(rawBriefs).length > 0;
    chordsTableData = {
      initials: Object.fromEntries(Object.entries(rawInitials).filter(([k]) => k !== "")),
      vowels: data.vowels ?? {},
      finals: data.finals ?? {},
      briefs: rawBriefs,
    };
    chordsBriefsTab.classList.toggle("hidden", !hasBriefs);
    chordsSearch.classList.remove("hidden");
    chordsSubtabs.classList.remove("hidden");
    chordsTables.classList.remove("hidden");
    if (!hasBriefs && chordsActiveSubTab === "briefs") setChordsSubTab("initials");
    setChordsSubTab(chordsActiveSubTab);
    chordsStatus.classList.add("hidden");
    renderAllChordsTables();
  } catch (e) {
    chordsStatus.textContent = "Failed to load chord data.";
    chordsStatus.classList.remove("hidden");
    chordsSearch.classList.add("hidden");
    chordsSubtabs.classList.add("hidden");
    chordsTables.classList.add("hidden");
  }
}

function setActiveTab(active: "lookup" | "chords" | "csv" | "config" | "jsonbuilder"): void {
  for (const [t, el] of [
    ["lookup", tabLookup],
    ["chords", tabChords],
    ["csv", tabCsv],
    ["config", tabConfig],
    ["jsonbuilder", tabJsonBuilder],
  ] as const) {
    const on = active === t;
    el.classList.toggle("border-indigo-500", on);
    el.classList.toggle("text-indigo-600", on);
    el.classList.toggle("border-transparent", !on);
    el.classList.toggle("text-gray-600", !on);
    el.setAttribute("aria-current", on ? "page" : "false");
  }
  panelLookup.classList.toggle("hidden", active !== "lookup");
  panelChords.classList.toggle("hidden", active !== "chords");
  panelCsv.classList.toggle("hidden", active !== "csv");
  panelConfig.classList.toggle("hidden", active !== "config");
  panelJsonBuilder.classList.toggle("hidden", active !== "jsonbuilder");
  headerSaveCsvBtn.classList.toggle("hidden", active !== "chords" && active !== "csv");
  if (active === "chords") loadAndRenderChords();
}

function switchTab(tab: "lookup" | "chords" | "csv" | "config" | "jsonbuilder"): void {
  setActiveTab(tab);
}

function escapeCsv(val: string): string {
  if (!/[\n",]/.test(val)) return val;
  return '"' + val.replace(/"/g, '""') + '"';
}

function saveChordsTabToCsv(): void {
  const tableId = chordsActiveSubTab;
  const chars = getColumnizeChars(columnizeChar[tableId] ?? "");
  const { col: sortCol, dir: sortDir } = chordsSortState[tableId];
  const version = versionEl.value;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tabLabel = tableId === "initials" ? "initials" : tableId === "vowels" ? "vowels" : tableId === "finals" ? "finals" : "briefs";
  let csv: string;
  let filename: string;
  if (chars.length > 0) {
    const rows = filterColumnizedRows(
      buildColumnizedRows(chordsTableData[tableId], chars),
      chordsSearchQuery,
      chordsSearchBy
    );
    const numCols = 2 + (1 << chars.length);
    const stateCol = Math.max(0, Math.min(sortCol, numCols - 1));
    const dataCol = stateCol === 0 ? 0 : stateCol - 1;
    const sorted = [...rows].sort((a, b) => {
      const va = String(a[dataCol] ?? "");
      const vb = String(b[dataCol] ?? "");
      const c = va.localeCompare(vb, undefined, { sensitivity: "base", numeric: true });
      return c * sortDir;
    });
    const labels = ["Stroke", ...Array.from({ length: 1 << chars.length }, (_, k) => columnizeLabel(k, chars))];
    const header = labels.map((l) => escapeCsv(l)).join(",") + "\n";
    const body = sorted
      .map((row) => row.map((cell) => escapeCsv(String(cell ?? ""))).join(","))
      .join("\n");
    csv = header + body;
    filename = `pinchord-chords-${tabLabel}-${version}-${timestamp}.csv`;
  } else {
    const data = filterChordsData(chordsTableData[tableId], chordsSearchQuery, chordsSearchBy);
    const dataCol = sortCol === 0 ? 1 : sortCol;
    const entries = Object.entries(data).sort((a, b) => {
      const va = a[dataCol - 1] ?? "";
      const vb = b[dataCol - 1] ?? "";
      return (va as string).localeCompare(vb as string, undefined, { sensitivity: "base", numeric: true }) * sortDir;
    });
    const header = "Stroke,Translation\n";
    const body = entries.map(([stroke, outline]) => `${escapeCsv(stroke)},${escapeCsv(outline)}`).join("\n");
    csv = header + body;
    filename = `pinchord-chords-${tabLabel}-${version}-${timestamp}.csv`;
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function saveCsvTabToCsv(): void {
  const version = versionEl.value;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let csv: string;
  let filename: string;
  if (csvActiveTableTab === "chords") {
    const sorted = [...csvChordsTableData].sort((a, b) => csvChordsSortCompare(a, b, csvChordsSortCol, csvChordsSortDir));
    const header = "Index,Key,Output,Type,Pct,Examples\n";
    const rows = sorted.map((r, i) => {
      const examplesStr = r.examples.slice(0, 5).join(", ");
      return `${i + 1},${escapeCsv(r.key)},${escapeCsv(r.output)},${escapeCsv(r.type)},${r.pct.toFixed(1)},${escapeCsv(examplesStr)}`;
    }).join("\n");
    csv = header + rows;
    filename = `pinchord-getchords-${version}-${timestamp}.csv`;
  } else {
    const header = "Index,Word,Chord output,Output,Word length,Chord count\n";
    const rows = csvTableData.map((r, i) => {
      const count = getCsvChordCount(r);
      return `${i + 1},${escapeCsv(r.word)},${escapeCsv(r.chordOutput)},${escapeCsv(r.output)},${r.word.length},${count}`;
    }).join("\n");
    csv = header + rows;
    filename = `pinchord-fewest-chords-${version}-${timestamp}.csv`;
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

csvComputeBtn.addEventListener("click", () => {
  if (versionEl.value === "custom" && !customChordData) {
    csvStatusEl.textContent = "Paste valid chord JSON in the Config tab first.";
    return;
  }
  const text = csvWordsEl.value.trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  csvTableData = [];
  csvRowBuffer = [];
  csvTbody.innerHTML = "";
  csvSortCol = 0;
  csvSortDir = 1;
  updateCsvSortIndicators();
  if (words.length === 0) {
    csvStatusEl.textContent = "Enter words separated by whitespace.";
    return;
  }
  csvWordQueue = [...words];
  csvTotalWords = words.length;
  csvComputeBtn.setAttribute("disabled", "");
  processNextCsvWord();
});

headerSaveCsvBtn.addEventListener("click", () => {
  const tab = getTabFromHash();
  if (tab === "chords") saveChordsTabToCsv();
  else if (tab === "csv") saveCsvTabToCsv();
});

// JSON Builder tab
const jsonbuilderCsvSeparator = document.getElementById("jsonbuilder-csv-separator") as HTMLSelectElement;
const jsonbuilderCsvSeparatorCustom = document.getElementById("jsonbuilder-csv-separator-custom") as HTMLInputElement;
const jsonbuilderInitials = document.getElementById("jsonbuilder-initials") as HTMLTextAreaElement;
const jsonbuilderInitialsCsv = document.getElementById("jsonbuilder-initials-csv") as HTMLInputElement;
const jsonbuilderVowels = document.getElementById("jsonbuilder-vowels") as HTMLTextAreaElement;
const jsonbuilderVowelsCsv = document.getElementById("jsonbuilder-vowels-csv") as HTMLInputElement;
const jsonbuilderFinals = document.getElementById("jsonbuilder-finals") as HTMLTextAreaElement;
const jsonbuilderFinalsCsv = document.getElementById("jsonbuilder-finals-csv") as HTMLInputElement;
const jsonbuilderPrefixes = document.getElementById("jsonbuilder-prefixes") as HTMLTextAreaElement;
const jsonbuilderSuffixes = document.getElementById("jsonbuilder-suffixes") as HTMLTextAreaElement;
const jsonbuilderBankInitials = document.getElementById("jsonbuilder-bank-initials") as HTMLInputElement;
const jsonbuilderBankVowels = document.getElementById("jsonbuilder-bank-vowels") as HTMLInputElement;
const jsonbuilderBankFinals = document.getElementById("jsonbuilder-bank-finals") as HTMLInputElement;
const jsonbuilderBriefs = document.getElementById("jsonbuilder-briefs") as HTMLTextAreaElement;
const jsonbuilderKeyOrder = document.getElementById("jsonbuilder-keyorder") as HTMLInputElement;
const jsonbuilderBuildCopyBtn = document.getElementById("jsonbuilder-build-copy")!;
const jsonbuilderLoadConfigBtn = document.getElementById("jsonbuilder-load-config")!;
const jsonbuilderStatus = document.getElementById("jsonbuilder-status")!;

/** Parse "key value" per line (first whitespace separates key from value). */
function parseKeyValueLines(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = s.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\S+)\s+(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
    else out[t] = "";
  }
  return out;
}

const JSONBUILDER_PLACEHOLDER_KEYVAL = {
  initials: "B b\nC c\nBC p",
  vowels: "A a\nO o\nEU eu",
  finals: "N n\nS s\nNG ng",
} as const;

function getJsonbuilderCsvPlaceholder(sep: string): string {
  const s = sep || ",";
  return `Stroke${s}Translation\nB${s}b\nC${s}c`;
}

function getJsonbuilderCsvSeparator(): string {
  const mode = jsonbuilderCsvSeparator?.value ?? "tab";
  if (mode === "tab") return "\t";
  if (mode === "custom") {
    const v = (jsonbuilderCsvSeparatorCustom?.value ?? "").trim();
    return v || "\t";
  }
  return ",";
}

function updateJsonbuilderCsvSeparatorUi(): void {
  const isCustom = jsonbuilderCsvSeparator?.value === "custom";
  if (jsonbuilderCsvSeparatorCustom) {
    jsonbuilderCsvSeparatorCustom.classList.toggle("hidden", !isCustom);
    if (isCustom && !jsonbuilderCsvSeparatorCustom.value.trim()) jsonbuilderCsvSeparatorCustom.placeholder = ",";
  }
}

function updateJsonbuilderPlaceholders(): void {
  const sep = getJsonbuilderCsvSeparator();
  const csvPlaceholder = getJsonbuilderCsvPlaceholder(sep);
  if (jsonbuilderInitials) {
    jsonbuilderInitials.placeholder = jsonbuilderInitialsCsv?.checked ? csvPlaceholder : JSONBUILDER_PLACEHOLDER_KEYVAL.initials;
  }
  if (jsonbuilderVowels) {
    jsonbuilderVowels.placeholder = jsonbuilderVowelsCsv?.checked ? csvPlaceholder : JSONBUILDER_PLACEHOLDER_KEYVAL.vowels;
  }
  if (jsonbuilderFinals) {
    jsonbuilderFinals.placeholder = jsonbuilderFinalsCsv?.checked ? csvPlaceholder : JSONBUILDER_PLACEHOLDER_KEYVAL.finals;
  }
}

/** Parse one CSV row (handles quoted fields). Supports single- or multi-char separator. */
function parseCsvRow(line: string, sep: string): string[] {
  const out: string[] = [];
  const s = sep || ",";
  const sepLen = s.length;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let cell = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          i++;
          if (line[i] === '"') {
            cell += '"';
            i++;
          } else break;
        } else {
          cell += line[i];
          i++;
        }
      }
      out.push(cell);
    } else {
      let cell = "";
      while (i < line.length) {
        const isSep = sepLen === 1 ? line[i] === s : line.slice(i, i + sepLen) === s;
        if (isSep) {
          i += sepLen;
          break;
        }
        cell += line[i];
        i++;
      }
      out.push(cell.trim());
    }
  }
  return out;
}

/** Parse CSV from Chords tab Save to CSV: header Index,Stroke,Translation or Index,Stroke,none,&,... */
function parseChordsCsvToRecord(csvText: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return out;
  const header = parseCsvRow(lines[0]!, sep);
  const strokeCol = header.indexOf("Stroke");
  if (strokeCol === -1) return out;
  const valueColStart = strokeCol + 1;
  const valueLabels = header.slice(valueColStart);
  for (let r = 1; r < lines.length; r++) {
    const row = parseCsvRow(lines[r]!, sep);
    const base = (row[strokeCol] ?? "").trim();
    if (!base) continue;
    for (let c = 0; c < valueLabels.length; c++) {
      const label = valueLabels[c] ?? "";
      const value = (row[valueColStart + c] ?? "").trim();
      const key = label === "none" ? base : base + label;
      if (key) out[key] = value;
    }
  }
  return out;
}

function formatKeyValueLines(rec: Record<string, string>): string {
  return Object.entries(rec)
    .map(([k, v]) => (v ? `${k} ${v}` : k))
    .join("\n");
}

function dropEmptyOutputs(rec: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== ""));
}

function buildJsonBuilderOutput(): { json: string; error?: string } {
  const csvSep = getJsonbuilderCsvSeparator();
  const initials = dropEmptyOutputs(
    jsonbuilderInitialsCsv?.checked
      ? parseChordsCsvToRecord(jsonbuilderInitials?.value ?? "", csvSep)
      : parseKeyValueLines(jsonbuilderInitials?.value ?? "")
  );
  const vowels = dropEmptyOutputs(
    jsonbuilderVowelsCsv?.checked
      ? parseChordsCsvToRecord(jsonbuilderVowels?.value ?? "", csvSep)
      : parseKeyValueLines(jsonbuilderVowels?.value ?? "")
  );
  const finals = dropEmptyOutputs(
    jsonbuilderFinalsCsv?.checked
      ? parseChordsCsvToRecord(jsonbuilderFinals?.value ?? "", csvSep)
      : parseKeyValueLines(jsonbuilderFinals?.value ?? "")
  );
  const prefixes = dropEmptyOutputs(parseKeyValueLines(jsonbuilderPrefixes?.value ?? ""));
  const suffixes = dropEmptyOutputs(parseKeyValueLines(jsonbuilderSuffixes?.value ?? ""));
  const bankInitials = (jsonbuilderBankInitials?.value ?? "").trim();
  const bankVowels = (jsonbuilderBankVowels?.value ?? "").trim();
  const bankFinals = (jsonbuilderBankFinals?.value ?? "").trim();
  const briefs = dropEmptyOutputs(parseKeyValueLines(jsonbuilderBriefs?.value ?? ""));
  const keyOrder = (jsonbuilderKeyOrder?.value ?? "").trim();

  const banks: { initials?: string; vowels?: string; finals?: string } = {};
  if (bankInitials) banks.initials = bankInitials;
  if (bankVowels) banks.vowels = bankVowels;
  if (bankFinals) banks.finals = bankFinals;

  const out: ChordData = {};
  if (Object.keys(initials).length > 0) out.initials = initials;
  if (Object.keys(vowels).length > 0) out.vowels = vowels;
  if (Object.keys(finals).length > 0) out.finals = finals;
  if (Object.keys(prefixes).length > 0) out.prefixes = prefixes;
  if (Object.keys(suffixes).length > 0) out.suffixes = suffixes;
  if (Object.keys(banks).length > 0) out.banks = banks;
  if (Object.keys(briefs).length > 0) out.briefs = briefs;
  if (keyOrder.length > 0) out.keyOrder = keyOrder;

  try {
    return { json: JSON.stringify(out, null, 2) };
  } catch (e) {
    return { json: "", error: e instanceof Error ? e.message : "Stringify failed" };
  }
}

jsonbuilderBuildCopyBtn.addEventListener("click", async () => {
  const { json, error } = buildJsonBuilderOutput();
  if (error) {
    jsonbuilderStatus.textContent = error;
    jsonbuilderStatus.classList.add("text-red-600");
    return;
  }
  try {
    await navigator.clipboard.writeText(json);
    jsonbuilderStatus.textContent = "Copied to clipboard.";
    jsonbuilderStatus.classList.remove("text-red-600");
  } catch {
    jsonbuilderStatus.textContent = "Copy failed (check permissions).";
    jsonbuilderStatus.classList.add("text-red-600");
  }
});

[jsonbuilderInitialsCsv, jsonbuilderVowelsCsv, jsonbuilderFinalsCsv].forEach((el) => {
  el?.addEventListener("change", updateJsonbuilderPlaceholders);
});
updateJsonbuilderCsvSeparatorUi();
jsonbuilderCsvSeparator?.addEventListener("change", () => {
  updateJsonbuilderCsvSeparatorUi();
  updateJsonbuilderPlaceholders();
});
jsonbuilderCsvSeparatorCustom?.addEventListener("input", updateJsonbuilderPlaceholders);
jsonbuilderCsvSeparatorCustom?.addEventListener("change", updateJsonbuilderPlaceholders);

jsonbuilderLoadConfigBtn.addEventListener("click", async () => {
  const version = versionEl.value;
  let d: ChordData | null = null;
  if (version === "custom") {
    d = customChordData;
    if (!d) {
      jsonbuilderStatus.textContent = "Paste chord JSON in the Config tab first.";
      jsonbuilderStatus.classList.remove("text-red-600");
      return;
    }
  } else {
    jsonbuilderStatus.textContent = "Loading…";
    jsonbuilderStatus.classList.remove("text-red-600");
    try {
      const res = await fetch(`chord-versions/${chordFileName(version)}`);
      if (!res.ok) throw new Error(res.statusText);
      d = (await res.json()) as ChordData;
    } catch (e) {
      jsonbuilderStatus.textContent = "Failed to load chord data.";
      jsonbuilderStatus.classList.add("text-red-600");
      return;
    }
  }
  if (!d) return;
  if (jsonbuilderInitials) jsonbuilderInitials.value = formatKeyValueLines(d.initials ?? {});
  if (jsonbuilderVowels) jsonbuilderVowels.value = formatKeyValueLines(d.vowels ?? {});
  if (jsonbuilderFinals) jsonbuilderFinals.value = formatKeyValueLines(d.finals ?? {});
  if (jsonbuilderPrefixes) jsonbuilderPrefixes.value = formatKeyValueLines(d.prefixes ?? {});
  if (jsonbuilderSuffixes) jsonbuilderSuffixes.value = formatKeyValueLines(d.suffixes ?? {});
  if (jsonbuilderBankInitials) jsonbuilderBankInitials.value = d.banks?.initials ?? "";
  if (jsonbuilderBankVowels) jsonbuilderBankVowels.value = d.banks?.vowels ?? "";
  if (jsonbuilderBankFinals) jsonbuilderBankFinals.value = d.banks?.finals ?? "";
  if (jsonbuilderBriefs) jsonbuilderBriefs.value = formatKeyValueLines(d.briefs ?? {});
  if (jsonbuilderKeyOrder) jsonbuilderKeyOrder.value = d.keyOrder ?? "";
  if (jsonbuilderInitialsCsv) jsonbuilderInitialsCsv.checked = false;
  if (jsonbuilderVowelsCsv) jsonbuilderVowelsCsv.checked = false;
  if (jsonbuilderFinalsCsv) jsonbuilderFinalsCsv.checked = false;
  updateJsonbuilderPlaceholders();
  jsonbuilderStatus.textContent = version === "custom" ? "Loaded from Config." : `Loaded ${version}.`;
  jsonbuilderStatus.classList.remove("text-red-600");
});

window.addEventListener("hashchange", () => {
  switchTab(getTabFromHash());
  syncUrlFromControls();
});

applyUrlParams();
updateConfigCustomVisibility();
switchTab(getTabFromHash());
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
