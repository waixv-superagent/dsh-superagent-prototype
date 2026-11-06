/** Whether a delivered change is in the shared editor a person is looking at (docs/021). */
import type { EditorView } from './editor.ts'
import type { EditorJob } from './editor-schedule.ts'

/**
 * What a person can tell about a delivered change in the editor right now: the newest build of the Ticket's own
 * workspace loaded into the running editor, a build exists but the editor has not loaded it, the change was not built
 * since it was delivered, no editor is running, or the timestamps are not enough to say.
 */
export type DeliveryEditorState = 'loaded' | 'restart' | 'build' | 'no-editor' | 'unknown'

/** The build the inference used, so the panel can name its time and workspace instead of only a verdict. */
export interface DeliveryBuildFact {
  id: string
  startedAt: string
  endedAt: string
  directory: string
  summary?: string
}

/** The readiness read: the state and the two timestamps it compares. */
export interface DeliveryEditorView {
  state: DeliveryEditorState
  /** The newest successful build of the Ticket's own workspace, whichever side of the delivery it is on. */
  build?: DeliveryBuildFact
  /** Interactive editor start times, newest first; empty when no editor runs or the probe is unreadable. */
  editors: string[]
}

/** Compare paths the way Windows and Perforce do: a build in another workspace must not count for this Ticket. */
const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

/** The interactive editors the probe sees, newest first; a row that would not report a start time cannot be ordered. */
function editorStarts(editor: EditorView | null): string[] {
  if (!editor) return []
  const rows = (editor.editors ?? []).flatMap(process => process.name === 'unrealeditor' && process.started ? [process.started] : [])
  if (rows.length) return [...new Set(rows)].sort((left, right) => Date.parse(right) - Date.parse(left))
  // A row from an older probe carries only the representative pid and start; it still answers "an editor is open".
  return editor.since && (editor.holder === 'person' || editor.holder === 'agent') ? [editor.since] : []
}

/**
 * Answers "is this delivered change in the editor I am looking at" from timestamps only, never from what a build or a
 * worker claimed: a successful build of the Ticket's own workspace must have started at or after the delivery (so it
 * read the delivered files), and the running editor must have started at or after that build ended (so it loaded them).
 * A build of another workspace is not evidence for this Ticket, which is why the directory is compared first.
 */
export function deliveryEditor(input: { deliveredAt?: string; directory?: string; editor: EditorView | null
  jobs: readonly EditorJob[] }): DeliveryEditorView {
  const editors = editorStarts(input.editor)
  const delivered = Date.parse(input.deliveredAt ?? '')
  if (!Number.isFinite(delivered)) return { state: 'unknown', editors }
  const workspace = input.directory?.trim() ? normalize(input.directory) : ''
  const builds = input.jobs.filter((job): job is EditorJob & { startedAt: string; endedAt: string } =>
    job.kind === 'build' && job.state === 'succeeded' && !!job.startedAt && !!job.endedAt
    && (!workspace || normalize(job.directory) === workspace))
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt))
  // Only a build that started at or after the delivery read the delivered files; an older one is context, not evidence.
  const build = builds.find(job => Date.parse(job.startedAt) >= delivered)
  if (!build) return { state: 'build', ...builds[0] ? { build: fact(builds[0]) } : {}, editors }
  if (!editors.length) return { state: 'no-editor', build: fact(build), editors }
  // The newest editor is the one a person would be looking at; loading happens when the process starts.
  return { state: Date.parse(editors[0]!) >= Date.parse(build.endedAt) ? 'loaded' : 'restart', build: fact(build), editors }
}

function fact(build: EditorJob & { startedAt: string; endedAt: string }): DeliveryBuildFact {
  return { id: build.id, startedAt: build.startedAt, endedAt: build.endedAt, directory: build.directory,
    ...build.summary ? { summary: build.summary } : {} }
}
