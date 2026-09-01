/**
 * dsh-preset-zombie-guard — 离线自测（node lib/selftest.js，不依赖宿主进程）。
 *
 * 在临时目录构造合成会话日志（与官方写入器字节级同构：JSON 行 + zstd 单帧
 * + checksum flag，首帧只含 header），对 DESIGN.md §9.4 四用例与补充用例
 * 做全量断言：
 *   (a) zstd 僵尸空白 → A 类自动归档（含 .jsonl 路径）
 *   (a2) v1.3 判别用例：header 指向不存在预设 + 三个创建生命周期事件
 *       （permission/preset、sandbox/mode、approval/policy）无 turn 活动 →
 *       僵尸空白（id-α 的真实形状——扩表前会被误判为非空白）
 *   (a3) 同 (a2) 但含一条 user/message → 僵尸非空白（扩表不放过真对话）
 *   (b) zstd 僵尸非空白（header 健康、selected 指向已删预设）→ B 类告警；
 *       check_remove(<已删预设>) 能列出它（header-only 检查会漏的 β 类判别用例）
 *   (c) 截断 zstd 帧 → decodeFail 计数、扫描继续、无未捕获异常、报告含不完整横幅
 *   (c2) header 健康的 decodeFail 文件（帧损坏）→ 不入 C 类但计入未完整横幅
 *       （v1.3 口径：N 统计全部 decodeFail 文件，不只 C 类）
 *   (d) autoArchiveBlank=false 与 override 模式 → 分类正确且归档调用计数为 0
 *   (e) .bak-* 后缀文件被完全忽略
 *   (f) header 无 agentPreset 字段的会话被跳过（无预设依赖）
 *   (g) 缓存命中：同目录第二次扫描零重解码（解码计数器断言）
 *   (h) 多事件单帧日志（一帧 ≥3 行事件）被完整解析
 *   (i) agentPresets 缺失 → 整轮跳过并 warn
 *   (j) liveness 不可判定 → 命中 A 不归档，告警标注 live? unknown
 *   (k) zstd 能力缺失 → zstd 日志按解码失败计、归档禁用、横幅仍在
 *   (l) 已归档会话幂等跳过
 *   (m) live 会话在碰文件前跳过
 *   (n) B 类告警每进程每 (id,状态) 去重一次 + acknowledgedSessions 永久静默
 * 结束清理临时目录；全部通过退出码 0。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { ZombieGuardEngine, decodeSegmentName, decodeSessionLog, scanZstdFrames, } from './classifier.js';
const CHECKSUM_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
/** 官方写入器同构：一批（多行）事件压成一个 zstd 单帧，帧内行尾 \n。 */
function zstdFrame(lines) {
    return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), CHECKSUM_OPTS);
}
function headerLine(spec) {
    const record = {
        type: 'session',
        version: 0,
        id: spec.id,
        createdAt: 1787000000000,
        cwd: spec.cwd,
        delegationDepth: 0,
    };
    if (spec.agentPreset !== undefined)
        record['agentPreset'] = spec.agentPreset;
    return JSON.stringify(record);
}
function event(type, seq, data) {
    const record = { type, seq, time: 1787000000000 + seq };
    if (data !== undefined)
        record['data'] = data;
    return JSON.stringify(record);
}
function writeZstdSession(root, projectKey, dirName, header, batches) {
    const dir = join(root, projectKey, dirName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'session.jsonl.zstd');
    const parts = [zstdFrame([headerLine(header)])];
    for (const batch of batches)
        parts.push(zstdFrame(batch));
    writeFileSync(path, Buffer.concat(parts));
    return path;
}
function writeJsonlSession(root, projectKey, dirName, header, eventLines) {
    const dir = join(root, projectKey, dirName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, [headerLine(header), ...eventLines].join('\n') + '\n', 'utf8');
    return path;
}
function recordingLogger() {
    const info = [];
    const warn = [];
    const error = [];
    return {
        logger: {
            info: (message) => {
                info.push(message);
            },
            warn: (message) => {
                warn.push(message);
            },
            error: (message) => {
                error.push(message);
            },
        },
        info,
        warn,
        error,
    };
}
function mockServices(opts) {
    const archiveCalls = [];
    const services = {
        roster: opts.roster === undefined ? undefined : new Set(opts.roster),
        archivedIds: new Set(opts.archived ?? []),
        isLive: opts.live ?? (() => false),
        archiveSession: async (id) => {
            archiveCalls.push(id);
        },
    };
    return { services, archiveCalls };
}
function scanOptionsFor(root, logger, overrides = {}) {
    return {
        root,
        autoArchiveBlank: true,
        acknowledged: new Set(),
        overrideMode: false,
        zstdCapable: true,
        logger,
        ...overrides,
    };
}
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
}
/** 2026-08-31 修复后基线 roster（对照 DESIGN.md §1）。 */
const ROSTER = ['standard', 'code', 'minimal', 'cordis', 'router-standard', 'anchored-standard'];
async function main() {
    if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
        console.error(`FAIL 环境：node:zlib 缺少 zstd API（需 Node ≥ 23.8.0），当前 ${process.version}`);
        return 1;
    }
    // 单元：目录名反映射
    check('(unit) segment 解码', decodeSegmentName('session-abc~0020def') === 'session-abc def' && decodeSegmentName('~002E') === '.');
    const base = mkdtempSync(join(tmpdir(), 'zombie-guard-selftest-'));
    try {
        // ─── (a) 僵尸空白：zstd 与 jsonl 双路径，A 类自动归档 ─────────────────────
        {
            const root = join(base, 'case-a', 'sessions');
            const zstdId = 'session-aaaaaaaa-0000-4000-8000-000000000001';
            const jsonlId = 'bbbbbbbb-0000-4000-8000-000000000002';
            writeZstdSession(root, '--ws-a--', zstdId, { id: zstdId, cwd: 'D:\\ws-a', agentPreset: 'ghost-preset' }, []);
            writeJsonlSession(root, '--ws-a--', jsonlId, { id: jsonlId, cwd: 'D:\\ws-a', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(a) A 类命中 2', report.classes.A === 2, `A=${report.classes.A} report=${JSON.stringify(report.classes)}`);
            check('(a) 归档动作执行', archiveCalls.length === 2 && report.archived.length === 2 && report.archived.includes(zstdId) && report.archived.includes(jsonlId), `calls=${JSON.stringify(archiveCalls)} archived=${JSON.stringify(report.archived)}`);
            check('(a) 归档成功不产生告警', report.warnings.length === 0 && rec.warn.length === 0);
        }
        // ─── (a2) v1.3 判别用例：id-α 真实形状（创建生命周期事件 ≠ 对话活动）─────────
        {
            const root = join(base, 'case-a2', 'sessions');
            const a2Id = 'session-a2a2a2a2-0000-4000-8000-000000000022';
            const path = writeZstdSession(root, '--ws-a2--', a2Id, { id: a2Id, cwd: 'D:\\ws-a2', agentPreset: 'ghost-preset' }, 
            // 宿主创建会话时必写的三个环境快照事件（单帧多行，id-α 实测形状），无任何 turn 活动
            [[
                    event('permission/preset', 1, { preset: 'workspace-write' }),
                    event('sandbox/mode', 2, { mode: 'workspace-write' }),
                    event('approval/policy', 3, { policy: 'auto' }),
                ]]);
            const parsed = await decodeSessionLog(path, 'zstd', { zstdCapable: true });
            check('(a2) 三个创建生命周期事件全在白名单 → blank=true', !parsed.decodeFail && parsed.blank === true && parsed.effectivePreset === 'ghost-preset' && parsed.eventCount === 3, `parsed=${JSON.stringify(parsed)}`);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(a2) 僵尸空白 → A 类候选并自动归档（v1.3 白名单扩表）', report.classes.A === 1 && archiveCalls.length === 1 && archiveCalls[0] === a2Id && report.warnings.length === 0, `A=${report.classes.A} calls=${JSON.stringify(archiveCalls)} warnings=${report.warnings.length}`);
        }
        // ─── (a3) 扩表不放过真对话：同 (a2) + 一条 user/message → 非空白 ────────────
        {
            const root = join(base, 'case-a3', 'sessions');
            const a3Id = 'session-a3a3a3a3-0000-4000-8000-000000000023';
            writeZstdSession(root, '--ws-a3--', a3Id, { id: a3Id, cwd: 'D:\\ws-a3', agentPreset: 'ghost-preset' }, [
                [
                    event('permission/preset', 1, { preset: 'workspace-write' }),
                    event('sandbox/mode', 2, { mode: 'workspace-write' }),
                    event('approval/policy', 3, { policy: 'auto' }),
                ],
                [event('user/message', 4, { text: 'hello' })],
            ]);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(a3) 含 user/message → 僵尸非空白（B 类告警，不归档）', report.classes.A === 0 &&
                report.classes.B === 1 &&
                archiveCalls.length === 0 &&
                report.warnings.length === 1 &&
                report.warnings[0].hitClass === 'B' &&
                report.warnings[0].effective === 'ghost-preset', `classes=${JSON.stringify(report.classes)} calls=${JSON.stringify(archiveCalls)}`);
        }
        // ─── (b) 僵尸非空白 + check_remove β 类判别（header-only 会漏）────────────
        {
            const root = join(base, 'case-b', 'sessions');
            const bId = 'session-bbbbbbbb-0000-4000-8000-000000000003';
            writeZstdSession(root, '--ws-b--', bId, { id: bId, cwd: 'D:\\ws-b', agentPreset: 'standard' }, [[event('step/start', 1)], [event('agent-preset/selected', 2, { agentPreset: 'ghost-preset' }), event('step/end', 3)]]);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const engine = new ZombieGuardEngine();
            const report = await engine.scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(b) B 类命中 1', report.classes.B === 1, `classes=${JSON.stringify(report.classes)}`);
            check('(b) B 类不归档只告警', archiveCalls.length === 0 &&
                report.warnings.length === 1 &&
                report.warnings[0].effective === 'ghost-preset' &&
                report.warnings[0].hitClass === 'B' &&
                rec.warn.length === 1, `warnings=${JSON.stringify(report.warnings)}`);
            const cr = await engine.checkRemove('ghost-preset', scanOptionsFor(root, rec.logger));
            check('(b) check_remove 列出 β 类（header-only 检查会漏）', cr.matches.length === 1 &&
                cr.matches[0].id === bId &&
                cr.matches[0].dependsOn.length === 1 &&
                cr.matches[0].dependsOn[0] === 'effective(strong)', `matches=${JSON.stringify(cr.matches)}`);
            check('(b) check_remove 与周期扫描共用缓存', cr.cacheHits === 1 && cr.decodes === 0, `hits=${cr.cacheHits} decodes=${cr.decodes}`);
            const crStandard = await engine.checkRemove('standard', scanOptionsFor(root, rec.logger));
            check('(b) check_remove 弱依赖标注', crStandard.matches.length === 1 && crStandard.matches[0].dependsOn.includes('header(weak)'), `matches=${JSON.stringify(crStandard.matches)}`);
        }
        // ─── (c) 截断 zstd 帧：decodeFail、扫描继续、横幅 ──────────────────────────
        {
            const root = join(base, 'case-c', 'sessions');
            const cId = 'session-cccccccc-0000-4000-8000-000000000004';
            const path = writeZstdSession(root, '--ws-c--', cId, { id: cId, cwd: 'D:\\ws-c', agentPreset: 'ghost-preset' }, [[event('session/title', 1, { title: 't' })]]);
            // 截断：保留完整 header 帧 + 半个事件帧（EOF 落在第二帧内部）
            const raw = readFileSync(path);
            const frameBoundary = scanZstdFrames(raw).frames[0].end;
            writeFileSync(path, raw.subarray(0, frameBoundary + Math.floor((raw.length - frameBoundary) / 2)));
            const dId = 'session-dddddddd-0000-4000-8000-000000000005';
            writeZstdSession(root, '--ws-c2--', dId, { id: dId, cwd: 'D:\\ws-c2', agentPreset: 'standard' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(c) 截断帧计 decodeFail、扫描继续', report.scanned === 2 && report.decodeFailCount === 1 && report.classes.C === 1 && report.classes.D === 1, `scanned=${report.scanned} decodeFails=${report.decodeFailCount} classes=${JSON.stringify(report.classes)}`);
            check('(c) 报告含不可抑制不完整横幅', report.banner !== undefined && report.banner.includes('未能完整解码'), `banner=${String(report.banner)}`);
            check('(c) C 类不归档、不误归档健康会话', archiveCalls.length === 0 && report.archived.length === 0);
            check('(c) 无未捕获异常', rec.error.length === 0, `errors=${JSON.stringify(rec.error)}`);
        }
        // ─── (c2) header 健康的 decodeFail 也计入未完整横幅（v1.3 口径）──────────────
        {
            const root = join(base, 'case-c2', 'sessions');
            const c2Id = 'session-c2c2c2c2-0000-4000-8000-000000000024';
            const path = writeZstdSession(root, '--ws-c2--', c2Id, 
            // header 指向 roster 内预设（健康）：decodeFail 仅因帧损坏
            { id: c2Id, cwd: 'D:\\ws-c2', agentPreset: 'standard' }, [[event('session/title', 1, { title: 't' })]]);
            const raw = readFileSync(path);
            const frameBoundary = scanZstdFrames(raw).frames[0].end;
            writeFileSync(path, raw.subarray(0, frameBoundary + Math.floor((raw.length - frameBoundary) / 2)));
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(c2) header 健康的 decodeFail 不入 C 类但计入横幅（全部 decodeFail 口径）', report.decodeFailCount === 1 &&
                report.classes.C === 0 &&
                report.classes.A === 0 &&
                report.classes.B === 0 &&
                report.warnings.length === 0 &&
                report.banner !== undefined &&
                report.banner.includes('1 个会话未能完整解码'), `decodeFails=${report.decodeFailCount} classes=${JSON.stringify(report.classes)} banner=${String(report.banner)}`);
            check('(c2) 不产生告警/归档/异常', archiveCalls.length === 0 && rec.warn.length === 0 && rec.error.length === 0);
        }
        // ─── (d) report-only：autoArchiveBlank=false 与 override 模式 ─────────────
        {
            const root = join(base, 'case-d1', 'sessions');
            const id = 'session-eeeeeeee-0000-4000-8000-000000000006';
            writeZstdSession(root, '--ws-d--', id, { id, cwd: 'D:\\ws-d', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger, { autoArchiveBlank: false }));
            check('(d1) autoArchiveBlank=false：分类正确且归档调用为 0', report.classes.A === 1 && archiveCalls.length === 0 && report.archiveEnabled === false && report.warnings.length === 1, `A=${report.classes.A} calls=${archiveCalls.length} warnings=${report.warnings.length}`);
        }
        {
            const root = join(base, 'case-d2', 'sessions');
            const id = 'session-ffffffff-0000-4000-8000-000000000007';
            writeZstdSession(root, '--ws-d2--', id, { id, cwd: 'D:\\ws-d2', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger, { overrideMode: true }));
            check('(d2) override 模式：归档整体禁用', report.classes.A === 1 && archiveCalls.length === 0 && report.archiveEnabled === false && report.overrideMode === true, `A=${report.classes.A} calls=${archiveCalls.length}`);
        }
        // ─── (e) .bak-* 修复备份被完全忽略 ────────────────────────────────────────
        {
            const root = join(base, 'case-e', 'sessions');
            const eId = 'session-11111111-0000-4000-8000-000000000008';
            const path = writeZstdSession(root, '--ws-e--', eId, { id: eId, cwd: 'D:\\ws-e', agentPreset: 'standard' }, []);
            // 修复前僵尸状态写入 .bak 备份（同目录）
            const bakDir = join(root, '--ws-e--', eId);
            const bakContent = Buffer.concat([
                zstdFrame([headerLine({ id: eId, cwd: 'D:\\ws-e', agentPreset: 'ghost-preset' })]),
                zstdFrame([event('agent-preset/selected', 9, { agentPreset: 'ghost-preset' })]),
            ]);
            writeFileSync(join(bakDir, 'session.jsonl.zstd.bak-20260831155931'), bakContent);
            // 只有 .bak、无精确文件名的目录也不得被发现
            const bakOnlyDir = join(root, '--ws-e--', 'session-22222222-0000-4000-8000-000000000009');
            mkdirSync(bakOnlyDir, { recursive: true });
            writeFileSync(join(bakOnlyDir, 'session.jsonl.zstd.bak-20260831155931'), bakContent);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(e) .bak 备份被完全忽略', report.scanned === 1 && report.classes.D === 1 && report.warnings.length === 0 && report.decodeFailCount === 0, `scanned=${report.scanned} classes=${JSON.stringify(report.classes)}`);
            check('(e) 精确文件名正常解析', (await decodeSessionLog(path, 'zstd', { zstdCapable: true })).effectivePreset === 'standard');
        }
        // ─── (f) header 无 agentPreset 且无 selected 事件 → 无预设依赖跳过 ─────────
        {
            const root = join(base, 'case-f', 'sessions');
            const f1 = 'session-33333333-0000-4000-8000-000000000010';
            const f2 = '44444444-0000-4000-8000-000000000011';
            writeZstdSession(root, '--ws-f--', f1, { id: f1, cwd: 'D:\\ws-f' }, [[event('session/title', 1, { title: 't' })]]);
            writeZstdSession(root, '--ws-f--', f2, { id: f2, cwd: 'D:\\ws-f' }, [[event('step/start', 1)]]);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(f) 无预设依赖会话跳过且永不判僵尸', report.noPresetDependency === 2 &&
                report.classes.A === 0 &&
                report.classes.B === 0 &&
                report.classes.C === 0 &&
                report.warnings.length === 0, `noPreset=${report.noPresetDependency} classes=${JSON.stringify(report.classes)}`);
        }
        // ─── (g) 缓存命中：第二次扫描零重解码 ─────────────────────────────────────
        {
            const root = join(base, 'case-g', 'sessions');
            const g1 = 'session-55555555-0000-4000-8000-000000000012';
            const g2 = 'session-66666666-0000-4000-8000-000000000013';
            writeZstdSession(root, '--ws-g--', g1, { id: g1, cwd: 'D:\\ws-g', agentPreset: 'ghost-preset' }, []);
            writeZstdSession(root, '--ws-g--', g2, { id: g2, cwd: 'D:\\ws-g', agentPreset: 'standard' }, []);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: ROSTER });
            const engine = new ZombieGuardEngine();
            const options = scanOptionsFor(root, rec.logger);
            const first = await engine.scanOnce(services, options);
            const second = await engine.scanOnce(services, options);
            check('(g) 首扫全量解码', first.decodes === 2 && first.cacheHits === 0, `decodes=${first.decodes} hits=${first.cacheHits}`);
            check('(g) 二扫零重解码（缓存命中）', second.decodes === 0 && second.cacheHits === 2, `decodes=${second.decodes} hits=${second.cacheHits}`);
            check('(g) 二扫分类与首扫一致', second.classes.A === first.classes.A && second.classes.D === first.classes.D, `first=${JSON.stringify(first.classes)} second=${JSON.stringify(second.classes)}`);
        }
        // ─── (h) 多事件单帧完整解析（防「整帧当单条 JSON」回归）─────────────────────
        {
            const root = join(base, 'case-h', 'sessions');
            const hId = 'session-77777777-0000-4000-8000-000000000014';
            const path = writeZstdSession(root, '--ws-h--', hId, { id: hId, cwd: 'D:\\ws-h', agentPreset: 'standard' }, 
            // 一个帧内 3 行事件：session/title + selected(ghost) + step/start
            [[event('session/title', 1, { title: 't' }), event('agent-preset/selected', 2, { agentPreset: 'ghost-preset' }), event('step/start', 3)]]);
            const parsed = await decodeSessionLog(path, 'zstd', { zstdCapable: true });
            check('(h) 单帧 3 事件全部解析', parsed.eventCount === 3 && parsed.hasSelected && parsed.effectivePreset === 'ghost-preset' && parsed.blank === false && !parsed.decodeFail, `parsed=${JSON.stringify(parsed)}`);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(h) 分类为 B（僵尸非空白）', report.classes.B === 1 && report.warnings[0].effective === 'ghost-preset');
        }
        // ─── (i) agentPresets 缺失 → 整轮跳过并 warn ──────────────────────────────
        {
            const root = join(base, 'case-i', 'sessions');
            const id = 'session-88888888-0000-4000-8000-000000000015';
            writeZstdSession(root, '--ws-i--', id, { id, cwd: 'D:\\ws-i', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: undefined });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(i) 无 roster 整轮跳过', report.skippedReason !== undefined && report.scanned === 0 && rec.warn.length === 1, `skipped=${String(report.skippedReason)} warn=${rec.warn.length}`);
        }
        // ─── (j) liveness 不可判定 → 命中 A 不归档，标注 live? unknown ─────────────
        {
            const root = join(base, 'case-j', 'sessions');
            const id = 'session-99999999-0000-4000-8000-000000000016';
            writeZstdSession(root, '--ws-j--', id, { id, cwd: 'D:\\ws-j', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER, live: () => undefined });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(j) liveness 不可判定不归档、按 B 告警标注', report.classes.A === 1 &&
                archiveCalls.length === 0 &&
                report.warnings.length === 1 &&
                report.warnings[0].note !== undefined &&
                report.warnings[0].note.includes('live? unknown'), `A=${report.classes.A} calls=${archiveCalls.length} warnings=${JSON.stringify(report.warnings)}`);
        }
        // ─── (k) zstd 能力缺失 → zstd 日志按解码失败、归档禁用、横幅仍在 ───────────
        {
            const root = join(base, 'case-k', 'sessions');
            const k1 = 'session-aaaa1111-0000-4000-8000-000000000017';
            const k2 = 'session-aaaa2222-0000-4000-8000-000000000018';
            writeZstdSession(root, '--ws-k--', k1, { id: k1, cwd: 'D:\\ws-k', agentPreset: 'standard' }, []);
            writeJsonlSession(root, '--ws-k--', k2, { id: k2, cwd: 'D:\\ws-k', agentPreset: 'standard' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger, { zstdCapable: false }));
            check('(k) zstd 缺失：zstd 会话 decodeFail、jsonl 正常、归档禁用', report.decodeFailCount === 1 &&
                report.classes.C === 1 &&
                report.classes.D === 1 &&
                report.archiveEnabled === false &&
                archiveCalls.length === 0 &&
                report.banner !== undefined, `decodeFails=${report.decodeFailCount} classes=${JSON.stringify(report.classes)}`);
        }
        // ─── (l) 已归档会话幂等跳过 ────────────────────────────────────────────────
        {
            const root = join(base, 'case-l', 'sessions');
            const id = 'session-bbbb1111-0000-4000-8000-000000000019';
            writeZstdSession(root, '--ws-l--', id, { id, cwd: 'D:\\ws-l', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services, archiveCalls } = mockServices({ roster: ROSTER, archived: [id] });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(l) 已归档僵尸空白幂等跳过', report.classes.A === 1 && report.alreadyArchived === 1 && archiveCalls.length === 0 && report.warnings.length === 0, `A=${report.classes.A} already=${report.alreadyArchived} calls=${archiveCalls.length}`);
        }
        // ─── (m) live 会话在碰文件前跳过 ──────────────────────────────────────────
        {
            const root = join(base, 'case-m', 'sessions');
            const id = 'session-cccc1111-0000-4000-8000-000000000020';
            writeZstdSession(root, '--ws-m--', id, { id, cwd: 'D:\\ws-m', agentPreset: 'ghost-preset' }, []);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: ROSTER, live: () => true });
            const report = await new ZombieGuardEngine().scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(m) live 会话跳过且不解码', report.scanned === 1 && report.liveSkipped === 1 && report.decodes === 0 && report.classes.A === 0, `scanned=${report.scanned} liveSkipped=${report.liveSkipped} decodes=${report.decodes}`);
        }
        // ─── (n) B 类告警去重 + acknowledgedSessions 静默 ──────────────────────────
        {
            const root = join(base, 'case-n', 'sessions');
            const id = 'session-dddd1111-0000-4000-8000-000000000021';
            writeZstdSession(root, '--ws-n--', id, { id, cwd: 'D:\\ws-n', agentPreset: 'standard' }, [[event('step/start', 1)], [event('agent-preset/selected', 2, { agentPreset: 'ghost-preset' })]]);
            const rec = recordingLogger();
            const { services } = mockServices({ roster: ROSTER });
            const engine = new ZombieGuardEngine();
            const first = await engine.scanOnce(services, scanOptionsFor(root, rec.logger));
            const second = await engine.scanOnce(services, scanOptionsFor(root, rec.logger));
            check('(n) 每 (id,状态) 只 warn 一次', first.newWarnings === 1 && second.newWarnings === 0 && rec.warn.length === 1, `first=${first.newWarnings} second=${second.newWarnings} warns=${rec.warn.length}`);
            check('(n) 仍命中仍列出（只是不重复 warn）', second.warnings.length === 1 && second.classes.B === 1);
            const third = await engine.scanOnce(services, scanOptionsFor(root, rec.logger, { acknowledged: new Set([id]) }));
            check('(n) acknowledged 永久静默', third.silencedByAck === 1 && third.warnings.length === 0 && rec.warn.length === 1, `silenced=${third.silencedByAck} warns=${rec.warn.length}`);
        }
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
    let failed = 0;
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || r.detail === '' ? '' : ' — ' + r.detail}`);
        if (!r.ok)
            failed += 1;
    }
    if (failed > 0) {
        console.error(`\n自测失败：${failed}/${results.length} 项未通过`);
        return 1;
    }
    console.log(`\n自测全部通过（${results.length} 项）`);
    return 0;
}
main().then((code) => {
    process.exitCode = code;
}, (error) => {
    console.error('自测异常退出：', error);
    process.exitCode = 1;
});
//# sourceMappingURL=selftest.js.map