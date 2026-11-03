# Board five-lane layout at Mac page widths

Captured from the live Superagent panel on 2026-11-03 between 10:54 and 10:57 +08:00:
`https://10.104.0.40:9443/?view=board`, Overview → 看板, headless Chromium
(`--headless=new`), viewport **1344 × 914 CSS px at DPR 2**, light theme.
All text inside the lane cards is redacted (every non-space character replaced with
`●`), so no ticket, CL, review or author data appears in the images.

- `before-1344x914.png` — the deployed `dsh-superagent` client bundle (installed
  2026-11-03 05:38, board fallback `@container (max-width: 1040px)`), served in the
  same live page for this capture.
- `after-1344x914.png` — this branch, built with `pnpm build`, board fallback
  `@container (max-width: 900px)`.

## Measurements at the same viewport

| | Before (1040 px) | After (900 px) |
| --- | --- | --- |
| `.dt-page` content box | 963 px | 963 px |
| `.dt-board` width | 960 px | 960 px |
| `grid-template-columns` | `475.5px 475.5px` | `192.328px 147.094px 222.516px 192.344px 169.703px` |
| board columns | 2 | 5 |

963 px comes from 1344 px window − 280 px sidebar − 2 × 48 px page padding − 5 px
scrollbar; the reported Mac window (1344 px, 280 px sidebar, overlay scrollbars)
leaves about 968 px, which also sits above 900 px and below the old 1040 px.

## Width sweep (After, same page, measured with the same bundle)

| Viewport (CSS px) | Board columns |
| --- | --- |
| 1344 | 5 |
| 1280 / 1200 / 1100 | 2 |
| 940 / 900 / 860 | 2 |
| 800 / 760 / 700 / 640 | 1 |

The DSH shell collapses its sidebar below about 1000 px, which widens the page
container again; that is why the column count is not strictly monotonic with the
window width. The 1240 px gap/padding step and the 700 px single-column step are
unchanged.

## Change

`src/client/client.css` only:

```diff
-@container (max-width: 1040px) {
+@container (max-width: 900px) {
   .dt-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
 }
```

The five lanes hold their 960 px board width from a ~900 px page up, so a Mac
window at 1344 px keeps all five lanes instead of collapsing into a 2 × N grid.
