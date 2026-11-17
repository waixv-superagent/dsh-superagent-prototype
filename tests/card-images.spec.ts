/** The images a candidate card carries: downloaded for the main Session within the attachment limits. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { expect, it, vi } from 'vitest'
import { candidateImages } from '../src/app/card-images.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { Trigger } from '../src/core/index.ts'
import type { TriggerContext } from '../src/sources/kind.ts'

const image = (name: string, bytes = 4): ImageAttachmentRef => ({ attachmentId: `id-${name}` as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png', bytes, width: 1, height: 1, name })
const trigger: Trigger = { id: 'feishu-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_chat:om_1' }], actor: { source: 'feishu', id: 'ou_user' },
  human: true, at: '2026-09-09T00:00:00Z', text: '![Image](img_a)\n修复这个弹窗 ![Image](img_b)', meta: { chatId: 'oc_chat', messageId: 'om_1' } }
const commands = {} as Commands
const signal = new AbortController().signal
const limits = { maxImageBytes: 100, maxImagesPerMessage: 2, maxMessageImageBytes: 100, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] as const }
/** A main-Session agent whose attachment service holds `limits`, or none at all with `undefined`. */
const agentWith = (value: typeof limits | undefined): Agent =>
  ({ ctx: { get: () => value === undefined ? undefined : { imageLimits: value } } }) as unknown as Agent
/** A Source read: `keys` are the message's image keys and `read` resolves one of them, or throws. */
function sourceOf(keys: string[], read: (key: string) => Promise<unknown>) {
  return { messageId: 'om_1', read: vi.fn(), images: vi.fn(() => keys), image: vi.fn((_agent, _commands, _message, key) => read(key)) } as unknown as TriggerContext
}
const input = (overrides: Partial<Parameters<typeof candidateImages>[0]> = {}) => ({
  agent: agentWith(limits), source: sourceOf(['img_a', 'img_b'], async key => ({ source_message_id: 'om_1', image_key: key, image: image(key) })),
  trigger, commands, stateDir: 'state', signal, ...overrides })

it('downloads the card message\'s images in order for the main Session', async () => {
  const request = input()
  const result = await candidateImages(request)
  expect(result).toEqual({ images: [image('img_a'), image('img_b')], unreadable: [] })
  expect(request.source.image).toHaveBeenCalledTimes(2)
  // The read stays paired with the trigger's own message and its full text, never a guessed key or body.
  expect(request.source.image).toHaveBeenNthCalledWith(1, request.agent, commands, { id: 'om_1', text: trigger.text }, 'img_a', 'state', signal)
})

it('leaves out images beyond the per-message count and byte limits, still delivering the rest', async () => {
  const many = input({ source: sourceOf(['img_a', 'img_b'], async key => ({ image: image(key) })) })
  const counted = await candidateImages({ ...many, agent: agentWith({ ...limits, maxImagesPerMessage: 1 }) })
  expect(counted.images).toEqual([image('img_a')])
  expect(counted.unreadable).toEqual(['img_b: only 1 images fit one message'])

  const heavy = input({ source: sourceOf(['img_a', 'img_b'], async key => ({ image: image(key, 60) })) })
  const bytes = await candidateImages({ ...heavy, agent: agentWith({ ...limits, maxMessageImageBytes: 100 }) })
  expect(bytes.images).toEqual([image('img_a', 60)])
  expect(bytes.unreadable).toEqual(['img_b: 60 bytes of images already fit one message of at most 100'])
})

it('reports an image it cannot read and keeps the others', async () => {
  const request = input({ source: sourceOf(['img_a', 'img_b', 'img_c'], async key => {
    if (key === 'img_b') throw new Error('Resource permission denied')
    return { image: image(key) }
  }) })
  expect(await candidateImages(request)).toEqual({ images: [image('img_a'), image('img_c')], unreadable: ['img_b: Resource permission denied'] })
})

it('stops at a model route that cannot see images and summarizes the keys it never attempted', async () => {
  const request = input({ source: sourceOf(['img_a', 'img_b', 'img_c'], async () => {
    throw new Error('Model deepseek-text does not support image input; the image has not been inspected')
  }) })
  const result = await candidateImages(request)
  expect(result.images).toEqual([])
  expect(result.unreadable).toEqual(['img_a: Model deepseek-text does not support image input; the image has not been inspected',
    '2 more images left out'])
  expect(request.source.image).toHaveBeenCalledOnce()
})

it('does nothing without an image key, a Source reader or the main Session', async () => {
  expect(await candidateImages(input({ source: sourceOf([], async () => ({ image: image('img_a') })) }))).toEqual({ images: [], unreadable: [] })
  expect(await candidateImages(input({ agent: undefined }))).toEqual({ images: [], unreadable: [] })
  expect(await candidateImages(input({ source: undefined }))).toEqual({ images: [], unreadable: [] })
})
