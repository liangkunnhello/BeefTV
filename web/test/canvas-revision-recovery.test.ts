import { afterEach, describe, expect, test } from "bun:test";

import { rebaseCanvasProjects, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { apiClient } from "@/services/api/request";
import { syncLocalCanvasGenerationProjectToBackend } from "@/services/local-workspace-repository";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

function node(id: string, status: string, extra: Record<string, unknown> = {}) {
    return { id, type: "image", title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status, ...extra } } as never;
}

function project(revision: number, nodes: unknown[], updatedAt: string): CanvasProject {
    return { id: "p1", title: "画布", revision, updatedAt, createdAt: updatedAt, nodes, connections: [], chatSessions: [] } as unknown as CanvasProject;
}

function document_(storageRevision: number, projects: CanvasProject[]): CanvasStorageDocument {
    return { version: 1, storageRevision, tombstones: { projects: {}, nodes: {}, connections: {}, sessions: {}, messages: {} }, state: { projects } };
}

// 场景来源（2026-10-12 实测）：同一画布开了两个窗口，窗口 A 把服务端版本推到 669，
// 窗口 B 还停在 668 并在本地生成了结果。旧实现在这种情况下整份返回本地分支，
// 会把 A 新增的节点一起丢掉；现在改为内容 3-way 合并、但保留本地 revision。
describe("画布本地合并：另一窗口写过时的处理", () => {
    const baseProject = project(668, [node("n1", "success"), node("n2", "loading")], "t0");
    const localProject = project(668, [node("n1", "success"), node("n2", "success", { content: "img" })], "t1");
    const durable = document_(900, [project(669, [node("n1", "success"), node("n2", "loading"), node("n3", "success")], "t2")]);

    test("既保留本地生成结果，也不吃掉另一窗口新增的节点", () => {
        const rebased = rebaseCanvasProjects({ document: durable, baseProjects: [baseProject], localProjects: [localProject], baseRevision: 900 });
        const merged = rebased.document.state.projects[0];
        expect(merged.nodes.map((item: { id: string }) => item.id)).toEqual(["n1", "n2", "n3"]);
        const n2 = merged.nodes.find((item: { id: string }) => item.id === "n2") as { metadata: { status: string } };
        expect(n2.metadata.status).toBe("success");
    });

    test("不采纳对方的 revision（版本号由服务端仲裁）", () => {
        const rebased = rebaseCanvasProjects({ document: durable, baseProjects: [baseProject], localProjects: [localProject], baseRevision: 900 });
        expect(rebased.document.state.projects[0].revision).toBe(668);
    });

    test("本地没有改动时直接采用对方版本", () => {
        const rebased = rebaseCanvasProjects({ document: durable, baseProjects: [baseProject], localProjects: [baseProject], baseRevision: 900 });
        expect(rebased.document.state.projects[0].revision).toBe(669);
        expect(rebased.document.state.projects[0].nodes.map((item: { id: string }) => item.id)).toEqual(["n1", "n2", "n3"]);
    });
});

// 场景来源（2026-10-12 实测）：draw 保存日志里 base_revision 卡在旧值、一路 409，
// 于是生成结果永远写不回画布。这里锁死「409 → 读最新版本 → 采纳 → 重试一次」。
describe("画布保存 409 自愈", () => {
    const originalRequest = apiClient.request;
    afterEach(() => {
        apiClient.request = originalRequest;
        useCanvasStore.setState({ projects: [] });
    });

    function stubSave(behaviour: { putStatuses: number[]; serverRevision: number }) {
        const calls: Array<{ method: string; url: string; revision?: number }> = [];
        let puts = 0;
        apiClient.request = (async (config: { method?: string; url?: string; data?: unknown }) => {
            const method = String(config.method || "get").toLowerCase();
            const body = typeof config.data === "string" ? JSON.parse(config.data) : (config.data as { project?: { revision?: number } } | undefined);
            calls.push({ method, url: String(config.url || ""), revision: body?.project?.revision });
            if (method === "put") {
                const status = behaviour.putStatuses[puts] ?? 200;
                puts += 1;
                if (status === 409) {
                    throw Object.assign(new Error("画布版本冲突"), { isAxiosError: true, response: { status: 409, data: { code: 40001, msg: "画布版本冲突" } } });
                }
                return { status: 200, data: { code: 0, data: { project: { id: "p1", title: "画布", createdAt: "t0", updatedAt: "t9", revision: 700 } } } };
            }
            return { status: 200, data: { code: 0, data: { project: { id: "p1", revision: behaviour.serverRevision } } } };
        }) as unknown as typeof apiClient.request;
        return calls;
    }

    test("409 后读到服务端版本、采纳并重试一次（重试带上新基准）", async () => {
        useCanvasStore.setState({ projects: [project(668, [node("n1", "success")], "t0")] });
        const calls = stubSave({ putStatuses: [409, 200], serverRevision: 699 });

        await syncLocalCanvasGenerationProjectToBackend("p1");

        expect(calls.map((call) => call.method)).toEqual(["put", "get", "put"]);
        expect(calls[0].revision).toBe(668);
        expect(calls[2].revision).toBe(699);
        expect(useCanvasStore.getState().projects[0].revision).toBe(700);
    });

    test("没有冲突时只发一次保存", async () => {
        useCanvasStore.setState({ projects: [project(668, [node("n1", "success")], "t0")] });
        const calls = stubSave({ putStatuses: [200], serverRevision: 699 });
        await syncLocalCanvasGenerationProjectToBackend("p1");
        expect(calls.map((call) => call.method)).toEqual(["put"]);
    });

    test("重试仍失败时向上抛错，不吞掉", async () => {
        useCanvasStore.setState({ projects: [project(668, [node("n1", "success")], "t0")] });
        stubSave({ putStatuses: [409, 409], serverRevision: 699 });
        await expect(syncLocalCanvasGenerationProjectToBackend("p1")).rejects.toThrow();
    });
});
