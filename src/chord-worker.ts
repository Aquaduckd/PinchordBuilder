// Web Worker: chord spelling computation (runs off main thread)
// Uses reverse maps (output → stroke keys) and split-point lookups, like 1PinSharp ChordFinder.

type ChordData = {
  initials?: Record<string, string>;
  vowels?: Record<string, string>;
  finals?: Record<string, string>;
  suffixes?: Record<string, string>;
  briefs?: Record<string, string>;
};

type Strokes = [string, string, string, string];

type RevMaps = {
  revInitials: Record<string, string[]>;
  revVowels: Record<string, string[]>;
  revFinals: Record<string, string[]>;
  revSuffixes: Record<string, string[]>;
  revBriefs: Record<string, string[]>;
};

function isLiteral(s: string): boolean {
  if (!s) return true;
  return !s.includes("{") && !s.includes("}") && !s.includes("|");
}

function literalPart(s: string): string {
  return isLiteral(s) ? s : "";
}

/** Build reverse map: literal output → list of stroke keys that produce it. */
function buildReverseMap(map: Record<string, string> | undefined): Record<string, string[]> {
  const rev: Record<string, string[]> = {};
  rev[""] = [""];
  for (const [key, value] of Object.entries(map ?? {})) {
    const out = literalPart(value);
    if (!rev[out]) rev[out] = [];
    rev[out].push(key);
  }
  return rev;
}

function buildRevMaps(data: ChordData): RevMaps {
  return {
    revInitials: buildReverseMap(data.initials),
    revVowels: buildReverseMap(data.vowels),
    revFinals: buildReverseMap(data.finals),
    revSuffixes: buildReverseMap(data.suffixes),
    revBriefs: buildReverseMap(data.briefs),
  };
}

function chordRepr(strokes: Strokes): string {
  const [i, v, f, s] = strokes;
  const fDisplay =
    f && f.startsWith("-") && !i && !v ? f : f?.startsWith("-") ? f.slice(1) : f;
  const raw = [i, v, fDisplay, s].join("") || "∅";
  return raw.replace(/\|/g, "&");
}

/** All chords that produce exactly the substring s (I+V+F+S plus briefs; same as repo TryFindAnyChord/FindChords). */
function getChordsForSubstring(s: string, rev: RevMaps): Strokes[] {
  const list: Strokes[] = [];
  const n = s.length;
  for (let p1 = 0; p1 <= n; p1++) {
    for (let p2 = p1; p2 <= n; p2++) {
      for (let p3 = p2; p3 <= n; p3++) {
        const s0 = s.slice(0, p1);
        const s1 = s.slice(p1, p2);
        const s2 = s.slice(p2, p3);
        const s3 = s.slice(p3, n);
        const keys0 = rev.revInitials[s0];
        const keys1 = rev.revVowels[s1];
        const keys2 = rev.revFinals[s2];
        const keys3 = rev.revSuffixes[s3];
        if (!keys0 || !keys1 || !keys2 || !keys3) continue;
        for (const k0 of keys0) {
          for (const k1 of keys1) {
            for (const k2 of keys2) {
              for (const k3 of keys3) {
                if (k0.length > 0 || k1.length > 0 || k2.length > 0 || k3.length > 0) {
                  list.push([k0, k1, k2, k3]);
                }
              }
            }
          }
        }
      }
    }
  }
  if (rev.revBriefs[s]) {
    for (const key of rev.revBriefs[s]) {
      if (key.length > 0) list.push([key, "", "", ""]);
    }
  }
  return list;
}

/** Chords whose output is a prefix of target, longest first. */
function getPrefixChords(target: string, rev: RevMaps): [string, Strokes][] {
  const list: [string, Strokes][] = [];
  for (let len = target.length; len >= 1; len--) {
    const prefix = target.slice(0, len);
    const chords = getChordsForSubstring(prefix, rev);
    for (const strokes of chords) {
      list.push([prefix, strokes]);
    }
  }
  return list;
}

/** One chord that produces the longest prefix of target (for greedy step). Returns (length, strokes) or (0, null). */
function findLongestChordPrefix(target: string, rev: RevMaps): [number, Strokes | null] {
  if (!target.length) return [0, null];
  for (let len = target.length; len >= 1; len--) {
    const prefix = target.slice(0, len);
    const chords = getChordsForSubstring(prefix, rev);
    if (chords.length > 0) return [len, chords[0]];
  }
  return [0, null];
}

/** Greedy shortest chord sequence (same as 1PinSharp FindShortestChordSequence). Returns null if no sequence exists. */
function findShortestChordSequence(target: string, rev: RevMaps): [string, Strokes][] | null {
  const way: [string, Strokes][] = [];
  let remaining = target;
  while (remaining.length > 0) {
    const [len, strokes] = findLongestChordPrefix(remaining, rev);
    if (len === 0 || strokes === null) return null;
    const segment = remaining.slice(0, len);
    way.push([segment, strokes]);
    remaining = remaining.slice(len);
  }
  return way;
}

function* findSpellingsGenerator(
  target: string,
  rev: RevMaps,
  memo: Record<string, [string, Strokes][][]> = {}
): Generator<[string, Strokes][]> {
  if (target === "") {
    memo[""] = [[]];
    yield [];
    return;
  }
  if (target in memo) {
    for (const way of memo[target]) yield way;
    return;
  }
  const chordList = getPrefixChords(target, rev);
  const ways: [string, Strokes][][] = [];
  for (const [out, strokes] of chordList) {
    const rest = target.slice(out.length);
    for (const restWay of findSpellingsGenerator(rest, rev, memo)) {
      const way: [string, Strokes][] = [[out, strokes], ...restWay];
      ways.push(way);
      yield way;
    }
  }
  memo[target] = ways;
}

const YIELD_EVERY = 5;

const CUSTOM_VERSION = "__custom__";

let currentJobId: number | null = null;
let jobRunning = false;
let pendingJob: {
  id: number;
  version?: string;
  data?: ChordData;
  target: string;
  maxEntries?: number;
} | null = null;

const cache: Record<string, ChordData> = {};
const revCache: Record<string, RevMaps> = {};

function getRevMaps(cacheKey: string, chordData: ChordData): RevMaps {
  let rev = revCache[cacheKey];
  if (!rev) {
    rev = buildRevMaps(chordData);
    revCache[cacheKey] = rev;
  }
  return rev;
}

async function startJob(
  id: number,
  target: string,
  maxEntries: number | undefined,
  version?: string,
  data?: ChordData
): Promise<void> {
  let chordData: ChordData;
  let cacheKey: string;
  if (data !== undefined) {
    cache[CUSTOM_VERSION] = data;
    chordData = data;
    cacheKey = CUSTOM_VERSION;
  } else if (version !== undefined) {
    chordData = cache[version];
    if (!chordData) {
      const fileName = version.startsWith("pinechord-")
        ? `pinechord-chords-${version.slice(10)}.json`
        : `pinchord-chords-${version}.json`;
      const res = await fetch(`../chord-versions/${fileName}`);
      if (!res.ok) throw new Error(`Failed to load ${version}`);
      chordData = (await res.json()) as ChordData;
      cache[version] = chordData;
    }
    cacheKey = version;
  } else {
    throw new Error("Either version or data must be provided");
  }
  const rev = getRevMaps(cacheKey, chordData);
  runJob(id, rev, target, maxEntries, (display, ways) => {
    if (currentJobId === id) self.postMessage({ type: "chunk", id, spellings: display, ways });
  });
}

function runJob(
  id: number,
  rev: RevMaps,
  target: string,
  maxEntries: number | undefined,
  onChunk: (display: string[], ways: Strokes[][]) => void
): void {
  jobRunning = true;
  (async () => {
    try {

      if (maxEntries === 1) {
        const way = findShortestChordSequence(target, rev);
        if (currentJobId === id) {
          if (way && way.length > 0) {
            const display = way.map(([, s]) => chordRepr(s)).join(" / ");
            const strokes = way.map(([, s]) => s);
            onChunk([display], [strokes]);
          }
          self.postMessage({ type: "resultDone", id, total: way && way.length > 0 ? 1 : 0 });
        }
        return;
      }

      const memo: Record<string, [string, Strokes][][]> = {};
      let total = 0;
      const gen = findSpellingsGenerator(target, rev, memo);
      let generatorDone = false;
      while (true) {
        const batch: [string, Strokes][][] = [];
        for (let i = 0; i < YIELD_EVERY; i++) {
          if (maxEntries !== undefined && total >= maxEntries) break;
          const { value, done } = gen.next();
          if (done) {
            generatorDone = true;
            break;
          }
          batch.push(value);
          total++;
        }
        for (const way of batch) {
          const display = way.map(([, s]) => chordRepr(s)).join(" / ");
          const strokes = way.map(([, s]) => s);
          onChunk([display], [strokes]);
        }
        if (generatorDone || (maxEntries !== undefined && total >= maxEntries)) {
          if (currentJobId === id) self.postMessage({ type: "resultDone", id, total });
          return;
        }
        await new Promise((r) => setTimeout(r, 0));
        if (currentJobId !== id) {
          const next = pendingJob;
          pendingJob = null;
          if (next) startJob(next.id, next.target, next.maxEntries, next.version, next.data);
          return;
        }
      }
    } finally {
      jobRunning = false;
    }
  })().catch((err) => {
    jobRunning = false;
    if (currentJobId === id) {
      self.postMessage({
        type: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

self.onmessage = (e: MessageEvent<{ type: string; id: number; version?: string; data?: ChordData; target: string; maxEntries?: number }>) => {
  const { type, id, version, data, target, maxEntries } = e.data;
  if (type !== "compute") return;
  currentJobId = id;
  pendingJob = { id, version, data, target, maxEntries };
  if (!jobRunning) {
    pendingJob = null;
    startJob(id, target, maxEntries, version, data).catch((err) => {
      currentJobId = null;
      self.postMessage({
        type: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }
};
