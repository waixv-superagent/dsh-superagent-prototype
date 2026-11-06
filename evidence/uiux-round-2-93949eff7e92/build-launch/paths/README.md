# Compile-and-launch: project and engine paths configured once

Baseline: previous main (`origin/main` at `92bedab`, the composed card without the path fields). Changed: this branch.
Both captures are the real panel in isolated DSH Web labs over the same synthetic state; the lab's engine is a fake
`fake-engine/Engine/Build/BatchFiles/Build.bat` printing a UBT-like verdict, and the project is a placeholder
`SunGame.uproject`, so the derived build path can be exercised without an engine.

| File | Shows |
| --- | --- |
| `before-settings.png` | Baseline settings: 编辑器工程（.uproject） only; no engine or editor executable field |
| `after-settings.png` | This branch: 工程路径（.uproject）, 引擎目录 and 编辑器可执行文件 (optional), with the build/restart templates still available as overrides |
| `after-path-card-ran.png` | The card after a run: the build was derived from the fake engine's `Build.bat`, the launch from the restart override; 成功, `Result: Succeeded`, exit 0 |
| `after-path-card-advanced.png` | 自定义组合: target × configuration × platform and the templates; the empty build template reads 自动 (derived from the paths) |

With the project and engine set, the panel derives
`Engine/Build/BatchFiles/Build.bat <target> <platform> <configuration> -Project=<project> -WaitMutex` and the editor
binary + project per host platform. Explicit build/restart commands still win. A path that is configured but missing is
refused before a run, and a missing project or engine is a configuration prompt on the card, not a failed build.
