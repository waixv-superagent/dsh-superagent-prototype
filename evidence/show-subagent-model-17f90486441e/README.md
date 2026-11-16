# Child Session model route

Captured 2026-11-16 19:02 +08:00 from the live DeepSeek Harness Web app at `http://127.0.0.1:3082/`, in the
conversation of the `Opus review of BlendStack change` subagent Session under ticket `bab134d5…`'s worker. Headless
Chrome driven through CDP, dark theme, 1440 × 1120 CSS px at DPR 2; the images are clipped to the conversation header
(1160 × 76 CSS px), and the parent Session title is masked with `●`, so no ticket content is published.

- **Before** — the plugin module the running host serves: the checkout build `lib/client.js` (sha256
  `8769292a…3785`; the served batch carries the same module content plus its own trailing separator).
- **After** — this branch's `pnpm build` output, `lib/client.js` (sha256 `f7e0b457…f51d`), spliced into the served
  plugin batch only for the capture browser through CDP request interception. No deployment file, profile or state
  database was changed, and the host was not restarted.

## What the evidence shows

An addressed subagent Session showed no model anywhere in its conversation. DSH renders a Session's model only through
the composer's model seat, and that seat renders nothing for an addressed child (its Agent-bound model RPCs would
activate persisted history outside the direct-parent continuation path). The child's own `modelSelection` projection
had recorded the route all along; the header now names it.

| | Before | After |
| --- | --- | --- |
| Header actions | `标准模式` | `标准模式 模型 ai-gateway/claude-opus-5.5` |
| Child Session model | not shown | `ai-gateway/claude-opus-5.5`, from the `modelSelection` projection |

`capture.json` records both client hashes (file bytes and the trimmed bundle text the splice uses), the served
module's normalized hash, the viewport, the clip and the exact header text the two phases rendered.

## Limit

The crop is the header alone on purpose: the rest of that conversation is the ticket's private code discussion. The
parent's `subagent` tool-call card and DSH's subagent picker rows are DSH-owned views and still do not name the child's
model; this change covers the child conversation a person opens to check it. A child Session with no recorded request
shows no chip rather than a guessed model.
