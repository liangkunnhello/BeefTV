/**
 * 内置渠道种子（builtin channel seeds）。
 *
 * 用途：打包发行的版本预置一条「中转网关」渠道 —— 地址与模型清单随程序分发，
 * **API Key 一律留空**，由使用者在设置页自行填写。
 *
 * 为什么放在前端种子、而不是后端的 `providerpreset/catalog/*.json`：
 * 后端预设要求每个模型携带完整能力画像（capabilityConfig），且协议必须落在
 * `providerpreset.knownProtocol` 白名单内；而本网关用的三个视频协议
 * （ark-task-gateway-video / -25、wan-task-gateway-video）都不在该白名单里，
 * 且画像体量大、易失配。放到前端后，协议与画像由既有的
 * `applyChannelAdaptation`（`channel-adaptation.ts`，按 hostname 命中 `jetmobo-hub`
 * 预设）自动产出，种子只需声明「地址 + 模型名」。
 *
 * 行为约定（由 `use-config-store.ts` 的 `mergeBuiltinChannelSeeds` 实现）：
 * - 已存在同 id 渠道（使用者填过 Key、改过名字）→ 保留使用者的一切设置，只补缺失模型；
 * - 不存在 → 追加一条，`enabled: true`、`pinned: true`（在渠道列表里靠前）；
 * - 使用者删掉这条渠道 → 下次读取配置时会重新出现（这就是「内置」的语义）。
 *
 * ⚠️ 这个文件会随安装包一起分发到使用者机器上，
 * **只允许放地址、模型名这类非敏感信息**，任何密钥 / 令牌都不要写进来。
 */

/** 与 `use-config-store.ts` 的 `ApiCallFormat` 保持一致；此处独立声明以避免循环依赖。 */
type BuiltinChannelApiFormat = "openai" | "gemini" | "claude";

export type BuiltinChannelSeed = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: BuiltinChannelApiFormat;
    /** 预置的模型名，必须与上游 `GET /v1/models` 返回的 id 逐字一致。 */
    models: string[];
};

export const BUILTIN_CHANNEL_SEEDS: BuiltinChannelSeed[] = [
    {
        id: "jetmobo-gateway",
        name: "中转网关",
        baseUrl: "https://ai-claude-code-hub.jetmobo.com",
        apiFormat: "openai",
        models: [
            // 生图
            "gpt-image-2",
            "Doubao-Seedream-5.0-lite",
            // 生视频
            "doubao-seedance-2.0",
            "doubao-seedance-2.0-fast",
            "doubao-seedance-2.5",
            "happyhorse-1.1-t2v",
            "happyhorse-1.1-i2v",
            "happyhorse-1.1-r2v",
            "happyhorse-1.0-video-edit",
            "wan3.0-video",
            "wan3.0-video-prime",
            // 文本
            "deepseek-v4.1-flash",
        ],
    },
];
