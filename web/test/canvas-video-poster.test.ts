import { describe, expect, test } from "bun:test";

import { canvasNodeHasVideoPreview, canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { canvasVideoPreviewNeedsHydration, CANVAS_VIDEO_PREVIEW_VERSION, isLocalPreviewStorageKey, isSessionBoundPreviewUrl } from "@/services/canvas-video-preview";
import type { CanvasNodeData } from "@/types/canvas";

// 场景来源（2026-10-12 实测）：本地工作区模式下首帧被存成 `blob:` 会话地址 + 本地键
// （`image:<uid>:<id>`），刷新/换端口（localhost vs 127.0.0.1 不同源）后取不到 →
// 节点永远显示「首帧暂不可用，点击播放视频」，因为 needsHydration 只判断 content 非空。

function videoNode(metadata: Record<string, unknown>): CanvasNodeData {
    return { id: "v1", type: "video", title: "视频", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "resource:src-video", ...metadata } } as unknown as CanvasNodeData;
}

describe("视频首帧的水合判定", () => {
    test("没有首帧记录时必须水合", () => {
        expect(canvasVideoPreviewNeedsHydration(videoNode({ videoPreview: undefined }))).toBe(true);
    });

    test("content 是 blob 会话地址时必须重新水合（旧实现会永远跳过）", () => {
        const node = videoNode({
            videoPreview: { content: "blob:http://localhost:3000/dead", storageKey: "image:user:abc", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:src-video" },
        });
        expect(canvasVideoPreviewNeedsHydration(node)).toBe(true);
    });

    test("只剩本地 storageKey（content 已清空）时也要校验一次，避免本地缓存静默消失", () => {
        const node = videoNode({
            videoPreview: { content: "", storageKey: "image:user:abc", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:src-video" },
        });
        expect(canvasVideoPreviewNeedsHydration(node)).toBe(true);
    });

    test("首帧已经是资源、且来源一致时不再重复水合（避免每次刷新都重抓）", () => {
        const node = videoNode({
            videoPreview: { content: "http://127.0.0.1:8080/api/resources/abc/file", storageKey: "resource:abc", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:src-video" },
        });
        expect(canvasVideoPreviewNeedsHydration(node)).toBe(false);
    });

    test("来源视频变了 / 抓帧版本落后时必须重抓", () => {
        const moved = videoNode({
            videoPreview: { content: "", storageKey: "resource:abc", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:other-video" },
        });
        expect(canvasVideoPreviewNeedsHydration(moved)).toBe(true);
        const legacy = videoNode({
            videoPreview: { content: "", storageKey: "resource:abc", captureVersion: 1, sourceKey: "resource:src-video" },
        });
        expect(canvasVideoPreviewNeedsHydration(legacy)).toBe(true);
    });

    test("辅助判定：会话地址与本地键的识别", () => {
        expect(isSessionBoundPreviewUrl("blob:http://localhost:3000/x")).toBe(true);
        expect(isSessionBoundPreviewUrl("http://127.0.0.1:8080/api/resources/x/file")).toBe(false);
        expect(isLocalPreviewStorageKey("image:user:abc")).toBe(true);
        expect(isLocalPreviewStorageKey("resource:abc")).toBe(false);
        expect(isLocalPreviewStorageKey("")).toBe(false);
    });
});

describe("视频节点是否走首帧渲染分支", () => {
    test("只有本地 storageKey（content 为空）时仍然渲染首帧，而不是退化成「点击播放视频」", () => {
        const node = videoNode({
            videoPreview: { content: "", storageKey: "image:user:abc", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:src-video" },
        });
        expect(canvasNodeVideoPreviewUrl(node)).toBe("");
        expect(canvasNodeHasVideoPreview(node)).toBe(true);
    });

    test("完全没有任何首帧记录时不走预览分支", () => {
        expect(canvasNodeHasVideoPreview(videoNode({ videoPreview: null }))).toBe(false);
    });

    test("非视频节点不参与该判定", () => {
        const image = { ...videoNode({}), type: "image" } as unknown as CanvasNodeData;
        expect(canvasNodeHasVideoPreview(image)).toBe(false);
    });
});
