import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { isVolcengineArkVideoProtocol } from "@/lib/model-protocols";
import { boolConfig, buildSeedancePromptText, isArkPlanBaseUrl, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution } from "@/lib/seedance-video";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { buildApiUrl, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

import { assertVideoCapability, isPublicMediaUrl } from "./video-validation";
import type { ApiEnvelope, RequestOptions, ResolvedAiConfig, SeedanceTask, VideoGenerationTask, VideoGenerationTaskState } from "./video-contracts";
import type { VideoProviderDeps } from "./video-provider-deps";
import { hasExplicitVideoFrames, resolveVideoImageReferences } from "./video-reference-roles";

export function isSeedanceConfig(config: ResolvedAiConfig) {
    return isVolcengineArkVideoProtocol(config.interfaceType) || isSeedanceVideoConfig(config);
}

export async function createSeedanceTask(deps: VideoProviderDeps, config: ResolvedAiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const profile = modelCapabilityConfigFor(config, model).video;
    if (profile) assertVideoCapability(profile, references, videoReferences, audioReferences, String(config.videoSeconds || "5"));
    const isVolcengineArk = isVolcengineArkVideoProtocol(config.interfaceType);
    const payload = isVolcengineArk || isArkPlanBaseUrl(config.baseUrl)
        ? await buildSeedanceAgentPlanPayload(config, model, prompt, references, videoReferences, audioReferences, deps, options)
        : await buildSeedanceVideosPayload(config, model, prompt, references, videoReferences, audioReferences, deps, options);

    try {
        const raw = await deps.transport.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, options);
        const created = deps.response.unwrapSeedanceTask(raw);
        const id = created.id || created.task_id;
        if (!id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id, provider: "seedance", model };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "Seedance 任务创建失败"));
    }
}

export async function pollSeedanceTask(deps: VideoProviderDeps, config: ResolvedAiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const raw = await deps.transport.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), options);
        const state = deps.response.unwrapSeedanceTask(raw);
        if (state.status === "succeeded" || state.status === "completed") {
            const url = state.video_url || state.content?.video_url;
            if (url) return { status: "completed", result: await deps.response.videoResultFromUrl(url, options) };
            if (isArkPlanBaseUrl(config.baseUrl)) return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
            const content = await deps.transport.getBlob(deps.transport.apiUrl(`/videos/${task.id}/content`), options);
            await deps.response.assertVideoBlob(content);
            return { status: "completed", result: { blob: content } };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: seedanceErrorMessage(state) || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        return { status: "pending" };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function seedanceApiUrl(config: ResolvedAiConfig, taskId?: string) {
    const suffix = taskId ? `/${encodeURIComponent(taskId)}` : "";
    // 中转网关把厂商原生路径统一挂到 /v1 下（官方 Ark 是 /api/v3）。
    if (config.interfaceType === "ark-task-gateway-video") return buildApiUrl(config.baseUrl, `/v1/contents/generations/tasks${suffix}`);
    if (isVolcengineArkVideoProtocol(config.interfaceType) || isArkPlanBaseUrl(config.baseUrl)) return buildApiUrl(config.baseUrl, `/contents/generations/tasks${suffix}`);
    return buildApiUrl(config.baseUrl, `/videos${suffix}`);
}

async function buildSeedanceAgentPlanPayload(config: ResolvedAiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], deps: VideoProviderDeps, options?: RequestOptions) {
    const profile = modelCapabilityConfigFor(config, model).video!;
    if (audioReferences.length && !references.length && !videoReferences.length && !profile.operations.includes("audio_to_video")) {
        throw new Error("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频");
    }
    const content = isVolcengineArkVideoProtocol(config.interfaceType)
        ? await buildVolcengineArkContent(prompt, references, videoReferences, audioReferences, deps, options)
        : await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences, deps, options);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    return {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        ...(profile.generateAudio.supported ? { generate_audio: boolConfig(config.videoGenerateAudio, profile.generateAudio.default) } : {}),
        ...(profile.watermark.supported ? { watermark: boolConfig(config.videoWatermark, profile.watermark.default) } : {}),
    };
}

async function buildVolcengineArkContent(prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], deps: VideoProviderDeps, options?: RequestOptions) {
    const content: Array<Record<string, unknown>> = [];
    const imagePlan = resolveVideoImageReferences(references, options, { videoCount: videoReferences.length, audioCount: audioReferences.length });
    if (prompt.trim()) content.push({ type: "text", text: prompt.trim() });
    for (const { image, role } of imagePlan) {
        content.push({ type: "image_url", image_url: { url: image.arkAssetId ? `asset://${image.arkAssetId}` : await resolveSeedanceImageUrl(image) }, role });
    }
    for (const video of videoReferences) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideosMediaUrl(video, deps) }, role: "reference_video" });
    }
    for (const audio of audioReferences) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceVideosMediaUrl(audio, deps, "audio") }, role: "reference_audio" });
    }
    return content;
}

async function buildSeedanceVideosPayload(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], deps: VideoProviderDeps, options?: RequestOptions) {
    const profile = modelCapabilityConfigFor(config, model).video!;
    if (!references.length && !videoReferences.length && audioReferences.length && !profile.operations.includes("audio_to_video")) {
        throw new Error("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频");
    }
    const imageUrls = await Promise.all(references.map(resolveSeedanceVideosImageUrl));
    const imagePlan = resolveVideoImageReferences(references, options, { videoCount: videoReferences.length, audioCount: audioReferences.length });
    const videoUrls = await Promise.all(videoReferences.map((media) => resolveSeedanceVideosMediaUrl(media, deps)));
    const audioUrls = await Promise.all(audioReferences.map((media) => resolveSeedanceVideosMediaUrl(media, deps, "audio")));
    const ratio = normalizeSeedanceRatio(config.size);
    const duration = normalizeSeedanceDuration(config.videoSeconds);
    const imagePayload: Record<string, unknown> = {};
    if (options?.videoEditOperation === "reference_to_video") {
        if (imageUrls.length) imagePayload.reference_image_urls = imageUrls;
    } else if (hasExplicitVideoFrames(options)) {
        imagePayload.image_urls = orderedImageUrls(imageUrls, imagePlan.map(({ role }) => role));
    } else if (imageUrls.length) {
        imagePayload.image_url = imageUrls[0];
        if (imageUrls.length > 1) imagePayload.reference_image_urls = imageUrls.slice(1);
    }
    return {
        model: modelOptionName(model),
        prompt: prompt.trim(),
        aspect_ratio: ratio === "adaptive" ? "16:9" : ratio,
        duration,
        ...(profile.generateAudio.supported ? { generate_audio: boolConfig(config.videoGenerateAudio, profile.generateAudio.default) } : {}),
        ...imagePayload,
        ...(videoUrls.length ? { reference_videos: videoUrls } : {}),
        ...(audioUrls.length ? { reference_audios: audioUrls } : {}),
    };
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], deps: VideoProviderDeps, options?: RequestOptions) {
    const content: Array<Record<string, unknown>> = [];
    const imagePlan = resolveVideoImageReferences(references, options, { videoCount: videoReferences.length, audioCount: audioReferences.length });
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const { image, role } of imagePlan) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(image) }, role });
    }
    for (const video of videoReferences) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceMediaUrl(video, deps, "参考视频") }, role: "reference_video" });
    }
    for (const audio of audioReferences) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceMediaUrl(audio, deps, "参考音频") }, role: "reference_audio" });
    }
    return content;
}

function orderedImageUrls(imageUrls: string[], roles: Array<"first_frame" | "last_frame" | "reference_image">) {
    return ["first_frame", "last_frame", "reference_image"].flatMap((role) => imageUrls.filter((_, index) => roles[index] === role));
}

async function resolveSeedanceImageUrl(image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideosImageUrl(image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("data:")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceMediaUrl(media: ReferenceVideo | ReferenceAudio, deps: VideoProviderDeps, label: string) {
    if (isPublicMediaUrl(media.url) || media.url.startsWith("asset://")) return media.url;
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && media.url?.startsWith("blob:")) blob = await (await fetch(media.url)).blob();
    if (!blob) throw new Error(`${label}必须是公网 URL、素材 ID，或本地已保存素材`);
    return deps.response.blobToDataUrl(blob);
}

async function resolveSeedanceVideosMediaUrl(media: ReferenceVideo | ReferenceAudio, deps: VideoProviderDeps, kind?: "video" | "audio") {
    if (isPublicMediaUrl(media.url) || media.url?.startsWith("data:") || media.url?.startsWith("asset://")) return media.url;
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && media.url?.startsWith("blob:")) blob = await (await fetch(media.url)).blob();
    if (!blob) throw new Error(kind === "audio" ? "参考音频需要公网 URL、素材 ID，或本地已保存素材" : "Seedance /videos 参考素材必须是公网 URL、data URL，或本地已保存素材");
    return deps.response.blobToDataUrl(blob);
}

function seedanceErrorMessage(state: SeedanceTask) {
    if (state.error?.message && state.error.code) return `${state.error.code}：${state.error.message}`;
    return state.error?.message || state.error_code || "";
}
