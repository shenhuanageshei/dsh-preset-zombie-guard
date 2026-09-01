# dsh-preset-zombie-guard — 设计文档

> 版本 v1.5（网关兼容修订）· 2026-09-01 · 状态：v1.5 工具改名进行中
> 形态：daemon-loop 插件（super-injector 生态，timer 周期扫描）
> 目标宿主：本地 DSH web profile（可热注入，可选持久装配）
>
> **脱敏说明**：本文档对外可分享。工作区名以 workspace-A/B/C 指代，
> 会话 id 以 id-α/β/γ/δ 指代，本机绝对路径以 `<DSH_HOME>` / `<plugins 根>`
> 指代；完整原值仅存在于内部修复记录，不在本文出现。
>
> v1.5 变更（重启后回归发现 🔴）：**工具名去点号**——`preset_guard.scan` →
> `preset_guard_scan`、`preset_guard.check_remove` →
> `preset_guard_check_remove`、`preset_guard.last_report` →
> `preset_guard_last_report`。教训固化：deepseek-official 网关对工具名
> 执行 `^[a-zA-Z0-9_-]+$` 校验（400 INVALID_REQUEST），qax 等网关不校验；
> 子代理裸继承父 options 路由，无 selection 兜底——凡在严格网关上派
> 子代理，一个非法工具名就杀死全部派生。生态惯例即下划线命名。
> 另记：启动即首扫可能早于 workspaceRegistry 装配就绪（archivedIds 取
> 不到 → 当轮 report-only 并对已归档空白僵尸误告警一次），registry
> 就绪后的下一轮自愈（幂等跳过、去重不重复告警）——已知可接受边界。
>
> v1.4 变更（交付评审裁决轮，doc-code 对齐）：① §4 扫描根解析链改为
> 与实现一致（override → DSH_HOME env → ~/.dsh/sessions；实现不依赖
> sessionPersistence，本部署实测正确——裁决：改文档不改代码）；② §4
> 已归档会话语义细化：A 类幂等跳过，B/C 类仍告警一次（归档不修复
> 僵尸，un-archive 后依旧无法 resume；acknowledgedSessions 永久静默）；
> ③ §7 scan 工具补 roster 缺失返回语义；④ §9 补 last_report 验收条款
> 与 A 类幂等说明；⑤ 记录 .jsonl/.zstd 互斥为写入器保证、非本插件契约。
>
> v1.3 变更（实现期，eng_coder 交付发现的 🔴 设计缺陷 + 评审 🟡/🔵 折叠）：
> ① BENIGN_TYPES 增补创建生命周期事件三类（§4，恢复 id-α 型空白僵尸的
> A 类自动归档——真实空白会话创建时宿主必写 `permission/preset` /
> `sandbox/mode` / `approval/policy` 环境快照事件，v1.2「空白会话无任何
> 活动事件」的论断源于取证解析器的多行帧缺陷，已订正）；② 周期报告的
> 未完成横幅统计全部 decodeFail 文件（§5，原仅 C 类）；③ check_remove
> 显式声明含 live 会话（§7）；④ 补录扫描根解析 / cwd 反转义 / 已归档跳过
> / tick 互斥四项实现契约（§4）；⑤ 性能验收按 Node zstd 公共 API 单帧
> 解码的现实修订（§9.2）。
>
> v1.2 变更（评审 round 1）：① `check_remove` 改为全量解码，废除其阈值
> 继承（🔴 #1）；② 引入分类缓存替代 `blankThresholdBytes`，僵尸判定统一
> 以 effective 预设为准（#2/#7）；③ blank 判定钉死事件类型白名单（#3）；
> ④ 新增 `last_report` 工具（#4）；⑤ 记录已验证的运行时与启动能力检查
> （#5）；⑥ 显式跳过无预设依赖会话（#6）；⑦ 补齐降级路径验收（#8/#9）；
> ⑧ 验收期望内联化（#10）。

## 1. 背景与根因（2026-08-31 事故）

用户在 workspace-A 的「新建会话」界面无法切换会话预设（选哪个都回退成
Router Standard），且模型选择报错：

```
internal: resume failed for session "session-<id-α>":
Error: agent-presets: preset "router-anchored-jspace" not found
(available: standard, code, minimal, cordis, router-standard,
 thincoder-eng, anchored-standard, zero-anchored-standard, re-framework)
```

根因链（已全部核实）：

1. 2026-08-31 13:06 删除了用户预设 `router-anchored-jspace`
   （`<DSH_HOME>\.agent-presets\router-anchored-jspace\` 整目录消失；
   undo 快照不覆盖该目录，原始 composition 不可恢复）。
2. 会话日志记录 preset 引用：header `agentPreset`（创建时）+ 事件
   `agent-preset/selected`（切换时）。**生效预设 = 最后一条 selected 事件，
   否则 header**（`resolveSessionPreset`，dsh-agent-presets）。
   **危险类正是 header ≠ effective**：id-β 的 header 是 `anchored-standard`，
   其对已删预设的依赖来自一条 selected 事件——只看 header 的依赖检查
   会漏掉它（这正是 v1.1 的缺陷，见 §7）。
3. 任何指向某会话的浏览器 RPC 走 `createApiRemoteAgentResolver`：非 live
   会话先**冷恢复**（`agents.resume`），恢复时按生效预设重新装配 →
   预设不存在 → `UnknownPresetError` → 该会话的一切 RPC 失败。
4. 「新建会话」流程 `connectWorkspace` 会**复用工作区内已存在的空白会话**，
   而不是创建新会话。workspace-A 唯一的空白会话恰是 id-α
   （记录着已删预设）→ 每次新建会话都落在坏会话上：
   - 预设切换 `agentPreset.select`：先冷恢复（失败）→ 前端回退默认预设
     `router-standard`（settings.yaml `agent-presets.default`）→
     **「选哪个都变成 Router Standard」**。
   - 模型选择 `session.models`：同样先冷恢复 → **「resume failed」**。
5. 死锁：`agentPreset.select` 的语义本可修复该会话（blank 会话允许
   recompose），但它必须先成功恢复会话才轮到切换 → 官方接口无法自愈。

事故影响面（全库会话全量解码扫描）：4 个会话引用已删预设——
1 个空白（id-α，卡死 workspace-A 新建流程）+ 3 个有真实历史
（workspace-A / workspace-B / workspace-C 各一，打开即报错）。

一次性修复已于 2026-08-31 完成（本设计只防复发）：
- 空白会话 id-α 经官方 `workspaceRegistry.archiveSession` 归档；
- 3 个历史会话（id-β/γ/δ）在日志末尾各追加一条 `agent-preset/selected`
  事件改指现存预设（β→anchored-standard，其创建预设；γ/δ→router-standard，
  当前默认），追加帧与官方写入器字节级同构（JSON 行 + zstd 单帧 +
  checksum flag），修复前各有 `.bak-*` 备份于会话目录内。
- **修复后的基线事实**（验收要用）：β/γ/δ 的 effective ∈ roster，
  resume 正常；但 γ/δ 的 **header 仍指向已删预设**（header 是创建事实，
  深冻结设计，不可也不应改写）。因此僵尸判定必须以 effective 为准
  ——header 失配但 effective 健康的会话是**健康**的，不应告警。

## 2. 目标 / 非目标

**目标**

1. 周期扫描全部会话日志，识别「生效预设（effective）不在当前 roster」
   的会话（预设僵尸）。
2. 僵尸且**空白**（见 §4 白名单定义）→ 自动归档（官方 `archiveSession`，
   幂等），即刻解除其对新会话复用流程的卡死。
3. 僵尸且**非空白** → 告警（logger.warn + 状态中的最近扫描报告，
   可经 `preset_guard_last_report` 查询），不自动改动——历史会话的组合
   替换是语义决策，必须人工选择（改指/重建/保留冷日志）。
4. 提供**删除前依赖检查**工具：给定 preset id，列出依赖它的会话清单，
   供删除预设前评估影响（本次事故的直接触发器就是无检查的删除）。
   **该工具全量解码，不留阈值捷径**（见 §7）。
5. 全程官方 API（文件系统只读 + workspaceRegistry.archiveSession），
   可热注入 / 热重载 / 卸载即净。

**非目标**

- 不修 DSH 核心（上游应做：`agentPreset.remove` 依赖检查、空白会话冷恢复
  回退默认预设、`connectWorkspace` 复用过滤）。
- 不自动改指非空白会话；不做 UI；不监控 preset 目录的文件系统事件。

## 3. 形态与部署

- scaffold：`dev_scaffold_plugin` 的 **daemon-loop** 形态
  （timer + 自主循环），目录 `<plugins 根>\dsh-preset-zombie-guard\`。
- 构建 `dev_build_plugin` → `dev_inject_plugin` 运行时验证 →
  用户确认后 `dev_install_package` 持久装配（重启存活）。
- 依赖声明：peerDeps 范围声明（不硬编码版本），仅用宿主侧服务
  `agentPresets` / `workspaceRegistry` / `agents` / `sessions`（均 optional，
  缺失时降级见 §6）。
- **运行时要求（已验证）**：zstd 解码用 `node:zlib` 的
  `zstdDecompressSync` / `zstdCompress`，需 Node ≥ 23.8.0。本宿主捆绑
  Node 24.x（LTS），且 2026-08-31 事故修复期间已在**宿主进程内**实测
  两个 API（含 checksum flag 压缩）均正常工作。实现仍带启动能力检查：
  `typeof zlib.zstdDecompressSync !== "function"` → warn 并进入
  report-only（无解码能力时连僵尸判定都不可靠，见 §6）。

## 4. 扫描算法

每个 tick（默认间隔 15min，可配置）：

```
roster := ctx.get("agentPresets").list()          # 现存 preset id 集合（含 broken 标记）
archived := ctx.get("workspaceRegistry").archivedSessionIds
for 每个 <DSH_HOME>\sessions\<encoded-cwd>\<session-id>\session.jsonl(.zstd):
    live := ctx.agents?.get(id) ?? ctx.sessions?.get(id) 存在    # 先查服务，后碰文件
    if live: 跳过（活会话 composition 在内存，不受预设删除影响；也避免为其变更的日志付解码）
    entry := decodeCache.get(路径)
    stat := 文件 size + mtimeMs
    if entry 存在且 entry.stamp === stat: 复用 entry 的解析结果
    else: 全量解码并解析 → 存入 cache（键: 路径, 值: {stamp, headerPreset, effective, blank, decodeFail}）
    # 解析规则:
    #   effective := 最后一条 agent-preset/selected 事件的 agentPreset ?? header.agentPreset
    #   header 无 agentPreset 字段且无 selected 事件 → 无预设依赖 → 跳过（永不判僵尸）
    #   blank := 无 step/start 事件 且 所有事件类型 ∈ BENIGN_TYPES
    #   解码失败（帧损坏）→ decodeFail 记数，effective := 未知
    命中判定:
      A. blank && effective ∉ roster && id ∉ archived → 归档候选
      B. 非blank && effective ∉ roster → 告警（去重，见 §5）
      C. 解码失败 && headerPreset ∉ roster → 「未定」告警（见 §5）
      D. 其余（含 header 失配但 effective 健康的 γ/δ 类）→ 健康，不动
```

要点：

- **BENIGN_TYPES（blank 判定白名单，钉死）**：`{"agent-preset/selected",
  "permission/preset", "sandbox/mode", "approval/policy"}` ∪
  `{t | t.startsWith("session/")}`。后三类是宿主创建会话时必写的
  环境快照（权限预设/沙箱模式/审批策略），不含用户内容——真实空白
  会话（id-α 实测）创建即携带这三事件；对话活动的任何痕迹（step/start、
  user/message、chunk、tool 等）不在白名单内。出现任何其他事件类型即非
  blank。**未知类型一律按非 blank 处理**（保守方向：宁可少归档，不可
  误归档）。自动归档（唯一写动作）同时要求 blank 白名单与
  effective ∉ roster 双门槛。
- **扫描根解析**：tick 与工具共用同一解析序——`scanRootOverride` 配置
  优先；未配置时取 `DSH_HOME` 环境变量下的 `sessions\`，环境变量未设时
  回退用户主目录 `~/.dsh/sessions`（与 dsh-home-paths 的解析语义一致；
  宿主启动器注入 DSH_HOME，本部署实测正确扫到全部会话）。cwd 取自
  header，header 缺失时由目录名 `~XXXX` 反转义得到。物理布局上
  `.jsonl` 与 `.jsonl.zstd` 的互斥由官方写入器保证（每目录仅一种），
  异常并存不构成本插件的契约场景；发现层仅接受精确文件名。
- **已归档会话的处置**：`id ∈ workspaceRegistry.archivedSessionIds` 时
  A 类幂等跳过（不重复归档、零动作零告警）；B/C 类仍各告警一次（去重
  后）——归档不修复僵尸：un-archive 后该会话依旧无法 resume，用户应
  知道自己搁置了一个坏会话；`acknowledgedSessions` 可永久静默。
  check_remove 始终全量列出（依赖检查关心事实，不关心展示状态）。
- **重入互斥**：`scan` 工具调用、`check_remove`、tick 扫描三者经同一
  序列化互斥锁——同一时刻至多一个扫描在跑，避免缓存戳竞争。
- **分类缓存取代阈值**（v1.1 的 `blankThresholdBytes` 已废除）：cache 键
  为路径、戳为 `(size, mtimeMs)`。首个 tick 对全部非 live 会话做一次性
  全量解码（事故修复时实测：数十会话、含数万事件大日志，秒级完成），
  之后每个 tick 只解码新增/变更的文件。已结束的会话极少变更，live 会话
  在解码前就被跳过——热循环成本天然收敛。
- **僵尸判定统一以 effective 为准**：header 是创建事实（γ/δ 修复后 header
  仍指已删预设，但 effective 健康、resume 正常）。header 失配只在解码
  失败、effective 不可知时作为弱信号（类别 C）。
- 帧解码沿用事故中验证过的实现：zstd magic（`28 B5 2F FD`）切帧 +
  `zstdDecompressSync` 逐帧 try/catch；解码失败计数并跳过，不中断扫描。
  同时支持无压缩 `.jsonl`（compression none 的存量布局）。
- `connectWorkspace` 复用条件是 `blank && cwd 匹配 && 在 workspace.sessionIds
  && 未归档`——归档正是把僵尸空白会话从复用环里摘除的官方手段。

## 5. 动作策略

| 命中类别 | 动作 | 理由 |
|---|---|---|
| A. 僵尸 + 空白（白名单）+ 未归档 + liveness 可判定为非 live | `workspaceRegistry.archiveSession(id)`，logger.info 记录 | 空白会话无历史可失；归档可逆（移出 archivedSessionIds 即恢复） |
| B. 僵尸 + 非空白 | logger.warn + 计入最近报告，**每进程每 (session, 状态) 只告警一次（会话文件存活期间；文件消失后去重键随剪枝清理，重现按新事件重新告警）**；`acknowledgedSessions` 配置项可永久静默指定 id | 组合替换是语义决策，留给人工；去重避免每 tick 刷屏 |
| C. 解码失败 + headerPreset ∉ roster | warn（同上去重）+ 计入「未定」类，报告含**不可抑制的不完整横幅**：`N 个会话未能完整解码，结论不完整`——**N 统计全部 decodeFail 文件（无论分类）**，不只 C 类：header 健康的解码失败同样意味着结论不完整 | effective 不可知，不能给安全结论 |
| 僵尸 + live | 跳过并计数 | 活会话不受预设删除影响，等其结束后下轮处理 |
| liveness 不可判定（agents 与 sessions 服务均缺失）且命中 A | **不归档**，按 B 告警并标注 `live? unknown` | 宁可漏归档，不可在可能活跃时归档 |
| roster 中 broken 预设 | 不处理 | 属部署配置问题，非本插件职责 |

归档失败（如 archiveSession 的存在性校验拒绝）→ 记 error，继续下一个。

## 6. 降级与安全

- `agentPresets` 服务缺失 → roster 不可得 → tick 直接跳过并 warn（无 roster
  无法判定僵尸）。
- zstd 能力缺失（启动检查不过）→ warn 并整体 report-only（§3）。
- `workspaceRegistry` 缺失、liveness 不可判定、或 `autoArchiveBlank=false`
  → 仍扫描、仍告警，仅不执行归档（report-only 模式）。
- 唯一写操作是 `archiveSession`；会话日志与一切配置文件只读。
- 自重载节流（<10s 拒绝）等注入器规范照常遵守。

## 7. 工具面（模型/用户可调用）

| 工具 | 入参 | 出参 |
|---|---|---|
| `preset_guard_scan` | — | 立即执行一轮扫描并返回报告（扫描数/命中分类/动作清单），不等 tick。roster 不可得时（agentPresets 服务缺失或 list() 失败）不报错，返回带「本轮跳过原因」的报告（无 roster 无法判定僵尸） |
| `preset_guard_check_remove` | `presetId` | **全量解码每一个会话日志（无阈值捷径，与周期扫描共用分类缓存），含 live 会话**——live 会话正是删除前最关键的依赖（其内存组合仍引用该预设）。返回依赖清单：id / cwd / blank / headerPreset / effective。**依赖匹配规则：`headerPreset === presetId ∨ effective === presetId`**（header 是弱依赖——resume 不受它影响；effective 是强依赖——resume 按它装配；两者都列出并标注强弱）。存在解码失败文件时输出**不可抑制横幅**：`N 个会话未完整分析，删除安全性未确认` |
| `preset_guard_last_report` | — | 周期扫描维护的最近一次报告快照（goal 3 的查询面）：时间 / 扫描数 / 各类命中 / 去重后的告警明细 / 未完成横幅 |

工具命名约束（v1.5 固化）：**工具名必须匹配 `^[a-zA-Z0-9_-]+$`**——deepseek-official 网关严格校验（非法名直接 400），子代理继承父路由时一个非法工具名即杀死全部派生；本插件工具一律下划线命名，禁用点号。

工具描述里写明使用纪律：删除任何用户预设前先跑 `check_remove`，且**必须
确认输出无未完整分析横幅**才可视为安全。

v1.1 缺陷（评审 #1，已修复）：check_remove 曾继承周期扫描的尺寸阈值，
大日志只看 header——而事故的 id-β 恰是「header 健康、effective 依赖已删
预设」的漏报类。教训固化：**删除安全检查永远全量解码**；周期热循环的
成本优化（缓存）不外溢到一次性安全工具的完整性。

## 8. 配置（cordis Config schema）

| 键 | 默认 | 说明 |
|---|---|---|
| `intervalMs` | 900000 | tick 间隔 |
| `autoArchiveBlank` | true | 僵尸空白会话是否自动归档 |
| `acknowledgedSessions` | `[]` | 已知并接受、永久静默告警的会话 id 清单（人工处理完成后登记） |
| `scanRootOverride` | — | 覆盖扫描根目录（测试/演示用；override 模式下归档动作禁用，见 §9） |

（v1.1 的 `blankThresholdBytes` 已废除，由分类缓存取代，见 §4。）

## 9. 验收标准

1. `dev_build_plugin` 构建零错误；`dev_inject_plugin` 注入后 fiber active，
   `dev_plugin_status` 可见；`dev_uninject_plugin` 卸载即净。
2. 真实环境 `preset_guard_scan`：全量会话扫描（数十个），命中 0 僵尸
   （A/B/C 类均 0，含 §1 修复后基线：β/γ/δ 为 D 类健康——γ/δ 的 header
   失配**不得**产生告警），无未捕获异常。**A 类幂等说明**：唯一预期
   A 类命中是已归档的 id-α（v1.3 白名单恢复其 blank=true），断言其
   alreadyArchived 幂等跳过（零动作零告警）。**性能口径**：Node 公共
   zstd API 为单帧解码（~165µs/帧），首 轮全量扫描为**一次性成本，
   允许数十秒**（扫描期间以 ≤250ms 间隔让出事件循环，GUI 保持响应）；
   **连续跑两轮**：第二轮全为缓存命中（无重复解码），告警零重复
   （去重生效），归档零动作（幂等）。**首扫时机**：装配（注入或启动）
   即异步触发首轮扫描，不等 intervalMs。
3. `preset_guard_check_remove("router-standard")`：返回非空依赖清单，
   跨 ≥3 个工作区，且**包含 id-γ 与 id-δ**——两者的依赖仅来自修复时
   追加的 selected 事件（header 仍指向已删预设 `router-anchored-jspace`），
   header-only 检查必然漏掉它们，故命中即证明全量解码路径生效。
   另跑 `check_remove("anchored-standard")` 作对照：应包含 id-β（其
   header 与 effective 双命中，不具判别力，仅验证清单完整性）。
3b. `preset_guard_last_report`：返回最近一次扫描（tick 或 scan 均可）
   的报告快照——时间 / 扫描数 / 各类命中计数 / 去重后告警明细 /
   未完成横幅（若有）；从未扫描过时明确说明。
4. 合成僵尸验证（不碰真实数据）：`scanRootOverride` 指向临时目录，内放
   手工构造的会话日志——(a) zstd 编码、header 指向不存在预设、**含创建
   生命周期事件（permission/preset、sandbox/mode、approval/policy）而无
   turn 活动** → 分类「僵尸空白」（A 类，v1.3 BENIGN_TYPES 增补的判别
   用例，id-α 的真实形状）；(b) zstd 编码、header 健康、selected 事件
   指向不存在预设、含 step/start → 分类「僵尸非空白（告警）」，且
   `check_remove(<不存在预设>)` 能把它列出来（header-only 检查会漏掉
   的 β 类用例）；(c) 损坏文件（截断的 zstd 帧）→ decodeFail 计数、
   扫描继续、无未捕获异常、报告含不完整横幅（横幅计数含 header 健康的
   decodeFail 文件）；(d) `autoArchiveBlank=false`
   + override → 分类正确且**归档调用次数为 0**（report-only 生效）。
   **override 模式下归档动作整体禁用**（archiveSession 会因会话不在真实
   persistence 而拒绝，禁用可避免噪声错误），(d) 通过调用计数断言而非
   真实归档。
5. 代码审查：无 monkey-patch、无对 DSH 内部模块的 import 耦合（zstd 解码
   直接用 `node:zlib`）；§6 各降级子句（agentPresets 缺失跳过 / zstd 能力
   检查 / liveness 不可判定不归档）均有对应守卫代码路径。

## 10. 交付流程

scaffold（daemon-loop）→ 实现 → build → inject 验证（含 §9 各项）→
用户确认 → `dev_install_package` 持久装配 → README 记录事故背景与使用纪律。
