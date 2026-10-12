import { describe, expect, test } from "bun:test";

import { inferProtocolFromModelName, knownProtocolRuleForModel } from "@/lib/model-protocol-inference";
import { defaultProtocolForModel, ensureModelProfilesWithUiDefaults, type ModelProtocolDefinition } from "@/lib/model-protocols";

function protocol(value: string, capability: ModelProtocolDefinition["capability"]): ModelProtocolDefinition {
    return { value, label: value, capability, create: "POST /x", contentType: "application/json", media: "插件协议" };
}

const protocols: ModelProtocolDefinition[] = [
    protocol("newapi-channel-2", "video"),
    protocol("ark-task-gateway-video", "video"),
    protocol("ark-task-gateway-video-25", "video"),
    protocol("wan-task-gateway-video", "video"),
];

describe("model protocol inference", () => {
    test("routes doubao seedance 2.0 and 2.5 to their gateway protocols", () => {
        expect(inferProtocolFromModelName("doubao-seedance-2.0", protocols)).toBe("ark-task-gateway-video");
        expect(inferProtocolFromModelName("doubao-seedance-2.0-fast", protocols)).toBe("ark-task-gateway-video");
        expect(inferProtocolFromModelName("doubao-seedance-2.5", protocols)).toBe("ark-task-gateway-video-25");
        expect(inferProtocolFromModelName("doubao-seedance-2-5", protocols)).toBe("ark-task-gateway-video-25");
    });

    test("routes the alibaba family to the wan gateway protocol", () => {
        for (const model of [
            "wan3.0-video",
            "wan3.0-video-prime",
            "wan-3.0",
            "happyhorse-1.1-t2v",
            "happyhorse-1.1-i2v",
            "happyhorse-1.1-r2v",
            "happyhorse-1.0-video-edit",
        ]) {
            expect(inferProtocolFromModelName(model, protocols)).toBe("wan-task-gateway-video");
        }
    });

    test("stays out of the way when the plugin is not installed", () => {
        expect(inferProtocolFromModelName("doubao-seedance-2.5", [])).toBeUndefined();
        expect(inferProtocolFromModelName("happyhorse-1.1-t2v", [protocol("newapi-channel-2", "video")])).toBeUndefined();
    });

    test("treats a disabled protocol as unavailable", () => {
        const disabled = [{ ...protocol("ark-task-gateway-video-25", "video"), enabled: false }];
        expect(inferProtocolFromModelName("doubao-seedance-2.5", disabled)).toBeUndefined();
    });

    test("leaves unknown models alone", () => {
        expect(inferProtocolFromModelName("gpt-image-2", protocols)).toBeUndefined();
        expect(inferProtocolFromModelName("", protocols)).toBeUndefined();
        expect(knownProtocolRuleForModel("gpt-image-2")).toBeUndefined();
        expect(knownProtocolRuleForModel("doubao-seedance-2.5")?.protocol).toBe("ark-task-gateway-video-25");
    });

    test("defaultProtocolForModel uses the inference, then falls back to capability defaults", () => {
        expect(defaultProtocolForModel("doubao-seedance-2.0", protocols)).toBe("ark-task-gateway-video");
        // 没装插件时退回按能力推断的通用默认（这里没有内置协议清单，应落到标准视频协议）
        expect(defaultProtocolForModel("doubao-seedance-2.0", [])).toBe("newapi-channel-2");
    });

    test("a protocol the user picked by hand always wins", () => {
        const profiles = ensureModelProfilesWithUiDefaults(
            ["doubao-seedance-2.5"],
            [{ model: "doubao-seedance-2.5", capability: "video", protocol: "newapi-channel-2" }],
            protocols,
            "openai",
        );
        expect(profiles[0]?.protocol).toBe("newapi-channel-2");
    });

    test("fills the inferred protocol when the model has no profile yet", () => {
        const profiles = ensureModelProfilesWithUiDefaults(["doubao-seedance-2.5", "happyhorse-1.1-t2v"], [], protocols, "openai");
        expect(profiles[0]).toMatchObject({ model: "doubao-seedance-2.5", capability: "video", protocol: "ark-task-gateway-video-25" });
        expect(profiles[1]).toMatchObject({ model: "happyhorse-1.1-t2v", capability: "video", protocol: "wan-task-gateway-video" });
    });
});
