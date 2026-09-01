/**
 * dsh-preset-zombie-guard — 日志解码与分类核心（宿主无关）。
 *
 * 本模块不 import 任何 cordis/DSH 服务：会话日志发现、zstd 帧解码、
 * 预设依赖分类、周期扫描引擎与删除前检查全部在此实现，宿主侧
 * （src/index.ts）只负责服务装配与工具注册；src/selftest.ts 直接
 * 复用本模块在无宿主进程的环境下自测。
 *
 * 关键事实（2026-08-31 事故取证 + dsh-session-persistence-jsonl 源码核对）：
 * - 会话日志布局 `<DSH_HOME>\sessions\<encoded-cwd>\<encoded-session-id>\
 *   session.jsonl.zstd`（或无压缩 `session.jsonl`）；会话目录名有两种形态
 *   （`session-<uuid>` 与裸 `<uuid>`）。
 * - 写入器把「一批事件压成一个 zstd 帧」，帧内是**多行** JSON（每行一个
 *   事件，行尾 \n）；首帧只含 header（type:"session"）。解码必须把每个帧
 *   的解压文本按 \n 拆行再逐行 JSON.parse。
 * - 生效预设（effective）= 最后一条 `agent-preset/selected` 事件的
 *   `data.agentPreset`，否则 header `agentPreset`（resolveSessionPreset）。
 *   僵尸判定统一以 effective 为准；header 是创建事实（深冻结），
 *   header 失配但 effective 健康的会话是健康的。
 * - 2026-08-31 修复在三个会话目录留下 `.bak-202608311559*` 备份
 *   （修复前的僵尸状态）：文件发现只接受**精确**文件名
 *   `session.jsonl.zstd` / `session.jsonl`，其余一律忽略。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
/** Zstandard 帧魔数（文件字节序 28 B5 2F FD，小端读数）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/**
 * blank 判定白名单（钉死，DESIGN.md §4 v1.3）：`agent-preset/selected`、三个
 * 创建生命周期事件（`permission/preset` / `sandbox/mode` / `approval/policy`，
 * 宿主创建会话时必写的环境快照，不含用户内容——真实空白会话创建即携带，
 * id-α 实测形状）与全部 `session/*` 类型。出现白名单外类型即非 blank，
 * 未知类型一律按非 blank（保守方向：宁可少归档，不可误归档）。
 */
export function isBenignType(type) {
    return (type === 'agent-preset/selected' ||
        type === 'permission/preset' ||
        type === 'sandbox/mode' ||
        type === 'approval/policy' ||
        type.startsWith('session/'));
}
function newParseState() {
    return {
        headerSeen: false,
        hasSelected: false,
        sawStepStart: false,
        allBenign: true,
        eventCount: 0,
        decodeFail: false,
    };
}
/**
 * 事件循环让步（调用方先用 Date.now() - policy.lastYield >= YIELD_INTERVAL_MS
 * 判断是否到期；对齐官方 backend 的 ZSTD_DECODE_YIELD_INTERVAL_MS=500 先例）：
 * 逐帧 zstdDecompressSync 是 node:zlib 公开 API 下唯一的多帧解码方式（一次性/
 * 流式接口实测都只解首帧），大日志（数万帧）同步解码会阻塞宿主事件循环数秒，
 * 故周期性让步。不改变任何分类语义。
 */
const YIELD_INTERVAL_MS = 250;
function newYieldPolicy() {
    return { lastYield: Date.now() };
}
async function maybeYield(policy) {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    policy.lastYield = Date.now();
}
function emptyParsed(reason) {
    return { hasSelected: false, blank: false, decodeFail: true, decodeFailReason: reason, eventCount: 0 };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * 仅扫帧头定位完整帧边界，不解压块内容。与官方实现一致：EOF 落在帧内
 * 返回 tornStart；魔数/保留位损坏官方直接抛出，这里改为记录 error 并保留
 * 此前的完整帧（僵尸分类需要前缀信息：header 在首帧）。
 */
export function scanZstdFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4)
            return { frames, tornStart: start };
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
            return { frames, error: `invalid frame magic at byte ${offset}` };
        offset += 4;
        if (offset === buffer.length)
            return { frames, tornStart: start };
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 24) !== 0)
            return { frames, error: `reserved frame-header bit at byte ${offset - 1}` };
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes)
            return { frames, tornStart: start };
        offset += remainingHeaderBytes;
        for (;;) {
            if (buffer.length - offset < 3)
                return { frames, tornStart: start };
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 3;
            const blockSize = blockHeader >>> 3;
            if (blockType === 3)
                return { frames, error: `reserved block type at byte ${offset - 3}` };
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes)
                return { frames, tornStart: start };
            offset += payloadBytes;
            if (lastBlock)
                break;
        }
        if (checksum) {
            if (buffer.length - offset < 4)
                return { frames, tornStart: start };
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return { frames };
}
//#endregion
//#region 日志解码
/** 消费一段解压文本：按 \n 拆行，逐行 JSON.parse（多事件帧的关键路径）。 */
async function consumeLines(text, state, policy) {
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.length === 0)
            continue;
        consumeLine(line, state);
        if (policy !== undefined && Date.now() - policy.lastYield >= YIELD_INTERVAL_MS)
            await maybeYield(policy);
    }
}
function consumeLine(line, state) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        state.decodeFail = true;
        if (state.decodeFailReason === undefined)
            state.decodeFailReason = 'bad-json-line';
        return;
    }
    if (!isRecord(parsed)) {
        state.decodeFail = true;
        if (state.decodeFailReason === undefined)
            state.decodeFailReason = 'non-object-line';
        return;
    }
    if (!state.headerSeen) {
        if (parsed['type'] !== 'session') {
            state.decodeFail = true;
            if (state.decodeFailReason === undefined)
                state.decodeFailReason = 'bad-header';
            return;
        }
        state.headerSeen = true;
        const id = parsed['id'];
        const cwd = parsed['cwd'];
        const preset = parsed['agentPreset'];
        if (typeof id !== 'string' || id.length === 0) {
            state.decodeFail = true;
            if (state.decodeFailReason === undefined)
                state.decodeFailReason = 'header-no-id';
        }
        else {
            state.headerId = id;
        }
        if (typeof cwd === 'string')
            state.headerCwd = cwd;
        if (typeof preset === 'string')
            state.headerPreset = preset;
        return;
    }
    const type = typeof parsed['type'] === 'string' ? parsed['type'] : '';
    state.eventCount++;
    if (type === 'agent-preset/selected') {
        state.hasSelected = true;
        const data = parsed['data'];
        const preset = isRecord(data) ? data['agentPreset'] : undefined;
        if (typeof preset === 'string') {
            state.lastSelectedPreset = preset;
        }
        else {
            // selected 事件缺 agentPreset：effective 不可信，按解码失败处理。
            state.decodeFail = true;
            if (state.decodeFailReason === undefined)
                state.decodeFailReason = 'malformed-selected';
        }
    }
    if (type === 'step/start')
        state.sawStepStart = true;
    if (!isBenignType(type))
        state.allBenign = false;
}
/** 汇总解析状态为 ParsedLog；decodeFail 时 effective/blank 置为不可信。 */
function finalizeParse(state) {
    if (state.decodeFail) {
        return {
            headerId: state.headerId,
            headerCwd: state.headerCwd,
            headerPreset: state.headerPreset,
            hasSelected: state.hasSelected,
            lastSelectedPreset: state.lastSelectedPreset,
            effectivePreset: undefined,
            blank: false,
            decodeFail: true,
            decodeFailReason: state.decodeFailReason,
            eventCount: state.eventCount,
        };
    }
    const effective = state.hasSelected ? state.lastSelectedPreset : state.headerPreset;
    return {
        headerId: state.headerId,
        headerCwd: state.headerCwd,
        headerPreset: state.headerPreset,
        hasSelected: state.hasSelected,
        lastSelectedPreset: state.lastSelectedPreset,
        effectivePreset: effective,
        blank: !state.sawStepStart && state.allBenign,
        decodeFail: false,
        eventCount: state.eventCount,
    };
}
async function decodeZstdLog(buffer) {
    const state = newParseState();
    const policy = newYieldPolicy();
    const scan = scanZstdFrames(buffer);
    for (const frame of scan.frames) {
        if (Date.now() - policy.lastYield >= YIELD_INTERVAL_MS)
            await maybeYield(policy);
        let text;
        try {
            text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
        }
        catch {
            // 帧损坏：计数并跳过，不中断扫描（DESIGN.md §4）。
            state.decodeFail = true;
            if (state.decodeFailReason === undefined)
                state.decodeFailReason = `frame-decompress@${frame.start}`;
            continue;
        }
        await consumeLines(text, state, policy);
    }
    if (scan.tornStart !== undefined) {
        state.decodeFail = true;
        if (state.decodeFailReason === undefined)
            state.decodeFailReason = 'torn-tail';
    }
    if (scan.error !== undefined) {
        state.decodeFail = true;
        if (state.decodeFailReason === undefined)
            state.decodeFailReason = scan.error;
    }
    if (!state.headerSeen && !state.decodeFail) {
        state.decodeFail = true;
        state.decodeFailReason = 'no-frames';
    }
    return finalizeParse(state);
}
async function decodeJsonlLog(buffer) {
    const state = newParseState();
    if (buffer.length === 0) {
        state.decodeFail = true;
        state.decodeFailReason = 'empty';
        return finalizeParse(state);
    }
    const text = buffer.toString('utf8');
    // 官方写入器每批以 \n 结尾；不以 \n 结尾 = 末行写入中断（torn tail）。
    if (!text.endsWith('\n')) {
        state.decodeFail = true;
        state.decodeFailReason = 'torn-tail';
    }
    await consumeLines(text, state, newYieldPolicy());
    if (!state.headerSeen && !state.decodeFail) {
        state.decodeFail = true;
        state.decodeFailReason = 'no-header';
    }
    return finalizeParse(state);
}
/** 解码一个会话日志文件（同步读盘 + 逐帧同步解压；周期性让步事件循环；zstd 能力缺失时 zstd 文件按解码失败处理）。 */
export async function decodeSessionLog(path, compression, options) {
    if (compression === 'zstd' && !options.zstdCapable) {
        return emptyParsed('zstd-unsupported');
    }
    let buffer;
    try {
        buffer = readFileSync(path);
    }
    catch {
        return emptyParsed('read-error');
    }
    return compression === 'zstd' ? decodeZstdLog(buffer) : decodeJsonlLog(buffer);
}
//#endregion
//#region 会话文件发现与目录名解码
function isRegularFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/**
 * 发现扫描根下的全部会话日志。**只接受目录下精确名为 `session.jsonl.zstd`
 * 或 `session.jsonl` 的文件**——`.bak-202608311559*` 修复备份（内容是修复
 * 前的僵尸状态，扫到会误报）及其他任何文件名一律忽略。同一目录两者并存
 * 时取 `.jsonl.zstd`（当前默认物理编码）。
 */
export function discoverSessionLogs(root) {
    const out = [];
    let projects;
    try {
        projects = readdirSync(root, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const project of projects) {
        if (!project.isDirectory())
            continue;
        const projectPath = join(root, project.name);
        let sessionDirs;
        try {
            sessionDirs = readdirSync(projectPath, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of sessionDirs) {
            if (!entry.isDirectory())
                continue;
            const dirPath = join(projectPath, entry.name);
            const zstdPath = join(dirPath, 'session.jsonl.zstd');
            const jsonlPath = join(dirPath, 'session.jsonl');
            if (isRegularFile(zstdPath)) {
                out.push({ projectKey: project.name, dirName: entry.name, dirPath, path: zstdPath, compression: 'zstd' });
            }
            else if (isRegularFile(jsonlPath)) {
                out.push({ projectKey: project.name, dirName: entry.name, dirPath, path: jsonlPath, compression: 'jsonl' });
            }
        }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
}
/**
 * encodeSegment 的反映射（~XXXX 转义解码）。常规会话目录名
 * （`session-<uuid>` / 裸 `<uuid>`）是其自身；含转义时还原原始 id。
 */
export function decodeSegmentName(name) {
    if (name === '~002E')
        return '.';
    if (name === '~002E~002E')
        return '..';
    let out = '';
    let i = 0;
    while (i < name.length) {
        if (name[i] === '~' && i + 5 <= name.length) {
            const code = Number.parseInt(name.slice(i + 1, i + 5), 16);
            if (Number.isFinite(code)) {
                out += String.fromCharCode(code);
                i += 5;
                continue;
            }
        }
        out += name[i];
        i += 1;
    }
    return out;
}
/**
 * 僵尸守护引擎：持有分类缓存（路径 → stat 戳 + 分类）与每进程告警去重键。
 * 无外部资源，fiber dispose 丢弃实例即净。每轮文件发现后经 pruneStaleEntries
 * 收敛两张表：会话日志从磁盘消失后其条目不再保留（有界泄漏收敛）。
 */
export class ZombieGuardEngine {
    cache = new Map();
    /** 告警去重键 `${id} ${state}` → 会话 id（pruneStaleEntries 按现存会话收敛用）。 */
    warnedKeys = new Map();
    /**
     * 执行一轮扫描（周期 tick 与 preset_guard_scan 共用）。
     * 动作策略（DESIGN.md §5）：A 类（僵尸+空白+未归档+liveness 可判定非
     * live+归档可用）归档；B 类（僵尸+非空白）告警去重；C 类（解码失败 +
     * headerPreset ∉ roster）「未定」告警；liveness 不可判定命中 A → 不归档
     * 改告警标注 live? unknown；归档失败记 error 继续。
     */
    async scanOnce(services, options) {
        const report = {
            time: new Date().toISOString(),
            root: options.root,
            overrideMode: options.overrideMode,
            zstdCapable: options.zstdCapable,
            archiveEnabled: false,
            scanned: 0,
            liveSkipped: 0,
            decodes: 0,
            cacheHits: 0,
            classes: { A: 0, B: 0, C: 0, D: 0 },
            noPresetDependency: 0,
            alreadyArchived: 0,
            decodeFailCount: 0,
            archived: [],
            archiveFailed: [],
            warnings: [],
            newWarnings: 0,
            silencedByAck: 0,
        };
        if (services.roster === undefined) {
            report.skippedReason = 'agentPresets 服务缺失或 roster 获取失败';
            options.logger.warn('[preset-zombie-guard] 无 preset roster（agentPresets 服务缺失或 list() 失败），本轮扫描跳过');
            return report;
        }
        const roster = services.roster;
        const archiveEnabled = options.autoArchiveBlank && !options.overrideMode && services.archivedIds !== undefined && options.zstdCapable;
        report.archiveEnabled = archiveEnabled;
        const files = discoverSessionLogs(options.root);
        this.pruneStaleEntries(files);
        report.scanned = files.length;
        for (const file of files) {
            // 先查服务（liveness），后碰文件：活会话 composition 在内存，且避免为持续增长的日志付解码。
            const dirId = decodeSegmentName(file.dirName);
            const live = services.isLive(dirId);
            if (live === true) {
                report.liveSkipped += 1;
                continue;
            }
            const { classification, cacheHit } = await this.classifyFile(file, options);
            if (cacheHit)
                report.cacheHits += 1;
            else
                report.decodes += 1;
            if (classification.decodeFail) {
                report.decodeFailCount += 1;
                const headerOutsideRoster = classification.headerPreset === undefined || !roster.has(classification.headerPreset);
                if (headerOutsideRoster) {
                    // C 类：解码失败且 headerPreset ∉ roster（header 预设未知也计入——无法给安全结论）。
                    report.classes.C += 1;
                    this.emitWarning(report, options, classification, 'C', `C:${classification.headerPreset ?? '?'}:${classification.decodeFailReason ?? 'decode-fail'}`, classification.headerPreset === undefined ? 'header 预设未知（header 不可读或无 agentPreset 字段），依赖不可判' : undefined);
                }
                continue;
            }
            // header 无 agentPreset 字段且无 selected 事件 → 无预设依赖，跳过（永不判僵尸）。
            if (classification.effective === undefined) {
                report.noPresetDependency += 1;
                continue;
            }
            // 僵尸判定统一以 effective 为准：header 失配但 effective 健康的会话是健康的（D 类）。
            if (roster.has(classification.effective)) {
                report.classes.D += 1;
                continue;
            }
            // 僵尸（effective ∉ roster）
            if (!classification.blank) {
                report.classes.B += 1;
                this.emitWarning(report, options, classification, 'B', `B:${classification.effective}`);
                continue;
            }
            // A 类：僵尸 + 空白（白名单）
            report.classes.A += 1;
            if (services.archivedIds !== undefined && services.archivedIds.has(classification.id)) {
                report.alreadyArchived += 1;
                continue;
            }
            if (live === undefined) {
                // liveness 不可判定：宁可漏归档，不可在可能活跃时归档 → 按 B 告警并标注。
                this.emitWarning(report, options, classification, 'A', `A:${classification.effective}:live-unknown`, 'live? unknown（agents 与 sessions 服务均缺失，不归档）');
                continue;
            }
            if (!archiveEnabled) {
                this.emitWarning(report, options, classification, 'A', `A:${classification.effective}:report-only`, 'report-only（autoArchiveBlank=false / override 模式 / workspaceRegistry 或 zstd 能力缺失），按 B 类告警处理');
                continue;
            }
            try {
                await services.archiveSession(classification.id);
                report.archived.push(classification.id);
                options.logger.info(`[preset-zombie-guard] 归档僵尸空白会话 ${classification.id}（effective=${classification.effective} ∉ roster）`);
            }
            catch (error) {
                report.archiveFailed.push(classification.id);
                options.logger.error(`[preset-zombie-guard] 归档 ${classification.id} 失败：${String(error)}（继续下一个）`);
            }
        }
        // v1.3 口径：横幅 N 统计**全部** decodeFail 文件——decodeFailCount 在循环内
        // 对每个解码失败文件递增（先于 C 类判定，无论 header 健康与否、无论命中
        // 哪类）：header 健康的解码失败同样意味着结论不完整。不可抑制。
        if (report.decodeFailCount > 0) {
            report.banner = `${report.decodeFailCount} 个会话未能完整解码，结论不完整`;
        }
        return report;
    }
    /**
     * 删除前依赖检查（DESIGN.md §7）：全量解码每一个会话日志——不跳 live、
     * 无阈值捷径；与周期扫描共用分类缓存（stat 戳命中 = 同内容的完整分类，
     * 非尺寸捷径）。依赖匹配 `headerPreset === presetId ∨ effective === presetId`，
     * 强弱依赖分别标注；存在解码失败文件时输出不可抑制横幅。
     * acknowledgedSessions 不适用于本工具（安全检查必须完整）。
     */
    async checkRemove(presetId, options) {
        const report = {
            time: new Date().toISOString(),
            presetId,
            root: options.root,
            scanned: 0,
            decodes: 0,
            cacheHits: 0,
            matches: [],
            decodeFailCount: 0,
        };
        const files = discoverSessionLogs(options.root);
        this.pruneStaleEntries(files);
        report.scanned = files.length;
        for (const file of files) {
            const { classification, cacheHit } = await this.classifyFile(file, options);
            if (cacheHit)
                report.cacheHits += 1;
            else
                report.decodes += 1;
            if (classification.decodeFail)
                report.decodeFailCount += 1;
            const dependsOn = [];
            if (classification.headerPreset === presetId)
                dependsOn.push('header(weak)');
            if (!classification.decodeFail && classification.effective === presetId)
                dependsOn.push('effective(strong)');
            if (dependsOn.length === 0)
                continue;
            report.matches.push({
                id: classification.id,
                cwd: classification.cwd,
                projectKey: classification.projectKey,
                headerPreset: classification.headerPreset,
                effective: classification.effective,
                blank: classification.blank,
                decodeFail: classification.decodeFail,
                reason: classification.decodeFailReason,
                dependsOn,
            });
        }
        if (report.decodeFailCount > 0) {
            report.banner = `${report.decodeFailCount} 个会话未完整分析，删除安全性未确认`;
        }
        return report;
    }
    /** stat 戳命中则复用缓存分类，否则全量解码并写缓存。stat 失败按解码失败处理且不缓存。 */
    async classifyFile(file, options) {
        let stamp;
        try {
            const st = statSync(file.path);
            stamp = { size: st.size, mtimeMs: st.mtimeMs };
        }
        catch {
            return { classification: buildClassification(file, emptyParsed('stat-error')), cacheHit: false };
        }
        const cached = this.cache.get(file.path);
        if (cached !== undefined && cached.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) {
            return { classification: cached.classification, cacheHit: true };
        }
        const parsed = await decodeSessionLog(file.path, file.compression, { zstdCapable: options.zstdCapable });
        const classification = buildClassification(file, parsed);
        this.cache.set(file.path, { stamp, classification });
        return { classification, cacheHit: false };
    }
    /**
     * 每轮文件发现后的有界泄漏收敛：会话日志从磁盘消失后，其缓存条目与告警
     * 去重键不再保留。cache 直接按路径删；warnedKeys 按值中记录的会话 id 对照
     * 「现存文件可推出的 id 集合」删——目录名解码 id ∪ 存活缓存条目的分类 id
     * （header id 优先、目录名回退，与 classification.id 的取值一致）。被删会话
     * 若重新出现（恢复/还原），视为新事件重新告警。
     */
    pruneStaleEntries(files) {
        const livePaths = new Set(files.map((file) => file.path));
        for (const path of this.cache.keys()) {
            if (!livePaths.has(path))
                this.cache.delete(path);
        }
        const knownIds = new Set();
        for (const file of files)
            knownIds.add(decodeSegmentName(file.dirName));
        for (const entry of this.cache.values())
            knownIds.add(entry.classification.id);
        for (const [key, id] of this.warnedKeys) {
            if (!knownIds.has(id))
                this.warnedKeys.delete(key);
        }
    }
    /** 告警去重 + acknowledged 静默 + logger.warn（每进程每 (id, state) 一次；会话文件消失后键被 pruneStaleEntries 移除，重现则重新告警）。 */
    emitWarning(report, options, classification, hitClass, state, note) {
        if (options.acknowledged.has(classification.id)) {
            report.silencedByAck += 1;
            return;
        }
        const key = `${classification.id} ${state}`;
        const firstWarned = !this.warnedKeys.has(key);
        if (firstWarned)
            this.warnedKeys.set(key, classification.id);
        report.warnings.push({
            id: classification.id,
            cwd: classification.cwd,
            projectKey: classification.projectKey,
            hitClass,
            state,
            headerPreset: classification.headerPreset,
            effective: classification.effective,
            blank: classification.blank,
            decodeFail: classification.decodeFail,
            reason: classification.decodeFailReason,
            note,
            firstWarned,
        });
        if (!firstWarned)
            return;
        report.newWarnings += 1;
        const parts = [
            `[preset-zombie-guard] ${hitClass} 类命中 ${classification.id}`,
            `cwd=${classification.cwd ?? classification.projectKey}`,
            `header=${classification.headerPreset ?? '无'}`,
            `effective=${classification.effective ?? '未知'}`,
        ];
        if (classification.decodeFail)
            parts.push(`解码失败(${classification.decodeFailReason ?? '?'})`);
        if (note !== undefined)
            parts.push(note);
        options.logger.warn(parts.join(' '));
    }
}
/** 装配分类：id 优先 header.id（权威），回退目录名解码。 */
function buildClassification(file, parsed) {
    return {
        id: parsed.headerId ?? decodeSegmentName(file.dirName),
        idFromHeader: parsed.headerId !== undefined,
        cwd: parsed.headerCwd,
        projectKey: file.projectKey,
        path: file.path,
        compression: file.compression,
        headerPreset: parsed.headerPreset,
        effective: parsed.decodeFail ? undefined : parsed.effectivePreset,
        hasSelected: parsed.hasSelected,
        blank: parsed.decodeFail ? false : parsed.blank,
        decodeFail: parsed.decodeFail,
        decodeFailReason: parsed.decodeFailReason,
        eventCount: parsed.eventCount,
    };
}
//# sourceMappingURL=classifier.js.map