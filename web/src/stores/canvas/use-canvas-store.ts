import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, readCanvasAppearanceDefault, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { useThemeStore } from "@/stores/use-theme-store";
import { parseCanvasStorageDocument, rebaseCanvasProjects, serializeCanvasStorageDocument, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { scopedLocalStorage } from "@/lib/user-scope";
import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasStarterMode } from "@/lib/canvas/canvas-starter";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";
import type { TimelineProject } from "@/types/timeline";

export type CanvasProject = {
    id: string;
    revision?: number;
    remoteContentHash?: string;
    /** Stable owner for the 1:N workspace-project -> canvases relationship. */
    workspaceProjectId?: string;
    projectId?: string;
    folderId?: string;
    title: string;
    /** Optional user-facing name for this canvas inside its workspace project. */
    canvasTitle?: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    starterMode?: CanvasStarterMode;
    appearance?: CanvasAppearance;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    directorScenes: DirectorScene[];
    timeline?: TimelineProject;
};

export type CanvasFolder = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    coverDataUrl?: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    folders: CanvasFolder[];
    createProject: (title?: string, projectId?: string, workspaceProjectId?: string) => string;
    createFolder: (name?: string) => string;
    renameFolder: (id: string, name: string) => void;
    deleteFolder: (id: string) => void;
    setFolderCover: (id: string, coverDataUrl: string) => void;
    moveProjectsToFolder: (ids: string[], folderId?: string) => void;
    importProject: (project: Partial<CanvasProject>, workspaceProjectId?: string) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    restoreProject: (project: CanvasProject) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "workspaceProjectId" | "projectId" | "folderId" | "title" | "canvasTitle" | "nodes" | "connections" | "chatSessions" | "activeChatId" | "starterMode" | "appearance" | "backgroundMode" | "showImageInfo" | "viewport" | "directorScenes" | "timeline">>) => void;
};

export const CANVAS_FOLDERS_KEY = "infinite-canvas:canvas_folders";

function readCanvasFolders(): CanvasFolder[] {
    try {
        const value = scopedLocalStorage.getItem(CANVAS_FOLDERS_KEY);
        const parsed = value ? JSON.parse(value) : [];
        return Array.isArray(parsed) ? parsed.filter((folder): folder is CanvasFolder => Boolean(folder && typeof folder.id === "string" && typeof folder.name === "string")) : [];
    } catch {
        return [];
    }
}

function writeCanvasFolders(folders: CanvasFolder[]) {
    scopedLocalStorage.setItem(CANVAS_FOLDERS_KEY, JSON.stringify(folders));
}

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";

function cloneCanvasValue<T>(value: T): T {
    if (value == null) return value;
    try {
        return structuredClone(value);
    } catch {
        if (Array.isArray(value)) return [...value] as T;
        if (typeof value === "object") return { ...value } as T;
        return value;
    }
}

type PersistedCanvasState = Pick<CanvasStore, "projects">;
type QueuedCanvasPersist = {
    name: string;
    scope: string;
    baseProjects: CanvasProject[];
    baseRevision: number;
    state: PersistedCanvasState;
    token: number;
};

type ObservedCanvasPersist = {
    projects: CanvasProject[];
    revision: number;
};

let suppressCanvasStorePersistence = 0;
const canvasMemoryStates = new Map<string, PersistedCanvasState>();
const observedCanvasPersists = new Map<string, ObservedCanvasPersist>();
const queuedCanvasPersists = new Map<string, QueuedCanvasPersist>();
const canvasSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const canvasPersistTokens = new Map<string, number>();
type CanvasGenerationPersistenceAttempt = {
    previousNodes?: CanvasNodeData[];
    nodes?: CanvasNodeData[];
    previousChatSessions?: CanvasAssistantSession[];
    chatSessions?: CanvasAssistantSession[];
};
const pendingCanvasGenerationAttempts = new Map<string, Map<string, CanvasGenerationPersistenceAttempt>>();

type AsyncCanvasStorageLock = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type CanvasStorageLockOptions = {
    requireCrossRealmLock?: boolean;
};

const CANVAS_STORAGE_LOCK_PREFIX = "infinite-canvas:canvas-generation-storage-lock:";
const canvasStorageTails = new Map<string, Promise<void>>();

function runWithBrowserCanvasStorageLock<T>(scope: string, operation: () => Promise<T>, options: CanvasStorageLockOptions) {
    const locks = typeof window !== "undefined" && typeof navigator !== "undefined" ? (navigator.locks as AsyncCanvasStorageLock | undefined) : undefined;
    const lockName = `${CANVAS_STORAGE_LOCK_PREFIX}${scope}`;
    if (locks) return locks.request(lockName, operation);
    if (options.requireCrossRealmLock && typeof window !== "undefined" && typeof document !== "undefined") {
        throw new Error("当前浏览器不支持跨标签存储锁，已停止画布生成持久化");
    }
    return operation();
}

/**
 * 串行化同一用户作用域的画布持久化，并在一次失败后允许队列继续前进。
 *
 * `pending` 必须把当前写入的真实结果返回给调用方；只有前一个 tail 的失败被
 * 转换成已处理的 void，才不会让一次旧失败永久毒化后续保存队列。
 */
export function withCanvasStorePersistenceLock<T>(scope: string, operation: () => Promise<T>, options: CanvasStorageLockOptions = {}): Promise<T> {
    const previous = canvasStorageTails.get(scope) ?? Promise.resolve();
    const pending = previous.then(() => undefined, () => undefined).then(() => runWithBrowserCanvasStorageLock(scope, operation, options));
    const tail = pending.then(
        () => undefined,
        () => undefined,
    );
    canvasStorageTails.set(scope, tail);
    void tail.finally(() => {
        if (canvasStorageTails.get(scope) === tail) canvasStorageTails.delete(scope);
    });
    return pending;
}

function clearCanvasSaveTimer(scope: string) {
    const timer = canvasSaveTimers.get(scope);
    if (!timer) return;
    clearTimeout(timer);
    canvasSaveTimers.delete(scope);
}

export function canvasStoreStorageRevision(scope: string) {
    return observedCanvasPersists.get(scope)?.revision ?? 0;
}

export function recordCanvasStorageDocument(scope: string, document: CanvasStorageDocument) {
    observedCanvasPersists.set(scope, {
        projects: document.state.projects,
        revision: document.storageRevision,
    });
}

export async function commitPendingCanvasStorePersistenceLocked(scope: string) {
    const storage = localForageStorageForScope(scope);
    let committed: CanvasStorageDocument | null = null;

    while (true) {
        const queued = queuedCanvasPersists.get(scope);
        if (!queued) return committed;

        const durable = parseCanvasStorageDocument(await storage.getItem(queued.name), queued.baseProjects);
        const rebased = rebaseCanvasProjects({
            document: durable,
            baseProjects: queued.baseProjects,
            localProjects: queued.state.projects,
            baseRevision: queued.baseRevision,
        }).document;
        await storage.setItem(queued.name, serializeCanvasStorageDocument(rebased));
        committed = rebased;
        recordCanvasStorageDocument(scope, rebased);

        const latest = queuedCanvasPersists.get(scope);
        if (!latest || latest.token === queued.token) {
            if (latest?.token === queued.token) queuedCanvasPersists.delete(scope);
            return committed;
        }

        latest.baseProjects = queued.state.projects;
        latest.baseRevision = rebased.storageRevision;
    }
}

async function writeQueuedCanvasPersist(scope: string, _token: number) {
    await withCanvasStorePersistenceLock(scope, () => commitPendingCanvasStorePersistenceLocked(scope));
}

export function pendingCanvasStorePersistence(scope: string) {
    const queued = queuedCanvasPersists.get(scope);
    return queued ? { projects: queued.state.projects, token: queued.token } : null;
}

export function rebasePendingCanvasStorePersistenceAfterGenerationCommitLocked(scope: string, committed: CanvasStorageDocument, committedEffectKey?: string) {
    const queued = queuedCanvasPersists.get(scope);
    if (!queued) return;
    const latestMemory = canvasMemoryStates.get(scope)?.projects ?? queued.state.projects;
    // Dedicated commit 已确认 generation stamp；用同 scope 最新内存重新投影队列，避免同节点普通编辑被旧 durable 快照替换。
    // `committedEffectKey` 是刚提交的那条副作用：内存里可能还停在提交前的快照（提交结果尚未送回 store），
    // 投影必须让这条副作用写过的节点以 committed 为准，否则会拼出「副作用已确认 + 内容为空」的节点。
    queued.baseProjects = committed.state.projects;
    queued.baseRevision = committed.storageRevision;
    queued.state = ordinaryCanvasPersistenceState(scope, { projects: latestMemory }, committed.state.projects, committedEffectKey);
}

export function withCanvasStorePersistenceSuppressed<T>(operation: () => T) {
    suppressCanvasStorePersistence += 1;
    try {
        return operation();
    } finally {
        suppressCanvasStorePersistence -= 1;
    }
}

export function registerCanvasGenerationPersistenceAttempt(scope: string, projectId: string, effectKey: string, attempt: CanvasGenerationPersistenceAttempt) {
    const projectKey = `${scope}\0${projectId}`;
    const attempts = pendingCanvasGenerationAttempts.get(projectKey) ?? new Map<string, CanvasGenerationPersistenceAttempt>();
    attempts.set(effectKey, attempt);
    pendingCanvasGenerationAttempts.set(projectKey, attempts);
    const queued = queuedCanvasPersists.get(scope);
    if (queued) {
        const latestMemory = canvasMemoryStates.get(scope)?.projects ?? queued.state.projects;
        const durableProjects = observedCanvasPersists.get(scope)?.projects ?? queued.baseProjects;
        queued.state = ordinaryCanvasPersistenceState(scope, { projects: latestMemory }, durableProjects);
    }
    return () => {
        if (attempts.get(effectKey) !== attempt) return;
        attempts.delete(effectKey);
        if (!attempts.size) pendingCanvasGenerationAttempts.delete(projectKey);
    };
}

function hasUnconfirmedGenerationKey(localKeys?: string[], durableKeys?: string[]) {
    return Boolean(localKeys?.some((key) => !durableKeys?.includes(key)));
}

function samePersistenceValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function rollbackGenerationValue(previous: unknown, attempted: unknown, live: unknown, durable: unknown): unknown {
    if (samePersistenceValue(previous, attempted)) return live;
    if (samePersistenceValue(live, attempted)) return durable;
    if (!previous || !attempted || !live || !durable || Array.isArray(previous) || Array.isArray(attempted) || Array.isArray(live) || Array.isArray(durable) || typeof previous !== "object" || typeof attempted !== "object" || typeof live !== "object" || typeof durable !== "object") return live;

    const previousRecord = previous as Record<string, unknown>;
    const attemptedRecord = attempted as Record<string, unknown>;
    const liveRecord = live as Record<string, unknown>;
    const durableRecord = durable as Record<string, unknown>;
    const result: Record<string, unknown> = { ...durableRecord };
    for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(attemptedRecord), ...Object.keys(liveRecord)])) {
        const previousHasKey = Object.hasOwn(previousRecord, key);
        const attemptedHasKey = Object.hasOwn(attemptedRecord, key);
        const liveHasKey = Object.hasOwn(liveRecord, key);
        if (!previousHasKey && !attemptedHasKey) {
            if (liveHasKey) result[key] = liveRecord[key];
            continue;
        }
        if (!previousHasKey && attemptedHasKey) {
            if (!liveHasKey || samePersistenceValue(liveRecord[key], attemptedRecord[key])) delete result[key];
            else result[key] = liveRecord[key];
            continue;
        }
        if (previousHasKey && !attemptedHasKey) {
            if (liveHasKey) result[key] = liveRecord[key];
            continue;
        }
        if (!liveHasKey) {
            delete result[key];
            continue;
        }
        const value = rollbackGenerationValue(previousRecord[key], attemptedRecord[key], liveRecord[key], durableRecord[key]);
        if (value === undefined) delete result[key];
        else result[key] = value;
    }
    return result;
}

function pendingGenerationAttempt(scope: string, projectId: string, effectKeys?: string[]) {
    const attempts = pendingCanvasGenerationAttempts.get(`${scope}\0${projectId}`);
    if (!attempts) return undefined;
    for (const effectKey of effectKeys || []) {
        const attempt = attempts.get(effectKey);
        if (attempt) return attempt;
    }
    return undefined;
}

function ordinaryCanvasProjectSnapshot(scope: string, project: CanvasProject, durableProject: CanvasProject | undefined, committedEffectKey?: string) {
    // 没有 durable 快照就没有可对账的对方版本：此时任何「本窗口有 stamp、对方没有」都不构成冲突，
    // 直接放行。（否则会给带 stamp 的节点走进回滚分支，在 durable 缺失时把节点整条丢掉。）
    if (!durableProject) return project;
    if (!hasGenerationEffectKeys(project) && !hasGenerationEffectKeys(durableProject)) return project;
    const durableNodes = new Map((durableProject?.nodes || []).map((node) => [node.id, node]));
    const durableSessions = new Map((durableProject?.chatSessions || []).map((session) => [session.id, session]));
    let changed = false;
    let hasUnconfirmedGeneration = false;
    const nodes: CanvasNodeData[] = [];
    for (const node of project.nodes) {
        const durableNode = durableNodes.get(node.id);
        const durableKeys = durableNode?.metadata?.generationEffectKeys;
        const localKeys = node.metadata?.generationEffectKeys;
        // 本条普通保存队列是在 generating commit 之前抓的快照：`durable` 里刚写回的节点才是权威版本。
        // 若让内存里的旧快照带着已确认的 effect stamp 落盘，就会造出「副作用已确认 + 内容为空」的节点 ——
        // 之后所有幂等守护都会把它当已应用而跳过修复，节点永久停在生成中（干活的证据见
        // canvas-generation-queue-projection 用例）。
        if (durableNode && committedEffectKey && generationEffectApplied(durableNode.metadata || {}, committedEffectKey)) {
            if (!samePersistenceValue(durableNode, node)) changed = true;
            nodes.push(durableNode);
            continue;
        }
        if (durableProject && hasUnconfirmedGenerationKey(localKeys, durableKeys)) {
            hasUnconfirmedGeneration = true;
            changed = true;
            if (durableNode) {
                const attempt = pendingGenerationAttempt(scope, project.id, localKeys);
                const previousNode = attempt?.previousNodes?.find((candidate) => candidate.id === node.id);
                const attemptedNode = attempt?.nodes?.find((candidate) => candidate.id === node.id);
                // durableNode comes from the observed storage snapshot. Never mutate that snapshot while
                // rebuilding a failed generation, otherwise a later retry observes a partially rolled-back base.
                const rolledBack = previousNode && attemptedNode
                    ? (rollbackGenerationValue(previousNode, attemptedNode, node, durableNode) as CanvasNodeData)
                    : { ...durableNode, metadata: durableNode.metadata ? { ...durableNode.metadata } : undefined };
                const metadata = { ...(rolledBack.metadata || {}) };
                if (durableKeys?.length) metadata.generationEffectKeys = [...durableKeys];
                else delete metadata.generationEffectKeys;
                nodes.push({ ...rolledBack, metadata });
            }
            continue;
        }
        if (sameGenerationEffectKeys(localKeys, durableKeys)) {
            nodes.push(node);
            continue;
        }
        changed = true;
        const metadata = { ...(node.metadata || {}) };
        if (durableKeys?.length) metadata.generationEffectKeys = [...durableKeys];
        else delete metadata.generationEffectKeys;
        nodes.push({ ...node, metadata });
    }
    const chatSessions: CanvasAssistantSession[] = [];
    for (const session of project.chatSessions) {
        const durableSession = durableSessions.get(session.id);
        const durableKeys = durableSession?.generationEffectKeys;
        // 与节点同理：本条提交刚写过的会话以 committed 为准，不能让旧快照带着 stamp 回去。
        if (durableSession && committedEffectKey && generationEffectApplied(durableSession, committedEffectKey)) {
            if (!samePersistenceValue(durableSession, session)) changed = true;
            chatSessions.push(durableSession);
            continue;
        }
        if (durableProject && hasUnconfirmedGenerationKey(session.generationEffectKeys, durableKeys)) {
            hasUnconfirmedGeneration = true;
            changed = true;
            if (durableSession) {
                const attempt = pendingGenerationAttempt(scope, project.id, session.generationEffectKeys);
                const previousSession = attempt?.previousChatSessions?.find((candidate) => candidate.id === session.id);
                const attemptedSession = attempt?.chatSessions?.find((candidate) => candidate.id === session.id);
                const rolledBack = previousSession && attemptedSession
                    ? (rollbackGenerationValue(previousSession, attemptedSession, session, durableSession) as CanvasAssistantSession)
                    : { ...durableSession, generationEffectKeys: durableSession.generationEffectKeys ? [...durableSession.generationEffectKeys] : undefined };
                if (durableKeys?.length) rolledBack.generationEffectKeys = [...durableKeys];
                else delete rolledBack.generationEffectKeys;
                chatSessions.push(rolledBack);
            }
            continue;
        }
        if (sameGenerationEffectKeys(session.generationEffectKeys, durableKeys)) {
            chatSessions.push(session);
            continue;
        }
        changed = true;
        const nextSession = { ...session };
        if (durableKeys?.length) nextSession.generationEffectKeys = [...durableKeys];
        else delete nextSession.generationEffectKeys;
        chatSessions.push(nextSession);
    }
    if (durableProject && hasUnconfirmedGeneration) {
        return {
            ...project,
            nodes,
            // Connection/active-chat records carry no effect stamp provenance, so keep them fail-closed while any generation entity is unconfirmed.
            connections: durableProject.connections,
            chatSessions,
            activeChatId: durableProject.activeChatId,
        };
    }
    return changed ? { ...project, nodes, chatSessions } : project;
}

function hasGenerationEffectKeys(value: CanvasProject | undefined) {
    if (!value) return false;
    return (value.nodes || []).some((node) => Boolean(node.metadata?.generationEffectKeys?.length))
        || (value.chatSessions || []).some((session) => Boolean(session.generationEffectKeys?.length));
}

function sameGenerationEffectKeys(left?: readonly string[], right?: readonly string[]) {
    if (left === right) return true;
    if (!left?.length && !right?.length) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function ordinaryCanvasPersistenceState(scope: string, state: PersistedCanvasState, durableProjects: CanvasProject[], committedEffectKey?: string) {
    return { projects: projectOrdinaryCanvasProjects(scope, state.projects, durableProjects, committedEffectKey) };
}

/**
 * 把内存快照投影成「相对 durable 可以安全当作普通保存提交」的状态。
 * `committedEffectKey` 用于生成副作用专用提交：那条副作用刚写过的节点/会话必须以 durable 为准。
 */
export function projectOrdinaryCanvasProjects(scope: string, projects: CanvasProject[], durableProjects: CanvasProject[], committedEffectKey?: string) {
    const durableById = new Map(durableProjects.map((project) => [project.id, project]));
    return projects.map((project) => ordinaryCanvasProjectSnapshot(scope, project, durableById.get(project.id), committedEffectKey));
}

export function reconcileCanvasGenerationFailure(scope: string, durableProjects: CanvasProject[]) {
    if (getActiveUserScope() !== scope) return;
    const projects = ordinaryCanvasPersistenceState(scope, { projects: useCanvasStore.getState().projects }, durableProjects).projects;
    withCanvasStorePersistenceSuppressed(() => {
        useCanvasStore.setState({ projects });
    });
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const scope = getActiveUserScope();
        const value = await localForageStorageForScope(scope).getItem(name);
        if (!value) {
            canvasMemoryStates.set(scope, { projects: [] });
            observedCanvasPersists.set(scope, { projects: [], revision: 0 });
            return null;
        }
        const document = parseCanvasStorageDocument(value);
        const state = document.state as PersistedCanvasState;
        canvasMemoryStates.set(scope, state);
        recordCanvasStorageDocument(scope, document);
        return document as unknown as StorageValue<CanvasStore>;
    },
    setItem: (name, value) => {
        const scope = getActiveUserScope();
        const nextState = value.state as PersistedCanvasState;
        if (canvasMemoryStates.get(scope)?.projects === nextState.projects) return;
        canvasMemoryStates.set(scope, nextState);
        if (suppressCanvasStorePersistence) return;

        const queued = queuedCanvasPersists.get(scope);
        const observed = observedCanvasPersists.get(scope);
        const token = (canvasPersistTokens.get(scope) || 0) + 1;
        canvasPersistTokens.set(scope, token);
        const baseProjects = queued?.baseProjects ?? observed?.projects ?? [];
        queuedCanvasPersists.set(scope, {
            name,
            scope,
            baseProjects,
            baseRevision: queued?.baseRevision ?? observed?.revision ?? 0,
            // generationEffectKeys 由专用 generation durable commit 管理；普通队列只能携带已确认 stamp。
            state: ordinaryCanvasPersistenceState(scope, nextState, observed?.projects ?? baseProjects),
            token,
        });
        clearCanvasSaveTimer(scope);
        const timer = setTimeout(() => {
            if (canvasSaveTimers.get(scope) === timer) canvasSaveTimers.delete(scope);
            void writeQueuedCanvasPersist(scope, token).catch((error) => {
                // 自动保存无法把异常返回给原始状态更新调用方，但失败队列仍会保留给下一次写入或显式 flush 重试。
                console.error("画布本地持久化失败，已保留待写队列", { scope, error });
            });
        }, 400);
        canvasSaveTimers.set(scope, timer);
    },
    removeItem: (name) => {
        const scope = getActiveUserScope();
        return localForageStorageForScope(scope).removeItem(name);
    },
};

export async function flushCanvasStorePersistence() {
    while (canvasStorageTails.size || queuedCanvasPersists.size || canvasSaveTimers.size) {
        for (const scope of [...canvasSaveTimers.keys()]) clearCanvasSaveTimer(scope);
        const writes = [...queuedCanvasPersists.values()].map(({ scope, token }) => writeQueuedCanvasPersist(scope, token));
        if (writes.length) await Promise.all(writes);
        else if (canvasStorageTails.size) await Promise.all([...canvasStorageTails.values()]);
    }
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            folders: [],
            createProject: (title = "未命名画布", projectId, workspaceProjectId) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const appearanceDefault = readCanvasAppearanceDefault();
                const project: CanvasProject = {
                    id,
                    revision: 0,
                    workspaceProjectId: workspaceProjectId || id,
                    projectId,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    appearance: appearanceDefault?.appearance ?? { mode: useThemeStore.getState().theme },
                    backgroundMode: appearanceDefault?.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                    showImageInfo: false,
                    viewport: initialViewport,
                    directorScenes: [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            createFolder: (name = "未命名文件夹") => {
                const now = new Date().toISOString();
                const folder = { id: nanoid(), name: name.trim() || "未命名文件夹", createdAt: now, updatedAt: now };
                set((state) => {
                    const folders = [folder, ...state.folders];
                    writeCanvasFolders(folders);
                    return { folders };
                });
                return folder.id;
            },
            renameFolder: (id, name) => set((state) => {
                const nextName = name.trim();
                if (!nextName) return state;
                const folders = state.folders.map((folder) => folder.id === id ? { ...folder, name: nextName, updatedAt: new Date().toISOString() } : folder);
                writeCanvasFolders(folders);
                return { folders };
            }),
            deleteFolder: (id) => set((state) => {
                const folders = state.folders.filter((folder) => folder.id !== id);
                const projects = state.projects.map((project) => project.folderId === id ? { ...project, folderId: undefined, updatedAt: new Date().toISOString() } : project);
                writeCanvasFolders(folders);
                return { folders, projects };
            }),
            setFolderCover: (id, coverDataUrl) => set((state) => {
                const folders = state.folders.map((folder) => folder.id === id ? { ...folder, coverDataUrl, updatedAt: new Date().toISOString() } : folder);
                writeCanvasFolders(folders);
                return { folders };
            }),
            moveProjectsToFolder: (ids, folderId) => set((state) => ({ projects: state.projects.map((project) => ids.includes(project.id) ? { ...project, folderId, updatedAt: new Date().toISOString() } : project) })),
            importProject: (source, workspaceProjectId) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    revision: 0,
                    workspaceProjectId: undefined,
                    projectId: source.projectId,
                    folderId: source.folderId,
                    title: source.title || "导入画布",
                    canvasTitle: source.canvasTitle,
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: cloneCanvasValue(source.nodes || []),
                    connections: cloneCanvasValue(source.connections || []),
                    chatSessions: cloneCanvasValue(source.chatSessions || []),
                    activeChatId: source.activeChatId || null,
                    starterMode: source.starterMode,
                    appearance: source.appearance ? normalizeCanvasAppearance(source.appearance, "dark") : undefined,
                    backgroundMode: source.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                    showImageInfo: source.showImageInfo || false,
                    viewport: cloneCanvasValue(source.viewport || initialViewport),
                    directorScenes: cloneCanvasValue(source.directorScenes || []),
                    timeline: source.timeline ? cloneCanvasValue(source.timeline) : undefined,
                };
                project.workspaceProjectId = workspaceProjectId || project.id;
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => set((state) => {
                const current = state.projects.find((project) => project.id === id);
                const nextTitle = title.trim() || current?.title;
                if (!current || current.title === nextTitle) return state;
                return { projects: state.projects.map((project) => project === current ? { ...project, title: nextTitle!, updatedAt: new Date().toISOString() } : project) };
            }),
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            restoreProject: (project) => set((state) => {
                if (state.projects.some((item) => item.id === project.id)) return state;
                return { projects: [project, ...state.projects] };
            }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) => set((state) => {
                const current = state.projects.find((project) => project.id === id);
                if (!current) return state;
                const next = { ...current, ...patch };
                const contentChanged = !sameCanvasContent(current, next);
                if (!contentChanged && samePersistenceValue(current.viewport, next.viewport)) return state;
                if (contentChanged) next.updatedAt = new Date().toISOString();
                return { projects: state.projects.map((project) => project === current ? next : project) };
            }),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ folders: readCanvasFolders(), hydrated: true });
            },
        },
    ),
);
