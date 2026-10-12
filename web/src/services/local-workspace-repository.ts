import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { http } from "@/services/api/request";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";

type LocalCanvasContent = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>;
type CanvasSaveSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt" | "revision">;

const backendSaveTails = new Map<string, Promise<void>>();
const backendSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 画布保存的乐观锁冲突（HTTP 409）。
 * 后端在 `base_revision` 落后于当前版本时以 409 拒绝；识别出来才能重读版本重试，
 * 否则该窗口会**永久**写不进去（生成结果挂不回画布、刷新后节点消失）。
 */
function isCanvasRevisionConflict(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: number; response?: { status?: number } };
    return candidate.status === 409 || candidate.response?.status === 409;
}

function resourceIdFromLocator(value?: string) {
    const storageID = resourceIdFromStorageKey(value);
    if (storageID) return storageID;
    return value?.match(/\/api\/resources\/([^/?#]+)\/file(?:[?#]|$)/)?.[1] || "";
}

function assetResourceId(asset: Asset) {
    if (!("storageKey" in asset.data)) return "";
    return resourceIdFromLocator(asset.data.storageKey);
}

export function canvasGenerationCommitAssets(project: CanvasProject, assets: Asset[]) {
    const resourceIDs = new Set<string>();
    for (const node of project.nodes) {
        if (node.type !== "image" && node.type !== "video" && node.type !== "audio") continue;
        const resourceID = resourceIdFromLocator(node.metadata?.storageKey) || resourceIdFromLocator(node.metadata?.content);
        if (resourceID) resourceIDs.add(resourceID);
    }
    return assets.filter((asset) => resourceIDs.has(assetResourceId(asset)));
}

export function bindCanvasGenerationCommitAssets(project: CanvasProject, assets: Asset[]): CanvasProject {
    const assetByResource = new Map<string, string>();
    for (const asset of assets) {
        const resourceID = assetResourceId(asset);
        if (resourceID) assetByResource.set(resourceID, asset.id);
    }
    return {
        ...project,
        nodes: project.nodes.map((node) => {
            if (node.type !== "image" && node.type !== "video" && node.type !== "audio") return node;
            const resourceID = resourceIdFromLocator(node.metadata?.storageKey) || resourceIdFromLocator(node.metadata?.content);
            const assetId = assetByResource.get(resourceID);
            return assetId ? { ...node, metadata: { ...node.metadata, assetId } } : node;
        }),
    };
}

function projectUpdatedAt(project: CanvasProject) {
    const timestamp = Date.parse(project.updatedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Resolve the browser/desktop dual-store snapshot without allowing an older
 * backend response to erase edits that have already been persisted locally.
 * Unknown/equal versions intentionally keep the local copy: data preservation
 * is safer than treating a backend read as authoritative without evidence that
 * it is newer.
 */
export function selectPreferredCanvasProject(local: CanvasProject | null | undefined, backend: CanvasProject) {
    if (!local) return backend;
    const localUpdatedAt = projectUpdatedAt(local);
    const backendUpdatedAt = projectUpdatedAt(backend);
    if (backendUpdatedAt !== localUpdatedAt) return backendUpdatedAt > localUpdatedAt ? backend : local;
    const localRevision = local.revision ?? 0;
    const backendRevision = backend.revision ?? 0;
    if (backendRevision !== localRevision) return backendRevision > localRevision ? backend : local;
    return local;
}

/**
 * Local workspace persistence boundary.
 *
 * This module deliberately has no network, account, or hosted-service imports.
 * Keep local canvas CRUD here so desktop callers do not need to enter the
 * hosted synchronization service just to persist a project.
 */
export async function createLocalCanvasProject(title: string, projectId?: string, initialContent?: LocalCanvasContent, workspaceProjectId?: string) {
    const id = useCanvasStore.getState().createProject(title, projectId, workspaceProjectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    // The in-memory project is already usable. Do not make navigation depend
    // on an IndexedDB/localForage flush completing successfully; the store
    // keeps its pending write queue and will retry it on the next flush.
    // Desktop restarts hydrate from the co-packaged Go repository. Creating a
    // project only in IndexedDB leaves the runtime returning 404 and allows its
    // detached-resource cleanup to delete media that the canvas still uses.
    await syncLocalCanvasProjectToBackend(id);
    // IndexedDB is an offline cache, not the desktop source of truth. A stuck
    // WebKit storage transaction must never block navigation after the Go
    // repository has durably accepted the project.
    void flushCanvasStorePersistence().catch((error) => {
        console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
    });
    return { id };
}

/** Serialize writes per canvas so optimistic revisions cannot race each other. */
function syncLocalCanvasProject(id: string, includeGeneratedAssets: boolean): Promise<void> {
    const previous = backendSaveTails.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        const buildPayload = () => {
            const project = openLocalCanvasProject(id);
            if (!project) return undefined;
            const assets = includeGeneratedAssets ? canvasGenerationCommitAssets(project, useAssetStore.getState().assets) : [];
            const projectForSave = includeGeneratedAssets ? bindCanvasGenerationCommitAssets(project, assets) : project;
            const endpoint = includeGeneratedAssets ? `/canvas-projects/${encodeURIComponent(id)}/generated-assets` : `/canvas-projects/${encodeURIComponent(id)}`;
            return { project, assets, endpoint, body: includeGeneratedAssets ? { project: projectForSave, assets } : { project: projectForSave } };
        };
        const put = (payload: NonNullable<ReturnType<typeof buildPayload>>) => http.put<{ project: CanvasSaveSummary }>(payload.endpoint, payload.body);

        let payload = buildPayload();
        if (!payload) return;
        let response: { project: CanvasSaveSummary };
        try {
            response = await put(payload);
        } catch (error) {
            if (!isCanvasRevisionConflict(error)) throw error;
            // 同一画布可能在多个窗口打开：另一个窗口把服务端版本推进后，本窗口的乐观版本会一直落后，
            // 于是**每一次**保存都被 409 拒绝 —— 生成结果、节点改动就永远写不回去（表现为「生成卡住 / 刷新后节点消失」）。
            // 与模型配置保存一致：读到服务端最新版本、采纳后重试一次。只重试一次，避免放大成写风暴。
            const latest = await http.get<{ project?: Pick<CanvasProject, "revision"> }>(`/canvas-projects/${encodeURIComponent(id)}`);
            const serverRevision = latest?.project?.revision;
            if (typeof serverRevision !== "number" || !Number.isFinite(serverRevision)) throw error;
            useCanvasStore.setState((state) => ({
                projects: state.projects.map((item) => (item.id === id ? { ...item, revision: serverRevision } : item)),
            }));
            payload = buildPayload();
            if (!payload) return;
            response = await put(payload);
        }
        const saved = response.project;
        if (!saved) return;
        useCanvasStore.setState((state) => ({
            projects: state.projects.map((current) => current.id === id
                // Preserve edits made while the request was in flight; only the
                // server-owned optimistic revision must advance.
                ? {
                    ...(includeGeneratedAssets ? bindCanvasGenerationCommitAssets(current, payload.assets) : current),
                    revision: saved.revision,
                    ...(current.updatedAt === payload.project.updatedAt ? { updatedAt: saved.updatedAt } : {}),
                }
                : current),
        }));
        void flushCanvasStorePersistence().catch((error) => {
            console.error("画布本地缓存写入失败，已保存到桌面数据库", { id, error });
        });
    });
    const tail = next.finally(() => {
        if (backendSaveTails.get(id) === tail) backendSaveTails.delete(id);
    });
    backendSaveTails.set(id, tail);
    return tail;
}

export function syncLocalCanvasProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, false);
}

type CanvasDocumentPersistPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "timeline">>;

function sameDocumentValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function revertUnchangedCanvasNodes(
    previous: CanvasProject["nodes"],
    attempted: CanvasProject["nodes"],
    live: CanvasProject["nodes"],
): CanvasProject["nodes"] {
    if (sameDocumentValue(live, attempted)) return previous;
    const previousById = new Map(previous.map((node) => [node.id, node]));
    const attemptedById = new Map(attempted.map((node) => [node.id, node]));
    const reverted: CanvasProject["nodes"] = [];
    for (const node of live) {
        const before = previousById.get(node.id);
        const optimistic = attemptedById.get(node.id);
        if (!before && optimistic) {
            if (sameDocumentValue(node, optimistic)) continue;
            reverted.push(node);
            continue;
        }
        if (before && optimistic) {
            reverted.push(sameDocumentValue(node, optimistic) ? before : node);
            continue;
        }
        reverted.push(node);
    }
    return reverted;
}

function revertUnchangedCanvasDocumentPatch(current: CanvasProject, previous: CanvasProject, patch: CanvasDocumentPersistPatch): CanvasProject {
    const next: CanvasProject = { ...current };
    (Object.keys(patch) as Array<keyof CanvasDocumentPersistPatch>).forEach((key) => {
        if (key === "nodes") {
            if (!patch.nodes) return;
            next.nodes = revertUnchangedCanvasNodes(previous.nodes, patch.nodes, current.nodes);
            return;
        }
        const attempted = patch[key];
        if (attempted === undefined) return;
        if (sameDocumentValue(current[key], attempted)) {
            (next as Record<string, unknown>)[key] = previous[key];
        }
    });
    return next;
}

/**
 * Persist a canvas document patch before the caller reports success.
 * Local desktop hydrates from SQLite, so that profile PUTs the Go repository
 * without waiting on IndexedDB. Hosted keeps update plus an awaited flush.
 * A failed write only reverts patch fields that nobody else changed.
 */
export async function persistCanvasDocument(id: string, patch: CanvasDocumentPersistPatch) {
    const previous = useCanvasStore.getState().openProject(id);
    useCanvasStore.getState().updateProject(id, patch);
    const attempted = useCanvasStore.getState().openProject(id);
    try {
        if (isLocalWorkspaceMode()) {
            await syncLocalCanvasProjectToBackend(id);
            return;
        }
        await flushCanvasStorePersistence();
    } catch (error) {
        if (previous) {
            useCanvasStore.setState((state) => ({
                projects: state.projects.map((item) => {
                    if (item.id !== id) return item;
                    const reverted = revertUnchangedCanvasDocumentPatch(item, previous, patch);
                    if (attempted && item.updatedAt === attempted.updatedAt) reverted.updatedAt = previous.updatedAt;
                    return reverted;
                }),
            }));
        }
        throw error;
    }
}

/** Timeline edits live on the canvas document. */
export async function persistCanvasTimeline(id: string, timeline: NonNullable<CanvasProject["timeline"]>) {
    await persistCanvasDocument(id, { timeline });
}

export function syncLocalCanvasGenerationProjectToBackend(id: string): Promise<void> {
    return syncLocalCanvasProject(id, true);
}

export function scheduleLocalCanvasBackendSync(id: string) {
    const existing = backendSaveTimers.get(id);
    if (existing) clearTimeout(existing);
    backendSaveTimers.set(id, setTimeout(() => {
        backendSaveTimers.delete(id);
        void syncLocalCanvasProjectToBackend(id).catch((error) => console.error("画布后端持久化失败，等待下次编辑重试", { id, error }));
    }, 500));
}

export function openLocalCanvasProject(id: string) {
    return useCanvasStore.getState().openProject(id);
}

/**
 * Best-effort bridge for the browser preview. The Go local runtime is the
 * canonical store when it is available; IndexedDB remains the offline
 * fallback so a stopped backend never prevents the UI from opening.
 */
export async function hydrateLocalCanvasProjectsFromBackend() {
    try {
        const response = await http.get<{ projects: Array<Pick<CanvasProject, "id">> }>("/canvas-projects", {
            params: { page: 1, pageSize: 500, sort: "updated" },
        });
        const summaries = Array.isArray(response.projects) ? response.projects : [];
        if (summaries.length === 0) return false;
        const projects = (await Promise.all(summaries.map(async (summary) => {
            try {
                const detail = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(summary.id)}`);
                return detail.project;
            } catch {
                return undefined;
            }
        }))).filter((project): project is CanvasProject => Boolean(project));
        if (projects.length === 0) return false;
        const current = useCanvasStore.getState().projects;
        const byId = new Map(current.map((project) => [project.id, project]));
        for (const project of projects) byId.set(project.id, selectPreferredCanvasProject(byId.get(project.id), project));
        useCanvasStore.setState({ projects: [...byId.values()] });
        await flushCanvasStorePersistence();
        return true;
    } catch {
        return false;
    }
}

export async function openLocalCanvasProjectFromBackend(id: string) {
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const backendProject = response.project;
        if (!backendProject) return openLocalCanvasProject(id);
        const project = selectPreferredCanvasProject(openLocalCanvasProject(id), backendProject);
        useCanvasStore.setState((state) => ({
            projects: state.projects.some((item) => item.id === id)
                ? state.projects.map((item) => item.id === id ? project : item)
                : [...state.projects, project],
        }));
        await flushCanvasStorePersistence();
        return project;
    } catch {
        return openLocalCanvasProject(id);
    }
}

export async function refreshLocalCanvasProjectIfChanged(id: string) {
    const current = openLocalCanvasProject(id);
    try {
        const response = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
        const remote = response.project;
        if (!remote || selectPreferredCanvasProject(current, remote) !== remote) return false;
        useCanvasStore.setState((state) => ({
            projects: state.projects.some((item) => item.id === id)
                ? state.projects.map((item) => item.id === id ? remote : item)
                : [...state.projects, remote],
        }));
        await flushCanvasStorePersistence();
        return remote;
    } catch {
        return undefined;
    }
}

export async function flushLocalWorkspace() {
    await flushCanvasStorePersistence();
}

export async function deleteLocalCanvasProjects(ids: readonly string[]) {
    const selected = new Set(ids);
    const snapshots = useCanvasStore.getState().projects.filter((project) => selected.has(project.id));
    useCanvasStore.getState().deleteProjects([...ids]);
    if (snapshots.length) useCanvasHistoryStore.getState().recordDeletedProjects(snapshots);
    await flushCanvasStorePersistence();
    await Promise.all(ids.map(async (id) => {
        try {
            await http.delete(`/canvas-projects/${encodeURIComponent(id)}`);
        } catch (error) {
            console.error("画布后端删除失败", { id, error });
            throw error;
        }
    }));
    return snapshots;
}
