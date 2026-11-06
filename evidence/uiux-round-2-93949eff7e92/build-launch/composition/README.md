# Compile-and-launch: Rider's composed run configuration

Baseline: the previous build (`origin/main` at `ed68b30`, the single-command card from PR #93). Changed: this branch.
Both captures are the real panel in the same isolated DSH Web lab (synthetic 33-Ticket state, Sources off, processing
paused). The lab's target command is a stand-in (`py demo-build.py` / `py demo-launch.py`); a real deployment configures
`<target>`, `<configuration>`, `<platform>` and `<project>` in its own build/launch templates.

| File | Shows |
| --- | --- |
| `before-single-command.png` | Baseline: one `name=command` target named "Development Editor SunGame", command shown inline |
| `after-composed.png` | This branch: one **运行配置** picker with Rider's composed names; 自定义组合 collapsed |
| `after-composed-ran.png` | After Run: 成功, `Result: Succeeded`, exit code 0 for `Development Editor SunGame` |
| `after-composed-advanced.png` | 自定义组合 opened: target `SunGameEditor` × configuration `Development` × platform `Win64`, and the command templates |

The run configuration is configuration × Editor/Game × target × platform, named as Rider names it
(`Development Editor SunGame`). The card defaults to Development Editor and hides the fields a person rarely changes
behind 自定义组合. `after-composed-facts.json` records the DOM facts the capture read (presets, command, runs).
