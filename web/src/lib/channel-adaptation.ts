import type { ModelProtocol } from "@/lib/model-protocols";
import type { ImageResolutionOption } from "@/lib/image-resolution-tiers";
import { defaultModelCapabilityConfig, type ImageCapabilityConfig, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ModelCapability, ModelChannel } from "@/stores/use-config-store";

/**
 * 渠道适配预设（channel adaptation preset）。
 *
 * 背景：BeefAPI 能在「拉取模型」后自动配好协议与能力画像，是因为它的 `/v1/models`
 * 会返回 `model_type` / `supported_endpoint_types` / `options` 等元数据，
 * `channel-model-catalog.ts` 据此推导（见 `docs` 与项目图谱 §3.5）。
 * 中转网关（如 ai-claude-code-hub）只返回 `id/object/created/owned_by`，
 * 推导无从下手 → 协议落到兜底值、能力画像落到「全支持」默认值，
 * 于是画布面板会显示上游根本不支持的选项（质量、透明背景…）。
 *
 * 本模块给这类渠道补一层**声明式适配**：按模型名模式钉死协议与图像能力画像，
 * 效果对齐 BeefAPI 的「内置适配」。
 *
 * 加一个新渠道 = 在 CHANNEL_ADAPTATION_PRESETS 里加一份预设：
 *   1. `match` 判定渠道（hostname 优先，避免依赖用户可见的渠道名）；
 *   2. `rules` 按**从具体到宽泛**排列，首个命中的生效；
 *   3. 只写有证据的字段 —— 不确定的宁可留默认并标 `[待验证]`，
 *      因为画像直接决定「面板显示什么」和「请求发什么」。
 *
 * 两条硬约束：
 *   ① **协议只补缺失**：用户手设的 `protocol` 永远优先，不覆盖；
 *   ② **画像里的「预设拥有的字段」由预设维护**：规则声明了哪些字段，就以预设为准
 *      （quality / transparentBackground / outputFormat / size.*）。这样预设修正后
 *      已落盘的旧画像会自动痊愈 —— 否则「只补空缺」会让旧画像永远停在错误值上
 *      （BeefAPI 的 `enrichBeefApiMediaChannel` 同样是强制归一化，理由相同）。
 *      规则没声明的字段（参考图上限、maxOutputs、displayName 等）一律保留。
 *   ③ 幂等：同样的输入必然得到同样的输出，可以安全地在每次读取配置时重跑。
 *
 * 视频协议这里是**显式声明**（与 `model-protocol-inference.ts` 的既有映射一致，也是用户
 * 已手工配置过的值）。若对应的自建插件被禁用，会得到「接口类型 X 未安装」—— 这是有意的：
 * 静默走错协议（例如落到 newapi-channel-2 然后 404）比明确报错更难排查。
 */

type ChannelModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

type AdaptationChannel = Pick<ModelChannel, "id" | "baseUrl" | "name" | "models" | "modelProfiles">;

type ImageSizeAdaptation = {
    values?: string[];
    default?: string;
    allowCustom?: boolean;
    presets?: ImageResolutionOption[];
};

type ImageAdaptation = {
    quality?: boolean;
    transparentBackground?: boolean;
    outputFormat?: boolean;
    /** 尺寸语义与可选尺寸：用于「画布预设尺寸超出上游窗口」的模型 */
    size?: ImageSizeAdaptation;
};

type AdaptationRule = {
    /** 模型名小写子串，任一命中即生效 */
    match: string[];
    /** 需要同时命中的子串（用于「gemini- 且 image」这类组合条件） */
    matchAll?: string[];
    capability: ModelCapability;
    protocol?: ModelProtocol;
    /** 图像能力裁剪：只写上游**确实没有**的参数，未列出的保持默认 */
    image?: ImageAdaptation;
    note?: string;
};

type ChannelAdaptationPreset = {
    id: string;
    /** UI 文案里显示的名字 */
    label: string;
    version: number;
    match: (channel: AdaptationChannel) => boolean;
    rules: AdaptationRule[];
};

/**
 * Seedream 5.0 lite / 4.5 的官方 2K 尺寸表（火山方舟文档「图片生成教程」+「图片生成 API」）。
 *
 * 关键约束（决定了画布默认预设为什么必挂）：
 * - lite 与 4.5 的总像素下限 = 2560x1440 = **3,686,400**，且文档明确 lite **不支持 1K 档**；
 * - 画布 1K 档的默认值（1024x1024 = 1.05M、1024x1824 = 1.87M）全部低于该下限；
 * - 上游拒绝这类尺寸后，中转网关把错误抹平成 503「所有供应商暂时不可用」，
 *   在 BeefTV 里看起来像「服务抖动」，于是反复重试仍然失败。
 *
 * 因此这里直接给出官方 2K 像素值，并关闭自定义输入（自定义框的校验下限是 655,360，
 * 拦不住小于 3,686,400 的非法值）。后端 `validateImageCapabilityConfig` 要求
 * 预设像素 ≤ 8,294,400 且最长边 ≤ 3840，所以官方 3K/4K 值（如 3072x3072 = 9.44M）
 * 无法作为预设表达 —— 暂不提供。
 */
const SEEDREAM_2K_PRESETS: ImageResolutionOption[] = [
    { tier: "2k", ratio: "1:1", width: 2048, height: 2048, size: "2048x2048" },
    { tier: "2k", ratio: "4:3", width: 2304, height: 1728, size: "2304x1728" },
    { tier: "2k", ratio: "3:4", width: 1728, height: 2304, size: "1728x2304" },
    { tier: "2k", ratio: "16:9", width: 2848, height: 1600, size: "2848x1600" },
    { tier: "2k", ratio: "9:16", width: 1600, height: 2848, size: "1600x2848" },
    { tier: "2k", ratio: "3:2", width: 2496, height: 1664, size: "2496x1664" },
    { tier: "2k", ratio: "2:3", width: 1664, height: 2496, size: "1664x2496" },
    { tier: "2k", ratio: "21:9", width: 3136, height: 1344, size: "3136x1344" },
];

function seedream2kSizeAdaptation(): ImageSizeAdaptation {
    return {
        values: ["auto", ...SEEDREAM_2K_PRESETS.map((preset) => preset.size)],
        default: "2048x2048",
        allowCustom: false,
        presets: SEEDREAM_2K_PRESETS,
    };
}

/**
 * 中转网关（ai-claude-code-hub.jetmobo.com）适配。
 *
 * 证据来源（2026-10-12）：
 * - `GET /v1/models` → HTTP 200，66 条，字段只有 `id/object/created/owned_by`
 *   （无任何类型/端点元数据，故必须按名匹配）。
 * - `/v1/images/generations`、`/v1/contents/generations/tasks`、`/v1/videos/{id}` 已实测可用；
 *   已知家族的协议由 `model-protocol-inference.ts` 与手工 profile 覆盖（见 note）。
 */
const HUB_RULES: AdaptationRule[] = [
    {
        // 必须在通用 `seedream` 规则之前：lite 的尺寸窗口最窄，且不支持 1K。
        match: ["seedream-5.0-lite", "seedream-5-0-lite", "seedream-5-lite"],
        capability: "image",
        protocol: "openai-image",
        image: { quality: false, transparentBackground: false, outputFormat: false, size: seedream2kSizeAdaptation() },
        note: "Doubao-Seedream-5.0-lite：总像素下限 2560x1440=3,686,400、不支持 1K，只给官方 2K 尺寸",
    },
    {
        match: ["seedream-4.5", "seedream-4-5"],
        capability: "image",
        protocol: "openai-image",
        image: { quality: false, transparentBackground: false, outputFormat: false, size: seedream2kSizeAdaptation() },
        note: "Doubao-Seedream-4.5：总像素下限同为 3,686,400，画布 1K 预设会低于下限",
    },
    {
        // 兜底：Seedream 4.0 与后续型号。4.0 的下限是 1280x720=921,600，
        // 画布 1K 预设（最小 1024x1024=1,048,576）在窗口内，因此不动尺寸与比例。
        match: ["seedream"],
        capability: "image",
        protocol: "openai-image",
        // 方舟图片契约（plugin-packages/volcengine-ark-seedream 的 create body）只有
        // model/prompt/size/image/watermark/response_format/seed/sequential_image_generation：
        // 没有 quality、没有 background、没有 output_format。面板因此不该显示这三个开关。
        // [待验证] 网关是否为未知字段报错；关掉是保守方向（少发无意义字段）。
        image: { quality: false, transparentBackground: false, outputFormat: false },
        note: "Doubao-Seedream-4.0 等：方舟系，无质量与透明背景参数；1K 尺寸在上游窗口内",
    },
    {
        match: ["gemini-"],
        matchAll: ["image"],
        capability: "image",
        protocol: "openai-image",
        // Gemini 图像契约（imageConfig.aspectRatio / imageSize）没有透明背景。
        // 协议保持 openai-image：网关的 /v1beta 生成端点未实测，不切 gemini-image。
        // [待验证] 网关是否接受 quality；未知前不动。
        image: { transparentBackground: false },
        note: "gemini-3-pro-image-preview / 3.1-flash-image-preview",
    },
    {
        match: ["gpt-image"],
        capability: "image",
        protocol: "openai-image",
        // OpenAI 图像契约里 quality / background / output_format 都是真实参数，画像保持完整。
        note: "gpt-image-2 / 2-c / 2.5-flare / 2.5-sunburst：OpenAI 系，能力全开",
    },
    {
        match: ["seedance-2.5"],
        capability: "video",
        protocol: "ark-task-gateway-video-25",
        note: "Seedance 2.5：顶层 prompt + GET /v1/videos/{id}（v1.6.5 起插件内独立 provider）",
    },
    {
        match: ["seedance-2.0"],
        capability: "video",
        protocol: "ark-task-gateway-video",
        note: "Seedance 2.0 / 2.0-fast：content[] + GET /v1/contents/generations/tasks/{id}",
    },
    {
        match: ["wan3.0-video", "wan-3.0"],
        capability: "video",
        protocol: "wan-task-gateway-video",
        note: "阿里系万相：wan-task-gateway 插件（该渠道 Key 下 2026-10-09 实测全部 503）",
    },
    {
        match: ["happyhorse"],
        capability: "video",
        protocol: "wan-task-gateway-video",
        note: "阿里系 happyhorse：t2v / i2v / r2v / video-edit 共用一套契约",
    },
    {
        // 注意用 `doubao-seed-`（带尾横线）：`doubao-seedance-*` / `doubao-seedream-*`
        // 也以 "doubao-seed" 开头，宽松匹配会把视频/图像模型误判成文本。
        match: ["claude-", "gpt-", "gemini-", "glm-", "kimi-", "deepseek-", "minimax", "doubao-seed-"],
        capability: "text",
        // 网关的 /v1/chat/completions 是默认可用路径；/v1/messages（Anthropic）虽实测 200，
        // 但不替用户切换传输契约 —— 只保证「不会落到视频/图像协议」。
        protocol: "chat-completion",
        note: "文本家族：钉死 chat-completion，避免脏 profile 把文本模型带到媒体协议",
    },
];

export const CHANNEL_ADAPTATION_PRESETS: ChannelAdaptationPreset[] = [
    {
        id: "jetmobo-hub",
        label: "中转网关适配",
        version: 1,
        match: (channel) => hostnameOf(channel.baseUrl) === "ai-claude-code-hub.jetmobo.com",
        rules: HUB_RULES,
    },
];

function hostnameOf(baseUrl: string) {
    try {
        return new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
    } catch {
        return "";
    }
}

function matchesRule(rule: AdaptationRule, model: string) {
    const value = String(model || "").toLowerCase();
    if (!rule.match.some((token) => value.includes(token))) return false;
    return (rule.matchAll || []).every((token) => value.includes(token));
}

function ruleForModel(preset: ChannelAdaptationPreset, model: string) {
    return preset.rules.find((rule) => matchesRule(rule, model));
}

/**
 * 只翻转 `supported`，不动 `values` / `default`：
 * 与后端 `DefaultImageCapabilityConfig` 裁剪 Ark 协议的做法保持一致，
 * 避免 capabilityConfig 校验与「未支持却有默认值」的组合产生歧义。
 */
function adaptedImageConfig(image: ImageCapabilityConfig, adaptation: ImageAdaptation): ImageCapabilityConfig {
    const size = adaptation.size
        ? {
              ...image.size,
              ...(adaptation.size.values ? { values: adaptation.size.values } : {}),
              ...(adaptation.size.default ? { default: adaptation.size.default } : {}),
              ...(adaptation.size.allowCustom === undefined ? {} : { allowCustom: adaptation.size.allowCustom }),
              ...(adaptation.size.presets ? { presets: adaptation.size.presets } : {}),
          }
        : image.size;
    return {
        ...image,
        size,
        quality: adaptation.quality === undefined ? image.quality : { ...image.quality, supported: adaptation.quality },
        transparentBackground: adaptation.transparentBackground === undefined ? image.transparentBackground : { ...image.transparentBackground, supported: adaptation.transparentBackground },
        outputFormat: adaptation.outputFormat === undefined ? image.outputFormat : { supported: adaptation.outputFormat },
    };
}

function adaptationCapabilityConfig(rule: AdaptationRule, protocol: ModelProtocol | undefined, model: string, current?: ModelCapabilityConfig): ModelCapabilityConfig | undefined {
    // 图像模型一律落一份显式画像（与 BeefAPI 的做法一致）：把「这台上游支持什么」
    // 固定下来，而不是依赖默认值 —— 默认值将来变了不会悄悄改变已适配渠道的行为。
    if (rule.capability !== "image") return undefined;
    const base = current?.image ? current : defaultModelCapabilityConfig(protocol, model);
    return { ...base, image: adaptedImageConfig(base.image!, rule.image || {}) };
}

/**
 * 只比较「预设拥有的字段」：决定了是否真的发生了变化。
 * 不能直接比对象引用 —— 每次都重建画像，引用必然不同，会让 normalizeConfigSnapshot
 * 在无变化时也返回新对象，触发 React 的重复渲染。
 */
function capabilityConfigEquals(left: ModelCapabilityConfig | undefined, right: ModelCapabilityConfig | undefined) {
    if (!left || !right) return left === right;
    const l = left.image;
    const r = right.image;
    if (!l || !r) return left === right;
    return (
        l.quality.supported === r.quality.supported &&
        l.transparentBackground.supported === r.transparentBackground.supported &&
        l.outputFormat.supported === r.outputFormat.supported &&
        l.size.parameter === r.size.parameter &&
        l.size.allowCustom === r.size.allowCustom &&
        l.size.default === r.size.default &&
        l.size.values.join("|") === r.size.values.join("|") &&
        (l.size.presets || []).map((preset) => `${preset.tier}:${preset.ratio}:${preset.size}`).join("|") ===
            (r.size.presets || []).map((preset) => `${preset.tier}:${preset.ratio}:${preset.size}`).join("|")
    );
}

export function channelAdaptationPresetFor(channel: AdaptationChannel): ChannelAdaptationPreset | undefined {
    return CHANNEL_ADAPTATION_PRESETS.find((preset) => preset.match(channel));
}

/** 渠道当前命中的适配预设说明，用于设置页展示；未命中返回空串。 */
export function channelAdaptationLabel(channel: AdaptationChannel): string {
    const preset = channelAdaptationPresetFor(channel);
    return preset ? `${preset.label} · v${preset.version}` : "";
}

/**
 * 把适配预设应用到渠道：补协议与图像能力画像。
 * 幂等且不覆盖用户手设；未命中任何预设时原样返回（保持引用相等，避免无谓重渲染）。
 */
export function applyChannelAdaptation(channel: ModelChannel): ModelChannel {
    const preset = channelAdaptationPresetFor(channel);
    if (!preset || !channel.models?.length) return channel;
    const existing = new Map((channel.modelProfiles || []).map((profile) => [profile.model, profile]));
    let changed = false;
    for (const model of channel.models) {
        const rule = ruleForModel(preset, model);
        if (!rule) continue;
        const current = existing.get(model);
        const protocol = current?.protocol || rule.protocol;
        const capability = current?.capability || rule.capability;
        // 画像是「预设拥有其声明字段」的合同：既是补齐空缺，也是刷新旧预设值。
        const capabilityConfig = adaptationCapabilityConfig(rule, protocol, model, current?.capabilityConfig);
        if (current && current.protocol === protocol && current.capability === capability && capabilityConfigEquals(current.capabilityConfig, capabilityConfig)) continue;
        existing.set(model, {
            ...(current || {}),
            model,
            capability,
            ...(protocol ? { protocol } : {}),
            ...(capabilityConfig ? { capabilityConfig } : {}),
        });
        changed = true;
    }
    if (!changed) return channel;
    return { ...channel, modelProfiles: Array.from(existing.values()) };
}

/** 供设置页展示「这条规则是从哪来的」（排障与自检用）。 */
export function channelAdaptationRuleNote(channel: AdaptationChannel, model: string) {
    const preset = channelAdaptationPresetFor(channel);
    if (!preset) return "";
    return ruleForModel(preset, model)?.note || "";
}

export function applyChannelAdaptations(channels: ModelChannel[]): ModelChannel[] {
    return channels.map(applyChannelAdaptation);
}

export type { AdaptationChannel, AdaptationRule, ChannelAdaptationPreset };
