/** A plan's code diff: the file index, then each file's hunks, readable inline or side by side like GitHub and GitLens. */
import { useState, type ReactNode } from 'react'
import type { PlanDiff, PlanDiffFile, PlanDiffHunk, PlanDiffLine } from '../core/diff.ts'
import { Icon } from './controls.tsx'
import type { DshSuperagentKey } from './locales.ts'
import { usePanel } from './provider.tsx'

type DiffMode = 'inline' | 'split'
/** The layout a person picked last, so every later diff opens the way they read code; private browsing keeps inline. */
const MODE_KEY = 'dsh-superagent.plan-diff-mode'
function readMode(): DiffMode {
  try { return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'inline' } catch { return 'inline' }
}
function rememberMode(mode: DiffMode): void {
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* a page that forbids storage still switches for this view */ }
}
/** A changed token run: `changed` marks what differs between the paired old and new line, not the whole line. */
interface Segment { text: string; changed: boolean }
/** One file's status as the badge says it; the letter is the same one a git diff header uses. */
const STATUS: Record<PlanDiffFile['status'], { letter: string; label: DshSuperagentKey }> = {
  added: { letter: 'A', label: 'planDiffAdded' },
  deleted: { letter: 'D', label: 'planDiffDeleted' },
  renamed: { letter: 'R', label: 'planDiffRenamed' },
  modified: { letter: 'M', label: 'planDiffModified' },
}
/** Tokens a line diff compares: words, whitespace runs, and each punctuation or CJK character on its own. */
const TOKEN = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/gu
const tokensOf = (text: string): string[] => text.match(TOKEN) ?? []
/** Above this many token pairs the per-line LCS is skipped: the line background already says what changed. */
const HIGHLIGHT_LIMIT = 40_000
/**
 * The tokens `a` and `b` share in order, as the indexes matched in each. A word-level LCS is what makes a changed
 * identifier stand out inside an otherwise unchanged line, which is the part a person actually reviews.
 */
function commonTokens(a: readonly string[], b: readonly string[]): { inA: Set<number>; inB: Set<number> } {
  const rows = a.length + 1, columns = b.length + 1
  const table = new Uint32Array(rows * columns)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * columns + j] = a[i] === b[j] ? table[(i + 1) * columns + j + 1]! + 1
        : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!)
    }
  }
  const inA = new Set<number>(), inB = new Set<number>()
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { inA.add(i); inB.add(j); i++; j++ }
    else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) i++
    else j++
  }
  return { inA, inB }
}
/** The tokens with the tokens outside the common run marked, merged into as few spans as possible. */
function segments(tokens: readonly string[], matched: Set<number>): Segment[] {
  const out: Segment[] = []
  tokens.forEach((token, index) => {
    const changed = !matched.has(index)
    const last = out[out.length - 1]
    if (last && last.changed === changed) last.text += token
    else out.push({ text: token, changed })
  })
  return out
}
/** The changed runs of each line in a hunk: a removed line and the added line that replaced it share their highlight. */
function highlights(hunk: PlanDiffHunk): (Segment[] | undefined)[] {
  const out: (Segment[] | undefined)[] = hunk.lines.map(() => undefined)
  const lines = hunk.lines
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind === 'same') { index++; continue }
    const removed: number[] = [], added: number[] = []
    while (index < lines.length && lines[index]!.kind === 'del') removed.push(index++)
    while (index < lines.length && lines[index]!.kind === 'add') added.push(index++)
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair++) {
      const left = lines[removed[pair]!]!, right = lines[added[pair]!]!
      const a = tokensOf(left.text), b = tokensOf(right.text)
      if (a.length * b.length > HIGHLIGHT_LIMIT) continue
      const common = commonTokens(a, b)
      out[removed[pair]!] = segments(a, common.inA)
      out[added[pair]!] = segments(b, common.inB)
    }
  }
  return out
}
/** A line's code, with the changed tokens marked when its pair on the other side differs. */
function code(text: string, segmentsOfLine: Segment[] | undefined): ReactNode {
  return segmentsOfLine && segmentsOfLine.some(segment => segment.changed)
    ? segmentsOfLine.map((segment, index) => segment.changed
      ? <mark className="dt-diff-mark" key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)
    : text
}
/** Where each line's old and new number goes; a hunk's header gives the first of each. */
function numbers(hunk: PlanDiffHunk): { old?: number; next?: number }[] {
  let old = hunk.oldStart, next = hunk.newStart
  return hunk.lines.map(line => {
    const row = { ...line.kind === 'add' ? {} : { old: old++ }, ...line.kind === 'del' ? {} : { next: next++ } }
    return row
  })
}
/** One hunk inline: both line numbers on the left and one column of code, the way a terminal diff reads. */
function InlineHunk({ hunk }: { hunk: PlanDiffHunk }) {
  const marks = highlights(hunk)
  const rowNumbers = numbers(hunk)
  return <div className="dt-diff-hunk">
    <div className="dt-diff-hunk-head">{hunkHead(hunk)}</div>
    {hunk.lines.map((line, index) => <div className="dt-diff-row" data-kind={line.kind} key={index}>
      <span className="dt-diff-no">{rowNumbers[index]?.old ?? ''}</span>
      <span className="dt-diff-no">{rowNumbers[index]?.next ?? ''}</span>
      <span className="dt-diff-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
      <code className="dt-diff-code">{code(line.text, marks[index])}</code>
    </div>)}
  </div>
}
/** The rows a hunk becomes side by side: a removed line paired with the added line that replaced it. */
interface SplitRow { left?: { no: number; line: PlanDiffLine }; right?: { no: number; line: PlanDiffLine } }
function splitRows(hunk: PlanDiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let old = hunk.oldStart, next = hunk.newStart
  for (let index = 0; index < hunk.lines.length;) {
    const line = hunk.lines[index]!
    if (line.kind === 'same') { rows.push({ left: { no: old++, line }, right: { no: next++, line } }); index++; continue }
    const removed: SplitRow['left'][] = [], added: SplitRow['right'][] = []
    while (index < hunk.lines.length && hunk.lines[index]!.kind === 'del') removed.push({ no: old++, line: hunk.lines[index++]! })
    while (index < hunk.lines.length && hunk.lines[index]!.kind === 'add') added.push({ no: next++, line: hunk.lines[index++]! })
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) rows.push({ left: removed[pair], right: added[pair] })
  }
  return rows
}
/** One hunk side by side: the old file on the left and the new one on the right, aligned row by row. */
function SplitHunk({ hunk }: { hunk: PlanDiffHunk }) {
  const rows = splitRows(hunk)
  const marks = highlights(hunk)
  const side = (cell: { no: number; line: PlanDiffLine } | undefined, _kind: 'old' | 'new') => {
    const index = cell ? hunk.lines.indexOf(cell.line) : -1
    return <div className="dt-diff-split-cell" data-kind={cell?.line.kind}>
      <span className="dt-diff-no">{cell?.no ?? ''}</span>
      <span className="dt-diff-sign" aria-hidden="true">{cell?.line.kind === 'add' ? '+' : cell?.line.kind === 'del' ? '−' : ' '}</span>
      <code className="dt-diff-code">{cell ? code(cell.line.text, index >= 0 ? marks[index] : undefined) : ''}</code>
    </div>
  }
  return <div className="dt-diff-hunk">
    <div className="dt-diff-hunk-head">{hunkHead(hunk)}</div>
    {rows.map((row, index) => <div className="dt-diff-split-row" key={index}>{side(row.left, 'old')}{side(row.right, 'new')}</div>)}
  </div>
}
/** `@@ -oldStart,oldLines +newStart,newLines @@ section`, which is how a diff says where it is. */
const hunkHead = (hunk: PlanDiffHunk): string =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ''}`
/** One file: its new path, the status a rename or a deletion needs, and its hunks in the chosen layout. */
function DiffFile({ file, anchor, mode }: { file: PlanDiffFile; anchor: string; mode: DiffMode }) {
  const { t } = usePanel()
  const status = STATUS[file.status]
  return <section className="dt-diff-file" aria-label={file.path}>
    <div className="dt-diff-file-head" id={anchor}>
      <span className="dt-diff-badge" data-status={file.status} title={t(status.label)}>{status.letter}</span>
      <code className="dt-diff-path">{file.path}</code>
      {file.oldPath && <span className="dt-diff-rename">{t('planDiffRename', { path: file.oldPath })}</span>}
      <span className="dt-diff-file-stat"><span className="dt-diff-added">+{file.added}</span><span className="dt-diff-removed">−{file.removed}</span></span>
    </div>
    {file.binary ? <p className="dt-diff-binary">{t('planDiffBinary')}</p>
      : file.hunks.map((hunk, index) => mode === 'split' ? <SplitHunk hunk={hunk} key={index} /> : <InlineHunk hunk={hunk} key={index} />)}
  </section>
}
/**
 * The plan's whole code change: how much it costs, a file index that jumps to each file, and every hunk. The layout
 * switch is one choice for the whole diff and is remembered, so a person who reads side by side keeps reading that way.
 */
export function PlanDiffView({ diff }: { diff: PlanDiff }) {
  const { t } = usePanel()
  const [mode, setMode] = useState<DiffMode>(readMode)
  const choose = (next: DiffMode) => { setMode(next); rememberMode(next) }
  const jump = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return <section className="dt-diff" aria-label={t('planDiffTitle')}>
    <header className="dt-diff-head">
      <div className="dt-diff-title">
        <Icon name="code" size={15} />
        <strong>{t('planDiffTitle')}</strong>
        <span className="dt-diff-count">{t('planDiffFiles', { count: diff.files.length })}</span>
        <span className="dt-diff-total"><span className="dt-diff-added">+{diff.added}</span><span className="dt-diff-removed">−{diff.removed}</span></span>
      </div>
      <div className="dt-diff-modes" role="group" aria-label={t('planDiffMode')}>
        <button type="button" className={`dt-pill${mode === 'inline' ? ' dt-pill-active' : ''}`} aria-pressed={mode === 'inline'}
          onClick={() => choose('inline')}>{t('planDiffInline')}</button>
        <button type="button" className={`dt-pill${mode === 'split' ? ' dt-pill-active' : ''}`} aria-pressed={mode === 'split'}
          onClick={() => choose('split')}>{t('planDiffSplit')}</button>
      </div>
    </header>
    {diff.base && <div className="dt-diff-base">{t('planDiffBase', { base: diff.base })}</div>}
    {diff.files.length > 1 && <nav className="dt-diff-index" aria-label={t('planDiffFiles', { count: diff.files.length })}>
      <ul>{diff.files.map((file, index) => <li key={`${file.path}-${index}`}>
        <button type="button" onClick={() => jump(`dt-diff-file-${index}`)}>
          <span className="dt-diff-badge" data-status={file.status}>{STATUS[file.status].letter}</span>
          <code>{file.path}</code>
          <span className="dt-diff-file-stat"><span className="dt-diff-added">+{file.added}</span><span className="dt-diff-removed">−{file.removed}</span></span>
        </button>
      </li>)}</ul>
    </nav>}
    {diff.files.map((file, index) => <DiffFile key={`${file.path}-${index}`} file={file} anchor={`dt-diff-file-${index}`} mode={mode} />)}
  </section>
}
