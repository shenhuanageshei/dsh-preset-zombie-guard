/**
 * dsh-preset-zombie-guard — 宿主装配（cordis 插件，daemon-loop 形态的
 * 纯确定性定时扫描：循环中无 LLM 调用）。
 *
 * 周期（intervalMs，默认 15min）扫描全部会话日志，识别「生效预设不在
 * 当前 roster」的会话（预设僵尸）；空白僵尸自动归档（官方
 * workspaceRegistry.archiveSession，唯一写动作），非空白僵尸告警去重。
 * 面向模型/用户暴露三个工具：preset_guard_scan / preset_guard_check_remove / preset_guard_last_report。
 *
 * 服务依赖全部 optional：agentPresets / workspaceRegistry / agents /
 * sessions 任一缺失按 DESIGN.md §6 降级，绝不因此阻止插件加载。
 * 资源挂载：timer 间隔经 timer 服务（内部 ctx.effect 挂到本 fiber），
 * 工具注册经 ctx.effect —— 卸载即净。禁止 monkey-patch；不 import DSH
 * 内部模块（zstd 只用 node:zlib）；除 archiveSession 外不写任何文件。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** timer 服务混入的间隔 API（cordis-plugin-timer 经 ctx.mixin 暴露）。 */
type AppContext = Context & {
    setInterval(callback: () => void, ms: number): unknown;
};
export declare const name = "dsh-preset-zombie-guard";
export declare const inject: string[];
export interface Config {
    /** tick 间隔（ms）。 */
    intervalMs: number;
    /** 僵尸空白会话是否自动归档。 */
    autoArchiveBlank: boolean;
    /** 已知并接受、永久静默告警的会话 id 清单（人工处理完成后登记）。 */
    acknowledgedSessions: string[];
    /** 覆盖扫描根目录（测试/演示用；override 模式下归档动作禁用）。 */
    scanRootOverride: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    intervalMs: z<number, number>;
    autoArchiveBlank: z<boolean, boolean>;
    acknowledgedSessions: z<string[], string[]>;
    scanRootOverride: z<string, string>;
}>, Schemastery.ObjectT<{
    intervalMs: z<number, number>;
    autoArchiveBlank: z<boolean, boolean>;
    acknowledgedSessions: z<string[], string[]>;
    scanRootOverride: z<string, string>;
}>>;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
