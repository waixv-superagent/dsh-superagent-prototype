# Compile-and-launch card on the editor page

Baseline: `origin/main` at `cb2d8c3`. Changed: this branch. Both captures come from two isolated DSH Web lab profiles
(baseline and this branch) over the same synthetic 33-Ticket state; every Source is off and processing is paused, so the
lab can neither launch nor deliver anything. The panel is the real application; only its data is synthetic.

The lab's target command is a stand-in (`py demo-build.py`) that prints a UBT-like verdict and a launch line; no engine is
involved. A real deployment configures its own commands under Settings › Execution › editor → 编译启动目标, one
`name=command` per line, and `<project>` is replaced with the configured `.uproject`.

| File | Shows |
| --- | --- |
| `before-editor-page.png` | Baseline editor page: no compile entry |
| `after-editor-page.png` | This branch: the 编译并启动 card between the schedule and the repro cases, with a target picker, the command and a run button |
| `after-editor-page-ran.png` | The same page after a run: the run's result in the card |
| `after-editor-build.png` | The card itself: target picker and the configured command |
| `after-editor-build-ran.png` | The card after Run: 成功, `Result: Succeeded`, exit code 0 |

The `*-editor-build-facts.json` files are the DOM facts the capture read (target options, command, buttons, runs, log), not
hand-written claims. The run is executed by `BuildRunner` (docs/021): it refuses while an agent or host job holds the
shared editor, claims the person's slot for its duration, and gives it back when the process ends.
