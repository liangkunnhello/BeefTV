import localforage from "localforage";

import { getActiveUserScope, setActiveUserScope } from "../../src/lib/user-scope";

type InstanceHook = (storeName: string, key: string, value: unknown) => Promise<void> | void;

type Scenario = "image-cleanup" | "scope-cleanup-switch" | "scope-cleanup-late-canvas-reference" | "video-commit-race" | "audio-commit-race" | "generation-commit-queue-race";

function installStorageHarness() {
    const originalCreateInstance = localforage.createInstance.bind(localforage);
    const originalGetItem = localforage.getItem.bind(localforage);
    const originalSetItem = localforage.setItem.bind(localforage);
    const originalRemoveItem = localforage.removeItem.bind(localforage);
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    const originalDocument = (globalThis as { document?: unknown }).document;
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);

    const defaultValues = new Map<string, unknown>();
    const instanceValues = new Map<string, Map<string, unknown>>();
    const localStorageValues = new Map<string, string>();
    const scheduled: Promise<void>[] = [];
    const hooks: { onSet?: InstanceHook } = {};
    const lockTails = new Map<string, Promise<void>>();

    const storeValues = (storeName: string) => {
        let values = instanceValues.get(storeName);
        if (!values) {
            values = new Map<string, unknown>();
            instanceValues.set(storeName, values);
        }
        return values;
    };

    localforage.getItem = (async (key: string) => defaultValues.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: unknown) => {
        defaultValues.set(key, value);
        return value;
    }) as typeof localforage.setItem;
    localforage.removeItem = (async (key: string) => {
        defaultValues.delete(key);
    }) as typeof localforage.removeItem;
    localforage.createInstance = ((options: { storeName?: string }) => {
        const storeName = options.storeName || "default";
        const values = storeValues(storeName);
        return {
            getItem: async (key: string) => values.get(key) ?? null,
            setItem: async (key: string, value: unknown) => {
                values.set(key, value);
                await hooks.onSet?.(storeName, key, value);
                return value;
            },
            removeItem: async (key: string) => {
                values.delete(key);
            },
            iterate: async (iterator: (value: unknown, key: string, iterationNumber: number) => unknown) => {
                let index = 1;
                for (const [key, value] of values) {
                    const result = iterator(value, key, index);
                    index += 1;
                    if (result !== undefined) return result;
                }
                return undefined;
            },
            clear: async () => values.clear(),
            keys: async () => [...values.keys()],
            length: async () => values.size,
        } as never;
    }) as typeof localforage.createInstance;

    Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: {
            localStorage: {
                getItem: (key: string) => localStorageValues.get(key) ?? null,
                setItem: (key: string, value: string) => localStorageValues.set(key, value),
                removeItem: (key: string) => localStorageValues.delete(key),
            },
            setTimeout: (handler: () => unknown, delay = 0) => {
                const scheduledRun = new Promise<void>((resolve, reject) => {
                    realSetTimeout(() => {
                        Promise.resolve(handler()).then(() => resolve(), reject);
                    }, delay);
                });
                scheduled.push(scheduledRun);
                return scheduled.length;
            },
            clearTimeout: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        },
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: {
            locks: {
                request: async <T>(name: string, callback: () => Promise<T>) => {
                    const previous = lockTails.get(name) ?? Promise.resolve();
                    let release!: () => void;
                    const tail = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    const queued = previous.catch(() => undefined).then(() => tail);
                    lockTails.set(name, queued);
                    await previous.catch(() => undefined);
                    try {
                        return await callback();
                    } finally {
                        release();
                        if (lockTails.get(name) === queued) lockTails.delete(name);
                    }
                },
            },
        },
    });
    delete (globalThis as { document?: unknown }).document;

    return {
        hooks,
        scheduled,
        realSetTimeout,
        restore() {
            localforage.createInstance = originalCreateInstance as typeof localforage.createInstance;
            localforage.getItem = originalGetItem;
            localforage.setItem = originalSetItem;
            localforage.removeItem = originalRemoveItem;
            if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
            else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: originalWindow });
            if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
            else Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: originalNavigator });
            if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
            else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument });
        },
    };
}

async function runImageCleanup() {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = "generation-image-cleanup";
    const usedKey = `generation-image:${scope}:used`;
    const unusedKey = `generation-image:${scope}:unused`;
    const imageStorage = await import("../../src/services/image-storage.ts?generation-image-cleanup-contract-worker");

    try {
        setActiveUserScope(scope);
        await imageStorage.setImageBlob(usedKey, new Blob(["used"], { type: "image/png" }));
        await imageStorage.setImageBlob(unusedKey, new Blob(["unused"], { type: "image/png" }));
        await imageStorage.cleanupUnusedImages({ assets: [{ data: { storageKey: usedKey } }] });
        return {
            usedPresent: (await imageStorage.getImageBlob(usedKey)) instanceof Blob,
            unusedPresent: (await imageStorage.getImageBlob(unusedKey)) instanceof Blob,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runScopeCleanupAfterSwitch() {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scopeA = "cleanup-account-a";
    const scopeB = "cleanup-account-b";
    const referencedKey = `image:${scopeA}:canvas-only`;
    const unusedKey = `image:${scopeA}:unused`;
    const otherScopeKey = `image:${scopeB}:unrelated`;

    try {
        setActiveUserScope(scopeA);
        const imageStorage = await import("../../src/services/image-storage.ts?scope-cleanup-switch-worker");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        const { useCanvasStore } = await import("../../src/stores/canvas/use-canvas-store");
        await imageStorage.setImageBlob(referencedKey, new Blob(["account-a-referenced"], { type: "image/png" }));
        await imageStorage.setImageBlob(unusedKey, new Blob(["account-a-unused"], { type: "image/png" }));
        await imageStorage.setImageBlob(otherScopeKey, new Blob(["account-b-unrelated"], { type: "image/png" }));
        useAssetStore.setState({ assets: [] });
        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-account-a",
                    title: "account A",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                    nodes: [
                        {
                            id: "node-account-a-image",
                            type: "image",
                            title: "account A image",
                            position: { x: 0, y: 0 },
                            width: 1,
                            height: 1,
                            metadata: { storageKey: referencedKey },
                        },
                    ],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                    directorScenes: [],
                },
            ],
        } as never);

        useAssetStore.getState().cleanupImages({ assets: [] });
        const cleanupRun = harness.scheduled.at(-1);
        if (!cleanupRun) throw new Error("cleanup was not scheduled");

        setActiveUserScope(scopeB);
        useAssetStore.setState({ assets: [] });
        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-account-b",
                    title: "account B",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                    directorScenes: [],
                },
            ],
        } as never);
        await cleanupRun;

        return {
            referencedPresent: (await imageStorage.getImageBlob(referencedKey)) instanceof Blob,
            unusedPresent: (await imageStorage.getImageBlob(unusedKey)) instanceof Blob,
            otherScopePresent: (await imageStorage.getImageBlob(otherScopeKey)) instanceof Blob,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runScopeCleanupAfterLateCanvasReference() {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = "cleanup-late-canvas-reference";
    const referencedKey = `image:${scope}:late-canvas-only`;
    const unusedKey = `image:${scope}:unused`;

    try {
        setActiveUserScope(scope);
        const imageStorage = await import("../../src/services/image-storage.ts?scope-cleanup-late-canvas-reference-worker");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        const { useCanvasStore } = await import("../../src/stores/canvas/use-canvas-store");
        await imageStorage.setImageBlob(referencedKey, new Blob(["late-canvas-reference"], { type: "image/png" }));
        await imageStorage.setImageBlob(unusedKey, new Blob(["still-unused"], { type: "image/png" }));
        useAssetStore.setState({ assets: [] });
        useCanvasStore.setState({ projects: [] });

        useAssetStore.getState().cleanupImages({ assets: [] });
        const cleanupRun = harness.scheduled.at(-1);
        if (!cleanupRun) throw new Error("cleanup was not scheduled");

        useCanvasStore.setState({
            projects: [
                {
                    id: "canvas-late-reference",
                    title: "late reference",
                    createdAt: "2026-08-14T00:00:00.000Z",
                    updatedAt: "2026-08-14T00:00:00.000Z",
                    nodes: [
                        {
                            id: "node-late-reference",
                            type: "image",
                            title: "late referenced image",
                            position: { x: 0, y: 0 },
                            width: 1,
                            height: 1,
                            metadata: { storageKey: referencedKey },
                        },
                    ],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: { x: 0, y: 0, k: 1 },
                    directorScenes: [],
                },
            ],
        } as never);

        await cleanupRun;

        return {
            referencedPresent: (await imageStorage.getImageBlob(referencedKey)) instanceof Blob,
            unusedPresent: (await imageStorage.getImageBlob(unusedKey)) instanceof Blob,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runMediaCommitRace(mediaType: "video" | "audio") {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = `generation-media-commit-race-${mediaType}`;
    let releaseMediaWrite!: () => void;
    const mediaWriteGate = new Promise<void>((resolve) => {
        releaseMediaWrite = resolve;
    });
    let mediaWriteStartedResolve!: () => void;
    const mediaWriteStarted = new Promise<void>((resolve) => {
        mediaWriteStartedResolve = resolve;
    });
    let blocked = false;
    harness.hooks.onSet = async (storeName, key) => {
        if (!blocked && storeName === "media_files" && key.startsWith(`generation-${mediaType}:${scope}:`)) {
            blocked = true;
            mediaWriteStartedResolve();
            await mediaWriteGate;
        }
    };

    try {
        setActiveUserScope(scope);
        const { materializeGenerationTaskAssets } = await import("../../src/services/project-asset-sync.ts?generation-media-commit-race-worker");
        const { useAssetStore } = await import("../../src/stores/use-asset-store");
        await import("../../src/stores/canvas/use-canvas-store");
        const fileStorage = await import("../../src/services/file-storage");
        const task = {
            id: `remote-generation-media-race-${mediaType}`,
            provider: "remote-test-provider",
            type: mediaType,
            status: "succeeded",
            prompt: "redacted",
            attempts: 1,
            resultState: "PENDING_MATERIALIZATION",
            resultJson: JSON.stringify(
                mediaType === "video"
                    ? {
                          mode: "video",
                          video: {
                              dataUrl: "data:video/mp4;base64,AAAA",
                              width: 16,
                              height: 9,
                              mimeType: "video/mp4",
                          },
                      }
                    : {
                          mode: "audio",
                          audio: {
                              dataUrl: "data:audio/mpeg;base64,AAAA",
                              mimeType: "audio/mpeg",
                          },
                      },
            ),
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
        } as const;

        const materializing = materializeGenerationTaskAssets(task as never);
        await mediaWriteStarted;
        useAssetStore.getState().cleanupImages({ assets: [] });
        const cleanupRun = harness.scheduled.at(-1);
        if (!cleanupRun) throw new Error("cleanup was not scheduled");
        await Promise.race([
            cleanupRun,
            new Promise<void>((resolve) => {
                harness.realSetTimeout(resolve, 20);
            }),
        ]);

        releaseMediaWrite();
        const materialized = await materializing;
        await cleanupRun;

        const assetId = materialized.outputs?.[0]?.materializedAssetId;
        const asset = useAssetStore.getState().assets.find((candidate) => candidate.id === assetId);
        const storageKey = asset?.kind === "video" || asset?.kind === "audio" ? asset.data.storageKey : undefined;
        const blobPresent = storageKey ? (await fileStorage.getMediaBlob(storageKey)) instanceof Blob : false;
        const generationAssetCount = useAssetStore.getState().assets.filter((candidate) => candidate.metadata?.generationEffectKey === `materialize:${task.id}:0`).length;
        return { kind: asset?.kind, storageKey, blobPresent, generationAssetCount };
    } finally {
        releaseMediaWrite();
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

async function runGenerationCommitQueueRace(options: { corrupted: boolean } = { corrupted: false }) {
    const previousScope = getActiveUserScope();
    const harness = installStorageHarness();
    const scope = options.corrupted ? "generation-commit-queue-race-corrupted" : "generation-commit-queue-race";
    const projectId = "canvas-generation-commit-queue-race";
    const nodeId = "text-node-queue-race";
    const effectKey = `attach-node:task-text-queue-race:${nodeId}:0`;
    const healedContent = "真人写实版提示词";
    // corrupted 变体复刻已被写坏的节点：带着已确认的 effect stamp，但内容为空、状态仍是生成中。
    const baseNode = {
        id: nodeId,
        type: "text",
        title: "文本节点 1",
        createdAt: "2026-10-12T08:46:09.772Z",
        updatedAt: "2026-10-12T08:46:09.772Z",
        position: { x: 0, y: 0 },
        width: 350,
        height: 350,
        metadata: {
            content: "",
            status: "loading",
            taskId: "task-text-queue-race",
            fontSize: 14,
            ...(options.corrupted ? { taskStatus: "succeeded", taskProgress: 100, generationEffectKeys: [effectKey] } : {}),
        },
    };
    const canvasProject = {
        id: projectId,
        revision: 0,
        title: "未命名项目",
        createdAt: "2026-10-12T08:00:00.000Z",
        updatedAt: "2026-10-12T08:00:00.000Z",
        nodes: [baseNode],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
    let injectedStaleSnapshot = false;

    try {
        setActiveUserScope(scope);
        const { scopedStorageKey } = await import("../../src/lib/user-scope");
        const { parseCanvasStorageDocument } = await import("../../src/lib/canvas/canvas-storage-revision");
        // 先把「已经存在磁盘上」的画布写进 durable，再导入 store —— 与真实启动（先读库、后水合）一致。
        const durableStoreKey = scopedStorageKey("infinite-canvas:canvas_store", scope);
        await localforage.setItem(
            durableStoreKey,
            JSON.stringify({
                state: { projects: [canvasProject] },
                version: 0,
                storageRevision: 5,
                tombstones: { projects: {}, nodes: {}, connections: {}, sessions: {}, messages: {} },
            }),
        );
        const { useCanvasStore, CANVAS_STORE_KEY, pendingCanvasStorePersistence } = await import("../../src/stores/canvas/use-canvas-store");
        const { persistCanvasGenerationEffect } = await import("../../src/services/canvas-generation-consumer");
        if (CANVAS_STORE_KEY !== "infinite-canvas:canvas_store") throw new Error("canvas store key changed");

        // 等 store 水合结束，拿到与磁盘一致的项目快照。
        for (let attempt = 0; attempt < 50 && !useCanvasStore.getState().hydrated; attempt += 1) {
            await new Promise<void>((resolve) => harness.realSetTimeout(resolve, 0));
        }
        const hydratedProject = useCanvasStore.getState().projects.find((project) => project.id === projectId);
        const hydratedNode = hydratedProject?.nodes.find((node) => node.id === nodeId);
        if (!hydratedProject || !hydratedNode) throw new Error("store hydration did not pick up the seeded canvas");
        const previousNode = hydratedNode;

        // 生成提交写盘时，普通保存队列恰好抓到提交前的快照（真实场景里是提交结果还没送回 store、
        // 而 React 刚把「绑定任务」的 setNodes 写进 store）。这里在「带生成结果的提交落盘」
        // 的同一步注入这份旧快照，模拟提交与普通保存队列的真实交错。
        const originalSetItem = localforage.setItem.bind(localforage);
        localforage.setItem = (async (key: string, value: unknown) => {
            const result = await originalSetItem(key, value);
            if (!injectedStaleSnapshot && typeof value === "string" && key.includes("canvas_store") && value.includes(healedContent)) {
                injectedStaleSnapshot = true;
                useCanvasStore.setState((state) => ({
                    projects: state.projects.map((project) => (project.id === projectId ? { ...project, nodes: [previousNode] } : project)),
                }));
            }
            return result;
        }) as typeof localforage.setItem;

        let effectError: string | null = null;
        await persistCanvasGenerationEffect({
            projectId,
            effectKey,
            previousNodes: [previousNode],
            nodes: [{ ...previousNode, metadata: { ...previousNode.metadata, content: healedContent, status: "success", generationEffectKeys: [effectKey] } }],
            signal: new AbortController().signal,
        } as never).catch((error: unknown) => {
            effectError = error instanceof Error ? error.message : String(error);
            return undefined;
        });

        const queuedContent = (pendingCanvasStorePersistence(scope)?.projects || []).find((project) => project.id === projectId)?.nodes?.[0]?.metadata?.content ?? null;
        const durable = parseCanvasStorageDocument(await localforage.getItem<string>(durableStoreKey));
        const durableNode = durable.state.projects.find((project) => project.id === projectId)?.nodes.find((node) => node.id === nodeId);
        const liveNode = (useCanvasStore.getState().projects.find((project) => project.id === projectId)?.nodes || []).find((node) => node.id === nodeId);
        return {
            injectedStaleSnapshot,
            effectError,
            queuedContent,
            durableContent: durableNode?.metadata?.content ?? null,
            durableStatus: durableNode?.metadata?.status ?? null,
            durableKeys: durableNode?.metadata?.generationEffectKeys?.length ?? 0,
            liveContent: liveNode?.metadata?.content ?? null,
            liveStatus: liveNode?.metadata?.status ?? null,
        };
    } finally {
        setActiveUserScope(previousScope);
        harness.restore();
    }
}

self.onmessage = async (event: MessageEvent<Scenario>) => {
    try {
        const result =
            event.data === "image-cleanup"
                ? await runImageCleanup()
                : event.data === "scope-cleanup-switch"
                  ? await runScopeCleanupAfterSwitch()
                  : event.data === "scope-cleanup-late-canvas-reference"
                    ? await runScopeCleanupAfterLateCanvasReference()
                    : event.data === "generation-commit-queue-race"
                      ? await runGenerationCommitQueueRace()
                      : event.data === "generation-commit-queue-race-corrupted"
                        ? await runGenerationCommitQueueRace({ corrupted: true })
                        : await runMediaCommitRace(event.data === "audio-commit-race" ? "audio" : "video");
        self.postMessage({ ok: true, result });
    } catch (error) {
        self.postMessage({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
};
