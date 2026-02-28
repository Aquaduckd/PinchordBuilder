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
const URL_PARAM_TAB = "tab";
const URL_PARAM_SEARCH = "search";

const DEFAULT_VERSION = "v26.0";
const DEFAULT_MAX = "100";

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

function getTabFromHash(): "lookup" | "chords" {
  const hash = window.location.hash.slice(1).toLowerCase();
  return hash === "chords" ? "chords" : "lookup";
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
  const tab = getTabFromHash();
  const text = inputEl.value.trim();
  const max = maxEntriesEl?.value.trim() ?? "";
  const search = chordsSearchInput?.value.trim() ?? "";
  if (version && version !== DEFAULT_VERSION) params.set(URL_PARAM_VERSION, version);
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
  if (getTabFromHash() === "chords") loadAndRenderChords();
});
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
const panelLookup = document.getElementById("panel-lookup")!;
const panelChords = document.getElementById("panel-chords")!;

// Chords tab tables
const chordsStatus = document.getElementById("chords-status")!;
const chordsSearch = document.getElementById("chords-search")!;
const chordsSearchInput = document.getElementById("chords-search-input") as HTMLInputElement;
const chordsTables = document.getElementById("chords-tables")!;
const chordsInitialsTbody = document.getElementById("chords-initials-tbody")!;
const chordsVowelsTbody = document.getElementById("chords-vowels-tbody")!;
const chordsFinalsTbody = document.getElementById("chords-finals-tbody")!;

type ChordsTableId = "initials" | "vowels" | "finals";
const chordsTbodies: Record<ChordsTableId, HTMLElement> = {
  initials: chordsInitialsTbody,
  vowels: chordsVowelsTbody,
  finals: chordsFinalsTbody,
};

let chordsTableData: Record<ChordsTableId, Record<string, string>> = {
  initials: {},
  vowels: {},
  finals: {},
};

let chordsSortState: Record<ChordsTableId, { col: 0 | 1; dir: 1 | -1 }> = {
  initials: { col: 1, dir: 1 },
  vowels: { col: 1, dir: 1 },
  finals: { col: 1, dir: 1 },
};

let chordsSearchQuery = "";
let chordsSearchBy: "stroke" | "outline" = "outline";

const CHORDS_COL_LABELS = ["Stroke", "Translation"] as const;

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
  sortDir: 1 | -1 = 1
): void {
  tbody.innerHTML = "";
  const entries = Object.entries(data);
  entries.sort((a, b) => {
    const va = a[sortCol];
    const vb = b[sortCol];
    const c = (va || "").localeCompare(vb || "", undefined, { sensitivity: "base", numeric: true });
    return c * sortDir;
  });
  for (const [stroke, outline] of entries) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 last:border-0";
    tr.innerHTML = `<td class="px-3 py-1.5 font-mono text-gray-800">${escapeHtml(stroke || "∅")}</td><td class="px-3 py-1.5 text-gray-700">${escapeHtml(outline)}</td>`;
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

chordsSearchInput.addEventListener("input", () => {
  chordsSearchQuery = chordsSearchInput.value;
  renderAllChordsTables();
  syncUrlFromControls();
});
chordsSearchInput.addEventListener("change", () => {
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
  const version = versionEl.value;
  chordsStatus.textContent = "Loading…";
  chordsStatus.classList.remove("hidden");
  chordsSearch.classList.add("hidden");
  chordsTables.classList.add("hidden");
  try {
    const res = await fetch(`chord-versions/pinchord-chords-${version}.json`);
    if (!res.ok) throw new Error(res.statusText);
    const data = (await res.json()) as {
      initials?: Record<string, string>;
      vowels?: Record<string, string>;
      finals?: Record<string, string>;
    };
    const rawInitials = data.initials ?? {};
    chordsTableData = {
      initials: Object.fromEntries(Object.entries(rawInitials).filter(([k]) => k !== "")),
      vowels: data.vowels ?? {},
      finals: data.finals ?? {},
    };
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

function switchTab(tab: "lookup" | "chords"): void {
  const isLookup = tab === "lookup";
  tabLookup.classList.toggle("border-indigo-500", isLookup);
  tabLookup.classList.toggle("text-indigo-600", isLookup);
  tabLookup.classList.toggle("border-transparent", !isLookup);
  tabLookup.classList.toggle("text-gray-600", !isLookup);
  tabLookup.setAttribute("aria-current", isLookup ? "page" : "false");
  tabChords.classList.toggle("border-indigo-500", !isLookup);
  tabChords.classList.toggle("text-indigo-600", !isLookup);
  tabChords.classList.toggle("border-transparent", isLookup);
  tabChords.classList.toggle("text-gray-600", isLookup);
  tabChords.setAttribute("aria-current", !isLookup ? "page" : "false");
  panelLookup.classList.toggle("hidden", !isLookup);
  panelChords.classList.toggle("hidden", isLookup);
  if (tab === "chords") loadAndRenderChords();
}

window.addEventListener("hashchange", () => {
  switchTab(getTabFromHash());
  syncUrlFromControls();
});

applyUrlParams();
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
