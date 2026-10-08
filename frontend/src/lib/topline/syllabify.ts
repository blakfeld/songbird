import type { ToplineSyllable } from "@/generated/ToplineSyllable";

export type { ToplineSyllable };

// The backend rejects longer syllables, so an over-long run of letters or digits is cut rather than sent.
const MAX_SYLLABLE_CHARS = 16;

const VOWELS = new Set(Array.from("aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ"));
const PLAIN_VOWELS = new Set(Array.from("aeiouàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ"));

// Consonant units that never start a syllable, so a lone one stays with the vowel before it (`sing-ing`, `tax-i`).
const CODA_ONLY = new Set(["ng", "ck", "gh", "x", "'"]);
const DIGRAPHS = new Set(["th", "ch", "sh", "ph", "wh", "ck", "gh"]);

// Onsets that may open a syllable together; any other cluster gives only its last consonant to the next syllable.
const ONSETS = new Set([
  "bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "tr",
  "sc", "sk", "sl", "sm", "sn", "sp", "st", "sw", "tw", "wr",
  "thr", "shr", "phr", "chr", "thw", "str", "spr", "spl", "scr", "squ",
]);

const FUNCTION_WORDS = new Set([
  "n",
  "a", "an", "the", "and", "or", "nor", "but", "if", "so", "as", "than",
  "of", "to", "in", "on", "at", "by", "for", "from", "with",
  "my", "your", "his", "her", "its", "our", "their",
  "i", "me", "you", "him", "us", "them", "he", "she", "it", "we", "they",
  "am", "is", "are", "was", "were", "be", "been", "do", "does", "did",
  "can", "will", "would", "could", "should", "shall", "may", "might", "must",
  "has", "have", "had",
  "i'm", "i'll", "i've", "i'd", "you're", "you'll", "you've", "you'd",
  "we're", "we'll", "we've", "we'd", "he's", "he'd", "he'll", "she's", "she'd", "she'll",
  "it's", "they're", "they'll", "they've", "they'd",
]);

// Lowercase letters of a syllable are unstressed and one uppercase syllable marks the stress; a single-syllable
// entry is stressed only when written in capitals. Kept for words the rules get wrong in everyday lyrics.
const EXCEPTIONS: Record<string, string> = {
  every: "EV-er-y",
  everyone: "EV-ery-one",
  everything: "EV-ery-thing",
  everybody: "EV-ery-bod-y",
  everywhere: "EV-ery-where",
  ever: "EV-er",
  never: "NEV-er",
  forever: "for-EV-er",
  whatever: "what-EV-er",
  whenever: "when-EV-er",
  however: "how-EV-er",
  river: "RIV-er",
  seven: "SEV-en",
  heaven: "HEAV-en",
  city: "CIT-y",
  money: "MON-ey",
  honey: "HON-ey",
  body: "BOD-y",
  lover: "LOV-er",
  maybe: "MAY-be",
  any: "AN-y",
  many: "MAN-y",
  able: "A-ble",
  being: "BE-ing",
  isle: "ISLE",
  aisle: "AISLE",
  rhythm: "RHY-thm",
  public: "PUB-lic",
  unknown: "un-KNOWN",
  somewhere: "SOME-where",
  someone: "SOME-one",
  something: "SOME-thing",
  hello: "hel-LO",
  region: "RE-gion",
  asleep: "a-SLEEP",
  forget: "for-GET",
  forgive: "for-GIVE",
  idea: "i-DE-a",
  create: "cre-ATE",
  creation: "cre-A-tion",
  poem: "PO-em",
  poet: "PO-et",
  quiet: "QUI-et",
  really: "REAL-ly",
  people: "PEO-ple",
  angel: "AN-gel",
  anger: "AN-ger",
  danger: "DAN-ger",
  finger: "FIN-ger",
  hunger: "HUN-ger",
  linger: "LIN-ger",
  stranger: "STRAN-ger",
  argue: "AR-gue",
  onion: "ON-ion",
  under: "UN-der",
  uncle: "UN-cle",
  tonight: "to-NIGHT",
  today: "to-DAY",
  tomorrow: "to-MOR-row",
  together: "to-GETH-er",
  devil: "DEV-il",
  demon: "DE-mon",
  mister: "MIS-ter",
  exit: "EX-it",
  player: "PLAY-er",
  prayer: "PRAY-er",
  lawyer: "LAW-yer",
  flower: "FLOW-er",
  power: "POW-er",
  shower: "SHOW-er",
  tower: "TOW-er",
  interesting: "IN-ter-est-ing",
  chocolate: "CHOC-o-late",
  different: "DIF-fer-ent",
  evening: "EVE-ning",
  camera: "CAM-er-a",
  business: "BUS-i-ness",
};

interface ExceptionEntry {
  parts: string[];
  stress: number;
}

function parseExceptions(): Map<string, ExceptionEntry> {
  const table = new Map<string, ExceptionEntry>();
  for (const [word, spec] of Object.entries(EXCEPTIONS)) {
    const raw = spec.split("-");
    const stress = raw.findIndex((p) => p === p.toUpperCase());
    table.set(word, { parts: raw.map((p) => p.toLowerCase()), stress });
  }
  return table;
}

const EXCEPTION_TABLE = parseExceptions();

interface Span {
  start: number;
  end: number;
}

const isPlainVowel = (c: string | undefined) => c !== undefined && PLAIN_VOWELS.has(c);

function classifyLetters(s: string[]): boolean[] {
  const isVowel = s.map((c) => VOWELS.has(c));
  s.forEach((c, i) => {
    if (c === "u" && (s[i - 1] === "q" || (s[i - 1] === "g" && "aeiy".includes(s[i + 1] ?? "-")))) {
      isVowel[i] = false;
    }
  });
  s.forEach((c, i) => {
    if (c === "y") {
      const nextVowel = isPlainVowel(s[i + 1]);
      if (i === 0 && nextVowel) isVowel[i] = false;
      else if (isVowel[i - 1] && nextVowel && s[i + 1] !== "i") isVowel[i] = false;
    } else if (c === "w") {
      // Only a trailing `w` after a vowel belongs to it (`how`, `know`); before a vowel it is a consonant (`a-way`).
      isVowel[i] = Boolean(isVowel[i - 1]) && !isPlainVowel(s[i + 1]) && s[i + 1] !== "y";
    }
  });
  return isVowel;
}

const SILENT_E_SUFFIX = /^(ly|ty|less|lessly|ment|ments|ness|ful|fully)$/;

// Unlike other silent e letters, the e of a final consonant-plus-`le` sounds (ta-ble), so the splitter must be told which one to keep.
function applySilentE(s: string[], isVowel: boolean[]): number {
  const n = s.length;
  const consonant = (i: number) => i >= 0 && !isVowel[i];
  const vowelBefore = (i: number) => isVowel.slice(0, i).some(Boolean);
  const sibilant = (i: number) =>
    "sxzcgj".includes(s[i]) || (s[i] === "h" && "cs".includes(s[i - 1] ?? "-"));

  if (s[n - 1] === "e" && s[n - 2] === "l" && consonant(n - 3) && vowelBefore(n - 3)) return n - 1;
  // Plural and past forms of -le words keep the syllable (`tables`, `troubled`).
  if (s[n - 2] === "e" && "sd".includes(s[n - 1]) && s[n - 3] === "l" && consonant(n - 4) && vowelBefore(n - 4)) {
    return n - 2;
  }
  if (s[n - 1] === "e" && consonant(n - 2) && vowelBefore(n - 2)) isVowel[n - 1] = false;
  if (s[n - 2] === "e" && s[n - 1] === "d" && consonant(n - 3) && !"td".includes(s[n - 3]) && vowelBefore(n - 2)) {
    isVowel[n - 2] = false;
  }
  if (s[n - 2] === "e" && s[n - 1] === "s" && consonant(n - 3) && !sibilant(n - 3) && vowelBefore(n - 2)) {
    isVowel[n - 2] = false;
  }
  for (let i = 2; i < n - 1; i++) {
    if (s[i] === "e" && isVowel[i] && consonant(i - 1) && isVowel[i - 2] && SILENT_E_SUFFIX.test(s.slice(i + 1).join(""))) {
      isVowel[i] = false;
    }
  }
  return -1;
}

const HIATUS = new Set(["ia", "io", "iu", "eo", "ua", "uo", "ii", "yi"]);

// Adjacent vowel letters normally share a syllable (`rain`); these pairs open a new one unless a suffix like -tion keeps them.
function splitsInside(s: string[], j: number, group: Span): boolean {
  const pair = s[j - 1] + s[j];
  if (j === group.end - 1 && s[j] === "i" && s[group.end] === "n" && s[group.end + 1] === "g" && group.end - group.start >= 2) {
    return true;
  }
  if (!HIATUS.has(pair)) return false;
  const before = s[j - 2];
  const doubledL = before === "l" && s[j - 3] === "l";
  if (pair === "io") {
    if (s[j + 1] === "n" && (doubledL || (before !== undefined && "tscgxn".includes(before)))) return false;
    if (s[j + 1] === "u" && before !== undefined && "tcgx".includes(before)) return false;
  }
  if (pair === "ia" && (doubledL || (before !== undefined && "tcsx".includes(before)))) return false;
  return true;
}

function vowelGroups(s: string[], isVowel: boolean[]): Span[] {
  const groups: Span[] = [];
  let i = 0;
  while (i < s.length) {
    if (!isVowel[i]) {
      i++;
      continue;
    }
    const group = { start: i, end: i };
    while (group.end < s.length && isVowel[group.end]) group.end++;
    let from = group.start;
    for (let j = group.start + 1; j < group.end; j++) {
      if (splitsInside(s, j, group)) {
        groups.push({ start: from, end: j });
        from = j;
      }
    }
    groups.push({ start: from, end: group.end });
    i = group.end;
  }
  return groups;
}

interface Unit {
  text: string;
  start: number;
}

function consonantUnits(s: string[], isVowel: boolean[], from: number, to: number): Unit[] {
  const units: Unit[] = [];
  let i = from;
  while (i < to) {
    const two = s[i] + (s[i + 1] ?? "");
    const quLike = (s[i] === "q" || s[i] === "g") && s[i + 1] === "u" && !isVowel[i + 1];
    const ng = two === "ng" && !"rl".includes(s[i + 2] ?? "-") && !(s[i + 2] === "u" && !isVowel[i + 2]);
    if (i + 1 < to && (DIGRAPHS.has(two) || quLike || ng)) {
      units.push({ text: two, start: i });
      i += 2;
    } else {
      units.push({ text: s[i], start: i });
      i++;
    }
  }
  return units;
}

function syllableStart(s: string[], isVowel: boolean[], from: number, to: number): number {
  const units = consonantUnits(s, isVowel, from, to);
  const last = units.at(-1);
  if (!last) return to;
  if (CODA_ONLY.has(last.text)) return to;
  for (let k = units.length - 2; k >= 0; k--) {
    if (units[k].text === units[k + 1].text) return units[k + 1].start;
  }
  for (const size of [3, 2]) {
    if (size > units.length) continue;
    const tail = units.slice(-size);
    // `s` plus a consonant stays split (`sis-ter`), unlike `a-fraid`.
    const sCluster = size === units.length && tail[0].text === "s";
    if (!sCluster && ONSETS.has(tail.map((u) => u.text).join(""))) return tail[0].start;
  }
  return last.start;
}

function splitLetters(word: string): string[] {
  const s = Array.from(word);
  const isVowel = classifyLetters(s);
  if (!isVowel.some(Boolean)) return [word];
  const leVowel = applySilentE(s, isVowel);
  const groups = vowelGroups(s, isVowel);
  const cuts: number[] = [];
  for (let g = 0; g + 1 < groups.length; g++) {
    const { end } = groups[g];
    const next = groups[g + 1];
    const isIngSuffix = next.start === s.length - 3 && s.slice(-3).join("") === "ing";
    const single = consonantUnits(s, isVowel, end, next.start).length === 1;
    if (isIngSuffix && single) {
      // Dictionaries close the stem before -ing (`mak-ing`, `dream-ing`) rather than opening it with the consonant.
      cuts.push(next.start);
    } else if (next.start === leVowel) {
      cuts.push(syllableStart(s, isVowel, end, leVowel - 1));
    } else {
      cuts.push(syllableStart(s, isVowel, end, next.start));
    }
  }
  const bounds = [0, ...cuts, s.length];
  return bounds.slice(0, -1).map((from, i) => s.slice(from, bounds[i + 1]).join(""));
}

const PREFIXES = new Set(["a", "be", "de", "re", "un", "dis", "ex", "pre", "en", "em", "mis"]);
const STRESS_BEFORE = ["tion", "sion", "cian", "cial", "tial", "ical", "ic", "ity", "ious", "eous"];

function stressIndex(parts: string[]): number {
  const word = parts.join("");
  const base = word.endsWith("s") ? word.slice(0, -1) : word;
  for (const suffix of STRESS_BEFORE) {
    const matched = word.endsWith(suffix) ? word : base.endsWith(suffix) ? base : null;
    if (!matched) continue;
    const at = matched.length - suffix.length;
    let seen = 0;
    for (let i = 0; i < parts.length; i++) {
      seen += parts[i].length;
      if (seen > at) return Math.max(0, i - 1);
    }
  }
  if (PREFIXES.has(parts[0])) return 1;
  return 0;
}

const isStressedWord = (word: string, parts: string[]): number =>
  parts.length === 1 ? (FUNCTION_WORDS.has(word) ? -1 : 0) : stressIndex(parts);

function lookupException(word: string): ExceptionEntry | undefined {
  const direct = EXCEPTION_TABLE.get(word);
  if (direct) return direct;
  const base = word.endsWith("s") ? EXCEPTION_TABLE.get(word.slice(0, -1)) : undefined;
  if (!base) return undefined;
  const parts = [...base.parts];
  parts[parts.length - 1] += "s";
  return { parts, stress: base.stress };
}

function shape(parts: string[], stressAt: number): ToplineSyllable[] {
  return parts.map((part, i) => {
    const last = i === parts.length - 1;
    const room = last ? MAX_SYLLABLE_CHARS : MAX_SYLLABLE_CHARS - 1;
    const text = Array.from(part).slice(0, room).join("") + (last ? "" : "-");
    return { text, stressed: i === stressAt };
  });
}

const CONTRACTION = /^[\p{L}]+'(s|t|m|d|ll|re|ve)$/u;
const LATIN_WORD = /^[\p{Script=Latin}']+$/u;

// Exposed per word because the dialog regroups syllables by word to offer a re-split.
export function syllabifyWord(word: string): ToplineSyllable[] {
  const lower = word.toLowerCase().replace(/[’ʼ]/g, "'").replace(/^'+|'+$/g, "");
  if (lower === "") return [];
  if (!LATIN_WORD.test(lower) || CONTRACTION.test(lower)) {
    return shape([lower], FUNCTION_WORDS.has(lower) ? -1 : 0);
  }
  const exception = lookupException(lower);
  if (exception) {
    return shape(exception.parts, exception.parts.length === 1 && exception.stress < 0 ? -1 : exception.stress);
  }
  const parts = splitLetters(lower);
  return shape(parts, isStressedWord(lower, parts));
}

const WORD = /[\p{L}\p{M}\p{N}'’ʼ]+/gu;

export function lineWords(text: string): string[] {
  return (text.match(WORD) ?? []).filter((w) => /[^'’ʼ]/.test(w));
}

export function syllabifyLine(text: string): ToplineSyllable[] {
  return lineWords(text).flatMap(syllabifyWord);
}

// Blank lines are skipped here so every caller counts the same lines the backend validates.
export function lyricLines(sectionBody: string): string[] {
  return sectionBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const letters = (s: string) => s.toLowerCase().replace(/[’ʼ]/g, "'");

// Comparing letters lets a correction move syllable boundaries only; a different spelling would silently change what is sung.
export function resplitWord(word: string, hyphenated: string): ToplineSyllable[] | null {
  const parts = hyphenated.split("-");
  if (parts.some((p) => p === "" || /\s/.test(p))) return null;
  const lower = letters(word).replace(/^'+|'+$/g, "");
  if (letters(parts.join("")) !== lower) return null;
  const typed = parts.map(letters);
  return shape(typed, isStressedWord(lower, typed));
}
