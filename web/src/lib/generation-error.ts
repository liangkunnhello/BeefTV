import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import { moderationErrorCopy, persistedModerationCopy } from "./moderation-error";

export const CONTENT_MODERATION_ERROR_CODE = "sensitive_words_detected";

export const GENERATION_ERROR_CATEGORIES = [
    "auth",
    "permission",
    "quota_user",
    "quota_upstream",
    "quota_unknown",
    "quota_limit",
    "moderation_input",
    "moderation_reference",
    "moderation_output",
    "invalid_params",
    "context_too_long",
    "input_inaccessible",
    "input_too_large",
    "model_missing",
    "throttled",
    "concurrency",
    "provider_unavailable",
    "network",
    "timeout",
    "submission_uncertain",
    "async_failed",
    "cancelled",
    "partial_success",
    "download_failed",
    "results_missing",
    "malformed_response",
    "unknown",
] as const;

export type GenerationErrorCategory = (typeof GENERATION_ERROR_CATEGORIES)[number];

export type GenerationFailureExplanation = {
    category: GenerationErrorCategory;
    reason: string;
    action: string;
    message: string;
    errorCode: string;
    providerCode?: string;
    requestId?: string;
    taskId?: string;
    retryable: boolean;
    uncertain: boolean;
    blockAutomaticRetry: boolean;
    moderation: boolean;
};

export type GenerationFailureMetadata = {
    errorDetails: string;
    generationErrorCode?: string;
    failedPromptFingerprint?: string;
    failedInputFingerprint?: string;
};

export type GenerationFailureContext = {
    taskId?: string;
    providerRequestId?: string;
    model?: string;
    createdAt?: string;
    stage?: string;
};

type CategoryCopy = { reason: string; action: string };

const CATEGORY_COPY: Record<GenerationErrorCategory, CategoryCopy> = {
    auth: { reason: "模型服务鉴权失败", action: "请检查 API Key 后重试" },
    permission: { reason: "当前渠道没有使用该模型的权限", action: "请更换模型或检查渠道权限" },
    quota_user: { reason: "当前账号额度不足", action: "请检查账号余额或联系管理员调整额度后重试" },
    quota_upstream: { reason: "模型供应商拒绝了计费或额度相关请求", action: "请到供应商核对账单与额度后，再决定是否重试" },
    quota_unknown: { reason: "模型服务拒绝了计费或额度相关请求", action: "请到当前渠道或模型供应商核对账单与额度后，再决定是否重试" },
    quota_limit: { reason: "模型调用已达到设置的用量上限", action: "请检查当前渠道的用量或预算限制，调整后再试" },
    moderation_input: { reason: "提示词或参考素材未通过内容安全审核", action: "请调整提示词或参考素材后重新生成" },
    moderation_reference: { reason: "参考素材未通过内容安全审核", action: "请检查并更换参考素材后重新生成" },
    moderation_output: { reason: "生成结果未通过内容安全审核", action: "请调整提示词或参考素材后重新生成" },
    invalid_params: { reason: "模型不接受当前参数", action: "请检查模型、尺寸、时长、格式或数量后重试" },
    context_too_long: { reason: "输入内容超出模型长度限制", action: "请缩短提示词或减少参考内容后重试" },
    input_inaccessible: { reason: "参考素材无法读取", action: "请检查素材后重试" },
    input_too_large: { reason: "参考素材过大", action: "请压缩或更换素材后重试" },
    model_missing: { reason: "当前模型或接口不可用", action: "请检查模型名称和渠道配置" },
    throttled: { reason: "请求过于频繁", action: "请稍后再试" },
    concurrency: { reason: "同时进行的生成过多", action: "请等待已有任务完成后再试" },
    provider_unavailable: { reason: "模型服务暂时不可用", action: "请稍后重试" },
    network: { reason: "网络连接失败", action: "请检查网络并核对原任务状态后，再决定是否重新生成" },
    timeout: { reason: "模型服务响应超时", action: "请稍后查询原任务，不要立即重新提交" },
    submission_uncertain: { reason: "提交结果尚未确认，上游任务可能仍在执行", action: "请先查询原任务状态，不要立即重新提交" },
    async_failed: { reason: "生成任务没有完成", action: "请查看详情后决定是否重试" },
    cancelled: { reason: "任务已取消", action: "可按原输入重新提交" },
    partial_success: { reason: "部分结果已生成，其余失败", action: "请查看已有结果后再决定是否补做" },
    download_failed: { reason: "生成结果下载失败", action: "请稍后重新加载，不要立即重新提交" },
    results_missing: { reason: "任务结束但没有可用结果", action: "请查看详情后再决定是否重试" },
    malformed_response: { reason: "模型服务返回了无法解析的内容", action: "请查看详情并核对原任务状态后，再决定是否重新生成" },
    unknown: { reason: "生成失败", action: "请查看详情后再决定是否重试" },
};

const PROVIDER_CODE_CATEGORIES: Record<string, GenerationErrorCategory> = {
    accountoverdueerror: "quota_upstream",
    "operationdenied.serviceoverdue": "quota_upstream",
    setlimitexceeded: "quota_limit",
    inflightbatchsizeexceeded: "concurrency",
    modelnotopen: "permission",
    // 中转网关 ai-claude-code-hub 实测码：账号未开通该模型（不是模型名写错）。
    model_not_allowed: "permission",
    "operationdenied.servicenotopen": "permission",
    contentsecuritydetectionerror: "provider_unavailable",
    invalid_reference_audio: "invalid_params",
    insufficient_user_quota: "quota_user",
    no_available_channel: "provider_unavailable",
    "channel:invalid_key": "provider_unavailable",
    "channel:no_available_key": "provider_unavailable",
    "channel:param_override_invalid": "unknown",
    "channel:header_override_invalid": "unknown",
    "channel:model_mapped_error": "unknown",
    "channel:aws_client_error": "provider_unavailable",
    "channel:response_time_exceeded": "timeout",
    "violation_fee.grok.csam": "moderation_input",
    prompt_blocked: "moderation_input",
    context_media_limit_exceeded: "context_too_long",
    media_request_capacity_exceeded: "concurrency",
    key_site_mismatch: "auth",
    bad_request_body: "invalid_params",
    invalid_api_type: "unknown",
    responses_encrypted_context_mismatch: "invalid_params",
    count_token_failed: "unknown",
    model_price_error: "unknown",
    json_marshal_failed: "unknown",
    do_request_failed: "submission_uncertain",
    get_channel_failed: "provider_unavailable",
    gen_relay_info_failed: "unknown",
    read_request_body_failed: "unknown",
    convert_request_failed: "unknown",
    read_response_body_failed: "submission_uncertain",
    bad_response_status_code: "unknown",
    bad_response: "malformed_response",
    bad_response_body: "malformed_response",
    empty_response: "results_missing",
    aws_invoke_error: "unknown",
    query_data_error: "unknown",
    update_data_error: "unknown",
    pre_consume_token_quota_failed: "unknown",
    upstream_crowded: "throttled",
    upstream_unavailable: "provider_unavailable",
    upstream_rejected: "unknown",
    upstream_error: "unknown",
    invalid_api_key: "auth",
    invalid_authentication: "auth",
    authentication_error: "auth",
    unauthenticated: "auth",
    unauthorized: "auth",
    permission_denied: "permission",
    forbidden: "permission",
    access_denied: "permission",
    insufficient_quota: "quota_unknown",
    insufficient_balance: "quota_unknown",
    billing_not_active: "quota_unknown",
    billing_hard_limit_reached: "quota_upstream",
    arrearage: "quota_upstream",
    allocationquota: "quota_unknown",
    quota_exceeded: "quota_unknown",
    sensitive_words_detected: "moderation_input",
    content_filter: "moderation_input",
    content_policy_violation: "moderation_input",
    content_policy: "moderation_input",
    datainspectionfailed: "moderation_input",
    prohibited_content: "moderation_input",
    invalid_request: "invalid_params",
    invalid_request_error: "invalid_params",
    invalid_parameter: "invalid_params",
    invalidparameter: "invalid_params",
    invalid_argument: "invalid_params",
    requestparameteriswrong: "invalid_params",
    model_capability_not_supported: "invalid_params",
    context_length_exceeded: "context_too_long",
    contentlengthexceeded: "context_too_long",
    url_error: "input_inaccessible",
    invalid_image_url: "input_inaccessible",
    file_too_large: "input_too_large",
    payload_too_large: "input_too_large",
    video_request_body_too_large: "input_too_large",
    model_not_found: "model_missing",
    model_not_exist: "model_missing",
    invalid_model: "model_missing",
    not_found: "model_missing",
    rate_limit_exceeded: "throttled",
    rate_limit_error: "throttled",
    throttling: "throttled",
    too_many_requests: "throttled",
    resource_exhausted: "throttled",
    channel_concurrency_wait_timeout: "concurrency",
    channel_concurrency_unavailable: "concurrency",
    unavailable: "provider_unavailable",
    overloaded: "provider_unavailable",
    internal_error: "provider_unavailable",
    upstream_timeout: "timeout",
    deadline_exceeded: "timeout",
    request_cancelled: "cancelled",
    provider_submission_unknown: "submission_uncertain",
    video_submission_unknown: "submission_uncertain",
    provider_reference_invalid: "input_inaccessible",
};

const DEFAULT_GENERATION_ERROR_MESSAGE = "生成失败。请查看详情后再决定是否重试。";
export const CONTENT_MODERATION_MESSAGE = "提示词未通过内容安全审核。请修改提示词或参考图后重新生成。";

const HTML_BODY = /^\s*(?:<!doctype|<html|<head|<body)/i;
const HTTP_STATUS = /(?:HTTP\s+|status(?:[_\s]+code)?\s*[:：=]?\s*)(\d{3})\b/i;
const WRAPPED_HTTP_STATUS = /Request failed with status code\s+(\d{3})/i;
const URL_PATTERN = /(?:https?:\/\/|data:[a-z0-9.+-]+\/[^;]+;base64,)[^\s"'<>]+/gi;
const SECRET_PATTERN = /(?:api[_-]?key|secret[_-]?key|access[_-]?token|authorization|bearer|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,})[^\s,;]*/gi;
const PROMPT_ECHO = /((?:prompt|input|query)\s*[=:：]\s*)(?:"[^"]{0,400}"|'[^']{0,400}'|\S{1,400})/gi;
const SIGNED_QUERY = /(?:[?&](?:signature|x-amz-signature|x-oss-signature|token|key)=)[^\s&]+/gi;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const UNSAFE_ID = /secret|token|password|apikey|api-key|bearer|sk-/i;
// 网关透传的「上游没有对应端点」文案（实测：「请求路径或资源不存在：上游未找到对应端点」）。
const MISSING_UPSTREAM_ENDPOINT_PATTERN = /未找到对应端点|请求路径或资源不存在|endpoint not found/i;

type ExtractedFields = {
    code: string;
    type: string;
    status: string;
    message: string;
    param: string;
    requestId: string;
    taskId: string;
};

export function explainGenerationError(error: unknown, context: GenerationFailureContext = {}): GenerationFailureExplanation {
    const classified = classifyUnknown(error, context);
    const copy = explanationCopy(classified);
    const message = joinSentences(copy.reason, copy.action, debugIdLine(classified.taskId || context.taskId, classified.requestId || context.providerRequestId));
    const moderation = isModerationCategory(classified.category);
    const uncertain = classified.uncertain || classified.category === "submission_uncertain" || classified.category === "download_failed" || (classified.category === "timeout" && classified.status === 524);
    return {
        category: classified.category,
        reason: copy.reason,
        action: copy.action,
        message: message || DEFAULT_GENERATION_ERROR_MESSAGE,
        errorCode: classified.category,
        providerCode: classified.providerCode || undefined,
        requestId: sanitizeDebugId(classified.requestId || context.providerRequestId) || undefined,
        taskId: sanitizeDebugId(classified.taskId || context.taskId) || undefined,
        retryable: Boolean(classified.retryable) && !uncertain && !moderation,
        uncertain,
        blockAutomaticRetry: uncertain || moderation || !["throttled", "concurrency", "provider_unavailable", "cancelled"].includes(classified.category),
        moderation,
    };
}

export function generationErrorMessage(error: unknown) {
    return explainGenerationError(error).message;
}

export function generationErrorCode(error: unknown) {
    if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && isGenerationErrorCode(code)) return code;
    }
    const explained = explainGenerationError(error);
    return explained.category === "unknown" ? undefined : explained.errorCode;
}

export function generationFailureMetadata(error: unknown, prompt: string, references: Array<string | { id?: string; storageKey?: string; url?: string }> = []): GenerationFailureMetadata {
    const explained = explainGenerationError(error);
    const inputFingerprint = generationInputFingerprint(prompt, references);
    if (!explained.moderation) return { errorDetails: explained.message, generationErrorCode: explained.category === "unknown" ? undefined : explained.errorCode };
    return {
        errorDetails: explained.message,
        generationErrorCode: explained.errorCode,
        failedPromptFingerprint: generationPromptFingerprint(prompt),
        failedInputFingerprint: inputFingerprint,
    };
}

export function isContentModerationError(value: unknown) {
    if (!value) return false;
    if (typeof value === "object" && value && "category" in value && isModerationCategory(String((value as { category?: unknown }).category || ""))) return true;
    const explained = explainGenerationError(value);
    if (explained.moderation) return true;
    const text = value instanceof Error ? value.message : String(value);
    return text.toLowerCase().includes(CONTENT_MODERATION_ERROR_CODE) || text.includes("内容审核未通过") || text.includes("内容安全审核");
}

export function shouldBlockAutomaticRetry(error: unknown, stage?: string) {
    if (stage === "submission_unknown") return true;
    return explainGenerationError(error, { stage }).blockAutomaticRetry;
}

export function unchangedModeratedPrompt(
    metadata: { errorDetails?: string; generationErrorCode?: string; failedPromptFingerprint?: string; failedInputFingerprint?: string } | undefined,
    prompt: string,
    references: Array<string | { id?: string; storageKey?: string; url?: string }> = [],
) {
    const moderationFailure = isModerationCategory(metadata?.generationErrorCode || "") || isContentModerationError(metadata?.errorDetails);
    if (!moderationFailure) return false;
    if (metadata?.failedInputFingerprint) return metadata.failedInputFingerprint === generationInputFingerprint(prompt, references);
    if (references.length) return false;
    if (!metadata?.failedPromptFingerprint) return false;
    return metadata.failedPromptFingerprint === generationPromptFingerprint(prompt);
}

export function generationPromptFingerprint(value: string) {
    const normalized = value.trim().replace(/\s+/g, " ");
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

export function generationInputFingerprint(prompt: string, references: Array<string | { id?: string; storageKey?: string; url?: string }> = []) {
    const referenceKeys = references
        .map((item) => (typeof item === "string" ? item : [item.id, item.storageKey, item.url].filter(Boolean).join("|")))
        .map((item) => item.trim())
        .filter(Boolean)
        .sort();
    return generationPromptFingerprint(`${prompt.trim()}\n${referenceKeys.join("\n")}`);
}

export function formatGenerationDiagnostics(explanation: GenerationFailureExplanation, context: GenerationFailureContext = {}) {
    const taskId = sanitizeDebugId(context.taskId) || sanitizeDebugId(explanation.taskId);
    const requestId = sanitizeDebugId(context.providerRequestId) || sanitizeDebugId(explanation.requestId);
    const model = sanitizeProviderCode(context.model || "");
    const createdAt = context.createdAt && /^\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]{5,35}$/.test(context.createdAt) ? context.createdAt : "";
    const lines = [
        `原因：${sanitizeProviderText(explanation.reason)}`,
        explanation.action ? `下一步：${sanitizeProviderText(explanation.action)}` : "",
        `类别：${explanation.category}`,
        sanitizeProviderCode(explanation.providerCode || "") ? `上游代码：${sanitizeProviderCode(explanation.providerCode || "")}` : "",
        taskId ? `任务 ID：${taskId}` : "",
        requestId ? `请求 ID：${requestId}` : "",
        model ? `模型：${model}` : "",
        createdAt ? `时间：${createdAt}` : "",
    ].filter(Boolean);
    return lines.join("\n");
}

export function isGenerationErrorCode(code: string) {
    return (GENERATION_ERROR_CATEGORIES as readonly string[]).includes(code) || /^(?:model|provider|origin)_[a-z0-9_]{2,80}$/.test(code) || code === CONTENT_MODERATION_ERROR_CODE;
}

type Classified = {
    category: GenerationErrorCategory;
    reason?: string;
    action?: string;
    providerCode?: string;
    requestId?: string;
    taskId?: string;
    status?: number;
    fromCode?: boolean;
    uncertain?: boolean;
    retryable?: boolean;
};

function classifyUnknown(error: unknown, context: GenerationFailureContext): Classified {
    if (context.stage === "submission_unknown") return { category: "submission_uncertain", uncertain: true, retryable: false };
    if (!error) return { category: "unknown", retryable: false };
    if (typeof error === "object" && error) {
        const record = error as Record<string, unknown>;
        const response = record.response && typeof record.response === "object" ? (record.response as Record<string, unknown>) : undefined;
        const status = numericStatus(record.status) ?? numericStatus(record.statusCode) ?? numericStatus(response?.status);
        const data = record.data ?? record.body ?? response?.data ?? record.response;
        if (status || data) {
            const classified = classifyHttp(status, data ?? record);
            if (classified.category !== "unknown" || status) return classified;
        }
        const structured = classifyText(stringifyAllowlisted(record));
        if (structured.fromCode || structured.category !== "unknown") return structured;
        if (typeof record.reason === "string" && record.reason) {
            const fromReason = classifyText(record.reason);
            if (fromReason.category !== "unknown") return fromReason;
        }
        if (typeof record.message === "string" && record.message) return classifyText(record.message);
    }
    if (error instanceof Error) return classifyText(error.message);
    if (typeof error === "string") return classifyText(error);
    return classifyText(providerPayloadMessage(error));
}

function classifyHttp(status: number | undefined, body: unknown): Classified {
    const text = typeof body === "string" ? body : providerPayloadMessage(body) || (body && typeof body === "object" ? JSON.stringify(body) : "");
    let classified = classifyText(text || (body && typeof body === "object" ? stringifyAllowlisted(body) : ""));
    if (body && typeof body === "object") {
        const fromObject = classifyText(stringifyAllowlisted(body));
        if (fromObject.fromCode || (fromObject.category !== "unknown" && classified.category === "unknown")) classified = fromObject;
    }
    if (classified.category !== "unknown" && !classified.fromCode && !trustProviderMessageStatus(status)) {
        classified = { category: "unknown", retryable: false };
    }
    if (!classified.fromCode && (classified.category === "unknown" || classified.category === "malformed_response") && status) {
        classified = { category: categoryFromHttpStatus(status), status, retryable: false };
        if (status === 524) {
            classified.category = "timeout";
            classified.uncertain = true;
            classified.reason = "模型服务响应超时，请求可能仍在服务端执行";
            classified.action = "请先查询原任务或到供应商核对状态，不要立即重新提交";
        }
    }
    if (status === 524 && (classified.category === "unknown" || classified.category === "timeout" || classified.category === "provider_unavailable" || classified.category === "malformed_response")) {
        classified.category = "timeout";
        classified.uncertain = true;
        classified.reason = "模型服务响应超时，请求可能仍在服务端执行";
        classified.action = "请先查询原任务或到供应商核对状态，不要立即重新提交";
    }
    // 网关把上游的 404 透传过来（「请求路径或资源不存在：上游未找到对应端点」）：
    // 模型名与路径都对，只是这一跳被路由到了没有该端点的上游 —— 换个上游就能过，属可重试。
    // 必须显式覆盖：404 不在 trustProviderMessageStatus 白名单里，消息判定会被丢弃，
    // 最终落到 404 → model_missing，提示用户去「检查模型名称和渠道配置」，属于误导。
    if (status === 404 && MISSING_UPSTREAM_ENDPOINT_PATTERN.test(text)) {
        classified = { category: "provider_unavailable", status, retryable: true };
    }
    if (status === 413 && classified.category === "input_too_large" && !classified.reason) {
        classified.reason = "整次请求的数据量超过接口上限";
        classified.action = "请减少参考素材，或改用可公开访问的素材链接后再提交";
    }
    classified.status = status;
    classified.retryable = retryableCategory(classified.category) && !classified.uncertain;
    return classified;
}

function classifyText(raw: string): Classified {
    const text = raw.trim();
    if (!text) return { category: "unknown", retryable: false };
    const moderationCopy = persistedModerationCopy(text);
    if (moderationCopy) {
        return { ...moderationCopy, requestId: sanitizeDebugId(text.match(/请求 ([A-Za-z0-9._:-]{6,127})/)?.[1]), taskId: sanitizeDebugId(text.match(/任务 ([A-Za-z0-9._:-]{6,127})/)?.[1]), retryable: false };
    }
    const durationCopy = referenceDurationCopy(text);
    if (durationCopy) {
        const debug = text.match(/。排查编号：([^。]+)。?$/)?.[1] || "";
        return {
            category: "invalid_params",
            ...durationCopy,
            requestId: sanitizeDebugId(debug.match(/(?:^| · )请求 ([A-Za-z0-9._:-]{6,127})$/)?.[1]),
            taskId: sanitizeDebugId(debug.match(/^任务 ([A-Za-z0-9._:-]{6,127})(?: · |$)/)?.[1]),
            retryable: false,
        };
    }
    const mediaCopy = referenceMediaConstraintCopy(text);
    if (mediaCopy) {
        const debug = text.match(/。排查编号：([^。]+)。?$/)?.[1] || "";
        return {
            category: mediaCopy.reason.includes("过大") ? "input_too_large" : "invalid_params",
            ...mediaCopy,
            requestId: sanitizeDebugId(debug.match(/(?:^| · )请求 ([A-Za-z0-9._:-]{6,127})$/)?.[1]),
            taskId: sanitizeDebugId(debug.match(/^任务 ([A-Za-z0-9._:-]{6,127})(?: · |$)/)?.[1]),
            retryable: false,
        };
    }
    if (HTML_BODY.test(text)) {
        const status = extractExplicitHttpStatus(text);
        if (status) return classifyHttp(status, "");
        return { category: "malformed_response", retryable: false };
    }
    const storage = resourceStorageFailureMessage(text);
    if (storage) return { category: "input_inaccessible", reason: storage.replace(/。$/, ""), action: "", retryable: false };
    const fields = extractProviderFields(text);
    if (fields.code || fields.type || fields.message || fields.status) {
        const fromCode = categoryFromProviderCode(fields.code, fields.type, fields.status);
        if (fromCode) return specialize({ category: fromCode, fromCode: true, providerCode: sanitizeProviderCode(fields.code), requestId: sanitizeDebugId(fields.requestId), taskId: sanitizeDebugId(fields.taskId) }, fields);
        const fromMessage = categoryFromProviderMessage(`${fields.message} ${fields.type} ${fields.status}`);
        if (fromMessage) return specialize({ category: fromMessage, providerCode: sanitizeProviderCode(fields.code), requestId: sanitizeDebugId(fields.requestId), taskId: sanitizeDebugId(fields.taskId) }, fields);
    }
    if (/^[{[]/.test(text)) return { category: "unknown", providerCode: sanitizeProviderCode(fields.code), requestId: sanitizeDebugId(fields.requestId), taskId: sanitizeDebugId(fields.taskId), retryable: false };
    const persisted = matchPersistedCategory(text);
    if (persisted) return { category: persisted, uncertain: ["timeout", "download_failed", "submission_uncertain"].includes(persisted), retryable: false };
    if (isMalformedText(text)) return { category: "malformed_response", retryable: false };
    const fromFull = categoryFromProviderMessage(text);
    if (fromFull) return specialize({ category: fromFull }, { ...emptyFields(), message: text });
    if (isNetworkText(text)) return { category: "network", retryable: true };
    if (isDownloadText(text)) return { category: "download_failed", uncertain: true, retryable: false };
    if (isCancelledText(text)) return { category: "cancelled", retryable: false };
    if (isResultsMissingText(text)) return { category: "results_missing", retryable: false };
    const status = extractExplicitHttpStatus(text);
    if (status) return classifyHttp(status, "");
    if (/[\u4e00-\u9fff]/.test(text) && !containsInfrastructureDetails(text)) return { category: "unknown", reason: sanitizeProviderText(text), action: "", retryable: false };
    return { category: "unknown", retryable: false };
}

function specialize(classified: Classified, fields: ExtractedFields): Classified {
    fields = { ...fields, message: sanitizeProviderText(fields.message) };
    classified.requestId ||= sanitizeDebugId(fields.message.match(/\brequest\s*id:\s*([A-Za-z0-9_-]{6,127})\b/i)?.[1]);
    // Only broad wrappers may be refined by a more specific provider message.
    const genericCode =
        ["", "unknown", "failed", "badrequest", "api_error", "upstream_error", "upstream_rejected", "invalid_request", "invalid_request_error", "invalid_parameter", "invalidparameter", "invalid_argument"].includes(normalizeCode(fields.code)) ||
        /^\d{3}$/.test(fields.code);
    const persistedCopy = persistedModerationCopy(fields.message);
    if (persistedCopy && (classified.category === persistedCopy.category || (genericCode && ["unknown", "invalid_params"].includes(classified.category)))) {
        const persisted = classifyText(fields.message);
        return { ...classified, ...persisted, providerCode: classified.providerCode, requestId: classified.requestId || persisted.requestId, taskId: classified.taskId || persisted.taskId };
    }
    if (genericCode && ["unknown", "invalid_params"].includes(classified.category)) {
        const refined = categoryFromProviderMessage(fields.message);
        if (refined) classified.category = refined;
    }
    if (isModerationCategory(classified.category) || (genericCode && ["unknown", "invalid_params"].includes(classified.category))) {
        const moderationCopy = moderationErrorCopy(fields.code, fields.message);
        if (moderationCopy) return { ...classified, ...moderationCopy, retryable: false };
    }
    const audioOrDuration = referenceAudioCopy(fields.message, normalizeCode(fields.code) === "invalid_reference_audio") || referenceDurationCopy(fields.message);
    if (audioOrDuration) return { ...classified, category: "invalid_params", ...audioOrDuration, retryable: false };
    const mediaCopy = referenceMediaConstraintCopy(fields.message);
    if (mediaCopy) return { ...classified, category: mediaCopy.reason.includes("过大") ? "input_too_large" : "invalid_params", ...mediaCopy, retryable: false };
    if (classified.category === "invalid_params") {
        const refined = categoryFromProviderMessage(fields.message);
        if (refined === "context_too_long" || refined === "input_inaccessible" || refined === "input_too_large" || refined === "model_missing") classified.category = refined;
    }
    if (isModerationCategory(classified.category) && !["moderation_reference", "moderation_output"].includes(fields.code)) classified.category = moderationCategoryFromMessage(`${fields.message} ${fields.code}`.toLowerCase());
    const normalized = `${fields.message} ${fields.code}`.toLowerCase();
    if (classified.category === "invalid_params") {
        const duration = fields.message.match(/duration\s+(?:must|should)\s+be\s+between\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\s+and\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
        if (duration && Number(duration[1]) <= Number(duration[2])) {
            const reference = fields.message.includes("素材") || /reference|audio/i.test(fields.message);
            classified.reason = reference ? "参考素材时长不符合模型要求" : "视频时长不符合模型要求";
            classified.action = reference ? `请检查每段参考音频和视频，将不符合要求的素材调整为 ${duration[1]}–${duration[2]} 秒后重新提交` : `请将时长调整为 ${duration[1]}–${duration[2]} 秒后重试`;
        }
        const height = fields.message.match(/height\s+(?:must|should)\s+be\s+between\s+(\d+)\s*(?:px|pixels?)?\s+and\s+(\d+)\s*(?:px|pixels?)/i);
        if (height) {
            classified.reason = "参考素材高度不符合模型要求";
            classified.action = `请将高度调整为 ${height[1]}–${height[2]} 像素后重新提交`;
        }
        const width = fields.message.match(/width\s+(?:must|should)\s+be\s+between\s+(\d+)\s*(?:px|pixels?)?\s+and\s+(\d+)\s*(?:px|pixels?)/i);
        if (width && !height) {
            classified.reason = "参考素材宽度不符合模型要求";
            classified.action = `请将宽度调整为 ${width[1]}–${width[2]} 像素后重新提交`;
        }
        const aspect = fields.message.match(/aspect(?:\s*ratio)?\s+(?:must|should)\s+be\s+between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)/i);
        if (aspect) {
            classified.reason = "参考素材宽高比不符合模型要求";
            classified.action = `请将宽高比调整为 ${aspect[1]}–${aspect[2]} 后重新提交`;
        }
        const pixels = fields.message.match(/(?:pixel(?:s)?(?:\s+count)?|total\s+pixels)\s+(?:must|should)\s+be\s+between\s+(\d+)\s+and\s+(\d+)/i);
        if (pixels) {
            classified.reason = "参考素材像素总量不符合模型要求";
            classified.action = "请调整尺寸或更换后再提交";
        }
    }
    if (classified.category === "input_too_large") {
        if (
            normalizeCode(fields.code) === "video_request_body_too_large" ||
            fields.message.startsWith("整次请求的数据量超过接口上限") ||
            /(?:request\s+(?:body|entity|payload)|payload)\s+(?:is\s+)?too\s+large|(?:request|payload).{0,24}(?:exceeds?|larger than)/i.test(fields.message)
        ) {
            classified.reason = "整次请求的数据量超过接口上限";
            classified.action = "请减少参考素材，或改用可公开访问的素材链接后再提交";
        } else if (/(?:file|image|video|audio)\s+too\s+large/i.test(fields.message)) {
            classified.reason = "单个参考文件过大";
            classified.action = "请压缩或更换该素材后再提交";
        }
    }
    if (((normalized.includes("thinking") || normalized.includes("reasoning")) && normalized.includes("tool_choice")) || (normalized.includes("tool_choice") && (normalized.includes("not support") || normalized.includes("unsupported")))) {
        classified.category = "invalid_params";
        classified.reason = "当前模型为思考或推理模式，不支持强制工具调用";
        classified.action = "请改用自动工具选择或更换非思考模式模型";
    }
    classified.retryable = retryableCategory(classified.category);
    return classified;
}

function referenceDurationCopy(text: string): CategoryCopy | undefined {
    const audio = referenceAudioCopy(text);
    if (audio) return audio;
    const numbered = text.match(/^第 (\d+) 段参考(音频|视频)时长为 (\d+(?:\.\d+)?) 秒[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒/);
    if (numbered) return { reason: `第 ${numbered[1]} 段参考${numbered[2]}时长为 ${numbered[3]} 秒`, action: `需要 ${numbered[4]}–${numbered[5]} 秒；请裁剪或更换这段素材后再提交` };
    const missing = text.match(/^第 (\d+) 段参考(音频|视频)的时长无法读取/);
    if (missing) return { reason: `第 ${missing[1]} 段参考${missing[2]}的时长无法读取`, action: "请重新导入素材后再提交" };
    const persisted = text.match(/^参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒/);
    if (persisted) return { reason: "参考素材时长不符合模型要求", action: `请检查每段参考音频和视频，将不符合要求的素材调整为 ${persisted[1]}–${persisted[2]} 秒后重新提交` };
}

function referenceAudioCopy(text: string, invalidAudio = false): CategoryCopy | undefined {
    const duration = text.match(/^reference audio (\d+) is (\d+(?:\.\d+)?) seconds; use audio between (\d+(?:\.\d+)?) and (\d+(?:\.\d+)?) seconds/i);
    if (duration) return { reason: `第 ${duration[1]} 段参考音频时长为 ${duration[2]} 秒`, action: `需要 ${duration[3]}–${duration[4]} 秒；请裁剪或更换这段素材后再提交` };
    const total =
        text.match(/^reference audio is (\d+(?:\.\d+)?) seconds in total; this model accepts at most (\d+(?:\.\d+)?) seconds of reference audio/i) || text.match(/^参考音频总时长为 (\d+(?:\.\d+)?) 秒[。，](?:该|当前)模型最多支持 (\d+(?:\.\d+)?) 秒/);
    if (total) return { reason: `参考音频总时长为 ${total[1]} 秒`, action: `该模型最多支持 ${total[2]} 秒参考音频；请裁剪或减少参考音频后再提交` };
    const numbered = text.match(/^reference audio (\d+)(?::| requires| exceeds)/i);
    const label = numbered ? `第 ${numbered[1]} 段参考音频` : "参考音频";
    const persisted = text.match(/^(第 \d+ 段参考音频|参考音频)(无法下载|的格式或时长无法读取|文件过大|不符合模型要求)。/);
    const issue =
        persisted?.[2] ||
        (invalidAudio || numbered
            ? /15 MiB|byte limit|at most.*MiB/i.test(text)
                ? "文件过大"
                : /duration could not be measured|invalid.*audio|unsupported|readable audio track/i.test(text)
                  ? "的格式或时长无法读取"
                  : /download|HTTPS URL|URL.*(?:policy|allowed)|redirect|readable within/i.test(text)
                    ? "无法下载"
                    : "不符合模型要求"
            : "");
    if (!issue) return;
    const actions: Record<string, string> = {
        无法下载: "请重新上传音频，确认素材链接可公开访问后再提交",
        的格式或时长无法读取: "请将音频重新导出为 MP3、WAV 或 M4A，确认文件完整且含有音轨后再上传",
        文件过大: "请压缩或更换音频，确保文件不超过模型的大小限制后再提交",
        不符合模型要求: "请检查参考音频的时长、格式和大小，调整后再提交",
    };
    return { reason: `${persisted?.[1] || label}${issue}`, action: actions[issue] };
}

function extractProviderFields(raw: string): ExtractedFields {
    const fields = emptyFields();
    if (raw.length > 16384) return fields;
    const suffix = raw.match(/\s*\(request id:\s*([A-Za-z0-9._:-]{6,127})\)\s*$/i);
    if (suffix) raw = raw.slice(0, suffix.index);
    const tryParse = (value: string) => {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                Object.assign(fields, walkProviderFields(parsed as Record<string, unknown>, 0));
                fields.requestId ||= sanitizeDebugId(suffix?.[1]);
            }
        } catch {
            return;
        }
    };
    tryParse(raw.trim());
    if (fields.message.startsWith("{") || fields.message.startsWith("[")) {
        const nested = emptyFields();
        try {
            const parsed = JSON.parse(fields.message) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(nested, walkProviderFields(parsed as Record<string, unknown>, 0));
        } catch {
            /* keep outer fields */
        }
        if (nested.message) fields.message = nested.message;
        if (nested.code) fields.code = nested.code;
        if (nested.type) fields.type = nested.type;
    }
    if (fields.message || fields.code) return fields;
    for (let index = raw.indexOf("{"); index >= 0; index = raw.indexOf("{", index + 1)) {
        tryParse(raw.slice(index).trim());
        if (fields.message || fields.code) return fields;
    }
    return fields;
}

function walkProviderFields(payload: Record<string, unknown>, depth: number): ExtractedFields {
    const fields = emptyFields();
    if (depth > 5) return fields;
    fields.code = allowlistedString(payload.code);
    fields.type = allowlistedString(payload.type);
    fields.status = allowlistedString(payload.status);
    fields.message = allowlistedString(payload.message) || allowlistedString(payload.msg) || allowlistedString(payload.detail);
    fields.param = allowlistedString(payload.param) || allowlistedString(payload.parameter);
    fields.requestId = allowlistedString(payload.request_id) || allowlistedString(payload.requestId) || allowlistedString(payload["request-id"]);
    fields.taskId = allowlistedString(payload.task_id) || allowlistedString(payload.taskId);
    const nested = [payload.error, payload.data, payload.output, payload.promptFeedback].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    for (const child of nested) {
        const walked = walkProviderFields(child, depth + 1);
        if (!fields.code || (child === payload.error && walked.code)) fields.code = walked.code;
        if (!fields.type) fields.type = walked.type;
        if (!fields.status) fields.status = walked.status;
        if (!fields.message || (child === payload.error && walked.message)) fields.message = walked.message;
        if (!fields.param) fields.param = walked.param;
        if (!fields.requestId) fields.requestId = walked.requestId;
        if (!fields.taskId) fields.taskId = walked.taskId;
        if (allowlistedString(child.blockReason)) {
            fields.code = fields.code || allowlistedString(child.blockReason);
            fields.message = fields.message || "blocked by content safety policy";
        }
    }
    return fields;
}

function categoryFromProviderCode(...values: string[]): GenerationErrorCategory | "" {
    for (const value of values) {
        const normalized = normalizeCode(value);
        if (!normalized || normalized === "0" || normalized === "success" || normalized === "ok") continue;
        if ((GENERATION_ERROR_CATEGORIES as readonly string[]).includes(normalized)) return normalized as GenerationErrorCategory;
        if (PROVIDER_CODE_CATEGORIES[normalized]) return PROVIDER_CODE_CATEGORIES[normalized];
        const moderationCopy = moderationErrorCopy(normalized, "");
        if (moderationCopy) return moderationCopy.category;
        if (/^sensitivecontentdetected(?:\.|$)/.test(normalized)) return "moderation_input";
        if (normalized.includes("content_filter") || normalized.includes("contentpolicy") || normalized.includes("sensitive_words")) return "moderation_input";
        if (normalized.includes("insufficient") && (normalized.includes("quota") || normalized.includes("balance"))) return "quota_unknown";
        if (normalized.includes("rate_limit") || normalized.includes("throttl")) return "throttled";
        if (normalized.includes("context_length") || normalized.includes("max_tokens")) return "context_too_long";
        if (normalized.includes("model_not") || normalized.includes("invalid_model")) return "model_missing";
        if (normalized.includes("auth") && (normalized.includes("invalid") || normalized.includes("fail") || normalized.includes("unauth"))) return "auth";
        if (normalized.includes("permission") || normalized.includes("forbidden")) return "permission";
    }
    return "";
}

function referenceMediaConstraintCopy(text: string): CategoryCopy | undefined {
    const persisted = text.match(/^参考素材(宽度|高度|宽高比)不符合模型要求。请将(?:宽度|高度|宽高比)调整为 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)( 像素| )后重新提交/);
    if (persisted) return { reason: `参考素材${persisted[1]}不符合模型要求`, action: `请将${persisted[1]}调整为 ${persisted[2]}–${persisted[3]}${persisted[4]}后重新提交` };
    const single = text.match(/^(第 \d+ (?:张|个|段)参考(?:图|视频|音频)(?:宽度|高度|宽高比|时长)为 \d+(?:\.\d+)?(?: 像素| 秒)?)[，。]需要 ((?:至少|不超过) \d+(?:\.\d+)?(?: 像素| 秒)?)/);
    if (single) return { reason: single[1], action: `需要 ${single[2]}；${single[1].includes("时长") ? "请裁剪或更换这段素材后再提交" : "请调整尺寸或更换后再提交"}` };
    const size = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)(宽度|高度)为 (\d+) 像素[，。]需要 (\d+)–(\d+) 像素/);
    if (size) return { reason: `第 ${size[1]} ${size[2]}参考${size[3]}${size[4]}为 ${size[5]} 像素`, action: `需要 ${size[6]}–${size[7]} 像素；请调整尺寸或更换后再提交` };
    const aspect = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)宽高比为 (\d+(?:\.\d+)?)[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)/);
    if (aspect) return { reason: `第 ${aspect[1]} ${aspect[2]}参考${aspect[3]}宽高比为 ${aspect[4]}`, action: `需要 ${aspect[5]}–${aspect[6]}；请调整尺寸或更换后再提交` };
    const pixels = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)像素总量/);
    if (pixels) return { reason: `第 ${pixels[1]} ${pixels[2]}参考${pixels[3]}像素总量不符合当前模型要求`, action: "请调整尺寸或更换后再提交" };
    const file = text.match(/^第 (\d+) (张|个|段)参考(图|视频|音频)文件过大[，。]当前模型单文件上限为 ([^；;]+)/);
    if (file) return { reason: `第 ${file[1]} ${file[2]}参考${file[3]}文件过大`, action: `当前模型单文件上限为 ${file[4]}；请压缩或更换后再提交` };
    if (text.startsWith("整次请求的参考素材合计过大")) return { reason: "整次请求的参考素材合计过大", action: "请减少素材后再提交" };
}

function categoryFromProviderMessage(raw: string): GenerationErrorCategory | "" {
    const normalized = sanitizeProviderText(raw).toLowerCase();
    if (!normalized.trim()) return "";
    if (/duration\s+(?:must|should)\s+be\s+between\s+\d/.test(normalized)) return "invalid_params";
    if (
        /(?:width|height)\s+(?:must|should)\s+be\s+between\s+\d/.test(normalized) ||
        /aspect(?:\s*ratio)?\s+(?:must|should)\s+be\s+between/.test(normalized) ||
        /(?:pixel(?:s)?(?:\s+count)?|total\s+pixels)\s+(?:must|should)\s+be\s+between/.test(normalized)
    )
        return "invalid_params";
    if (((normalized.includes("thinking") || normalized.includes("reasoning")) && normalized.includes("tool_choice")) || (normalized.includes("tool_choice") && (normalized.includes("not support") || normalized.includes("unsupported"))))
        return "invalid_params";
    const moderationCopy = moderationErrorCopy("", normalized);
    if (moderationCopy) return moderationCopy.category;
    if (containsContentSafety(normalized)) return moderationCategoryFromMessage(normalized);
    if (normalized.includes("insufficient_quota") || ((normalized.includes("quota") || normalized.includes("balance") || normalized.includes("额度") || normalized.includes("余额") || normalized.includes("欠费")) && !normalized.includes("rate")))
        return normalized.includes("arrearage") || normalized.includes("billing_hard_limit") ? "quota_upstream" : "quota_unknown";
    if (normalized.includes("rate limit") || normalized.includes("too many requests") || normalized.includes("throttl") || normalized.includes("频繁")) return "throttled";
    if (normalized.includes("context length") || normalized.includes("too many tokens") || normalized.includes("max_tokens") || (normalized.includes("长度") && (normalized.includes("最大") || normalized.includes("超出")))) return "context_too_long";
    // 中转网关把上游的 404 透传过来（「请求路径或资源不存在：上游未找到对应端点」）：
    // 模型名与路径都对，只是这一跳被路由到了没有该端点的上游 —— 判成可重试，别让用户去改配置。
    if (normalized.includes("未找到对应端点") || normalized.includes("请求路径或资源不存在") || normalized.includes("endpoint not found")) return "provider_unavailable";
    if (normalized.includes("model_not_found") || normalized.includes("model not found") || normalized.includes("模型不存在") || normalized.includes("当前模型或接口不可用")) return "model_missing";
    if (normalized.includes("invalid api key") || normalized.includes("incorrect api key") || normalized.includes("authentication") || normalized.includes("unauthorized") || normalized.includes("鉴权失败")) return "auth";
    if (normalized.includes("permission") && (normalized.includes("denied") || normalized.includes("model") || normalized.includes("access"))) return "permission";
    if (normalized.includes("url error") || normalized.includes("failed to download") || normalized.includes("cannot fetch") || normalized.includes("invalid image url") || normalized.includes("无法读取")) return "input_inaccessible";
    if (normalized.includes("too large") || normalized.includes("payload too large") || normalized.includes("过大") || normalized.startsWith("整次请求的数据量超过接口上限") || /(?:request|payload).{0,24}(?:exceeds?|larger than)/i.test(normalized))
        return "input_too_large";
    if (normalized.includes("invalid") || normalized.includes("parameter") || normalized.includes("argument") || normalized.includes("请检查模型")) return "invalid_params";
    return "";
}

function containsContentSafety(normalized: string) {
    return (
        normalized.includes("sensitive_words_detected") ||
        normalized.includes("content policy") ||
        normalized.includes("content safety") ||
        normalized.includes("safety policy") ||
        normalized.includes("data inspection") ||
        normalized.includes("prohibited_content") ||
        normalized.includes("内容安全审核") ||
        normalized.includes("内容审核未通过") ||
        (normalized.includes("blocked by") && (normalized.includes("safety") || normalized.includes("policy") || normalized.includes("content"))) ||
        (normalized.includes("safety") && (normalized.includes("blocked") || normalized.includes("violat") || normalized.includes("filter")))
    );
}

function moderationCategoryFromMessage(normalized: string): GenerationErrorCategory {
    if (/prompt\s+(?:or|and)\s+(?:reference|input)|提示词或参考/.test(normalized)) return "moderation_input";
    if (normalized.includes("reference image") || normalized.includes("input image") || normalized.includes("参考图")) return "moderation_reference";
    if (normalized.includes("output") && (normalized.includes("image") || normalized.includes("video") || normalized.includes("result"))) return "moderation_output";
    return "moderation_input";
}

function categoryFromHttpStatus(status: number): GenerationErrorCategory {
    if (status === 401) return "auth";
    if (status === 403) return "permission";
    if (status === 402) return "quota_unknown";
    if (status === 404) return "model_missing";
    if (status === 408 || status === 504 || status === 524) return "timeout";
    if (status === 409) return "invalid_params";
    if (status === 413) return "input_too_large";
    if (status === 400 || status === 422) return "invalid_params";
    if (status === 429) return "throttled";
    if (status >= 500) return "provider_unavailable";
    return "unknown";
}

function trustProviderMessageStatus(status?: number) {
    if (!status) return true;
    if (status >= 200 && status < 300) return true;
    return status === 400 || status === 402 || status === 409 || status === 413 || status === 422 || status === 429 || status === 451;
}

function extractExplicitHttpStatus(raw: string) {
    const match = raw.match(HTTP_STATUS) || raw.match(WRAPPED_HTTP_STATUS);
    const status = match ? Number(match[1]) : 0;
    return status >= 400 && status <= 599 ? status : 0;
}

function explanationCopy(classified: Classified): CategoryCopy {
    if (classified.reason) return { reason: classified.reason, action: classified.action || "" };
    return CATEGORY_COPY[classified.category] || CATEGORY_COPY.unknown;
}

function debugIdLine(taskId?: string, requestId?: string) {
    const parts = [sanitizeDebugId(taskId) ? `任务 ${sanitizeDebugId(taskId)}` : "", sanitizeDebugId(requestId) ? `请求 ${sanitizeDebugId(requestId)}` : ""].filter(Boolean);
    return parts.length ? `排查编号：${parts.join(" · ")}` : "";
}

function joinSentences(...parts: Array<string | undefined>): string {
    const out = parts.map((part) => (part || "").trim().replace(/[。.;；]+$/u, "")).filter(Boolean);
    if (!out.length) return DEFAULT_GENERATION_ERROR_MESSAGE;
    if (out.length === 1) return out[0];
    return `${out.join("。")}。`;
}

function sanitizeDebugId(value?: string) {
    const text = (value || "").trim();
    if (!text || text.length > 80 || !SAFE_ID.test(text) || UNSAFE_ID.test(text)) return "";
    return text;
}

function sanitizeProviderCode(value: string) {
    const text = value.trim();
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(text) && !/^(?:sk-|eyJ)|secret|password|bearer/i.test(text) ? text : "";
}

function sanitizeProviderText(value: string) {
    let text = value.trim();
    if (!text || HTML_BODY.test(text)) return "";
    // Unstructured messages may echo whole headers or prompts; discard the suffix,
    // since a whitespace-based token matcher cannot know where a secret ends.
    text = text.replace(/(?:authorization|cookie|set-cookie|api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|password|prompt|input|query)\s*[=:：][\s\S]*/i, "[已隐藏]");
    text = text.replace(URL_PATTERN, "").replace(SIGNED_QUERY, "").replace(SECRET_PATTERN, "").replace(PROMPT_ECHO, "$1[已隐藏]");
    text = text.replace(/\s+/g, " ").trim();
    if (text.startsWith("{") || text.startsWith("<")) return "";
    return text.slice(0, 240);
}

function normalizeCode(value: string) {
    return value.toLowerCase().trim().replace(/-/g, "_").replace(/\s+/g, "_");
}

function allowlistedString(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && value !== 0) return String(value);
    return "";
}

function numericStatus(value: unknown) {
    if (typeof value === "number" && value >= 400 && value <= 599) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) {
        const status = Number(value);
        return status >= 400 && status <= 599 ? status : undefined;
    }
    return undefined;
}

function stringifyAllowlisted(value: unknown) {
    try {
        return JSON.stringify(value);
    } catch {
        return "";
    }
}

function emptyFields(): ExtractedFields {
    return { code: "", type: "", status: "", message: "", param: "", requestId: "", taskId: "" };
}

function isModerationCategory(value: string) {
    return value === "moderation_input" || value === "moderation_reference" || value === "moderation_output" || value === CONTENT_MODERATION_ERROR_CODE;
}

function retryableCategory(category: GenerationErrorCategory) {
    return category === "throttled" || category === "provider_unavailable" || category === "network" || category === "timeout" || category === "concurrency";
}

function isNetworkText(value: string) {
    return /\b(?:dial tcp|connection refused|connection reset|no such host|i\/o timeout|context deadline exceeded|network error|failed to fetch|fetch failed|socket hang up|econnrefused|econnreset|etimedout)\b/i.test(value);
}

function isMalformedText(value: string) {
    return /(?:接口返回非 JSON|没有返回有效 JSON|invalid character|unexpected end of json|<!doctype|<html)/i.test(value);
}

function isDownloadText(value: string) {
    return value.includes("视频结果下载失败") || (value.includes("下载失败") && value.includes("结果"));
}

function isCancelledText(value: string) {
    return value.includes("任务已取消") || value.includes("请求已取消") || /context canceled/i.test(value);
}

function isResultsMissingText(value: string) {
    return value.includes("没有返回图片") || value.includes("没有返回视频") || value.includes("没有可用结果") || value.includes("接口没有返回");
}

function matchPersistedCategory(text: string): GenerationErrorCategory | "" {
    for (const [category, copy] of Object.entries(CATEGORY_COPY) as Array<[GenerationErrorCategory, CategoryCopy]>) {
        if (category === "unknown") continue;
        if (text.startsWith(copy.reason)) return category;
    }
    if (text.includes("真人形象")) return "moderation_reference";
    if (text.includes("不支持强制工具调用")) return "invalid_params";
    if (text.startsWith("视频时长不符合模型要求")) return "invalid_params";
    if (text.includes("可能仍在服务端执行") || text.includes("请勿立即重试")) return "timeout";
    return "";
}

function containsInfrastructureDetails(value: string) {
    return /(?:接口请求失败|Request failed with status code|https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+["']?|Bad Gateway|Service Unavailable|Gateway Timeout|upstream_error)/i.test(value);
}

function providerPayloadMessage(payload: unknown): string {
    if (typeof payload === "string") return payload.trim();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
        const nested = providerPayloadMessage(record.error);
        if (nested) return nested;
    }
    for (const key of ["message", "msg", "detail"] as const) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return typeof record.error === "string" ? record.error.trim() : "";
}

function resourceStorageFailureMessage(value: string) {
    if (!value) return "";
    if (isLocalRuntimeMode() && /(?:参考(?:图片|媒体)上传失败|OSS 上传失败|对象存储|腾讯云 COS|七牛云)/i.test(value)) {
        return "本地参考素材保存失败，请检查本地资源目录后重试。";
    }
    if (/\bUserDisable\b/i.test(value)) return "对象存储账号已停用，请检查或更换对象存储配置。";
    if (/(?:参考(?:图片|媒体)上传失败|OSS 上传失败|对象存储|腾讯云 COS|七牛云)/i.test(value)) {
        return "参考素材上传到对象存储失败，请检查对象存储配置后重试。";
    }
    return "";
}
