import { buildLibTVVideoPreviewUrl } from "@/lib/canvas/libtv-import";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * Returns an image source that is safe to mount for a passive video preview.
 * The original video URL is deliberately never returned: callers must fall
 * back to a video icon instead of creating a decoder outside the active node.
 */
export function canvasNodeVideoPreviewUrl(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Video) return "";
    const content = node.metadata?.content || "";
    const generatedPreview = node.metadata?.videoPreview?.content || "";
    if (generatedPreview && generatedPreview !== content) return generatedPreview;
    const explicitPreview = node.metadata?.previewContent || "";
    if (explicitPreview && explicitPreview !== content) return explicitPreview;
    return buildLibTVVideoPreviewUrl(content);
}

/**
 * 是否存在首帧记录 —— 即便 `content` 已被清空、只剩本地 storageKey 也算：
 * 本地工作区模式不再把 `blob:` 会话地址持久化进元数据（刷新/换端口必然失效），
 * 渲染时要靠 storageKey 现算可用地址，所以这里不能只看 content。
 */
export function canvasNodeHasVideoPreview(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Video) return false;
    return Boolean(node.metadata?.videoPreview?.storageKey || node.metadata?.previewContent?.trim());
}

export function canvasVideoAssetPreviewUrl(videoUrl: string, coverUrl?: string) {
    const explicitCover = coverUrl?.trim() || "";
    if (explicitCover && explicitCover !== videoUrl) return explicitCover;
    return buildLibTVVideoPreviewUrl(videoUrl);
}
