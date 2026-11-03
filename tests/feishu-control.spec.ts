import { describe, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { handleProcessingControl, processingControl } from '../src/sources/feishu-control.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

describe('Feishu processing controls', () => {
  it('reads a control only from the whole message', () => {
    expect(processingControl('恢复')).toBe('resume')
    expect(processingControl(' 挂起。')).toBe('pause')
    expect(processingControl('@大肥鱼 挂起')).toBe('pause')
    expect(processingControl('游戏模式！')).toBe('pause')
    expect(processingControl('退出游戏模式')).toBe('resume')
    expect(processingControl('恢复了吗都')).toBeUndefined()
    expect(processingControl('这个先暂停处理吧')).toBeUndefined()
    expect(processingControl('')).toBeUndefined()
  })

  it('resumes processing from chat while paused, answers there, and pauses it again', async () => {
    const h = await startRuntime()
    try {
      const lark = vi.mocked(Commands.prototype.lark)
      const ctx = h.runtime.context(feishuKind)
      await h.runtime.settings.pause(true, 'panel')
      const replies = () => lark.mock.calls.map(([args]) => args as string[]).filter(args => args[1] === '+messages-reply')

      const resumed = feishu('900', '恢复')
      expect(await handleProcessingControl(ctx, resumed)).toBe(true)
      expect(h.runtime.store.settings().paused).toBe(false)
      // A control message is not work: it leaves no Trigger for an Eval.
      expect(h.runtime.store.triggers.get(resumed.id)).toBeUndefined()
      const answer = replies().find(args => args.includes('om_900'))
      expect(answer).toBeDefined()
      expect(JSON.stringify(answer)).toContain('已恢复')

      // A history replay of the same message must not toggle processing again or answer twice.
      const calls = lark.mock.calls.length
      expect(await handleProcessingControl(ctx, resumed)).toBe(true)
      expect(lark.mock.calls.length).toBe(calls)

      expect(await handleProcessingControl(ctx, feishu('901', '挂起'))).toBe(true)
      expect(h.runtime.store.settings().paused).toBe(true)
      const paused = replies().find(args => args.includes('om_901'))
      expect(JSON.stringify(paused)).toContain('已进入挂起')
    } finally {
      await h.stop()
    }
  })

  it('does not let someone outside the allowed list switch processing', async () => {
    const h = await startRuntime()
    try {
      const ctx = h.runtime.context(feishuKind)
      await h.runtime.settings.pause(true, 'panel')
      const lark = vi.mocked(Commands.prototype.lark)
      const calls = lark.mock.calls.length
      // Not a control: it is ingested as ordinary work, which waits while processing is paused.
      expect(await handleProcessingControl(ctx, feishu('910', '恢复', { sender_id: 'ou_guest' }))).toBe(false)
      expect(h.runtime.store.settings().paused).toBe(true)
      expect(lark.mock.calls.length).toBe(calls)
    } finally {
      await h.stop()
    }
  })
})
