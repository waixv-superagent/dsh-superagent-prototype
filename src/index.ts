/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import type { OutboundMessage } from './core/index.ts'
import { webKind } from './sources/web.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  // The Web Source has no service to watch: the panel's request form produces its Triggers, and its Channel injects each
  // Ticket's replies into the main Session, where the person who submitted the request already is.
  ctx.effect(() => runtime.sources.register(webKind({ deliver: message => deliverIntoMainSession(runtime, message) })), 'web: source kind')
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
/**
 * Delivers one outbound message of a Web Source Ticket into the main Session, as an injected notice so it is shown without
 * waking the orchestrator; a Session the host no longer knows can never receive it, while a transient failure is thrown so
 * the Outbox retries.
 */
async function deliverIntoMainSession(runtime: Runtime, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const session = message.channel.address.session
  if (session !== runtime.masterId) return 'gone'
  try {
    await runtime.sessions.prompt(session, message.id, message.text, { inject: summaryOf(message.text) })
    return 'sent'
  } catch (error) {
    if ((error as { code?: string }).code === 'session/not-found') return 'gone'
    throw error
  }
}
/** The one line the chat shows collapsed for an injected reply, before the person expands it. */
const summaryOf = (text: string): string => {
  const line = text.split('\n').map(item => item.trim()).find(Boolean) ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
