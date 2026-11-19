/**
 * Bringing the desktop app forward from the host: the app registers the `dsh` protocol for exactly this, and a launch of
 * `dsh://open` reaches the running instance, which focuses its main window (a second launch is routed to the first). The
 * host only ever launches the fixed URL, never one a request supplies.
 */
export type CommandRunner = (program: string, args: string[]) => void
/** The OS command that opens the app's protocol URL, or undefined on a platform whose launcher is not known. */
export function appFocusCommand(platform: string = process.platform): [program: string, args: string[]] | undefined {
  if (platform === 'win32') return [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'start "" "dsh://open"']]
  if (platform === 'darwin') return ['open', ['dsh://open']]
  if (platform === 'linux') return ['xdg-open', ['dsh://open']]
  return undefined
}
/**
 * Launches the app's focus URL.
 * @returns whether a launch was attempted; a platform without one leaves the handoff page's own button as the way in.
 */
export function focusDesktopApp(run: CommandRunner, platform: string = process.platform): boolean {
  const command = appFocusCommand(platform)
  if (command === undefined) return false
  try {
    run(command[0], command[1])
    return true
  } catch {
    return false
  }
}
