import { captureVideoPoster } from "@/lib/video-poster";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type VideoPreview = NonNullable<CanvasNodeMetadata["videoPreview"]>;

export const CANVAS_VIDEO_PREVIEW_VERSION = 2;

const previewRequests = new Map<string, Promise<VideoPreview | null>>();

export function hydrateCanvasVideoPreview(node: CanvasNodeData, signal?: AbortSignal) {
    const sourceKey = node.metadata?.storageKey || node.metadata?.content || "";
    if (!sourceKey) return Promise.resolve(null);
    const requestKey = `${node.id}:${sourceKey}`;
    const existing = previewRequests.get(requestKey);
    if (existing) return existing;

    const request = generateCanvasVideoPreview(node, signal)
        .then((preview) => {
            if (!preview) previewRequests.delete(requestKey);
            return preview;
        })
        .catch((error: unknown) => {
            previewRequests.delete(requestKey);
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            return null;
        });
    previewRequests.set(requestKey, request);
    return request;
}

export function canvasVideoPreviewNeedsHydration(node: CanvasNodeData) {
    const sourceKey = canvasVideoPreviewSourceKey(node);
    if (!sourceKey) return false;
    const preview = node.metadata?.videoPreview;
    // 完全没有首帧记录。
    if (!preview?.content && !preview?.storageKey) return true;
    if (preview.captureVersion !== CANVAS_VIDEO_PREVIEW_VERSION || preview.sourceKey !== sourceKey) return true;
    // `content` 若是 blob:/会话态地址，说明这份首帧跨会话已失效（刷新、换端口、清缓存后取不到）
    // → 必须重新水合，否则节点会永远停在「首帧暂不可用」。
    if (isSessionBoundPreviewUrl(preview.content)) return true;
    // content 是可用地址（http / /api/resources/...）：直接用，不重抓（含旧数据里没有 storageKey 的情况）。
    if (preview.content) return false;
    // 只剩本地键、没有可用地址时才做一次廉价校验：能解析就直接复用，解析不到才重新抓帧。
    return isLocalPreviewStorageKey(preview.storageKey);
}

/** 会话态地址：blob:（同源同会话才有效），不该作为首帧的长期缓存依据。 */
export function isSessionBoundPreviewUrl(url: string | undefined) {
    return String(url || "").trim().toLowerCase().startsWith("blob:");
}

/** 本地缓存键（非资源键），如 `image:<uid>:<nanoid>`。 */
export function isLocalPreviewStorageKey(storageKey: string | undefined) {
    const value = String(storageKey || "").trim();
    return Boolean(value) && !value.startsWith("resource:");
}

async function generateCanvasVideoPreview(node: CanvasNodeData, signal?: AbortSignal): Promise<VideoPreview | null> {
    await waitForBrowserIdle(signal);
    throwIfAborted(signal);
    // 先校验已有首帧是否还能取到：能取到就复用（避免每次进视口都重新抓帧），
    // 取不到才重新抓取 —— 这样「刷新/换端口导致本地缓存失效」可以自愈。
    const existing = await reusableCanvasVideoPreview(node);
    throwIfAborted(signal);
    if (existing) return existing;

    const source = await resolveMediaUrl(node.metadata?.storageKey, node.metadata?.content || "");
    if (!source) return null;
    const captured = await captureVideoPoster(source, { signal, maxWidth: 400 });
    throwIfAborted(signal);
    if (!captured.poster) return null;
    const preview = await uploadImage(captured.poster);
    throwIfAborted(signal);
    return {
        // 本地工作区模式下 uploadImage 返回的是 `blob:` 会话地址：它会被写进节点元数据并同步到后端，
        // 而 blob 只在**同源同会话**有效 → 刷新/换端口后必然失效。因此这里不持久化 blob 地址，
        // 只留 storageKey（渲染时由 CachedResourceImage 现算可用地址）。
        content: isSessionBoundPreviewUrl(preview.url) ? "" : preview.url,
        storageKey: preview.storageKey,
        width: preview.width,
        height: preview.height,
        bytes: preview.bytes,
        mimeType: preview.mimeType,
        captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
        sourceKey: canvasVideoPreviewSourceKey(node),
        capturedAtMs: captured.capturedAtMs,
    };
}

/** 已有首帧仍然可用时原样复用（同时把其中的会话态地址清掉）。 */
async function reusableCanvasVideoPreview(node: CanvasNodeData): Promise<VideoPreview | null> {
    const preview = node.metadata?.videoPreview;
    if (!preview?.storageKey) return null;
    if (preview.captureVersion !== CANVAS_VIDEO_PREVIEW_VERSION) return null;
    if (preview.sourceKey !== canvasVideoPreviewSourceKey(node)) return null;
    const resolved = await resolveImageUrl(preview.storageKey).catch(() => "");
    if (!resolved) return null;
    return isSessionBoundPreviewUrl(preview.content) ? { ...preview, content: "" } : preview;
}

function canvasVideoPreviewSourceKey(node: CanvasNodeData) {
    return node.metadata?.storageKey || node.metadata?.content || "";
}

function waitForBrowserIdle(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        let idleId: number | undefined;
        let timerId: ReturnType<typeof globalThis.setTimeout> | undefined;
        const idleWindow = window as unknown as {
            requestIdleCallback?: Window["requestIdleCallback"];
            cancelIdleCallback?: Window["cancelIdleCallback"];
        };
        const cleanup = () => {
            signal?.removeEventListener("abort", handleAbort);
            if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
            if (timerId !== undefined) globalThis.clearTimeout(timerId);
        };
        const finish = () => {
            cleanup();
            resolve();
        };
        const handleAbort = () => {
            cleanup();
            reject(abortError());
        };
        signal?.addEventListener("abort", handleAbort, { once: true });
        if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(finish, { timeout: 1_000 });
        else timerId = globalThis.setTimeout(finish, 250);
    });
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
}

function abortError() {
    return new DOMException("Canvas video preview hydration aborted", "AbortError");
}
