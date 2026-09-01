/**
 * blank 判定白名单（钉死，DESIGN.md §4 v1.3）：`agent-preset/selected`、三个
 * 创建生命周期事件（`permission/preset` / `sandbox/mode` / `approval/policy`，
 * 宿主创建会话时必写的环境快照，不含用户内容——真实空白会话创建即携带，
 * id-α 实测形状）与全部 `session/*` 类型。出现白名单外类型即非 blank，
 * 未知类型一律按非 blank（保守方向：宁可少归档，不可误归档）。
 */
export declare function isBenignType(type: string): boolean;
export type Compression = 'zstd' | 'jsonl';
/** 文件 stat 戳：size + mtimeMs，分类缓存的失效依据。 */
export interface Stamp {
    size: number;
    mtimeMs: number;
}
/** 会话日志文件定位信息。 */
export interface SessionLogFile {
    /** 编码后的工作区目录名（cwd 的有损可读形式，仅作展示）。 */
    projectKey: string;
    /** 编码后的会话目录名（encodeSegment 形态）。 */
    dirName: string;
    dirPath: string;
    /** 日志文件完整路径。 */
    path: string;
    compression: Compression;
}
/** 一次日志解码的原始结果（不含 id 回退等装配逻辑）。 */
export interface ParsedLog {
    headerId?: string;
    headerCwd?: string;
    headerPreset?: string;
    hasSelected: boolean;
    /** 最后一条 selected 事件的 agentPreset（仅诊断用；可信值见 effectivePreset）。 */
    lastSelectedPreset?: string;
    /** 生效预设；仅 decodeFail === false 时可信，否则 undefined。 */
    effectivePreset?: string;
    /** 空白判定；仅 decodeFail === false 时有意义。 */
    blank: boolean;
    decodeFail: boolean;
    decodeFailReason?: string;
    /** 解析出的事件数（不含 header 行）。 */
    eventCount: number;
}
/** 装配后的会话分类（缓存值类型）。 */
export interface Classification {
    /** 原始会话 id（优先 header.id，回退目录名解码）。 */
    id: string;
    idFromHeader: boolean;
    cwd?: string;
    projectKey: string;
    path: string;
    compression: Compression;
    headerPreset?: string;
    /** 生效预设；decodeFail 或无预设依赖时 undefined。 */
    effective?: string;
    hasSelected: boolean;
    blank: boolean;
    decodeFail: boolean;
    decodeFailReason?: string;
    eventCount: number;
}
export interface FrameRange {
    start: number;
    end: number;
}
export interface FrameScanResult {
    /** 结构完整的帧区间（按文件顺序）。 */
    frames: FrameRange[];
    /** EOF 落在最后一帧内部（截断/写入中断）时的该帧起点。 */
    tornStart?: number;
    /** 结构性损坏（魔数/保留位/保留块型）描述；此前的完整帧仍保留在 frames。 */
    error?: string;
}
/**
 * 仅扫帧头定位完整帧边界，不解压块内容。与官方实现一致：EOF 落在帧内
 * 返回 tornStart；魔数/保留位损坏官方直接抛出，这里改为记录 error 并保留
 * 此前的完整帧（僵尸分类需要前缀信息：header 在首帧）。
 */
export declare function scanZstdFrames(buffer: Buffer): FrameScanResult;
export interface DecodeOptions {
    zstdCapable: boolean;
}
/** 解码一个会话日志文件（同步读盘 + 逐帧同步解压；周期性让步事件循环；zstd 能力缺失时 zstd 文件按解码失败处理）。 */
export declare function decodeSessionLog(path: string, compression: Compression, options: DecodeOptions): Promise<ParsedLog>;
/**
 * 发现扫描根下的全部会话日志。**只接受目录下精确名为 `session.jsonl.zstd`
 * 或 `session.jsonl` 的文件**——`.bak-202608311559*` 修复备份（内容是修复
 * 前的僵尸状态，扫到会误报）及其他任何文件名一律忽略。同一目录两者并存
 * 时取 `.jsonl.zstd`（当前默认物理编码）。
 */
export declare function discoverSessionLogs(root: string): SessionLogFile[];
/**
 * encodeSegment 的反映射（~XXXX 转义解码）。常规会话目录名
 * （`session-<uuid>` / 裸 `<uuid>`）是其自身；含转义时还原原始 id。
 */
export declare function decodeSegmentName(name: string): string;
/** 引擎所需的最小日志面（宿主侧传入 ctx.logger 的具名 facade；自测传记录桩）。 */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** 周期扫描所需的服务面（全部由宿主侧装配；任一缺失按 §6 降级）。 */
export interface ScanServices {
    /** 现存 preset id 集合（含 broken 标记）。undefined = agentPresets 服务缺失或 roster 获取失败 → 本轮跳过。 */
    roster?: ReadonlySet<string>;
    /** 已归档会话 id 集合。undefined = workspaceRegistry 服务缺失 → 归档禁用（report-only）。 */
    archivedIds?: ReadonlySet<string>;
    /** 会话 liveness：true = live，false = 非 live，undefined = 不可判定（agents 与 sessions 服务均缺失）。 */
    isLive: (id: string) => boolean | undefined;
    /** 官方归档服务调用（唯一写动作）。 */
    archiveSession: (id: string) => Promise<void>;
}
export interface ScanOptions {
    root: string;
    autoArchiveBlank: boolean;
    acknowledged: ReadonlySet<string>;
    /** scanRootOverride 生效时归档动作整体禁用（archiveSession 会因会话不在真实 persistence 而拒绝）。 */
    overrideMode: boolean;
    zstdCapable: boolean;
    logger: Logger;
}
export interface WarningEntry {
    id: string;
    cwd?: string;
    projectKey: string;
    hitClass: 'A' | 'B' | 'C';
    /** 去重状态键（每进程每 (session, 状态) 只 logger.warn 一次）。 */
    state: string;
    headerPreset?: string;
    effective?: string;
    blank: boolean;
    decodeFail: boolean;
    reason?: string;
    note?: string;
    /** 本轮是否首次告警（logger.warn 是否真的发出）。 */
    firstWarned: boolean;
}
export interface ScanReport {
    time: string;
    root: string;
    overrideMode: boolean;
    zstdCapable: boolean;
    archiveEnabled: boolean;
    /** 整轮跳过原因（agentPresets 缺失 / roster 获取失败）。 */
    skippedReason?: string;
    scanned: number;
    liveSkipped: number;
    decodes: number;
    cacheHits: number;
    classes: {
        A: number;
        B: number;
        C: number;
        D: number;
    };
    /** header 无 agentPreset 字段且无 selected 事件的会话：无预设依赖，永不判僵尸。 */
    noPresetDependency: number;
    /** 僵尸空白但已在归档集（幂等跳过）。 */
    alreadyArchived: number;
    decodeFailCount: number;
    archived: string[];
    archiveFailed: string[];
    /** 本轮去重后的告警明细（含历史已告警仍命中的条目；ack 静默的不列出）。 */
    warnings: WarningEntry[];
    newWarnings: number;
    silencedByAck: number;
    /** 不可抑制横幅：存在解码失败会话时结论不完整。 */
    banner?: string;
}
export interface CheckRemoveMatch {
    id: string;
    cwd?: string;
    projectKey: string;
    headerPreset?: string;
    effective?: string;
    blank: boolean;
    decodeFail: boolean;
    reason?: string;
    /** 依赖强弱标注：effective = 强（resume 按它装配），header = 弱（resume 不受影响）。 */
    dependsOn: Array<'header(weak)' | 'effective(strong)'>;
}
export interface CheckRemoveReport {
    time: string;
    presetId: string;
    root: string;
    scanned: number;
    decodes: number;
    cacheHits: number;
    matches: CheckRemoveMatch[];
    decodeFailCount: number;
    /** 不可抑制横幅：存在解码失败会话时删除安全性未确认。 */
    banner?: string;
}
/**
 * 僵尸守护引擎：持有分类缓存（路径 → stat 戳 + 分类）与每进程告警去重键。
 * 无外部资源，fiber dispose 丢弃实例即净。每轮文件发现后经 pruneStaleEntries
 * 收敛两张表：会话日志从磁盘消失后其条目不再保留（有界泄漏收敛）。
 */
export declare class ZombieGuardEngine {
    private readonly cache;
    /** 告警去重键 `${id} ${state}` → 会话 id（pruneStaleEntries 按现存会话收敛用）。 */
    private readonly warnedKeys;
    /**
     * 执行一轮扫描（周期 tick 与 preset_guard_scan 共用）。
     * 动作策略（DESIGN.md §5）：A 类（僵尸+空白+未归档+liveness 可判定非
     * live+归档可用）归档；B 类（僵尸+非空白）告警去重；C 类（解码失败 +
     * headerPreset ∉ roster）「未定」告警；liveness 不可判定命中 A → 不归档
     * 改告警标注 live? unknown；归档失败记 error 继续。
     */
    scanOnce(services: ScanServices, options: ScanOptions): Promise<ScanReport>;
    /**
     * 删除前依赖检查（DESIGN.md §7）：全量解码每一个会话日志——不跳 live、
     * 无阈值捷径；与周期扫描共用分类缓存（stat 戳命中 = 同内容的完整分类，
     * 非尺寸捷径）。依赖匹配 `headerPreset === presetId ∨ effective === presetId`，
     * 强弱依赖分别标注；存在解码失败文件时输出不可抑制横幅。
     * acknowledgedSessions 不适用于本工具（安全检查必须完整）。
     */
    checkRemove(presetId: string, options: ScanOptions): Promise<CheckRemoveReport>;
    /** stat 戳命中则复用缓存分类，否则全量解码并写缓存。stat 失败按解码失败处理且不缓存。 */
    private classifyFile;
    /**
     * 每轮文件发现后的有界泄漏收敛：会话日志从磁盘消失后，其缓存条目与告警
     * 去重键不再保留。cache 直接按路径删；warnedKeys 按值中记录的会话 id 对照
     * 「现存文件可推出的 id 集合」删——目录名解码 id ∪ 存活缓存条目的分类 id
     * （header id 优先、目录名回退，与 classification.id 的取值一致）。被删会话
     * 若重新出现（恢复/还原），视为新事件重新告警。
     */
    private pruneStaleEntries;
    /** 告警去重 + acknowledged 静默 + logger.warn（每进程每 (id, state) 一次；会话文件消失后键被 pruneStaleEntries 移除，重现则重新告警）。 */
    private emitWarning;
}
