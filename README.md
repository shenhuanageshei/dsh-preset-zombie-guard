# dsh-preset-zombie-guard

预设僵尸守护插件（DSH 宿主 cordis 插件，daemon-loop 形态的**纯确定性定时扫描**——循环中无 LLM 调用）。

## 背景

2026-08-31 删除用户预设 `router-anchored-jspace` 后，4 个引用该预设的会话成为「预设僵尸」：
生效预设（effective）不在当前 roster 的会话冷恢复（resume）时按已删预设装配 →
`UnknownPresetError` → 该会话一切 RPC 失败；其中空白僵尸会话还会卡死
`connectWorkspace` 的空白会话复用（「新建会话」永远落在坏会话上）。一次性修复已完成
（空白会话归档 + 3 个历史会话追加 selected 事件改指现存预设），本插件只防复发。
完整设计见 [DESIGN.md](./DESIGN.md)（唯一需求来源，v1.5）。

## 用途

- 装配后立即首扫一次，此后周期（默认 15min）扫描全部会话日志（扫描根解析链：
  `scanRootOverride` → `DSH_HOME` 环境变量下 `sessions\` → `~/.dsh/sessions`；
  zstd 帧逐行解码，同时支持无压缩 `.jsonl`——每目录仅一种物理编码，互斥由
  官方写入器保证），识别「effective 预设 ∉ 当前 roster」的会话。
- **僵尸且空白**（事件类型全部 ∈ 白名单 `{agent-preset/selected, permission/preset,
  sandbox/mode, approval/policy} ∪ {session/*}`——中间三类是宿主创建会话时必写的
  环境快照，真实空白会话创建即携带——且无 `step/start`，保守方向）→ 自动归档
  （官方 `workspaceRegistry.archiveSession`，幂等、可逆，**唯一写动作**）；
  空白僵尸没有历史可失，归档即刻解除对新会话复用流程的卡死。
- **僵尸且非空白** → 告警（`logger.warn` + 报告），每进程每 (会话, 状态) 去重一次
  （会话日志从磁盘消失后去重键随之清理，重现按新事件重新告警）；
  历史会话的组合替换是语义决策，必须人工选择（改指/重建/保留冷日志）。
- **解码失败**（帧损坏/截断）→ 计入 decodeFail；其中 header 预设 ∉ roster 者为
  「未定」告警；不可抑制横幅「N 个会话未能完整解码，结论不完整」的 **N 统计全部
  decodeFail 文件**（header 健康的解码失败同样意味着结论不完整），不只未定类。
- **已归档会话**：A 类（僵尸空白）幂等跳过（不重复归档、零动作零告警）；B/C 类
  仍各告警一次——归档不修复僵尸（un-archive 后依旧无法 resume）；
  `acknowledgedSessions` 可永久静默指定 id。
- header 是创建事实（深冻结）：header 失配但 effective 健康的会话（如修复后的 γ/δ）
  是**健康**的，不告警；僵尸判定统一以 effective 为准。

## 工具

| 工具 | 说明 |
|---|---|
| `preset_guard_scan` | 立即执行一轮扫描并返回报告（扫描数/命中分类/动作清单），不等周期 tick；roster 不可得（agentPresets 缺失或 list() 失败）时不报错，返回带「本轮跳过原因」的报告 |
| `preset_guard_check_remove` | **删除预设前的依赖安全检查**：全量解码所有会话日志（不跳 live、无阈值捷径，与周期扫描共用 stat 戳缓存），列出依赖指定 presetId 的会话；effective=强依赖（resume 按它装配）、header=弱依赖 |
| `preset_guard_last_report` | 最近一次扫描（周期 tick 或手动 scan 均可）的报告快照（时间/扫描数/各类命中/去重告警明细/未完成横幅）；从未扫描过时明确说明 |

## 使用纪律（删除预设前必读）

1. 删除任何用户预设前**必须**先跑 `preset_guard_check_remove(presetId)`。
2. **必须确认输出无「未完整分析」横幅**（`N 个会话未完整分析，删除安全性未确认`）
   才可视为安全——存在横幅时清单不完整，删除操作不可视为安全。
3. 依赖清单非空时逐个处理（改指/归档/确认可冷死）后再删除。

## 配置（cordis Config）

| 键 | 默认 | 说明 |
|---|---|---|
| `intervalMs` | `900000` | 扫描周期（ms，下限 5000） |
| `autoArchiveBlank` | `true` | 僵尸空白会话是否自动归档；`false` 时整体 report-only |
| `acknowledgedSessions` | `[]` | 已知并接受、永久静默 B/C 告警的会话 id（人工处理完成后登记；不影响 check_remove 的完整性） |
| `scanRootOverride` | — | 覆盖扫描根目录（测试/演示用）；override 模式下归档动作整体禁用 |

## 降级（服务全部 optional，绝不阻止插件加载）

- `agentPresets` 缺失或 `list()` 失败 → 无 roster，本轮跳过并 warn。
- `workspaceRegistry` 缺失 / liveness 不可判定（`agents` 与 `sessions` 均缺失）/ `autoArchiveBlank=false` / override 模式 → 仍扫描、仍告警，仅不归档；liveness 不可判定命中 A 类时按 B 告警并标注 `live? unknown`（宁可漏归档，不可在可能活跃时归档）。
- `node:zlib` 无 zstd 能力（Node < 23.8）→ 启动 warn 并整体 report-only，`.zstd` 日志按解码失败计（结论不完整横幅照常）。本宿主捆绑 Node 24.x，正常不触发。
- 归档失败（如存在性校验拒绝）→ 记 error 继续。
- live 会话在碰文件前跳过（composition 在内存，不受预设删除影响；也避免为持续增长的日志付解码）。

## 构建与验证

```bash
# 依赖：DSH_CHECKOUT 或默认探测（本机 web profile：
# D:/DSH-Portable/profile/profiles/web；或 dsh 源码 checkout：packages/ + vendor/）
# ⚠️ Windows：PATH 上的 bash 若是 WSL bash 无法运行 Windows node，
#    用 Git Bash，如 "D:/SoftWare/Git/bin/bash.exe" scripts/build.sh
bash scripts/build.sh

# 离线自测（临时目录合成数据，不依赖宿主进程，必须全绿）
node lib/selftest.js
```

tsc 解析顺序：`$DSH_CHECKOUT/node_modules/.bin/tsc` → 本目录 `node_modules/.bin/tsc`
（离线 devDependency，本机从本地 pnpm store 安装：

```bash
node D:/DSH-Portable/tools/node_modules/pnpm/dist/pnpm.mjs install \
  --store-dir=D:/DSH-Portable/.pnpm-store --prefer-offline \
  --config.node-linker=hoisted --config.auto-install-peers=false
```

）。构建产物 `lib/`（含 `selftest.js`、`index.js`、`classifier.js`、`types/`）。

注入与运行时验证由 dsh-super-injector 生态执行：
`dev_inject_plugin`（运行时注入，热重载/卸载即净）→ 验收（DESIGN.md §9.2/§9.3）→
用户确认后 `dev_install_package` 持久装配。本插件不 monkey-patch、不 import DSH
内部模块（zstd 只用 `node:zlib`）、不写任何会话/配置文件（唯一写动作是
`workspaceRegistry.archiveSession` 服务调用）；timer 间隔经 timer 服务、工具注册经
`ctx.effect`，卸载即净。
