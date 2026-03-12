// Pinchord site – chord spelling via Web Worker

import { LayoutVisual } from "./LayoutVisual.js";

const versionEl = document.getElementById("version") as HTMLSelectElement;
const inputEl = document.getElementById("text-input") as HTMLInputElement;
const maxEntriesEl = document.getElementById("max-entries") as HTMLInputElement;
const outputEl = document.getElementById("chord-output")!;
const outputCountEl = document.getElementById("chord-output-count")!;

const configCustomJson = document.getElementById("config-custom-json") as HTMLTextAreaElement;
const configCustomStatus = document.getElementById("config-custom-status")!;

const URL_PARAM_VERSION = "version";
const URL_PARAM_TEXT = "text";
const URL_PARAM_MAX = "max";
const URL_PARAM_TAB = "tab";
const URL_PARAM_SEARCH = "search";

const DEFAULT_VERSION = "v26.0";
const DEFAULT_MAX = "100";

/** Chord JSON: initials, vowels, finals, suffixes, briefs, banks, and keyOrder (required). */
type ChordData = {
  initials?: Record<string, string>;
  vowels?: Record<string, string>;
  finals?: Record<string, string>;
  suffixes?: Record<string, string>;
  briefs?: Record<string, string>;
  banks?: { initials?: string; vowels?: string; finals?: string };
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

function getTabFromHash(): "lookup" | "chords" | "csv" | "config" {
  const hash = window.location.hash.slice(1).toLowerCase();
  if (hash === "chords") return "chords";
  if (hash === "csv") return "csv";
  if (hash === "config") return "config";
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

function buildRow(display: string, strokes: Stroke[]): string {
  const chords = display.split(" / ");
  const slash = '<span class="text-gray-400 text-sm px-0.5">/</span>';
  const boxes = chords
    .map((c, chordIndex) => {
      const stroke = strokes[chordIndex] ?? ["", "", "", ""];
      const [initial, vowel, final, suffix] = stroke;
      const attrs = `data-initial="${escapeHtml(initial)}" data-vowel="${escapeHtml(vowel)}" data-final="${escapeHtml(final)}" data-suffix="${escapeHtml(suffix)}" data-chord-index="${chordIndex}"`;
      const label = chordIndex > 0 ? "+" + c : c;
      return `<span class="chord-box inline-block rounded border border-gray-300 bg-white px-2 py-0.5 text-sm font-medium text-gray-800 cursor-pointer hover:bg-gray-100" ${attrs}>${escapeHtml(label)}</span>`;
    })
    .join(slash);
  return `<div class="flex flex-wrap gap-1.5 items-center h-[2.25rem] border-b border-gray-200 py-0">${boxes}</div>`;
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
let csvTableData: { word: string; chordOutput: string }[] = [];
let csvRowBuffer: { index: number; word: string; chordOutput: string }[] = [];
let csvWordQueue: string[] = [];
let csvCurrentWord = "";
let csvTotalWords = 0;

function flushCsvRowBuffer(): void {
  if (csvRowBuffer.length === 0) return;
  const frag = document.createDocumentFragment();
  for (const { index, word, chordOutput } of csvRowBuffer) {
    const chordCount = chordOutput ? chordOutput.split(" / ").length : 0;
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    tr.innerHTML = `<td class="px-3 py-1.5 text-gray-600">${index}</td><td class="px-3 py-1.5 text-gray-800">${escapeHtml(word)}</td><td class="px-3 py-1.5 text-gray-700 font-mono">${escapeHtml(chordOutput)}</td><td class="px-3 py-1.5 text-gray-600">${chordCount}</td>`;
    frag.appendChild(tr);
  }
  csvTbody.appendChild(frag);
  csvRowBuffer.length = 0;
}

function processNextCsvWord(): void {
  if (csvWordQueue.length === 0) {
    flushCsvRowBuffer();
    csvStatusEl.textContent = `Done. ${csvTableData.length} word(s).`;
    csvComputeBtn.removeAttribute("disabled");
    csvSaveBtn.removeAttribute("disabled");
    return;
  }
  csvCurrentWord = csvWordQueue.shift()!;
  const m = csvTableData.length + 1;
  csvStatusEl.textContent = `Computing: ${escapeHtml(csvCurrentWord)}… (${m} of ${csvTotalWords} entries)`;
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
    csvSaveBtn.removeAttribute("disabled");
  }
}

function chordOutputWithJoiner(display: string): string {
  const chords = display.split(" / ");
  return chords.map((c, i) => (i > 0 ? "+" + c : c)).join(" / ");
}

worker.onmessage = (e: MessageEvent<{ type: string; id: number; spellings?: string[]; ways?: Stroke[][]; total?: number; message?: string }>) => {
  const { type, id } = e.data;
  if (id === CSV_REQUEST_ID) {
    const pushRow = (chordOutput: string) => {
      csvTableData.push({ word: csvCurrentWord, chordOutput });
      csvRowBuffer.push({ index: csvTableData.length, word: csvCurrentWord, chordOutput });
      if (csvRowBuffer.length >= CSV_ROW_BATCH_SIZE) flushCsvRowBuffer();
      processNextCsvWord();
    };
    if (type === "chunk" && e.data.spellings !== undefined && e.data.spellings.length > 0) {
      pushRow(chordOutputWithJoiner(e.data.spellings[0]));
    } else if (type === "resultDone" && e.data.total === 0) {
      pushRow("");
    } else if (type === "error" && e.data.message !== undefined) {
      pushRow("");
    }
    return;
  }
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

/** Split key names into left (keyOrder indices 0–11) and right (12–23). Used for briefs. */
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
  const isBrief = initial.length > 0 && !vowel && !final && !suffix;
  if (isBrief) {
    const byHand = splitKeysByHand(initialKeys, keyNames);
    leftKeys = new Set([...byHand.left, ...suffixKeys]);
    rightKeys = new Set([...byHand.right, ...suffixKeys]);
  } else {
    leftKeys = new Set<string>([...initialKeys, ...suffixKeys]);
    rightKeys = new Set<string>([...finalKeys, ...suffixKeys]);
  }
  if (chordIndex > 0 && keyNames.includes("+")) {
    const joinerIdx = keyNames.indexOf("+");
    if (joinerIdx < 12) leftKeys.add("+");
    else rightKeys.add("+");
  }
  layoutVisual.setHighlightedKeys(leftKeys, rightKeys, centerKeys);
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
const panelLookup = document.getElementById("panel-lookup")!;
const panelChords = document.getElementById("panel-chords")!;
const panelCsv = document.getElementById("panel-csv")!;
const panelConfig = document.getElementById("panel-config")!;

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
const csvWordsEl = document.getElementById("csv-words") as HTMLTextAreaElement;
const csvComputeBtn = document.getElementById("csv-compute")!;
const csvSaveBtn = document.getElementById("csv-save")!;
const csvStatusEl = document.getElementById("csv-status")!;
const csvTbody = document.getElementById("csv-tbody")!;

// Chords tab tables
const chordsStatus = document.getElementById("chords-status")!;
const chordsSearch = document.getElementById("chords-search")!;
const chordsSearchInput = document.getElementById("chords-search-input") as HTMLInputElement;
const chordsTables = document.getElementById("chords-tables")!;
const chordsInitialsTbody = document.getElementById("chords-initials-tbody")!;
const chordsVowelsTbody = document.getElementById("chords-vowels-tbody")!;
const chordsFinalsTbody = document.getElementById("chords-finals-tbody")!;

const chordsBriefsTbody = document.getElementById("chords-briefs-tbody")!;
const chordsBriefsSection = document.getElementById("chords-briefs-section")!;

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

let chordsSortState: Record<ChordsTableId, { col: 0 | 1; dir: 1 | -1 }> = {
  initials: { col: 1, dir: 1 },
  vowels: { col: 1, dir: 1 },
  finals: { col: 1, dir: 1 },
  briefs: { col: 1, dir: 1 },
};

let chordsSearchQuery = "";
let chordsSearchBy: "stroke" | "outline" = "outline";

const CHORDS_COL_LABELS = ["Stroke", "Translation"] as const;
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

function fillChordTable(
  tbody: HTMLElement,
  data: Record<string, string>,
  sortCol: 0 | 1 = 0,
  sortDir: 1 | -1 = 1,
  maxRows = MAX_CHORD_TABLE_ROWS
): void {
  tbody.innerHTML = "";
  const entries = Object.entries(data);
  entries.sort((a, b) => {
    const va = a[sortCol];
    const vb = b[sortCol];
    const c = (va || "").localeCompare(vb || "", undefined, { sensitivity: "base", numeric: true });
    return c * sortDir;
  });
  const total = entries.length;
  const toRender = total <= maxRows ? entries : entries.slice(0, maxRows);
  const frag = document.createDocumentFragment();
  for (const [stroke, outline] of toRender) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    tr.innerHTML = `<td class="px-3 py-1.5 font-mono text-gray-800">${escapeHtml(stroke || "∅")}</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(outline)}</td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  if (total > maxRows) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 bg-gray-50";
    tr.innerHTML = `<td colspan="2" class="px-3 py-2 text-sm text-gray-500">Showing first ${maxRows.toLocaleString()} of ${total.toLocaleString()} entries. Narrow the search to see more.</td>`;
    tbody.appendChild(tr);
  }
}

function updateChordsSortIndicators(section: Element, col: 0 | 1, dir: 1 | -1): void {
  const ths = section.querySelectorAll("thead th");
  const arrow = dir === 1 ? " ↑" : " ↓";
  ths.forEach((th, i) => {
    th.textContent = CHORDS_COL_LABELS[i] + (i === col ? arrow : "");
  });
}

function renderChordsTable(tableId: ChordsTableId): void {
  const data = filterChordsData(chordsTableData[tableId], chordsSearchQuery, chordsSearchBy);
  const { col, dir } = chordsSortState[tableId];
  fillChordTable(chordsTbodies[tableId], data, col, dir);
  const section = chordsTables.querySelector(`[data-chords-table="${tableId}"]`);
  if (section) updateChordsSortIndicators(section, col, dir);
}

function renderAllChordsTables(): void {
  renderChordsTable("initials");
  renderChordsTable("vowels");
  renderChordsTable("finals");
  if (!chordsBriefsSection.classList.contains("hidden")) renderChordsTable("briefs");
}

function handleChordsThClick(ev: Event): void {
  const th = (ev.target as HTMLElement).closest("th");
  if (!th?.classList.contains("chords-th")) return;
  const section = th.closest("section");
  const tableId = section?.getAttribute("data-chords-table") as ChordsTableId | null;
  if (!tableId || !chordsTbodies[tableId]) return;
  const col = th.cellIndex as 0 | 1;
  const state = chordsSortState[tableId];
  const newDir: 1 | -1 = state.col === col ? (state.dir === 1 ? -1 : 1) : 1;
  chordsSortState[tableId] = { col, dir: newDir };
  renderChordsTable(tableId);
}

chordsTables.addEventListener("click", handleChordsThClick);

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

async function loadAndRenderChords(): Promise<void> {
  const source = versionEl.value;
  chordsStatus.textContent = "Loading…";
  chordsStatus.classList.remove("hidden");
  chordsSearch.classList.add("hidden");
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
    chordsBriefsSection.classList.toggle("hidden", !hasBriefs);
    chordsTables.classList.toggle("grid-cols-3", !hasBriefs);
    chordsTables.classList.toggle("grid-cols-4", hasBriefs);
    chordsSearch.classList.remove("hidden");
    chordsTables.classList.remove("hidden");
    chordsStatus.classList.add("hidden");
    renderAllChordsTables();
  } catch (e) {
    chordsStatus.textContent = "Failed to load chord data.";
    chordsStatus.classList.remove("hidden");
    chordsSearch.classList.add("hidden");
    chordsTables.classList.add("hidden");
  }
}

function setActiveTab(active: "lookup" | "chords" | "csv" | "config"): void {
  for (const [t, el] of [
    ["lookup", tabLookup],
    ["chords", tabChords],
    ["csv", tabCsv],
    ["config", tabConfig],
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
  if (active === "chords") loadAndRenderChords();
}

function switchTab(tab: "lookup" | "chords" | "csv" | "config"): void {
  setActiveTab(tab);
}

function escapeCsv(val: string): string {
  if (!/[\n",]/.test(val)) return val;
  return '"' + val.replace(/"/g, '""') + '"';
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
  if (words.length === 0) {
    csvStatusEl.textContent = "Enter words separated by whitespace.";
    return;
  }
  csvWordQueue = [...words];
  csvTotalWords = words.length;
  csvComputeBtn.setAttribute("disabled", "");
  csvSaveBtn.setAttribute("disabled", "");
  processNextCsvWord();
});

csvSaveBtn.addEventListener("click", () => {
  const header = "Index,Word,Chord output,Chord count\n";
  const rows = csvTableData.map((r, i) => {
    const count = r.chordOutput ? r.chordOutput.split(" / ").length : 0;
    return `${i + 1},${escapeCsv(r.word)},${escapeCsv(r.chordOutput)},${count}`;
  }).join("\n");
  const csv = header + rows;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const version = versionEl.value;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pinchord-fewest-chords-${version}-${timestamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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
