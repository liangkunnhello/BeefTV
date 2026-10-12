import { expect, test } from "bun:test";

import { projectOrdinaryCanvasProjects, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";

// 生成副作用提交（dedicated commit）与普通保存队列之间的竞态：
// 队列快照可能早于这次提交（提交结果还没送回 store），重投影时不能让旧快照带上已确认的 effect stamp。
const EFFECT_KEY = "attach-node:task-text-1:text-node-1:0";

function textNode(metadata: Partial<CanvasNodeData["metadata"]> = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return {
        id: "text-node-1",
        type: "text",
        title: "文本节点 1",
        createdAt: "2026-10-12T08:46:09.772Z",
        updatedAt: "2026-10-12T08:46:09.772Z",
        position,
        width: 350,
        height: 350,
        metadata: { content: "", status: "loading", taskId: "task-text-1", fontSize: 14, ...metadata },
    } as CanvasNodeData;
}

function canvasProject(nodes: CanvasNodeData[]): CanvasProject {
    return {
        id: "canvas-1",
        title: "未命名项目",
        createdAt: "2026-10-12T08:00:00.000Z",
        updatedAt: "2026-10-12T08:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    } as CanvasProject;
}

function projectedNode(project: CanvasProject | undefined) {
    return project!.nodes[0]!;
}

test("adopts the committed generation node instead of stamping a stale pre-generation snapshot", () => {
    // 提交结果：内容已写回，并带本次 effect stamp。
    const committed = canvasProject([textNode({ content: "真人写实版提示词", status: "success", generationEffectKeys: [EFFECT_KEY] })]);
    // 内存里的旧快照：提交结果还没送回 store，仍是「生成中 + 空内容 + 无 stamp」。
    const memory = canvasProject([textNode()]);

    const [projection] = projectOrdinaryCanvasProjects("projection-scope", [memory], [committed], EFFECT_KEY);
    const node = projectedNode(projection);

    expect(node.metadata?.content).toBe("真人写实版提示词");
    expect(node.metadata?.status).toBe("success");
    expect(node.metadata?.generationEffectKeys).toEqual([EFFECT_KEY]);
});

test("never leaves a confirmed effect stamp on a node without that effect's content", () => {
    const committed = canvasProject([textNode({ content: "真人写实版提示词", status: "success", generationEffectKeys: [EFFECT_KEY] })]);
    const memory = canvasProject([textNode()]);

    const [projection] = projectOrdinaryCanvasProjects("projection-scope", [memory], [committed], EFFECT_KEY);
    const node = projectedNode(projection);

    // 回归断言：修复前这里得到的是 {content: "", status: "loading", generationEffectKeys: [EFFECT_KEY]}，
    // 于是节点带着「副作用已确认」的身份永久停在生成中。
    expect(node.metadata?.generationEffectKeys?.includes(EFFECT_KEY)).toBe(true);
    expect(node.metadata?.content).not.toBe("");
    expect(node.metadata?.status).toBe("success");
});

test("keeps ordinary memory edits on nodes outside the committed generation effect", () => {
    const committedImage = {
        id: "image-1",
        type: "image",
        title: "图片节点",
        createdAt: "2026-10-12T08:00:00.000Z",
        updatedAt: "2026-10-12T08:00:00.000Z",
        position: { x: 0, y: 0 },
        width: 320,
        height: 320,
        metadata: { content: "resource:image-1", status: "success" },
    } as CanvasNodeData;
    const committed = canvasProject([textNode({ content: "正文", status: "success", generationEffectKeys: [EFFECT_KEY] }), committedImage]);
    const memory = canvasProject([textNode(), { ...committedImage, position: { x: 120, y: -40 } }]);

    const [projection] = projectOrdinaryCanvasProjects("projection-scope", [memory], [committed], EFFECT_KEY);

    expect(projection!.nodes[1]!.position).toEqual({ x: 120, y: -40 });
    expect(projection!.nodes[0]!.metadata?.content).toBe("正文");
});

test("still rolls back a local effect the durable snapshot never confirmed", () => {
    const localKey = "attach-node:task-text-9:text-node-1:0";
    const memory = canvasProject([textNode({ content: "本地结果", status: "success", generationEffectKeys: [localKey] })]);
    const durable = canvasProject([textNode()]);

    const [projection] = projectOrdinaryCanvasProjects("projection-scope", [memory], [durable], EFFECT_KEY);
    const node = projectedNode(projection);

    expect(node.metadata?.generationEffectKeys ?? []).toEqual([]);
    expect(node.metadata?.content).toBe("");
    expect(node.metadata?.status).toBe("loading");
});

test("keeps stamped nodes when there is no durable snapshot to reconcile against", () => {
    // 没有 durable 就没有「对方版本」，此时带 stamp 的节点不构成冲突，绝不能被投影丢掉。
    const memory = canvasProject([textNode({ content: "", status: "loading", generationEffectKeys: [EFFECT_KEY] })]);

    const [projection] = projectOrdinaryCanvasProjects("projection-scope", [memory], []);
    expect(projection).toBe(memory);
    expect(projection!.nodes).toHaveLength(1);
});
