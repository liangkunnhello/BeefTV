import { describe, expect, test } from "bun:test";

import { BUILTIN_CHANNEL_SEEDS } from "@/lib/builtin-channels";
import { createModelChannel, normalizeConfigSnapshot } from "@/stores/use-config-store";

/**
 * 内置渠道种子只声明「地址 + 模型名」，协议与能力画像由 `applyChannelAdaptation`
 * 按 hostname 补齐 —— 这里把这条链路端到端钉住，避免种子与适配预设脱节。
 */
describe("builtin channel seeds", () => {
    const seed = BUILTIN_CHANNEL_SEEDS[0];

    test("空配置下自动出现内置渠道，密钥为空，模型清单与种子一致", () => {
        const { config } = normalizeConfigSnapshot({ config: {} });
        const channel = config.channels.find((item) => item.id === seed.id);

        expect(channel).toBeDefined();
        expect(channel?.baseUrl).toBe(seed.baseUrl);
        expect(channel?.apiKey).toBe("");
        expect(channel?.enabled).toBe(true);
        expect(channel?.models).toEqual(seed.models);
    });

    test("全部模型的协议与能力由适配层补齐", () => {
        const { config } = normalizeConfigSnapshot({ config: {} });
        const channel = config.channels.find((item) => item.id === seed.id);
        const profileOf = (model: string) => channel?.modelProfiles?.find((profile) => profile.model === model);

        const expected: Record<string, { capability: string; protocol: string }> = {
            "gpt-image-2": { capability: "image", protocol: "openai-image" },
            "Doubao-Seedream-5.0-lite": { capability: "image", protocol: "openai-image" },
            "doubao-seedance-2.0": { capability: "video", protocol: "ark-task-gateway-video" },
            "doubao-seedance-2.0-fast": { capability: "video", protocol: "ark-task-gateway-video" },
            "doubao-seedance-2.5": { capability: "video", protocol: "ark-task-gateway-video-25" },
            "happyhorse-1.1-t2v": { capability: "video", protocol: "wan-task-gateway-video" },
            "happyhorse-1.1-i2v": { capability: "video", protocol: "wan-task-gateway-video" },
            "happyhorse-1.1-r2v": { capability: "video", protocol: "wan-task-gateway-video" },
            "happyhorse-1.0-video-edit": { capability: "video", protocol: "wan-task-gateway-video" },
            "wan3.0-video": { capability: "video", protocol: "wan-task-gateway-video" },
            "wan3.0-video-prime": { capability: "video", protocol: "wan-task-gateway-video" },
            "deepseek-v4.1-flash": { capability: "text", protocol: "chat-completion" },
        };

        for (const [model, want] of Object.entries(expected)) {
            const profile = profileOf(model);
            expect({ model, capability: profile?.capability, protocol: profile?.protocol }).toEqual({ model, ...want });
        }
    });

    test("使用者已填过密钥的同一渠道被保留，只补缺失模型", () => {
        const { config } = normalizeConfigSnapshot({
            config: {
                channels: [{ ...createModelChannel({ ...seed, models: ["gpt-image-2"] }), apiKey: "user-key", name: "我的网关" }],
            },
        });
        const channel = config.channels.find((item) => item.id === seed.id);

        expect(channel?.apiKey).toBe("user-key");
        expect(channel?.name).toBe("我的网关");
        expect(channel?.models).toEqual(seed.models);
    });

    test("种子里的每个模型都被适配层落到 profile 上", () => {
        const { config } = normalizeConfigSnapshot({ config: {} });
        const channel = config.channels.find((item) => item.id === seed.id);
        const profiled = new Set((channel?.modelProfiles || []).map((profile) => profile.model));

        expect(seed.models.filter((model) => !profiled.has(model))).toEqual([]);
    });
});
