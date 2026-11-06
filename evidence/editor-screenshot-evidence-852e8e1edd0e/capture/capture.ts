/**
 * Reproduces the engine-side capture for this Ticket's evidence (docs/027).
 *
 * Requires Unreal Editor for SunGame running with the project's ModelContextProtocol server on :8000, and the
 * shared-editor lease held by whoever runs it. Writes a PNG and its JSON sidecar under the given directory.
 *
 *   node evidence/editor-screenshot-evidence-852e8e1edd0e/capture/capture.ts <outDir> [window-title-substring]
 */
import { captureEditor } from '../../../src/app/editor-capture.ts'

const outDir = process.argv[2]
const window = process.argv[3]
if (!outDir) {
  console.error('usage: node capture.ts <outDir> [window-title-substring]')
  process.exit(1)
}
const capture = await captureEditor({
  ticketId: 'editor-screenshot-evidence-852e8e1edd0e',
  outDir,
  ...(window === undefined ? {} : { window }),
})
console.log(JSON.stringify(capture, null, 2))
