/**
 * The code change a P1 plan proposes, carried as the worker's real unified diff. The parser keeps only what the panel
 * renders — files, hunks, old/new line numbers and stats — so a plan card can summarize the change and the panel can
 * show it inline or side by side without re-reading prose. A diff that does not parse is refused instead of guessed at.
 */
export interface PlanDiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}
export interface PlanDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The text after the closing `@@`, which names the function or block a hunk starts in. */
  section?: string
  lines: PlanDiffLine[]
}
export type PlanDiffStatus = 'modified' | 'added' | 'deleted' | 'renamed'
export interface PlanDiffFile {
  path: string
  /** The path before a rename or a deletion; absent when the file keeps its name. */
  oldPath?: string
  status: PlanDiffStatus
  binary?: boolean
  added: number
  removed: number
  hunks: PlanDiffHunk[]
}
export interface PlanDiff {
  files: PlanDiffFile[]
  added: number
  removed: number
  /** What the diff compares against, such as a p4 revision or a git ref; the worker writes it. */
  base?: string
}
/**
 * Bounds that keep one diff inside what a card summary and a panel page can carry: a plan proposes a change, not a
 * whole-file rewrite, and a diff past these limits is refused rather than silently truncated.
 */
export const PLAN_DIFF_LIMITS = { chars: 200_000, lines: 6_000, files: 100, hunks: 400, base: 200 } as const
/** A parse result: the structured diff, or what makes the text unusable as a unified diff. */
export type PlanDiffParse = { diff: PlanDiff } | { problem: string }
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u
/** Git's file header and the per-file metadata a unified diff may carry before its hunks. */
const FILE_HEADER = /^(?:diff --git |index |old mode |new mode |similarity index |dissimilarity index |new file mode |deleted file mode |rename from |rename to |copy from |copy to )/u
const BINARY = /^(?:Binary files .* differ|GIT binary patch)$/u
/**
 * Decodes a path as a diff header writes it: git quotes paths with spaces, quotes or non-ASCII bytes and escapes them
 * with C-style `\"`, `\t` and octal bytes, while a plain `diff -u` leaves the path bare.
 */
function diffPath(raw: string): string {
  const bare = raw.replace(/\t[\d:. +-]*$/, '').trim()
  const quoted = /^"(.*)"$/su.exec(bare)
  if (!quoted) return bare
  const bytes: number[] = []
  const text = quoted[1] ?? ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char !== '\\') {
      bytes.push(...new TextEncoder().encode(char))
      continue
    }
    const next = text[++index]
    if (next === undefined) break
    const octal = /^[0-7]{1,3}/u.exec(text.slice(index))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff)
      index += octal[0].length - 1
      continue
    }
    const escape: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, '"': 34, '\\': 92 }
    bytes.push(escape[next] ?? next.codePointAt(0) ?? 63)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
/** The path a file header names, without git's `a/` or `b/` side prefix. */
function sidePath(line: string, side: 'a' | 'b'): string {
  const path = diffPath(line.slice(4))
  return path.startsWith(`${side}/`) ? path.slice(2) : path
}
/** Whether a header path is git's marker for a file that exists on only one side. */
const absent = (path: string): boolean => path === '/dev/null'
/** The two paths a `diff --git a/x b/y` header names; a quoted path keeps its spaces together. */
function gitHeaderPaths(line: string): { old: string; new: string } | undefined {
  const rest = line.slice('diff --git '.length)
  const paths: string[] = []
  for (let index = 0; index < rest.length && paths.length < 2;) {
    while (rest[index] === ' ') index++
    if (index >= rest.length) break
    if (rest[index] === '"') {
      let end = index + 1
      while (end < rest.length && !(rest[end] === '"' && rest[end - 1] !== '\\')) end++
      paths.push(diffPath(rest.slice(index, end + 1)))
      index = end + 1
    } else {
      const end = rest.indexOf(' ', index)
      if (end < 0) { paths.push(rest.slice(index)); break }
      paths.push(rest.slice(index, end))
      index = end
    }
  }
  if (paths.length < 2) return undefined
  const strip = (path: string, side: string): string => path.startsWith(`${side}/`) ? path.slice(2) : path
  return { old: strip(paths[0]!, 'a'), new: strip(paths[1]!, 'b') }
}
/** The file a pair of `---`/`+++` headers describes: added, deleted, renamed or modified, with its display path. */
function diffFile(oldPath: string, newPath: string): PlanDiffFile {
  const before = absent(oldPath) ? '' : oldPath
  const after = absent(newPath) ? '' : newPath
  const base = { added: 0, removed: 0, hunks: [] }
  if (!before) return { path: after, status: 'added', ...base }
  if (!after) return { path: before, status: 'deleted', ...base }
  if (before !== after) return { path: after, oldPath: before, status: 'renamed', ...base }
  return { path: after, status: 'modified', ...base }
}
/**
 * Parses a unified diff into the files and hunks the panel renders. Hunk bodies are consumed by their own line
 * counts, so a removed line that itself looks like a `---` header is never mistaken for one; a body that ends early,
 * runs long or contains a line a diff cannot produce becomes a `problem` the caller reports instead of a wrong diff.
 */
export function parsePlanDiff(text: string, base?: string): PlanDiffParse {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return { problem: 'the diff is empty' }
  if (normalized.length > PLAN_DIFF_LIMITS.chars) {
    return { problem: `the diff is ${normalized.length} characters; the limit is ${PLAN_DIFF_LIMITS.chars}` }
  }
  const lines = normalized.replace(/\n+$/u, '').split('\n')
  if (lines.length > PLAN_DIFF_LIMITS.lines) {
    return { problem: `the diff is ${lines.length} lines; the limit is ${PLAN_DIFF_LIMITS.lines}` }
  }
  const files: PlanDiffFile[] = []
  let current: PlanDiffFile | undefined
  /** The paths the next `+++` completes: a `diff --git` header or a `---` line starts them, and a binary marker uses them too. */
  let pending: { old: string; new?: string } | undefined
  let hunk: PlanDiffHunk | undefined
  let oldSeen = 0, newSeen = 0, hunks = 0, unknown = 0
  /** Git's binary patch payload is opaque lines that look like hunks; skip them to the next file header. */
  let binaryPayload = false
  const finish = () => { if (current) { files.push(current); if (files.length > PLAN_DIFF_LIMITS.files) return false } current = undefined; return true }
  const start = (oldPath: string, newPath: string): boolean => {
    if (!finish()) return false
    current = diffFile(oldPath, newPath)
    pending = undefined
    return true
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (binaryPayload) {
      if (/^(?:diff --git |--- )/u.test(line)) { binaryPayload = false } else continue
    }
    if (hunk) {
      if (line.startsWith('\\')) continue
      const sign = line[0]
      const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : sign === ' ' || line === '' ? 'same' : undefined
      if (!kind) return { problem: `line ${index + 1} is not a hunk line: ${JSON.stringify(line.slice(0, 40))}` }
      hunk.lines.push({ kind, text: line.slice(1) })
      if (kind !== 'add') oldSeen++
      if (kind !== 'del') newSeen++
      if (kind === 'add') current!.added++
      if (kind === 'del') current!.removed++
      if (oldSeen > hunk.oldLines || newSeen > hunk.newLines) {
        return { problem: `hunk at line ${index + 1} has more lines than its header counts` }
      }
      if (oldSeen === hunk.oldLines && newSeen === hunk.newLines) hunk = undefined
      continue
    }
    if (line.startsWith('--- ')) {
      pending = { old: sidePath(line, 'a'), ...pending?.new !== undefined ? { new: pending.new } : {} }
      continue
    }
    if (line.startsWith('+++ ')) {
      if (pending === undefined) return { problem: `line ${index + 1}: a +++ header without a --- header before it` }
      if (!start(pending.old, sidePath(line, 'b'))) return { problem: `the diff has more than ${PLAN_DIFF_LIMITS.files} files` }
      continue
    }
    const hunkHeader = HUNK.exec(line)
    if (hunkHeader) {
      if (!current) return { problem: `line ${index + 1}: a hunk without a file header` }
      if (++hunks > PLAN_DIFF_LIMITS.hunks) return { problem: `the diff has more than ${PLAN_DIFF_LIMITS.hunks} hunks` }
      hunk = { oldStart: Number(hunkHeader[1]), oldLines: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
        newStart: Number(hunkHeader[3]), newLines: hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]),
        ...hunkHeader[5]?.trim() ? { section: hunkHeader[5].trim() } : {}, lines: [] }
      oldSeen = 0; newSeen = 0
      current.hunks.push(hunk)
      continue
    }
    if (BINARY.test(line)) {
      // A binary file has no hunks: the header and this line are all a diff gives it, so it becomes a file entry too.
      if (!current && pending) {
        if (!start(pending.old, pending.new ?? pending.old)) return { problem: `the diff has more than ${PLAN_DIFF_LIMITS.files} files` }
      }
      if (current) current.binary = true
      if (line === 'GIT binary patch') binaryPayload = true
      continue
    }
    if (/^diff --git /u.test(line)) {
      if (!finish()) return { problem: `the diff has more than ${PLAN_DIFF_LIMITS.files} files` }
      pending = gitHeaderPaths(line)
      continue
    }
    if (FILE_HEADER.test(line) || line.startsWith('\\')) continue
    // Text between sections (a submodule notice, a mode-change summary) is not a hunk; keep it out of the diff, but
    // a document with no file header at all is not a unified diff and is refused below.
    if (line.trim()) unknown++
  }
  if (hunk) return { problem: 'the diff ends in the middle of a hunk' }
  if (!finish()) return { problem: `the diff has more than ${PLAN_DIFF_LIMITS.files} files` }
  if (!files.length) {
    return { problem: unknown ? 'it has no ---/+++ file headers' : 'it has no file changes' }
  }
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const label = base?.trim()
  if (label && Array.from(label).length > PLAN_DIFF_LIMITS.base) return { problem: `the base label is longer than ${PLAN_DIFF_LIMITS.base} characters` }
  return { diff: { files, added, removed, ...label ? { base: label } : {} } }
}
