/** Downloads the images a candidate card's own message carries, so the main Session sees them natively. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { TriggerContext } from '../sources/kind.ts'

/** One durable image a Source read for the card; `AdmissionImage` from a Feishu read fits this shape. */
const ImageReferenceSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
})
/** The image a Source's `image` read places under `image`; its extra source-pairing fields are ignored here. */
const ReadSchema = z.object({ image: ImageReferenceSchema })
/** A card carries at most this many reasons before the rest are summarized, so one huge message cannot bloat the card. */
const NOTE_LINES = 8

export interface CardImages {
  /** The images to attach to the card message, in the message's own order. */
  images: ImageAttachmentRef[]
  /** One line per image left out, naming its key and why; empty when every image was attached. */
  unreadable: string[]
}
/** The model route's own image limit, read from the attachment service that will hold the images. */
function limitsOf(agent: Agent) { return agent.ctx.get('attachments')?.imageLimits }

/**
 * Downloads the images a candidate's own message carries through the Source's ThreadContext and returns them for
 * attachment to the candidate card, so the main Session reads a screenshot the way a person sent it.
 * Each image is bounded by the attachment service's per-message count and byte limit; one that cannot be read, or
 * cannot fit, is reported in `unreadable` instead of failing the card. A model route without image input, or a Source
 * without image reads, ends the download, because every later image would fail the same way.
 */
export async function candidateImages(input: {
  agent: Agent | undefined
  source: TriggerContext | undefined
  trigger: Trigger
  commands: Commands
  stateDir: string
  signal: AbortSignal
}): Promise<CardImages> {
  const { agent, source, trigger, commands, stateDir, signal } = input
  const keys = source?.images(trigger.text) ?? []
  if (!agent || !source || !keys.length) return { images: [], unreadable: [] }
  const limits = limitsOf(agent)
  const images: ImageAttachmentRef[] = []
  const unreadable: string[] = []
  // Every skipped image counts; only the first few get a line of their own.
  let skipped = 0
  const skip = (line: string) => { skipped++; if (unreadable.length < NOTE_LINES) unreadable.push(line) }
  let bytes = 0
  for (const [index, key] of keys.entries()) {
    signal.throwIfAborted()
    if (limits && images.length >= limits.maxImagesPerMessage) {
      skip(`${key}: only ${limits.maxImagesPerMessage} images fit one message`)
      continue
    }
    let image: ImageAttachmentRef
    try {
      image = ReadSchema.parse(await source.image(agent, commands, { id: source.messageId, text: trigger.text }, key, stateDir, signal)).image as ImageAttachmentRef
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      skip(`${key}: ${reason.slice(0, 200)}`)
      // The model route or the Source itself cannot read images: every later key would repeat this failure.
      if (/does not support image input|no attachment service|has no images/i.test(reason)) {
        skipped += keys.length - index - 1
        break
      }
      continue
    }
    if (limits && bytes + image.bytes > limits.maxMessageImageBytes) {
      skip(`${key}: ${bytes} bytes of images already fit one message of at most ${limits.maxMessageImageBytes}`)
      continue
    }
    images.push(image)
    bytes += image.bytes
  }
  const summarized = skipped - unreadable.length
  if (summarized > 0) unreadable.push(`${summarized} more image${summarized === 1 ? '' : 's'} left out`)
  return { images, unreadable }
}
