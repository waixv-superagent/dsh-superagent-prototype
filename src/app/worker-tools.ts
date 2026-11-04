/** The worker capability face: the tools a worker Session cannot work without, and the error raised when its profile resolves none of them. */
/**
 * The tools a worker cannot work without: reading and writing files, and one shell. `glob`, `grep` and the web tools are
 * useful but a worker can reach the same ground through a shell, so they are not required here.
 */
export const REQUIRED_WORK_TOOLS: readonly string[] = ['read', 'write']
/** The names of the shell tools DSH may register; a profile registers one of them. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']
/** The required tools among `allow` that a worker Session's profile does not resolve, named for its report and health entry. */
export function missingWorkerTools(allow: readonly string[]): string[] {
  const missing: string[] = REQUIRED_WORK_TOOLS.filter(name => !allow.includes(name))
  // A profile registers one shell: accept either name, and name both as missing when neither resolves.
  if (!SHELL_TOOLS.some(name => allow.includes(name))) missing.push(SHELL_TOOLS.join('|'))
  return missing
}
/**
 * A worker Session whose profile resolves none of the tools it needs. The Session is never narrowed to an empty toolset:
 * the Executor starts no work for it, records the missing names, and reports the Assignment blocked instead.
 */
export class MissingWorkerTools extends Error {
  constructor(readonly tools: readonly string[]) {
    super(`The worker Session's profile does not resolve the tools it needs: ${tools.join(', ')}. `
      + 'Fix the worker agent preset or the DSH version that provides them before starting a worker.')
    this.name = 'MissingWorkerTools'
  }
}
