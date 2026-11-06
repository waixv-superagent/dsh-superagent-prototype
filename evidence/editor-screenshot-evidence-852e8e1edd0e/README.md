# Editor-side capture: the editor's own rendering as Ticket evidence (docs/027)

Reported on 2026-11-06: with the Windows session locked (or an RDP session disconnected) a desktop screenshot comes
back black, so editor UI evidence could not be captured — while the DSH board still could be captured, because a
browser renders its own frames. The Unreal Editor renders too. This change captures an editor window through the
engine's own `ModelContextProtocol` server (`SlateInspectorToolset`), so the pixels are the editor's Slate rendering
and not a desktop grab.

## Evidence

| File | What |
| --- | --- |
| `20261106T100038Z-SunGame-Unreal-Editor.png` | A real capture of the running SunGame editor's main window, taken with `src/app/editor-capture.ts` through the engine MCP on 2026-11-06 18:00:38 +08:00. 2560×1380, 1,996,817 bytes, sha256 `d30ec9e7f2ccd55130ef6886423b0e4b03d99a65981e70c45ad7fc5bca03733b`. |
| `20261106T100038Z-SunGame-Unreal-Editor.json` | The sidecar the capture wrote beside it: ticket, time, window index and title, size, byte count, sha256, endpoint and toolset. |
| `capture/capture.ts` | The script that produced both. |

The sha256 in the sidecar is the value the PR and the Ticket verification package quote, so the image and the record
can be matched. The capture went through `SlateInspectorToolset.Screenshot`, which renders the window from its own
Slate render target (`FSlateApplication::TakeScreenshot`) rather than reading the desktop; the window was brought to
the front and captured while the editor was otherwise idle.

## Reproduce

Requires Unreal Editor for SunGame running with the project's `ModelContextProtocol` server (the project sets
`bAutoStartServer=True`, port 8000) and the shared-editor lease:

```powershell
# from the repository root, while holding the editor lease
node evidence/editor-screenshot-evidence-852e8e1edd0e/capture/capture.ts <outDir> SunGame
```

The script prints the capture JSON (path, metadata path, width, height, sha256, window). With no `SunGame` argument it
captures the active editor window instead. The caller holds the editor lease: `orchestrator_editor op=acquire
purpose=use`, then `op=release` or `op=close` when done.

## Verification in the PR

- `pnpm typecheck` exit 0; `pnpm test tests/editor-capture.spec.ts` 11/11; `pnpm build` exit 0.
- Full `pnpm test`: 1914 passed / 22 skipped; the only failure is the pre-existing `tests/docs.spec.ts` numbering test
  (the duplicate `025`/`026` documents also fail on `origin/main` `ed68b30`).
- The module ran against the real editor above; with no editor reachable it fails with a clear
  "cannot reach the editor MCP at http://127.0.0.1:8000/mcp" message.

## Limitation

The locked-screen state itself was not reproduced on the shared machine; the evidence is the channel — the capture
comes from the editor's Slate render target instead of the desktop. PIE/game-viewport capture is out of scope (the
ue-mcp bridge's `capture_screenshot(target=pie)` is a separate channel), and the image stays a host-local file rather
than an inline Ticket-page image.
