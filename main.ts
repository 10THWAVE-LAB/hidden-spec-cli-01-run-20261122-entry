// mend: one patch tool for every AI edit format.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits) and applies every edit to the tree in the
// working directory, or none at all. SPEC.md is the whole contract;
// this file is my own implementation of it, written from the spec.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// Thrown for the exit-2 failures: the single line to print.
class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

// Thrown by one edit when it fails: its code and the path it concerns.
class EditFail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

// A patch's lines: split at \n, one trailing \r removed from each, and
// without the empty piece after a final \n.
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// A file seen as lines: its own line break, its lines, and whether it
// ends with a line break.
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// --- Section 5: matching lines at three tiers ---

function trimEndSpacesTabs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function trimBothSpacesTabs(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(a, b);
}

function leadingSpacesTabs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function tierForm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndSpacesTabs(s);
  return trimBothSpacesTabs(s);
}

// Every start position where oldLines occur in fileLines at this tier,
// at or after `from`. Occurrences may overlap.
function spotsAtTier(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const last = fileLines.length - oldLines.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (tierForm(fileLines[i + j], tier) !== tierForm(oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 when strict) with at least
// one occurrence at or after `from`, and those occurrences. When
// endOnly, only occurrences ending at the file's last line count.
function firstTierWith(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
  endOnly: boolean,
): { tier: number; spots: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    let spots = spotsAtTier(fileLines, oldLines, t, from);
    if (endOnly) spots = spots.filter((i) => i + oldLines.length === fileLines.length);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

// One line of N: a context line names its index in O (it is written as
// the file's own matched line); an added line has ctx null.
interface NewLine {
  text: string;
  ctx: number | null;
}

// Build the lines that replace a match at position `at`: context lines
// come from the file itself, and at tier 2 every other non-blank line
// starting with O's first-line indent is re-indented to the file's.
function buildReplacement(
  items: NewLine[],
  fileLines: string[],
  at: number,
  oldLines: string[],
  tier: number,
): string[] {
  let fileLead = '';
  let patchLead = '';
  if (tier === 2 && oldLines.length > 0) {
    fileLead = leadingSpacesTabs(fileLines[at]);
    patchLead = leadingSpacesTabs(oldLines[0]);
  }
  const out: string[] = [];
  for (const item of items) {
    if (item.ctx !== null) {
      out.push(fileLines[at + item.ctx]);
      continue;
    }
    let s = item.text;
    if (tier === 2 && s.trim() !== '' && s.startsWith(patchLead)) {
      s = fileLead + s.slice(patchLead.length);
    }
    out.push(s);
  }
  return out;
}

// --- The tree as the edits leave it ---

type EditFn = (tree: Tree) => void;

class Tree {
  origCache = new Map<string, string | null>();
  state = new Map<string, string | null>();
  moves: Array<{ from: string; to: string }> = [];

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p) as string | null;
  }

  current(p: string): string | null {
    return this.state.has(p) ? (this.state.get(p) as string | null) : this.original(p);
  }

  snapshot(): { state: Map<string, string | null>; moves: Array<{ from: string; to: string }> } {
    return { state: new Map(this.state), moves: this.moves.slice() };
  }

  restore(s: { state: Map<string, string | null>; moves: Array<{ from: string; to: string }> }): void {
    this.state = s.state;
    this.moves = s.moves;
  }
}

// --- Section 6: unified diffs ---

interface Hunk {
  a: number;
  oldLines: string[];
  newItems: NewLine[];
  backslashAfterLast: boolean;
  backslashAfterLastPlus: boolean | null;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_DIFF_LINE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

function isHunkBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function buildHunk(a: number, body: string[]): Hunk {
  const oldLines: string[] = [];
  const newItems: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k];
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = k;
    if (l.startsWith('+')) lastPlus = k;
  }
  const followedByBackslash = (idx: number): boolean =>
    idx >= 0 && idx + 1 < body.length && body[idx + 1].startsWith('\\');
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      oldLines.push(text);
      newItems.push({ text, ctx: oldLines.length - 1 });
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      newItems.push({ text: l.slice(1), ctx: null });
    }
  }
  return {
    a,
    oldLines,
    newItems,
    backslashAfterLast: followedByBackslash(lastCtxPlus),
    backslashAfterLastPlus: lastPlus < 0 ? null : followedByBackslash(lastPlus),
  };
}

interface UnifiedSection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

// The path of a --- or +++ line: text after the four characters, up to
// the first tab, surrounding spaces removed; /dev/null means no file;
// one leading a/ or b/ removed.
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let pairSeen = false;
  let pastHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (s: UnifiedSection, pair: boolean): void => {
    sections.push(s);
    cur = s;
    pairSeen = pair;
    pastHeader = false;
  };
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = GIT_DIFF_LINE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(
        {
          dashOld: undefined,
          dashNew: undefined,
          renameFrom: undefined,
          renameTo: undefined,
          gitOld: m[1],
          gitNew: m[2],
          newFile: false,
          deletedFile: false,
          hunks: [],
        },
        false,
      );
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      pastHeader = true;
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const lj = lines[j];
        if (lj.startsWith('diff --git ')) break;
        if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (!isHunkBodyLine(lj)) break;
        body.push(lj);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(Number(m[1]), body));
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = dashPath(line);
      const newP = dashPath(lines[i + 1]);
      if (cur !== null && !pastHeader && !pairSeen) {
        cur.dashOld = oldP;
        cur.dashNew = newP;
        pairSeen = true;
      } else {
        startSection(
          {
            dashOld: oldP,
            dashNew: newP,
            renameFrom: undefined,
            renameTo: undefined,
            gitOld: undefined,
            gitNew: undefined,
            newFile: false,
            deletedFile: false,
            hunks: [],
          },
          true,
        );
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !pastHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && !pastHeader) {
      if (line.startsWith('+++ ')) {
        cur.dashNew = dashPath(line);
      } else if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function resolveUnifiedPaths(s: UnifiedSection): { oldP: string | null; newP: string | null } {
  const oldP =
    s.dashOld !== undefined ? s.dashOld : s.renameFrom !== undefined ? s.renameFrom : (s.gitOld ?? '');
  const newP =
    s.dashNew !== undefined ? s.dashNew : s.renameTo !== undefined ? s.renameTo : (s.gitNew ?? '');
  return { oldP, newP };
}

function applyUnifiedHunks(startText: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = splitFile(startText);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      const ins = h.newItems.map((it) => it.text);
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !h.backslashAfterLast;
      d += h.newItems.length;
      continue;
    }
    const found = firstTierWith(f.lines, h.oldLines, strict, 0, false);
    if (found === null) throw new EditFail('no-match', failPath);
    const want = h.a - 1 + d;
    let best = found.spots[0];
    let bestDist = Math.abs(best - want);
    for (const s of found.spots) {
      const dist = Math.abs(s - want);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }
    const atEnd = best + h.oldLines.length === f.lines.length;
    const rep = buildReplacement(h.newItems, f.lines, best, h.oldLines, found.tier);
    f.lines.splice(best, h.oldLines.length, ...rep);
    if (atEnd) f.final = !h.backslashAfterLast;
    d += h.newItems.length - h.oldLines.length;
  }
  return joinFile(f);
}

function unifiedEdit(s: UnifiedSection, strict: boolean): EditFn {
  const { oldP, newP } = resolveUnifiedPaths(s);
  return (tree) => {
    if (oldP === null || s.newFile) {
      const target = newP ?? '';
      if (!isSafePath(target)) throw new EditFail('unsafe', target);
      if (tree.current(target) !== null) throw new EditFail('exists', target);
      const plus: string[] = [];
      let lastBs: boolean | null = null;
      for (const h of s.hunks) {
        for (const it of h.newItems) {
          if (it.ctx === null) plus.push(it.text);
        }
        if (h.backslashAfterLastPlus !== null) lastBs = h.backslashAfterLastPlus;
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastBs === true ? '' : '\n');
      tree.state.set(target, text);
      return;
    }
    if (newP === null || s.deletedFile) {
      const target = oldP ?? '';
      if (!isSafePath(target)) throw new EditFail('unsafe', target);
      if (tree.current(target) === null) throw new EditFail('missing', target);
      tree.state.set(target, null);
      return;
    }
    if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
    if (!isSafePath(newP)) throw new EditFail('unsafe', newP);
    const before = tree.current(oldP);
    if (before === null) throw new EditFail('missing', oldP);
    if (oldP !== newP) {
      if (tree.current(newP) !== null) throw new EditFail('exists', newP);
      const out = applyUnifiedHunks(before, s.hunks, strict, oldP);
      tree.state.set(oldP, null);
      tree.state.set(newP, out);
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    const out = applyUnifiedHunks(before, s.hunks, strict, oldP);
    tree.state.set(oldP, out);
  };
}

// --- Section 7: SEARCH/REPLACE blocks ---

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditFail('exists', path);
      tree.state.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.current(path);
    if (before === null) throw new EditFail('missing', path);
    const f = splitFile(before);
    const found = firstTierWith(f.lines, oldLines, strict, 0, false);
    if (found === null) throw new EditFail('no-match', path);
    if (found.spots.length > 1) throw new EditFail('ambiguous', path);
    const at = found.spots[0];
    const items: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(items, f.lines, at, oldLines, found.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.state.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    prevPath = path;
    prevEnd = rep;
    edits.push(
      makeSearchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict),
    );
    i = rep + 1;
  }
  return edits;
}

// --- Section 8: V4A patches ---

function makeV4aAdd(path: string, fileLines: string[]): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.current(path) !== null) throw new EditFail('exists', path);
    tree.state.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): EditFn {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (tree.current(path) === null) throw new EditFail('missing', path);
    tree.state.set(path, null);
  };
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newItems: NewLine[];
}

function makeV4aUpdate(
  path: string,
  raw: string[],
  rawIdx: number[],
  sectionLine: number,
  strict: boolean,
): EditFn {
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0].startsWith('*** Move to: ')) {
    moveTo = raw[0].slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (let k = start; k < raw.length; k += 1) {
    const l = raw[k];
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oldLines: [], newItems: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur !== null) {
        cur.eof = true;
        closeChunk();
      }
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) cur = { anchor: null, eof: false, oldLines: [], newItems: [] };
      if (l === '') {
        cur.oldLines.push('');
        cur.newItems.push({ text: '', ctx: cur.oldLines.length - 1 });
      } else if (l.startsWith(' ')) {
        const t = l.slice(1);
        cur.oldLines.push(t);
        cur.newItems.push({ text: t, ctx: cur.oldLines.length - 1 });
      } else if (l.startsWith('-')) {
        cur.oldLines.push(l.slice(1));
      } else {
        cur.newItems.push({ text: l.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${rawIdx[k] + 1}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.current(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.current(moveTo) !== null) throw new EditFail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundAt < 0; t += 1) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (tierForm(f.lines[k], t) === tierForm(ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new EditFail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.oldLines.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = ch.newItems.map((it) => it.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const found = firstTierWith(f.lines, ch.oldLines, strict, cursor, ch.eof);
        if (found === null) throw new EditFail('no-match', path);
        const at = found.spots[0];
        const rep = buildReplacement(ch.newItems, f.lines, at, ch.oldLines, found.tier);
        f.lines.splice(at, ch.oldLines.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.state.set(path, null);
      tree.state.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.state.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  let first = -1;
  let last = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (!isBlank(lines[k])) {
      if (first < 0) first = k;
      last = k;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: string | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i;
    const raw: string[] = [];
    const rawIdx: number[] = [];
    i += 1;
    while (i < last) {
      const l = lines[i];
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push(l);
      rawIdx.push(i);
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1])) {
      raw.pop();
      rawIdx.pop();
    }
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${rawIdx[k] + 1}`);
      }
      edits.push(makeV4aAdd(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (raw[k] !== '') throw new Exit2(`error: parse ${rawIdx[k] + 1}`);
      }
      edits.push(makeV4aDelete(path));
    } else {
      edits.push(makeV4aUpdate(path, raw, rawIdx, sectionLine, strict));
    }
  }
  return edits;
}

// --- Section 9: JSON edits ---

function jsonEditFn(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      tree.state.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.current(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.state.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const atLine = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.current(p);
      if (before === null) throw new EditFail('missing', p);
      const f = splitFile(before);
      if (atLine < 0 || atLine > f.lines.length) throw new EditFail('no-match', p);
      f.lines.splice(atLine, 0, ...add);
      tree.state.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: EditFn[] = [];
    for (const item of v) {
      const e = jsonEditFn(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: EditFn[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditFn(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 4: detecting the format ---

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// --- Sections 1, 2, 10: the command line, the output, the write ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const movedAway = new Set<string>();
  const movedInto = new Map<string, string>();
  for (const m of tree.moves) {
    if (
      tree.original(m.from) !== null &&
      tree.current(m.from) === null &&
      tree.original(m.to) === null &&
      tree.current(m.to) !== null
    ) {
      movedAway.add(m.from);
      movedInto.set(m.to, m.from);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.state.keys()) {
    const was = tree.original(p);
    const now = tree.state.get(p) as string | null;
    if (was === now) continue;
    if (movedAway.has(p)) continue;
    if (movedInto.has(p)) {
      rows.push({ key: p, line: `R ${movedInto.get(p)} -> ${p}` });
      continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    const changed = [...tree.state.keys()].filter((p) => tree.original(p) !== tree.state.get(p));
    for (const p of changed) {
      if (tree.state.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const v = tree.state.get(p);
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
