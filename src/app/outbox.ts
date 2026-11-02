/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { ChannelHost } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, PARKED, Rejected, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle' | 'retry'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  /** The Source's own records, which a Channel settles with the reply it sent, such as a Feishu receipt reaction. */
  readonly state: ChannelHost['state']
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 * A message whose CLI refused its arguments is held, not dropped, so fixed code sends it on the next start.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  /** Sends a pending message again now, such as one whose payload was refused; returns whether it was waiting. */
  retry(id: string): boolean {
    return this.host.store.receipts.get(id)?.status === 'pending' && this.host.effects.retry('reply', id)
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands, state } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR, PARKED)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    // A CLI that refused its arguments refuses the same message again, so the message waits for a fix instead of a timer.
    const result = await sources.send(receipt, { commands, state }).catch((error: unknown) => {
      throw error instanceof CliError && error.type === 'validation' ? new Rejected(error.message) : error
    })
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
