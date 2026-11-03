# Feishu receipt-reaction select: readable emoji choices

Captured from the live Superagent panel through the deployment's gateway on
2026-11-03, panel route **设置 → 来源 → 飞书 → 高级**, headless Chromium
(`--headless=new`), viewport **1344 × 914 CSS px at DPR 2**, light theme, page
scrolled so the `高级` disclosure fills the clip. The clip covers that disclosure
only: no chat ids, message text or other private Feishu content appears in it.

- `before-advanced.png` — the deployed `dsh-superagent` client bundle (the
  profile's installed build, `client.js` 589,145 bytes, written 2026-11-03
  15:10, which already previews each reaction's Feishu emoji), served in the
  same live page for this capture.
- `after-advanced.png` — this branch, built with `pnpm build` (`client.js`
  590,134 bytes), served by the same page.

## Measurements (same page, same viewport)

The receipt-reaction field is a select whose six choices each render an emoji
image plus a label. The shared segmented field caps itself at 240 px, and the
control lays its choices out as `repeat(6, minmax(0, 1fr))`, so every choice got
the same 37 px while a choice needs 79–92 px (a 47–60 px emoji-plus-label span
and 32 px of chip padding) at this text size.

| | Before (deployed) | After (this branch) |
| --- | --- | --- |
| Segmented control width | 240 px | 521 px (content width, capped at 100%) |
| Choice widths | 37 px each | 92 / 92 / 79 / 79 / 79 / 84 px |
| Emoji-plus-label span | 47–60 px (unclipped) | 47–60 px (inside its chip) |
| Overlap per choice | 42–55 px of the label | 0 px (`scrollWidth` = choice width) |
| Rows | 1 (labels overlapping) | 1 (wraps only when the field is narrower) |

`src/client/client.css` keeps the 240 px cap for plain two-choice selects and
adds a `dt-field-emoji` modifier for a select whose options preview an emoji:

```diff
 .dt-field-segmented { max-width: 240px; }
+.dt-segmented.dt-field-emoji { display: flex; flex-wrap: wrap; width: fit-content; max-width: 100%; }
+.dt-field-emoji .dt-segment { flex: none; }
```

```diff
-      case 'select': return <Field label={label} hint={hint}>
-        <SegmentedControl className="dt-segmented dt-field-segmented" ... />
+      case 'select': {
+        const emoji = field.options.some(option => option.emoji)
+        return <Field label={label} hint={hint}>
+          <SegmentedControl className={`dt-segmented dt-field-segmented${emoji ? ' dt-field-emoji' : ''}`} ... />
+        </Field>
+      }
```

`src/client/settings-kit.tsx` therefore only asks for the wrapping layout when
an option has its own emoji image; a blocked image still falls back to the text
label alone, as before.
