/** Resolves where a ticket's work belongs — this deployment's git source repository or its Perforce depot — from the
 * installation's configured delivery targets, so acceptance never has to ask a person to choose a channel. */
import type { Backend, Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'

/**
 * One configured environment a ticket's work can belong to, with the spellings an accept may use for it.
 * `target` is the canonical value recorded on the ticket: the GitHub repository slug or the Perforce depot path.
 */
export interface DeliveryTarget {
  target: string
  backend: Backend
  /** Other spellings that resolve here: a workspace id, directory, or p4 client for a depot; URLs and `.git` forms for a repository. */
  aliases: readonly string[]
}

/** Drops surrounding spaces, uses forward slashes, removes a trailing separator and compares case-insensitively. */
const normalize = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The spellings of a repository: its slug, URL and `git@github.com:` forms, whichever one an accept copies. */
function repositoryAliases(repository: string): string[] {
  const slug = normalize(repository).replace(/^https?:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '')
  return [repository, slug, `https://github.com/${slug}`, `https://github.com/${slug}.git`, `git@github.com:${slug}.git`, `github.com/${slug}`]
}

/**
 * The delivery targets the installation configures: the GitHub Source's watched repository (`git`) and the Perforce
 * depot with its shared workspaces (`p4`). Nothing is hardcoded as a channel: an installation that configures neither
 * has no target, and a ticket that names none keeps the configured backend.
 */
export function deliveryTargets(settings: Settings, repository: string): DeliveryTarget[] {
  const targets: DeliveryTarget[] = []
  const repo = repository.trim()
  if (repo) targets.push({ target: repo, backend: 'git', aliases: repositoryAliases(repo) })
  const depot = settings.executor.p4.depot.trim()
  if (depot) targets.push({ target: depot, backend: 'p4', aliases: [
    depot,
    ...settings.executor.workspaces.flatMap(workspace => [workspace.id, workspace.directory, workspace.p4Client].filter(Boolean)),
  ] })
  return targets
}

/**
 * Whether `value` names, or lies inside, a spelling of `target`: a repository by slug or URL, a depot by path or through
 * one of its configured workspace ids, directories or clients. Path prefixes use `/`, so a Windows directory compares the
 * same however it was written.
 */
function names(value: string, target: DeliveryTarget): boolean {
  return target.aliases.some(alias => {
    const candidate = normalize(alias)
    return candidate !== '' && (value === candidate || value.startsWith(`${candidate}/`))
  })
}

/** The configured target a spelling names, or undefined when the installation does not configure it. */
export function matchDeliveryTarget(value: string, targets: readonly DeliveryTarget[]): DeliveryTarget | undefined {
  const name = normalize(value)
  return name ? targets.find(target => names(name, target)) : undefined
}

/** The channel a ticket's work belongs in, and the configured target it came from when one was named. */
export interface DeliveryResolution {
  backend: Backend
  target?: string
}

/**
 * Resolves a ticket's delivery from its target. An explicit `target` is matched against the configured targets; the
 * accept path validates it first, so a value that no longer matches means the configuration changed and the deployment
 * backend applies. Without one the Source fixes the target: a GitHub trigger belongs to the watched repository, a TAPD
 * trigger to the depot. Anything else, such as a research or conversation ticket, keeps the configured backend.
 */
export function resolveDelivery(input: { settings: Settings; repository: string; source?: string; target?: string }): DeliveryResolution {
  const { settings, repository, source, target } = input
  if (target?.trim()) {
    const matched = matchDeliveryTarget(target, deliveryTargets(settings, repository))
    return matched ? { backend: matched.backend, target: matched.target } : { backend: settings.executor.backend }
  }
  if (source === 'github' && repository.trim()) return { backend: 'git', target: repository.trim() }
  const depot = settings.executor.p4.depot.trim()
  if (source === 'tapd' && depot) return { backend: 'p4', target: depot }
  return { backend: settings.executor.backend }
}

/**
 * The delivery environment a ticket's work belongs to, for the worker-slot limit: the target recorded at accept, or
 * the target its backend falls back to when the ticket recorded none (one accepted before targets existed), so both
 * spellings of one environment share a single limit.
 */
export function deliveryKey(settings: Settings, repository: string, ticket: Pick<Ticket, 'execution'> | undefined): string {
  const target = ticket?.execution?.target?.trim()
  if (target) return target
  const backend = ticket?.execution?.backend ?? settings.executor.backend
  return (backend === 'p4' ? settings.executor.p4.depot.trim() : repository.trim()) || backend
}
