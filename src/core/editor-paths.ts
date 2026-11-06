/**
 * Where the editor and its project live (docs/021): a person configures the `.uproject`, the engine directory and,
 * optionally, the `UnrealEditor` executable once. The panel derives the UBT build and editor launch commands from them,
 * so nobody has to write those command lines; explicit build/restart templates still override the derived ones.
 */
import type { EditorPlatform } from './editor-composition.ts'

/** The configured locations the derived commands use. */
export interface EditorPaths {
  /** The `.uproject`; empty until a person configures it. */
  project: string
  /** The Unreal Engine root, the directory holding `Engine/`; empty until configured. */
  engine: string
  /** An explicit `UnrealEditor` executable for a non-standard install; empty derives it from the engine. */
  editorExe: string
}

/** Which configured path a derived compile-and-launch still needs: the project or the engine. */
export type EditorPathProblem = 'project' | 'engine' | null

const quote = (value: string) => `"${value.replaceAll('"', '')}"`
/** A configured path in the host's own separators, so a forward-slash setting and a joined suffix never mix. */
export const nativePath = (value: string, platform: EditorPlatform): string =>
  platform === 'Win64' ? value.replaceAll('/', '\\') : value.replaceAll('\\', '/')
const join = (root: string, parts: readonly string[], platform: EditorPlatform): string => {
  const separator = platform === 'Win64' ? '\\' : '/'
  return [nativePath(root, platform).replace(/[\\/]+$/, ''), ...parts].join(separator)
}

/** The path needs the project and the engine; an explicit editor executable is optional. */
export function editorPathProblem(paths: Pick<EditorPaths, 'project' | 'engine'>): EditorPathProblem {
  if (!paths.project.trim()) return 'project'
  if (!paths.engine.trim()) return 'engine'
  return null
}

/** UBT's entry script in the engine root. */
export function buildScript(engine: string, platform: EditorPlatform): string {
  return join(engine, ['Build', 'BatchFiles', platform === 'Win64' ? 'Build.bat' : 'Build.sh'], platform)
}

/** The editor executable: the configured one, else the engine's own binary for the host platform. */
export function editorBinary(paths: EditorPaths, platform: EditorPlatform): string {
  if (paths.editorExe.trim()) return paths.editorExe.trim()
  const relative = platform === 'Win64' ? ['Engine', 'Binaries', 'Win64', 'UnrealEditor.exe']
    : platform === 'Mac' ? ['Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor']
    : ['Engine', 'Binaries', 'Linux', 'UnrealEditor']
  return join(paths.engine, relative, platform)
}

/**
 * The UBT command for one run: target, platform and configuration, the project and `-WaitMutex`, so a second build
 * waits instead of fighting this one.
 */
export function derivedBuildCommand(paths: EditorPaths, selection: { target: string; platform: EditorPlatform; configuration: string }): string {
  return `${quote(buildScript(paths.engine, selection.platform))} ${selection.target} ${selection.platform} ${selection.configuration}`
    + ` -Project=${quote(nativePath(paths.project, selection.platform))} -WaitMutex`
}

/** The editor launch command for one run: the editor binary and the project. */
export function derivedLaunchCommand(paths: EditorPaths, platform: EditorPlatform): string {
  return `${quote(nativePath(editorBinary(paths, platform), platform))} ${quote(nativePath(paths.project, platform))}`
}

