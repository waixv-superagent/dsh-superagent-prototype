/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Backend, Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
  { key: 'DSH_SUPERAGENT_BACKEND', description: { zh: '交付后端：git（GitHub 拉取请求）或 p4（Perforce CL + Swarm review）', en: 'Delivery backend: git (GitHub pull request) or p4 (Perforce changelist shelved for a Swarm review)' } },
  { key: 'DSH_SUPERAGENT_P4_CLIENT', ticket: true, description: { zh: '这个工单的 Perforce 工作区名；p4 后端下由准备命令创建', en: 'This ticket\'s Perforce workspace name, created by the prepare command under the p4 backend' } },
  { key: 'DSH_SUPERAGENT_P4_PORT', description: { zh: 'Perforce 服务器地址；为空时用安装环境的 P4PORT', en: 'Perforce server address; empty keeps the installation\'s P4PORT' } },
  { key: 'DSH_SUPERAGENT_P4_DEPOT', description: { zh: '工作区映射的 depot 路径', en: 'Depot path the workspace maps' } },
  { key: 'DSH_SUPERAGENT_P4_STREAM', description: { zh: '工作区所属的 stream，如 //sun/mainline；stream depot 用它代替手写 view', en: 'Stream the workspace is a client of, such as //sun/mainline; a stream depot needs it instead of a hand-written view' } },
  { key: 'DSH_SUPERAGENT_P4_SYNC', description: { zh: '新工作区同步的版本，如 @head 或 @12345', en: 'Revision synced into a new workspace, such as @head or @12345' } },
  { key: 'DSH_SUPERAGENT_P4_CL', description: { zh: '本工单的 changelist 号；交付前为空，由 worker 交付时自行记录', en: 'This ticket\'s changelist number; empty until the worker delivers, which records it' } },
  { key: 'DSH_SUPERAGENT_SWARM_URL', description: { zh: 'Swarm 基址；为空时不做 review 动作', en: 'Swarm base URL; empty disables review actions' } },
  { key: 'DSH_SUPERAGENT_SWARM_REVIEW', description: { zh: '本工单的 Swarm review id；创建前为空', en: 'This ticket\'s Swarm review id; empty until it is opened' } },
  { key: 'DSH_SUPERAGENT_LEASE', ticket: true, description: { zh: '这个工单允许写的路径，以空格分隔；为空表示整个工作区、不与他人并行', en: 'The paths this ticket may write, separated by spaces; empty means the whole workspace, so it never runs beside a peer' } },
]
/** Workspace name for a Ticket under the p4 backend, from the configured template and the Ticket's short name. */
export const p4Client = (template: string, name: string): string => template.replaceAll('<name>', name)

/**
 * Prepare command used under the p4 backend when no custom `prepare` command is configured.
 * With a configured stream it saves a stream client spec built from the server's own template — which is what a stream
 * depot requires — and without one it writes a classic client whose view maps the configured depot. Either way the client is
 * rooted at the workspace directory and then syncs, so the worker's directory is a Perforce workspace of the delivery area.
 * No `-f`: a non-admin user may save its own client but not force one, and `@head` is not a valid sync path spec, so it means
 * "head" and is left off. Credentials are never named here: `p4` reads `P4TICKETS` and the rest of the installation's environment.
 */
export function p4Prepare(): string {
  return [
    'set -e',
    'mkdir -p "$DSH_SUPERAGENT_DIR"',
    'spec="$DSH_SUPERAGENT_DIR/.p4client.spec"',
    'if [ -n "$DSH_SUPERAGENT_P4_STREAM" ]; then',
    '  # The template keeps Host, Options and SubmitOptions the server requires; only the root is ours.',
    '  p4 -c "$DSH_SUPERAGENT_P4_CLIENT" client -S "$DSH_SUPERAGENT_P4_STREAM" -o | sed "s|^Root:.*|Root: $DSH_SUPERAGENT_DIR|" > "$spec"',
    'else',
    '  {',
    '    printf \'Client: %s\\n\' "$DSH_SUPERAGENT_P4_CLIENT"',
    '    printf \'Root: %s\\n\' "$DSH_SUPERAGENT_DIR"',
    '    printf \'Options: noallwrite noclobber nocompress unlocked nomodtime normdir\\n\'',
    '    printf \'SubmitOptions: submitunchanged\\n\'',
    '    printf \'LineEnd: local\\n\'',
    '    printf \'View:\\n\'',
    '    printf \'\\t%s/... //%s/...\\n\' "$DSH_SUPERAGENT_P4_DEPOT" "$DSH_SUPERAGENT_P4_CLIENT"',
    '  } > "$spec"',
    'fi',
    'p4 -c "$DSH_SUPERAGENT_P4_CLIENT" client -i < "$spec"',
    'if [ -n "$DSH_SUPERAGENT_P4_SYNC" ] && [ "$DSH_SUPERAGENT_P4_SYNC" != "@head" ]; then',
    '  p4 -c "$DSH_SUPERAGENT_P4_CLIENT" sync "$DSH_SUPERAGENT_P4_DEPOT/...$DSH_SUPERAGENT_P4_SYNC"',
    'else',
    '  p4 -c "$DSH_SUPERAGENT_P4_CLIENT" sync "$DSH_SUPERAGENT_P4_DEPOT/..."',
    'fi',
  ].join('\n')
}
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings;
  ticket?: { id: string; name: string; directory: string; workspace?: string; lease?: string[]; backend?: Backend }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const { backend: configured, p4 } = settings.executor
  // A ticket records the delivery environment its work belongs in; without one the deployment's configured backend applies.
  const backend = ticket?.backend ?? configured
  const executor: Record<string, string> = {
    DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '),
    DSH_SUPERAGENT_BACKEND: backend,
    DSH_SUPERAGENT_P4_PORT: p4.port,
    DSH_SUPERAGENT_P4_DEPOT: p4.depot,
    DSH_SUPERAGENT_P4_STREAM: p4.stream,
    DSH_SUPERAGENT_P4_SYNC: p4.syncSpec,
    DSH_SUPERAGENT_SWARM_URL: p4.swarmUrl,
    // A Ticket's changelist and review do not exist yet; the worker records them when it delivers.
    DSH_SUPERAGENT_P4_CL: '',
    DSH_SUPERAGENT_SWARM_REVIEW: '',
    ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id,
      DSH_SUPERAGENT_P4_CLIENT: p4Client(p4.clientTemplate, ticket.name),
      DSH_SUPERAGENT_LEASE: (ticket.lease ?? []).join(' ') } : {},
  }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '',
    workspace: ticket.execution?.workspace, lease: ticket.execution?.lease, backend: ticket.execution?.backend }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
