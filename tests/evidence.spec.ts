/**
 * Editor captures are host-local evidence (docs/030). The capture tool writes a timestamped PNG beside a JSON sidecar
 * whose `editor.toolset` names the Slate inspector; either file inside the repository means someone copied internal
 * project content in, so the test fails and names the file instead of letting it land in a pull request.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Generated, vendored or local-only directories: a capture would not be committed there either. */
const SKIP = new Set(['.git', 'node_modules', 'lib', '.artifacts', 'coverage'])
/** The capture's file name is `<UTC stamp>-<window slug>.png`; the sidecar beside it carries the toolset marker. */
const CAPTURE_PNG = /^\d{8}T\d{6}Z-.+\.png$/u
const SLATE_TOOLSET = 'SlateInspectorToolset.SlateInspectorToolset'

function files(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files(path, found)
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/** The sidecar's marker survives a rename; only the capture writes a JSON file with this toolset. */
function isCaptureSidecar(path: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  if (typeof value !== 'object' || value === null) return false
  const editor = (value as { editor?: unknown }).editor
  return typeof editor === 'object' && editor !== null
    && (editor as { toolset?: unknown }).toolset === SLATE_TOOLSET
}

it('keeps editor captures out of the repository', () => {
  const captures = files(ROOT).filter(path => {
    const name = basename(path)
    return (name.endsWith('.png') && CAPTURE_PNG.test(name)) || (path.endsWith('.json') && isCaptureSidecar(path))
  })
  expect(captures.map(path => relative(ROOT, path).replaceAll('\\', '/')), 'editor captures are host-local evidence '
    + '(docs/030): keep the PNG and its sidecar under <stateDir>/evidence and never commit them to the repository').toEqual([])
})
