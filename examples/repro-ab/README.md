# repro-ab 演示用例（合成）

这个目录演示 [docs/026](../../docs/026-repro-ab.md) 的 A/B 复现流程：同一个探针在 baseline 臂（A）与改动臂（B）
各跑一次，用两臂观测的差异做断言，最后生成一份人能直接打开的报告。它不接引擎、不依赖编辑器，只用来演示与自测。

## 跑一次

在仓库根目录：

```sh
# 1. 改动前记录 baseline（这个合成 case 的 A 臂会模拟未修复的滑动）
node scripts/repro-ab.mjs run examples/repro-ab --arm A --label "baseline (demo)"

# 2. 改动后跑对照并写报告（replay = 跑 B 臂 + 与最近的 A 比）
node scripts/repro-ab.mjs replay examples/repro-ab --label "fixed (demo)"

# 3. 打开报告
start examples/repro-ab/.repro/report.html
```

`replay` 的退出码就是判定：`0` 通过、`2` 不通过、`3` 信息不足（缺臂、缺观测或重复不一致）。
所有运行记录、产物与报告都在 `.repro/` 下，已被本目录的 `.gitignore` 忽略。

在面板的“复现用例”卡片里，这个目录的 `case.json` 指向 `../../scripts/repro-ab.mjs replay .`，
点“运行”等价于第 2 步，跑完“报告”按钮会打开同一份 HTML。

## 真实 case 怎么用

真实 case 的探针要自己写（Python/Node/UE MCP 都行），约定只有三条：

1. 观测写到 `REPRO_RUN_DIR/observation.json`，内容是 JSON 对象；
2. 断言写在 `ab.json` 的 `expect` 里（`changed` / `unchanged` / `increase` / `decrease` / `equals` / `within`）；
3. 用 `node <checkout>/scripts/repro-ab.mjs init <caseDir> --probe "<命令>"` 准备 `.repro/`，
   再按“改动前 A、改动后 replay”的顺序跑。

字段与判定的完整说明见 [docs/026](../../docs/026-repro-ab.md)。
