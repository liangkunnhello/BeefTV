import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { createModelChannel, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";

// 依据 Model Studio「Wan3.0 视频生成」官方文档（2026-10-12 核对）：
// parameters.duration 为 2–30 秒整数、resolution 为 480P/720P/1080P、ratio 支持 adaptive。
// 后端有同名合同测试 `wan_gateway_capability_test.go`，两边必须一致。
describe("wan 中转网关视频能力画像", () => {
    test("wan3.0-video / -prime 按官方文档放开到 30 秒并支持 adaptive", () => {
        for (const model of ["wan3.0-video", "wan3.0-video-prime", "wan-3.0"]) {
            const video = defaultModelCapabilityConfig("wan-task-gateway-video", model).video!;
            expect({ model, duration: video.duration }).toEqual({ model, duration: { selection: "range", min: 2, max: 30, step: 1, default: 5 } });
            expect({ model, ratios: video.ratios }).toEqual({ model, ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] });
            expect({ model, resolutions: video.resolutions }).toEqual({ model, resolutions: ["480p", "720p", "1080p"] });
            expect(video.watermark.supported).toBe(true);
            expect(video.operations).toEqual(expect.arrayContaining(["text_to_video", "image_to_video", "reference_to_video", "video_to_video"]));
        }
    });

    test("素材上限按官方 API 参考收敛", () => {
        // 官方：音频素材 type 为 reference_audio（不是 driving_audio）；插件侧已按官方枚举发送。
        const video = defaultModelCapabilityConfig("wan-task-gateway-video", "wan3.0-video").video!;
        expect(video.references.maxImages).toBe(9);
        expect(video.generateAudio).toEqual({ supported: false, default: false });
    });

    test("两个家族的画幅枚举不同，不能混用", () => {
        const wan3 = defaultModelCapabilityConfig("wan-task-gateway-video", "wan3.0-video").video!;
        expect(wan3.ratios).toEqual(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
        // happyhorse 实测拒绝 adaptive，只能用 9 个具名值。
        const happyhorse = defaultModelCapabilityConfig("wan-task-gateway-video", "happyhorse-1.1-i2v").video!;
        expect(happyhorse.ratios).toEqual(["16:9", "9:16", "4:3", "3:4", "1:1", "5:4", "4:5", "9:21", "21:9"]);
        expect(happyhorse.ratios).not.toContain("adaptive");
    });

    test("happyhorse 维持 2–15 秒（无公开文档，不跟着放开）", () => {
        const video = defaultModelCapabilityConfig("wan-task-gateway-video", "happyhorse-1.1-i2v").video!;
        expect(video.duration).toEqual({ selection: "range", min: 2, max: 15, step: 1, default: 5 });
        // 实测拒绝 adaptive，因此不能出现该值。
        expect(video.ratios).not.toContain("adaptive");
    });

    test("adaptive 不会泄漏到别的协议", () => {
        expect(defaultModelCapabilityConfig("ark-task-gateway-video", "doubao-seedance-2.0").video!.ratios).not.toContain("adaptive");
        expect(defaultModelCapabilityConfig("openai-image", "gpt-image-2").image!.size.parameter).toBe("size");
    });

    // 2026-10-12 实测：参考图 2304x1728(4:3) → 产出 1108x832(4:3)，前端设的 16:9 不生效。
    // 面板必须说明这一点，否则会被当成「上游没按设置走」的参数 bug。
    test("面板会说明图生视频的输出比例跟随首帧参考图（仅阿里系）", () => {
        // 走真实的配置归一化：渠道适配预设会给 happyhorse 打上 wan-task-gateway-video 协议，
        // 面板据此显示提示（直接建裸渠道会退回通用画像，测不到这条）。
        const channel = createModelChannel({ id: "hub", name: "渠道 2", baseUrl: "https://ai-claude-code-hub.jetmobo.com", apiFormat: "openai", models: ["happyhorse-1.1-i2v", "kling-v2"] });
        const render = (model: string) => {
            const config = normalizeConfigSnapshot({ config: { channels: [channel], model: `hub::${model}` } as unknown as AiConfig }).config;
            return renderToStaticMarkup(React.createElement(VideoSettingsPanel, { config: { ...config, size: "16:9", vquality: "720", videoSeconds: "6" }, onConfigChange: () => undefined, theme: canvasThemes.light }));
        };
        expect(render("happyhorse-1.1-i2v")).toContain("输出比例跟随首帧参考图");
        expect(render("kling-v2")).not.toContain("输出比例跟随首帧参考图");
    });
});
