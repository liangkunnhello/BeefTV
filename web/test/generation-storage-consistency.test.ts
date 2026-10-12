import { expect, test } from "bun:test";

type Scenario = "image-cleanup" | "scope-cleanup-switch" | "scope-cleanup-late-canvas-reference" | "video-commit-race" | "audio-commit-race" | "generation-commit-queue-race" | "generation-commit-queue-race-corrupted";
type ScenarioResponse<T> = { ok: true; result: T } | { ok: false; error: string };

function runScenario<T>(scenario: Scenario): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/generation-storage-consistency.worker.ts", import.meta.url).href, { type: "module" });
        const finish = () => {
            worker.terminate();
        };
        worker.onmessage = (event: MessageEvent<ScenarioResponse<T>>) => {
            finish();
            if (event.data.ok) resolve(event.data.result);
            else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => {
            finish();
            reject(event.error ?? new Error(event.message));
        };
        worker.postMessage(scenario);
    });
}

test("generation image cleanup removes unused generation-image blobs and preserves referenced ones", async () => {
    const result = await runScenario<{ usedPresent: boolean; unusedPresent: boolean }>("image-cleanup");
    expect(result.usedPresent).toBe(true);
    expect(result.unusedPresent).toBe(false);
});

test("delayed cleanup keeps account-A Canvas-only image references after switching the active account", async () => {
    const result = await runScenario<{ referencedPresent: boolean; unusedPresent: boolean; otherScopePresent: boolean }>("scope-cleanup-switch");
    expect(result.referencedPresent).toBe(true);
    expect(result.unusedPresent).toBe(false);
    expect(result.otherScopePresent).toBe(true);
});

test("delayed cleanup preserves a same-scope Canvas-only reference added after cleanup was queued", async () => {
    const result = await runScenario<{ referencedPresent: boolean; unusedPresent: boolean }>("scope-cleanup-late-canvas-reference");
    expect(result.referencedPresent).toBe(true);
    expect(result.unusedPresent).toBe(false);
});

test("generation video and audio materialization cannot race cleanup into a catalog row whose blob is missing", async () => {
    for (const mediaType of ["video", "audio"] as const) {
        const result = await runScenario<{ kind?: string; storageKey?: string; blobPresent: boolean; generationAssetCount: number }>(`${mediaType}-commit-race`);
        expect(result.kind).toBe(mediaType);
        expect(result.storageKey).toMatch(new RegExp(`^generation-${mediaType}:generation-media-commit-race-${mediaType}:`));
        expect(result.blobPresent).toBe(true);
        expect(result.generationAssetCount).toBe(1);
    }
});

test("a stale ordinary save queued during the generation commit cannot strip the committed node content", async () => {
    const result = await runScenario<{ injectedStaleSnapshot: boolean; durableContent: string | null; durableStatus: string | null; durableKeys: number; liveContent: string | null; liveStatus: string | null }>("generation-commit-queue-race");
    expect(result.injectedStaleSnapshot).toBe(true);
    // 回归：修复前 durable/live 上留下的是「已确认 effect stamp + 空内容 + loading」的节点，
    // 之后所有幂等守护都会把它当作已应用而跳过修复，节点永久停在生成中。
    expect(result.durableKeys).toBe(1);
    expect(result.durableContent).toBe("真人写实版提示词");
    expect(result.durableStatus).toBe("success");
    expect(result.liveContent).toBe("真人写实版提示词");
    expect(result.liveStatus).toBe("success");
});

test("replaying the task result heals a node already corrupted with a confirmed stamp and empty content", async () => {
    const result = await runScenario<{ injectedStaleSnapshot: boolean; durableContent: string | null; durableStatus: string | null; durableKeys: number; liveContent: string | null }>("generation-commit-queue-race-corrupted");
    expect(result.injectedStaleSnapshot).toBe(true);
    expect(result.durableKeys).toBe(1);
    expect(result.durableContent).toBe("真人写实版提示词");
    expect(result.durableStatus).toBe("success");
    expect(result.liveContent).toBe("真人写实版提示词");
});
