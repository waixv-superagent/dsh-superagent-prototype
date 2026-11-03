/**
 * Feishu conversation controls for processing: a person can pause the deployment's work ("game mode") and resume it
 * from the chat itself, which works while processing is paused. A control message is not work, so it is answered here
 * and never becomes a Trigger.
 */
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sendFeishu } from './feishu-channel.ts'
import type { SourceContext } from './host.ts'

/** What a control message asks: stop starting work and hold replies, or start them again. */
export type ProcessingControl = 'pause' | 'resume'
/** How long a handled control message stays on record, so a history replay never toggles processing again. */
const CONTROL_KEEP_MS = 7 * 24 * 3600_000
/**
 * The whole message that pauses or resumes processing, ignoring surrounding whitespace, a mention of the bot, and
 * closing sentence punctuation. A word inside a longer sentence is ordinary talk and is not a command.
 */
const CONTROL_WORDS: Readonly<Record<string, ProcessingControl>> = {
  '挂起': 'pause', '暂停处理': 'pause', '游戏模式': 'pause', '进入游戏模式': 'pause',
  '恢复': 'resume', '恢复处理': 'resume', '继续处理': 'resume', '退出游戏模式': 'resume', '结束游戏模式': 'resume',
}
/** The control a message asks for, if the message is one of `CONTROL_WORDS` rather than a sentence that contains it. */
export function processingControl(text: string): ProcessingControl | undefined {
  const word = text.trim().replace(/^(?:@\S+\s+)+/u, '').replace(/[\s。.!！?？~～]+$/u, '')
  return CONTROL_WORDS[word]
}

/**
 * Applies the control a person sent as a whole message in the Source's own conversation: a person may pause or resume
 * processing, and the Source answers in the same thread. It runs before the Engine sees the message, so the resume
 * word gets through while processing is paused, when no Eval would run to read it.
 * @returns whether this message was a control command the Source handled; otherwise the caller ingests it normally.
 */
export async function handleProcessingControl(ctx: SourceContext, trigger: Trigger): Promise<boolean> {
  const control = processingControl(trigger.text)
  if (!control || !trigger.human || !trigger.addressed || !ctx.mayControl(trigger)) return false
  const applied = ctx.state.get(KV.feishu.controls) ?? {}
  // A live event and history recovery can both deliver one message; only the first one acts.
  if (applied[trigger.id]) return true
  const paused = await ctx.pauseProcessing(control === 'pause')
  if (trigger.channel) {
    const text = paused
      ? '已进入挂起（游戏模式）：不再开始新的评估、派工和回复，正在跑的派工不会中断。要恢复就说「恢复」。'
      : '已恢复：评估、派工和回复继续。要再次挂起就说「挂起」。'
    await sendFeishu({ commands: ctx.commands, state: ctx.state }, { id: key('control', trigger.id), channel: trigger.channel, text, kind: 'reply' })
  }
  const keep = Date.now() - CONTROL_KEEP_MS
  const at = new Date().toISOString()
  ctx.state.set(KV.feishu.controls, Object.fromEntries(Object.entries({ ...applied, [trigger.id]: at })
    .filter(([, when]) => Date.parse(when) >= keep)))
  return true
}
