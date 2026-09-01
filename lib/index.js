import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { ZombieGuardEngine, } from './classifier.js';
export const name = 'dsh-preset-zombie-guard';
export const inject = ['timer', 'tools'];
export const Config = z.object({
    intervalMs: z.number().min(5000).default(900000),
    autoArchiveBlank: z.boolean().default(true),
    acknowledgedSessions: z.array(z.string()).default([]),
    scanRootOverride: z.string().default(''),
});
export function apply(ctx, config) {
    const logger = ctx.logger('preset-zombie-guard');
    // 启动能力检查（§3）：无 zstd 解码能力时连僵尸判定都不可靠 → warn + 整体 report-only。
    const zstdCapable = typeof zlib.zstdDecompressSync === 'function';
    if (!zstdCapable) {
        logger.warn('node:zlib 缺少 zstdDecompressSync（需 Node ≥ 23.8.0）：进入 report-only，.zstd 会话日志无法解码，结论不完整');
    }
    const override = config.scanRootOverride.trim();
    // DSH_HOME 优先（web 进程 homedir 可能与 DSH_HOME 不一致），与 dsh-home-paths 的 resolveDshHome 语义一致。
    const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh');
    const scanRoot = override !== '' ? override : join(dshHome, 'sessions');
    const engine = new ZombieGuardEngine();
    const acknowledged = new Set(config.acknowledgedSessions);
    let lastReport;
    const scanOptions = {
        root: scanRoot,
        autoArchiveBlank: config.autoArchiveBlank,
        acknowledged,
        overrideMode: override !== '',
        zstdCapable,
        logger,
    };
    /** 每轮扫描装配服务面（服务可随 fiber 生灭，逐轮重新获取）。 */
    async function runScan() {
        const presets = ctx.get('agentPresets');
        const registry = ctx.get('workspaceRegistry');
        const agents = ctx.get('agents');
        const sessions = ctx.get('sessions');
        let roster;
        if (presets !== undefined) {
            try {
                roster = new Set((await presets.list()).map((preset) => preset.id));
            }
            catch (error) {
                logger.warn(`agentPresets.list() 失败：${String(error)}（本轮按无 roster 跳过）`);
                roster = undefined;
            }
        }
        let archivedIds;
        if (registry !== undefined) {
            try {
                archivedIds = new Set(registry.archivedSessionIds);
            }
            catch (error) {
                logger.warn(`workspaceRegistry.archivedSessionIds 读取失败：${String(error)}（归档禁用，仍扫描告警）`);
                archivedIds = undefined;
            }
        }
        const services = {
            roster,
            archivedIds,
            isLive(id) {
                // 至少一个服务成功查询且未命中才算非 live；无服务可查（或全部查询失败）= 不可判定。
                let known = false;
                try {
                    if (agents !== undefined) {
                        // != null：null 与 undefined 同为未命中——服务以 null 报缺席时不得全体误判 live。
                        if (agents.get(id) != null)
                            return true;
                        known = true;
                    }
                }
                catch {
                    /* 单服务查询失败按该服务不可用 */
                }
                try {
                    if (sessions !== undefined) {
                        if (sessions.get(id) != null)
                            return true;
                        known = true;
                    }
                }
                catch {
                    /* 同上 */
                }
                return known ? false : undefined;
            },
            async archiveSession(id) {
                await registry?.archiveSession(id);
            },
        };
        const report = await engine.scanOnce(services, scanOptions);
        lastReport = report;
        return report;
    }
    // tick 与手动 scan/check_remove 串行，避免并发重复解码与动作交错。
    let chain = Promise.resolve();
    function serialized(task) {
        const run = chain.then(task, task);
        chain = run.then(() => undefined, () => undefined);
        return run;
    }
    // ═══ 周期 tick：intervalMs 一轮（首个 tick 在一个间隔之后；启动首扫见 apply 末尾，立即扫描用 preset_guard_scan）═══
    ctx.setInterval(() => {
        void serialized(runScan).catch((error) => {
            logger.error(`周期扫描异常：${String(error)}`);
        });
    }, config.intervalMs);
    function formatScanReport(r) {
        const lines = [];
        lines.push(`preset-zombie-guard 扫描报告 ${r.time}`);
        lines.push(`root: ${r.root}${r.overrideMode ? '（override 模式，归档动作禁用）' : ''}`);
        if (r.skippedReason !== undefined) {
            lines.push(`本轮跳过：${r.skippedReason}（无 roster 无法判定僵尸）`);
            return lines.join('\n');
        }
        lines.push(`会话: scanned=${r.scanned} liveSkipped=${r.liveSkipped} cacheHits=${r.cacheHits} decodes=${r.decodes} zstd=${r.zstdCapable ? 'ok' : '缺失'}`);
        lines.push(`命中: A僵尸空白=${r.classes.A} B僵尸非空白=${r.classes.B} C未定=${r.classes.C} D健康=${r.classes.D} 无预设依赖=${r.noPresetDependency} 已归档跳过=${r.alreadyArchived} 解码失败=${r.decodeFailCount}`);
        if (r.archived.length > 0)
            lines.push(`已归档: ${r.archived.join(', ')}`);
        if (r.archiveFailed.length > 0)
            lines.push(`归档失败(已记error): ${r.archiveFailed.join(', ')}`);
        lines.push(`告警明细(去重): ${r.warnings.length} 条（本轮新告警 ${r.newWarnings}，ack 静默 ${r.silencedByAck}）`);
        for (const w of r.warnings) {
            const parts = [
                `  [${w.hitClass}] ${w.id}`,
                `cwd=${w.cwd ?? w.projectKey}`,
                `header=${w.headerPreset ?? '无'}`,
                `effective=${w.effective ?? '未知'}`,
            ];
            if (w.decodeFail)
                parts.push(`解码失败(${w.reason ?? '?'})`);
            if (w.note !== undefined)
                parts.push(w.note);
            if (!w.firstWarned)
                parts.push('（已告警过，不重复）');
            lines.push(parts.join(' '));
        }
        if (r.banner !== undefined)
            lines.push(`⚠️ ${r.banner}`);
        return lines.join('\n');
    }
    function formatCheckRemoveReport(r) {
        const lines = [];
        lines.push(`preset_guard_check_remove("${r.presetId}") ${r.time}`);
        lines.push(`root: ${r.root}  scanned=${r.scanned} cacheHits=${r.cacheHits} decodes=${r.decodes}`);
        if (r.matches.length === 0) {
            lines.push('依赖清单: 空 —— 没有会话依赖该预设');
        }
        else {
            lines.push(`依赖清单: ${r.matches.length} 个会话`);
            for (const m of r.matches) {
                const parts = [
                    `  ${m.id}`,
                    `cwd=${m.cwd ?? m.projectKey}`,
                    `blank=${m.blank}`,
                    `header=${m.headerPreset ?? '无'}`,
                    `effective=${m.effective ?? '未知'}`,
                    `依赖=${m.dependsOn.join('+')}`,
                ];
                if (m.decodeFail)
                    parts.push(`（该会话解码失败 ${m.reason ?? '?'}，effective 不可知）`);
                lines.push(parts.join(' '));
            }
        }
        if (r.banner !== undefined) {
            lines.push(`⚠️ ${r.banner}`);
            lines.push('存在未完整分析横幅：本清单不完整，删除操作不可视为安全。');
        }
        else {
            lines.push('无未完整分析横幅：清单可视为完整。');
        }
        return lines.join('\n');
    }
    // ─── 工具注册（ctx.effect：fiber dispose 自动注销）─────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'preset_guard_scan',
        description: '预设僵尸守护：立即执行一轮全量会话日志扫描并返回报告（扫描数/命中分类 A僵尸空白 B僵尸非空白 C未定 D健康/归档动作清单），不等周期 tick。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute() {
            const report = await serialized(runScan);
            return formatScanReport(report);
        },
    })), 'preset-zombie-guard: scan tool');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'preset_guard_check_remove',
        description: '删除预设前的依赖安全检查：全量解码所有会话日志，列出依赖指定 presetId 的会话（effective=强依赖，header=弱依赖）。使用纪律：删除任何用户预设前必须先跑本工具，且必须确认输出无「未完整分析」横幅才可视为安全。',
        parameters: {
            presetId: { type: 'string', required: true, description: '待删除的预设 id' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
            const presetId = args.presetId.trim();
            if (presetId === '')
                return 'ERROR: presetId 不能为空';
            const report = await serialized(() => engine.checkRemove(presetId, scanOptions));
            return formatCheckRemoveReport(report);
        },
    })), 'preset-zombie-guard: check_remove tool');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'preset_guard_last_report',
        description: '预设僵尸守护：查询最近一次扫描的报告快照（时间/扫描数/各类命中/去重后的告警明细/未完成横幅）。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute() {
            if (lastReport === undefined) {
                return '尚无扫描报告：首扫尚未完成，稍后重试。';
            }
            return formatScanReport(lastReport);
        },
    })), 'preset-zombie-guard: last_report tool');
    logger.info(`守护启动：每 ${config.intervalMs}ms 扫描 ${scanRoot}${override !== '' ? '（override，归档禁用）' : ''}` +
        `${config.autoArchiveBlank ? '' : '（autoArchiveBlank=false，report-only）'}` +
        `${acknowledged.size > 0 ? `（ack ${acknowledged.size} 会话）` : ''}`);
    // ─── 首扫：装配即排队，消除持久装配后最长 intervalMs 的启动盲区 ─────────────
    // 沿用互斥锁与 runScan（与 tick/工具调用完全串行）；void 异步触发，不在
    // 插件加载路径上同步 await。
    void serialized(runScan).catch((error) => {
        logger.error(`首扫异常：${String(error)}`);
    });
}
//# sourceMappingURL=index.js.map