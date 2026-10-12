import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { applyChannelAdaptation, channelAdaptationLabel, channelAdaptationPresetFor } from "@/lib/channel-adaptation";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { resolveModelGenerationDefaults } from "@/lib/model-selection";
import { createModelChannel, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

/** 2026-10-12 从 `GET https://ai-claude-code-hub.jetmobo.com/v1/models` 抄回的真实目录（66 条）。 */
const HUB_MODELS = [
    "Doubao-Seed-2.0-Mini",
    "Doubao-Seed-2.0-Pro",
    "Doubao-Seedream-5.0-lite",
    "Doubao-seedream-4.0",
    "Doubao-seedream-4.5",
    "MiniMax-M2.5",
    "MiniMax-M2.7",
    "MiniMax-M3",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-haiku-4-5-20251001",
    "claude-haiku-5-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2.5",
    "gemini-2.5-pro",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-high",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "glm-5.0",
    "glm-5.1",
    "glm-5.2",
    "glm-5.3",
    "glm-5.3-flash",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-image-2",
    "gpt-image-2-c",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "happyhorse-1.0-video-edit",
    "happyhorse-1.1-i2v",
    "happyhorse-1.1-r2v",
    "happyhorse-1.1-t2v",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k3",
    "minimax-m2.7",
    "minimax-m3",
    "wan3.0-video",
    "wan3.0-video-prime",
];

function hubChannel(models: string[] = HUB_MODELS, overrides: Partial<ModelChannel> = {}): ModelChannel {
    return {
        ...createModelChannel({ id: "hub", name: "渠道 2", baseUrl: "https://ai-claude-code-hub.jetmobo.com", apiFormat: "openai", models }),
        ...overrides,
    };
}

function profileOf(channel: ModelChannel, model: string) {
    return (channel.modelProfiles || []).find((profile) => profile.model === model);
}

describe("channel adaptation presets", () => {
    test("命中中转网关渠道，未命中其他渠道", () => {
        expect(channelAdaptationPresetFor(hubChannel())?.id).toBe("jetmobo-hub");
        expect(channelAdaptationPresetFor(createModelChannel({ id: "other", name: "其他", baseUrl: "https://api.example.com", apiFormat: "openai", models: ["x"] }))).toBeUndefined();
        expect(channelAdaptationLabel(hubChannel())).toBe("中转网关适配 · v1");
    });

    test("网关全部 66 个模型都被规则覆盖，且能力分类正确", () => {
        const channel = applyChannelAdaptation(hubChannel());
        const missing = HUB_MODELS.filter((model) => !profileOf(channel, model));
        expect(missing).toEqual([]);
        for (const model of HUB_MODELS) {
            const value = model.toLowerCase();
            const expected = value.includes("seedream") || value.includes("gpt-image") || (value.includes("gemini-") && value.includes("image"))
                ? "image"
                : value.includes("seedance") || value.includes("wan3.0-video") || value.includes("happyhorse")
                  ? "video"
                  : "text";
            expect({ model, capability: profileOf(channel, model)?.capability }).toEqual({ model, capability: expected });
        }
    });

    test("Seedream 系裁掉上游不存在的质量 / 透明背景 / output_format", () => {
        const channel = applyChannelAdaptation(hubChannel(["Doubao-Seedream-5.0-lite", "Doubao-seedream-4.5"]));
        for (const model of ["Doubao-Seedream-5.0-lite", "Doubao-seedream-4.5"]) {
            const image = profileOf(channel, model)?.capabilityConfig?.image;
            expect(image?.quality.supported).toBe(false);
            expect(image?.transparentBackground.supported).toBe(false);
            expect(image?.outputFormat.supported).toBe(false);
            // 尺寸仍走像素语义，画布保存的 1024x1024 这类值不能被改写成比例。
            expect(image?.size.parameter).toBe("size");
        }
    });

    // Seedream 5.0 lite / 4.5 的总像素下限是 2560x1440 = 3,686,400，且 lite 不支持 1K。
    // 2026-10-12 实测：1024x1824（画布 9:16@1K）→ 网关 503，2048x2048 → 200 出图。
    test("Seedream lite / 4.5 只给官方 2K 尺寸，且每个尺寸都在上游窗口内", () => {
        const channel = applyChannelAdaptation(hubChannel(["Doubao-Seedream-5.0-lite", "Doubao-seedream-4.5"]));
        for (const model of ["Doubao-Seedream-5.0-lite", "Doubao-seedream-4.5"]) {
            const size = profileOf(channel, model)?.capabilityConfig?.image?.size;
            expect(size?.allowCustom).toBe(false);
            expect(size?.presets?.length).toBe(8);
            expect(size?.default).toBe("2048x2048");
            for (const preset of size?.presets || []) {
                const pixels = preset.width * preset.height;
                // 上游窗口：lite / 4.5 为 [3,686,400, 3072x3072x1.1025]
                expect({ size: preset.size, ok: pixels >= 3_686_400 }).toEqual({ size: preset.size, ok: true });
                // 后端 validateImageCapabilityConfig 的预设边界：最长边 ≤ 3840、像素 ∈ [655360, 8294400]
                expect({ size: preset.size, edge: Math.max(preset.width, preset.height) <= 3840 }).toEqual({ size: preset.size, edge: true });
                expect({ size: preset.size, cap: pixels <= 8_294_400 }).toEqual({ size: preset.size, cap: true });
                // 预设值必须在 values 里，否则后端校验会拒（"图片预设必须包含在尺寸支持值中"）
                expect(size?.values).toContain(preset.size);
            }
            // 画布 1K 档的默认值必须已经不在可选集合里
            expect(size?.values).not.toContain("1024x1824");
            expect(size?.values).not.toContain("1024x1024");
        }
    });

    test("Seedream 4.0 不受影响：下限 921,600，画布 1K 仍可用", () => {
        const channel = applyChannelAdaptation(hubChannel(["Doubao-seedream-4.0"]));
        const size = profileOf(channel, "Doubao-seedream-4.0")?.capabilityConfig?.image?.size;
        expect(size?.presets).toBeUndefined();
        expect(size?.allowCustom).toBe(true);
        expect(size?.values).toContain("1024x1024");
    });

    // 画布节点的 metadata 里还存着上次选的 1024x1824；生成时按能力画像校正，
    // 否则用户不重新选尺寸就会一直撞同一个错误。
    test("旧节点残留的 1K 尺寸会被校正到有效尺寸", () => {
        const channel = applyChannelAdaptation(hubChannel());
        const config = { channels: [channel], model: "hub::Doubao-Seedream-5.0-lite" } as unknown as AiConfig;
        const resolved = resolveModelGenerationDefaults(config, "hub::Doubao-Seedream-5.0-lite", "image", { size: "1024x1824" });
        expect(resolved.size).toBe("2048x2048");
        // 已经合法的值不被改动
        expect(resolveModelGenerationDefaults(config, "hub::Doubao-Seedream-5.0-lite", "image", { size: "1600x2848" }).size).toBe("1600x2848");
    });

    test("OpenAI 系（gpt-image）画像保持完整，Gemini 图像只关透明背景", () => {
        const channel = applyChannelAdaptation(hubChannel(["gpt-image-2", "gpt-image-2.5-flare", "gemini-3-pro-image-preview"]));
        for (const model of ["gpt-image-2", "gpt-image-2.5-flare"]) {
            const image = profileOf(channel, model)?.capabilityConfig?.image;
            expect(image?.quality.supported).toBe(true);
            expect(image?.transparentBackground.supported).toBe(true);
            expect(image?.outputFormat.supported).toBe(true);
        }
        const gemini = profileOf(channel, "gemini-3-pro-image-preview")?.capabilityConfig?.image;
        expect(gemini?.transparentBackground.supported).toBe(false);
        expect(gemini?.quality.supported).toBe(true);
    });

    test("视频家族落到各自的中转网关协议", () => {
        const channel = applyChannelAdaptation(hubChannel(["doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.5", "wan3.0-video-prime", "happyhorse-1.1-r2v"]));
        const expected: Record<string, string> = {
            "doubao-seedance-2.0": "ark-task-gateway-video",
            "doubao-seedance-2.0-fast": "ark-task-gateway-video",
            "doubao-seedance-2.5": "ark-task-gateway-video-25",
            "wan3.0-video-prime": "wan-task-gateway-video",
            "happyhorse-1.1-r2v": "wan-task-gateway-video",
        };
        for (const [model, protocol] of Object.entries(expected)) {
            expect({ model, protocol: profileOf(channel, model)?.protocol }).toEqual({ model, protocol });
        }
        // 协议定了之后视频能力画像由 model-capabilities 按协议给出，不需要适配层再写一遍。
        expect(defaultModelCapabilityConfig("ark-task-gateway-video-25", "doubao-seedance-2.5").video?.duration.max).toBe(30);
    });

    test("文本家族不会被误判成媒体模型", () => {
        const channel = applyChannelAdaptation(hubChannel(["Doubao-Seed-2.0-Pro", "claude-opus-5", "gemini-3.5-flash", "kimi-k3", "MiniMax-M3"]));
        for (const model of ["Doubao-Seed-2.0-Pro", "claude-opus-5", "gemini-3.5-flash", "kimi-k3", "MiniMax-M3"]) {
            expect({ model, ...profileOf(channel, model) }).toMatchObject({ model, capability: "text", protocol: "chat-completion" });
        }
    });

    test("协议只补缺失，画像里的预设字段以预设为准（旧画像会自愈）", () => {
        const base = hubChannel(["Doubao-Seedream-5.0-lite", "doubao-seedance-2.0"]);
        const manualImage = {
            model: "Doubao-Seedream-5.0-lite",
            capability: "image" as const,
            protocol: "openai-image",
            displayName: "我的自定义名字",
            // 模拟「上一次适配留下的旧画像」：尺寸仍是画布的 1K 值（低于上游下限，必失败）
            capabilityConfig: { ...defaultModelCapabilityConfig("openai-image", "Doubao-Seedream-5.0-lite"), image: { ...defaultModelCapabilityConfig("openai-image", "Doubao-Seedream-5.0-lite").image!, maxOutputs: 3, size: { parameter: "size", values: ["auto", "1024x1824"], default: "1024x1824", allowCustom: true } } },
        };
        const manualVideo = { model: "doubao-seedance-2.0", capability: "video" as const, protocol: "newapi-channel-2" };
        const channel = applyChannelAdaptation({ ...base, modelProfiles: [manualImage, manualVideo] });

        // 用户手设的协议不被覆盖
        expect(profileOf(channel, "doubao-seedance-2.0")).toBe(manualVideo);
        // 预设拥有的字段被刷新到官方 2K
        const size = profileOf(channel, "Doubao-Seedream-5.0-lite")?.capabilityConfig?.image?.size;
        expect(size?.allowCustom).toBe(false);
        expect(size?.default).toBe("2048x2048");
        // 预设没声明的字段（张数上限）与手填的展示名保留
        const profile = profileOf(channel, "Doubao-Seedream-5.0-lite");
        expect(profile?.capabilityConfig?.image?.maxOutputs).toBe(3);
        expect(profile?.displayName).toBe("我的自定义名字");
    });

    test("幂等：重复应用结果一致，且未命中的渠道保持原引用", () => {
        const once = applyChannelAdaptation(hubChannel());
        const twice = applyChannelAdaptation(once);
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
        // 无变化时必须返回同一个引用，避免 normalizeConfigSnapshot 触发重复渲染
        expect(twice).toBe(once);
        const other = createModelChannel({ id: "other", name: "其他", baseUrl: "https://api.example.com", apiFormat: "openai", models: ["x"] });
        expect(applyChannelAdaptation(other)).toBe(other);
    });

    test("画布面板真的不再显示上游不支持的开关", () => {
        const channel = applyChannelAdaptation(hubChannel());
        const render = (model: string) =>
            renderToStaticMarkup(
                ImageSettingsPanel({
                    config: { channels: [channel], model: `hub::${model}`, size: "1024x1024", quality: "auto", transparentBackground: "false", count: "1" } as unknown as AiConfig,
                    onConfigChange: () => {},
                    theme: canvasThemes.light,
                }),
            );
        const seedream = render("Doubao-Seedream-5.0-lite");
        expect(seedream).not.toContain("透明背景");
        expect(seedream).not.toContain("质量");
        // 尺寸/比例仍然可选：网关接受 OpenAI 风格的 size 像素值。
        expect(seedream).toContain("宽高比");
        // 只露出官方 2K 档；1K/4K 会让用户选到低于下限的尺寸（实测必失败）。
        expect(seedream).toContain("2K");
        expect(seedream).not.toContain("1K");
        expect(seedream).not.toContain("4K");
        // 自定义输入的下限（655,360）拦不住小于 3,686,400 的非法值，直接不给。
        expect(seedream).not.toContain("自定义比例或尺寸");
        expect(seedream).not.toContain("1024");

        const openai = render("gpt-image-2");
        expect(openai).toContain("透明背景");
        expect(openai).toContain("质量");
    });
});
