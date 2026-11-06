/**
 * Rider-style editor target composition (docs/021): a run configuration is a **configuration** (Development,
 * DebugGame, Shipping), a **target type** (Editor or Game) and the **target name** (such as SunGame or SunGameEditor)
 * on a **platform** (Win64 on Windows). The panel composes the display name and the build/launch command from the
 * configured templates, so a person picks the same combination Rider lists instead of an opaque command.
 */

/** The configurations Rider offers for an Unreal project. */
export const EDITOR_CONFIGURATIONS = ['Development', 'DebugGame', 'Shipping'] as const
export type EditorConfiguration = typeof EDITOR_CONFIGURATIONS[number]
/** The platforms a host can build for; the panel shows the one it runs on. */
export const EDITOR_PLATFORMS = ['Win64', 'Linux', 'Mac'] as const
export type EditorPlatform = typeof EDITOR_PLATFORMS[number]
/** A target name is a C# type name: letters, digits, `_`, `.`, `+` and `-`. */
export const EDITOR_TARGET = /^[A-Za-z0-9_.+-]{1,80}$/

/** The platform a host at `platform` builds for; Node names are `win32`, `darwin` and `linux`. */
export const hostPlatform = (platform: string): EditorPlatform =>
  platform === 'win32' ? 'Win64' : platform === 'darwin' ? 'Mac' : 'Linux'

/** Whether a target name ends in `Editor`, which is how an Unreal project names its editor target. */
export const editorTarget = (target: string): boolean => /Editor$/.test(target)

/** The base name Rider shows: the target without its `Editor` suffix (`SunGameEditor` → `SunGame`). */
export const editorBase = (target: string): string => editorTarget(target) ? target.slice(0, -'Editor'.length) : target

/**
 * The run configuration's name in Rider's order: configuration, type, target — `Development Editor SunGame`,
 * `Shipping Game SunGame`. `target` is the C# target name the build command receives.
 */
export function editorRunName(target: string, configuration: string): string {
  return `${configuration} ${editorTarget(target) ? 'Editor' : 'Game'} ${editorBase(target)}`
}
