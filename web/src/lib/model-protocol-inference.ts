import type { ModelProtocol, ModelProtocolDefinition } from "@/lib/model-protocols";

/**
 * 已知模型名 → 请求协议 的对照表。
 *
 * 背景：拉取到的模型如果没显式指定协议，会落到「按能力猜的通用协议」——视频落
 * NewAPI 视频协议、图像落 OpenAI 图像协议。但中转网关上的厂商模型往往要专用协议
 * 才通（豆包 Seedance 走 Ark 任务式路径、阿里系走 `/v1/wan/...`），新手不了解这点，
 * 一生成就失败，而报错还是「模型或接口不可用」这种看不出原因的话。
 *
 * 两条安全约束：
 * 1. 只有该协议**在当前环境可用**（插件已安装且未禁用）时才自动选中 —— 没装这些
 *    插件的用户完全不受影响；
 * 2. 只作为**缺省值**：用户手设过的协议永远优先（调用方仅在 profile 没协议时兜底）。
 */
const KNOWN_MODEL_PROTOCOLS: ReadonlyArray<{ pattern: RegExp; protocol: ModelProtocol; note: string }> = [
    {
        pattern: /^doubao-seedance-2[.-]5/i,
        protocol: "ark-task-gateway-video-25",
        note: "豆包 Seedance 2.5：顶层 prompt 创建 + GET /v1/videos/{id} 查询",
    },
    {
        pattern: /^doubao-seedance-2[.-]0/i,
        protocol: "ark-task-gateway-video",
        note: "豆包 Seedance 2.0 / 2.0-fast：content[] 创建 + GET /v1/contents/generations/tasks/{id} 查询",
    },
    {
        pattern: /^wan-?3[.-]?0/i,
        protocol: "wan-task-gateway-video",
        note: "万相 wan3.0-video / wan3.0-video-prime（网关 /v1/wan/... 契约）",
    },
    {
        pattern: /^happyhorse-/i,
        protocol: "wan-task-gateway-video",
        note: "happyhorse 系列与 wan 共用同一套网关契约",
    },
    // 待补：Doubao-seedream-4.0 / 4.5 / 5.0-lite（图像）。这几个模型在网关上
    // POST /v1/images/generations 与 /v1/seedream/images/generations 都返回
    // 503 No available providers，无法判定正确端点；拿到可用的真实路径后再补规则。
];

/** 从模型名推断专用协议；推断不出、或该协议在当前环境不可用时返回 undefined。 */
export function inferProtocolFromModelName(
    model: string,
    availableProtocols: ModelProtocolDefinition[] = [],
): ModelProtocol | undefined {
    const name = String(model || "").trim();
    if (!name) return undefined;
    const rule = KNOWN_MODEL_PROTOCOLS.find((item) => item.pattern.test(name));
    if (!rule) return undefined;
    const usable = availableProtocols.some((item) => item.value === rule.protocol && item.enabled !== false);
    return usable ? rule.protocol : undefined;
}

/** 供 UI 展示 / 排障：这条模型名是否有已知协议规则（不判断可用性）。 */
export function knownProtocolRuleForModel(model: string) {
    const name = String(model || "").trim();
    if (!name) return undefined;
    return KNOWN_MODEL_PROTOCOLS.find((item) => item.pattern.test(name));
}
