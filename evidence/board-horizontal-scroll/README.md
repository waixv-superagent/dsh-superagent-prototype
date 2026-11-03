# Board page width and horizontal scrolling

Captured from the live Superagent panel on 2026-11-03 between 14:48 and 14:58 +08:00:
`https://10.104.0.40:9443/?view=board`, Overview → 看板, headless Edge (`--headless=new`),
light theme, DPR 1. All text inside the lane cards is replaced with `●`; lane headers,
counts and page chrome are real.

- **Before** — the deployed `dsh-superagent` bundle in the installed profile
  (`lib/client.js`, sha256 `5BD20B0D…9C78`).
- **After** — this branch, `pnpm build`, its `lib/client.js` served by the same live panel for
  the capture. The installed bundle was restored afterwards (sha256 matches again).

The panel is live, so counts and cards differ between captures taken minutes apart; the
captures compare layout, not data.

## Change

- The board container's `:has(> .dt-board)` never matched: `.dt-board` sits inside `.dt-main`,
  so the board stayed on the 960px reading column while the editor page used the 1440px
  working column. `:has(.dt-board)` now matches the board as well.
- The five lanes keep a 960px minimum inside a `.dt-board-scroll` wrapper. Below that width
  the wrapper scrolls horizontally; the 900px two-column and 700px single-column board
  fallbacks are removed, so lanes are never squeezed or stacked.
- The wrapper fades the edge that still hides lanes (`data-more`, the same cue as the tab
  bar), so horizontal scrolling is visible without reaching the bottom scrollbar.
- The running lane keeps a 168px minimum so its `打开工单 →` header row fits at the 960px
  board width; before this it overflowed the lane border by 16px.

## Measurements

| Viewport | Before board | Before editor | After board | After scroller |
| --- | --- | --- | --- | --- |
| 1920×1080 | 960px | 1440px | 1440px | 1440px, no overflow |
| 1512×982 | 960px | 1131px | 1131px | 1131px, no overflow |
| 1344×914 | 960px | — | 963px | 963px, no overflow |
| 1200×900 | 819px, two 405px columns | — | 960px | 819px viewport, scrollWidth 960 |

At 1200 the after wrapper reports `overflow-x: auto`, `clientWidth 819`, `scrollWidth 960`;
the lane header rows fit (`scrollWidth == clientWidth`) at every captured width. Focusing the
last lane's `全部 →` button with `HTMLElement.focus()` moved the wrapper from `scrollLeft 0` to
`141` (its maximum), so keyboard focus reaches the off-screen lanes.

## Files

- `before-board-1920x1080.png` / `after-board-1920x1080.png` — the width difference on a wide
  screen: the board moves from the 960px reading column to the editor's 1440px column.
- `before-board-1512x982.png` / `after-board-1512x982.png` — laptop width; after is 1131px,
  the editor's width at the same viewport.
- `before-board-1200x900.png` / `after-board-1200x900.png` — before stacks into two columns;
  after keeps five lanes and clips the right lane at the scroller edge.
- `after-board-1200x900-scrolled.png` — the same after state scrolled to the right edge.
- `after-board-1200x900-bottom.png` — the bottom of the scroller, showing the horizontal
  scrollbar.
- `after-board-1344x914.png` — Mac-size window; five lanes fit without a scrollbar.
