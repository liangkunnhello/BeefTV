package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// FailureCategory 是生成失败的稳定机器可读类目。HTTP 状态只作兜底，不能单独当原因。
type FailureCategory string

const (
	CategoryAuth                FailureCategory = "auth"
	CategoryPermission          FailureCategory = "permission"
	CategoryQuotaUser           FailureCategory = "quota_user"
	CategoryQuotaUpstream       FailureCategory = "quota_upstream"
	CategoryQuotaUnknown        FailureCategory = "quota_unknown"
	CategoryQuotaLimit          FailureCategory = "quota_limit"
	CategoryModerationInput     FailureCategory = "moderation_input"
	CategoryModerationReference FailureCategory = "moderation_reference"
	CategoryModerationOutput    FailureCategory = "moderation_output"
	CategoryInvalidParams       FailureCategory = "invalid_params"
	CategoryContextTooLong      FailureCategory = "context_too_long"
	CategoryInputInaccessible   FailureCategory = "input_inaccessible"
	CategoryInputTooLarge       FailureCategory = "input_too_large"
	CategoryModelMissing        FailureCategory = "model_missing"
	CategoryThrottled           FailureCategory = "throttled"
	CategoryConcurrency         FailureCategory = "concurrency"
	CategoryProviderUnavailable FailureCategory = "provider_unavailable"
	CategoryNetwork             FailureCategory = "network"
	CategoryTimeout             FailureCategory = "timeout"
	CategorySubmissionUncertain FailureCategory = "submission_uncertain"
	CategoryAsyncFailed         FailureCategory = "async_failed"
	CategoryCancelled           FailureCategory = "cancelled"
	CategoryPartialSuccess      FailureCategory = "partial_success"
	CategoryDownloadFailed      FailureCategory = "download_failed"
	CategoryResultsMissing      FailureCategory = "results_missing"
	CategoryMalformedResponse   FailureCategory = "malformed_response"
	CategoryUnknown             FailureCategory = "unknown"
)

const (
	maxSanitizedRunes    = 240
	maxProviderCodeRunes = 80
	maxDebugIDRunes      = 80
	maxJSONExtractBytes  = 16 << 10
	maxWalkDepth         = 5
)

// Failure 是归类后的可行动失败。UserMessage 给用户看；ErrorCode 给机器判断。
type Failure struct {
	Category        FailureCategory
	Reason          string
	Action          string
	ProviderCode    string
	ProviderMessage string
	Param           string
	RequestID       string
	TaskID          string
	HTTPStatus      int
	Retryable       bool
	Uncertain       bool
	Structured      bool
	FromCode        bool
}

type categoryCopy struct {
	Reason string
	Action string
}

var categoryCopies = map[FailureCategory]categoryCopy{
	CategoryAuth:                {Reason: "模型服务鉴权失败", Action: "请检查 API Key 后重试"},
	CategoryPermission:          {Reason: "当前渠道没有使用该模型的权限", Action: "请更换模型或检查渠道权限"},
	CategoryQuotaUser:           {Reason: "当前账号额度不足", Action: "请检查账号余额，或联系管理员调整额度后重试"},
	CategoryQuotaUpstream:       {Reason: "模型供应商拒绝了计费或额度相关请求", Action: "请到供应商核对账单与额度后，再决定是否重试"},
	CategoryQuotaUnknown:        {Reason: "模型服务拒绝了计费或额度相关请求", Action: "请到当前渠道或模型供应商核对账单与额度后，再决定是否重试"},
	CategoryQuotaLimit:          {Reason: "模型调用已达到设置的用量上限", Action: "请检查当前渠道的用量或预算限制，调整后再试"},
	CategoryModerationInput:     {Reason: "提示词或参考素材未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"},
	CategoryModerationReference: {Reason: "参考素材未通过内容安全审核", Action: "请检查并更换参考素材后重新生成"},
	CategoryModerationOutput:    {Reason: "生成结果未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"},
	CategoryInvalidParams:       {Reason: "模型不接受当前参数", Action: "请检查模型、尺寸、时长、格式或数量后重试"},
	CategoryContextTooLong:      {Reason: "输入内容超出模型长度限制", Action: "请缩短提示词或减少参考内容后重试"},
	CategoryInputInaccessible:   {Reason: "参考素材无法读取", Action: "请检查素材后重试"},
	CategoryInputTooLarge:       {Reason: "参考素材过大", Action: "请压缩或更换素材后重试"},
	CategoryModelMissing:        {Reason: "当前模型或接口不可用", Action: "请检查模型名称和渠道配置"},
	CategoryThrottled:           {Reason: "请求过于频繁", Action: "请稍后再试"},
	CategoryConcurrency:         {Reason: "同时进行的生成过多", Action: "请等待已有任务完成后再试"},
	CategoryProviderUnavailable: {Reason: "模型服务暂时不可用", Action: "请稍后重试"},
	CategoryNetwork:             {Reason: "网络连接失败", Action: "请检查网络并核对原任务状态后，再决定是否重新生成"},
	CategoryTimeout:             {Reason: "模型服务响应超时", Action: "请稍后查询原任务，不要立即重新提交"},
	CategorySubmissionUncertain: {Reason: "提交结果尚未确认，上游任务可能仍在执行", Action: "请先查询原任务状态，不要立即重新提交"},
	CategoryAsyncFailed:         {Reason: "生成任务没有完成", Action: "请查看详情后决定是否重试"},
	CategoryCancelled:           {Reason: "任务已取消", Action: "可按原输入重新提交"},
	CategoryPartialSuccess:      {Reason: "部分结果已生成，其余失败", Action: "请查看已有结果后再决定是否补做"},
	CategoryDownloadFailed:      {Reason: "生成结果下载失败", Action: "请稍后重新加载，不要立即重新提交"},
	CategoryResultsMissing:      {Reason: "任务结束但没有可用结果", Action: "请查看详情后再决定是否重试"},
	CategoryMalformedResponse:   {Reason: "模型服务返回了无法解析的内容", Action: "请查看详情并核对原任务状态后，再决定是否重新生成"},
	CategoryUnknown:             {Reason: "生成失败", Action: "请查看详情后再决定是否重试"},
}

var (
	htmlBodyPattern           = regexp.MustCompile(`(?is)^\s*(?:<!doctype|<html|<head|<body)`)
	httpStatusPattern         = regexp.MustCompile(`(?i)(?:HTTP\s+|status(?:\s+code)?\s*[:：]?\s*)(\d{3})\b`)
	wrappedHTTPStatusPattern  = regexp.MustCompile(`(?i)Request failed with status code\s+(\d{3})`)
	urlPattern                = regexp.MustCompile(`(?i)(?:https?://|data:[a-z0-9.+-]+/[^;]+;base64,)[^\s"'<>]+`)
	secretPattern             = regexp.MustCompile(`(?i)(?:\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|password)\b["']?\s*[=:：]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)|\bbearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_.-]{20,})`)
	credentialHeaderPattern   = regexp.MustCompile(`(?im)\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[=:：][^\r\n]*`)
	promptEchoPattern         = regexp.MustCompile(`(?is)(?:\b(?:prompt|input|query)|提示词|输入内容)["']?\s*[=:：].*`)
	signedQueryPattern        = regexp.MustCompile(`(?i)(?:[?&](?:signature|x-amz-signature|x-oss-signature|token|key)=)[^\s&]+`)
	safeIDPattern             = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$`)
	providerCodePattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]*$`)
	unsafeIDPattern           = regexp.MustCompile(`(?i)secret|token|password|apikey|api-key|bearer|sk-`)
	durationRangePattern      = regexp.MustCompile(`(?i)\bduration\s+(?:must\s+be|should\s+be|is\s+required\s+to\s+be)\s+(?:between\s+([0-9]+(?:\.[0-9]+)?)\s*(?:seconds?|secs?|s)?\s+and\s+([0-9]+(?:\.[0-9]+)?)|in\s+(?:the\s+)?range\s*\[?([0-9]+(?:\.[0-9]+)?)\s*[,–-]\s*([0-9]+(?:\.[0-9]+)?)\]?)\s*(?:seconds?|secs?|s)\b`)
	widthRangePattern         = regexp.MustCompile(`(?i)\bwidth\s+(?:must\s+be|should\s+be)\s+between\s+(\d+)\s*(?:px|pixels?)?\s+and\s+(\d+)\s*(?:px|pixels?)`)
	heightRangePattern        = regexp.MustCompile(`(?i)\bheight\s+(?:must\s+be|should\s+be)\s+between\s+(\d+)\s*(?:px|pixels?)?\s+and\s+(\d+)\s*(?:px|pixels?)`)
	aspectRangePattern        = regexp.MustCompile(`(?i)aspect(?:\s*ratio)?\s+(?:must\s+be|should\s+be)\s+between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)`)
	pixelRangePattern         = regexp.MustCompile(`(?i)(?:pixel(?:s)?(?:\s+count)?|total\s+pixels)\s+(?:must\s+be|should\s+be)\s+between\s+(\d+)\s+and\s+(\d+)`)
	requestTooLargePattern    = regexp.MustCompile(`(?i)(?:request\s+(?:body|entity|payload)|payload)\s+(?:is\s+)?too\s+large|(?:request|payload).{0,24}(?:exceeds?|larger than)`)
	singleFileTooLargePattern = regexp.MustCompile(`(?i)(?:file|image|video|audio)\s+too\s+large|(?:file|image|video|audio).{0,24}(?:exceeds?|larger than)\s+\d+`)
)

var providerCodeCategories = map[string]FailureCategory{
	"contentsecuritydetectionerror":  CategoryProviderUnavailable,
	"accountoverdueerror":            CategoryQuotaUpstream,
	"operationdenied.serviceoverdue": CategoryQuotaUpstream,
	"setlimitexceeded":               CategoryQuotaLimit,
	"inflightbatchsizeexceeded":      CategoryConcurrency,
	"modelnotopen":                   CategoryPermission,
	// 中转网关（ai-claude-code-hub）实测码：403 model_not_allowed =「当前账号未开通模型 X」，
	// 与 modelnotopen 同义。必须显式登记：通用启发式按 "model_not" 前缀会把它归成
	// model_missing，进而提示「请检查模型名称和渠道配置」—— 而模型名是对的，缺的是账号开通。
	"model_not_allowed":                CategoryPermission,
	"operationdenied.servicenotopen":   CategoryPermission,
	"invalid_api_key":                  CategoryAuth,
	"invalid_authentication":           CategoryAuth,
	"authentication_error":             CategoryAuth,
	"unauthenticated":                  CategoryAuth,
	"unauthorized":                     CategoryAuth,
	"invalid_api_key_error":            CategoryAuth,
	"permission_denied":                CategoryPermission,
	"forbidden":                        CategoryPermission,
	"access_denied":                    CategoryPermission,
	"model_permission":                 CategoryPermission,
	"insufficient_quota":               CategoryQuotaUnknown,
	"insufficient_balance":             CategoryQuotaUnknown,
	"billing_not_active":               CategoryQuotaUnknown,
	"billing_hard_limit_reached":       CategoryQuotaUpstream,
	"arrearage":                        CategoryQuotaUpstream,
	"allocationquota":                  CategoryQuotaUnknown,
	"quota_exceeded":                   CategoryQuotaUnknown,
	"account_deactivated":              CategoryQuotaUpstream,
	"sensitive_words_detected":         CategoryModerationInput,
	"content_filter":                   CategoryModerationInput,
	"content_filter_error":             CategoryModerationInput,
	"content_policy_violation":         CategoryModerationInput,
	"content_policy":                   CategoryModerationInput,
	"datainspectionfailed":             CategoryModerationInput,
	"prohibited_content":               CategoryModerationInput,
	"safety":                           CategoryModerationInput,
	"blocked_reason_safety":            CategoryModerationInput,
	"invalid_request":                  CategoryInvalidParams,
	"invalid_request_error":            CategoryInvalidParams,
	"invalid_parameter":                CategoryInvalidParams,
	"invalidparameter":                 CategoryInvalidParams,
	"invalid_argument":                 CategoryInvalidParams,
	"requestparameteriswrong":          CategoryInvalidParams,
	"model_capability_not_supported":   CategoryInvalidParams,
	"invalid_model_selection":          CategoryInvalidParams,
	"context_length_exceeded":          CategoryContextTooLong,
	"context_length":                   CategoryContextTooLong,
	"max_tokens":                       CategoryContextTooLong,
	"string_above_max_length":          CategoryContextTooLong,
	"contentlengthexceeded":            CategoryContextTooLong,
	"url_error":                        CategoryInputInaccessible,
	"invalid_image_url":                CategoryInputInaccessible,
	"invalid_image":                    CategoryInputInaccessible,
	"download_error":                   CategoryInputInaccessible,
	"file_too_large":                   CategoryInputTooLarge,
	"payload_too_large":                CategoryInputTooLarge,
	"video_request_body_too_large":     CategoryInputTooLarge,
	"model_not_found":                  CategoryModelMissing,
	"model_not_exist":                  CategoryModelMissing,
	"invalid_model":                    CategoryModelMissing,
	"not_found":                        CategoryModelMissing,
	"model_catalog_mismatch":           CategoryModelMissing,
	"model_route_unavailable":          CategoryProviderUnavailable,
	"rate_limit_exceeded":              CategoryThrottled,
	"rate_limit_error":                 CategoryThrottled,
	"throttling":                       CategoryThrottled,
	"too_many_requests":                CategoryThrottled,
	"resource_exhausted":               CategoryThrottled,
	"channel_concurrency_wait_timeout": CategoryConcurrency,
	"channel_concurrency_unavailable":  CategoryConcurrency,
	"unavailable":                      CategoryProviderUnavailable,
	"overloaded":                       CategoryProviderUnavailable,
	"internal_error":                   CategoryProviderUnavailable,
	"server_error":                     CategoryProviderUnavailable,
	"provider_request_failed":          CategoryUnknown,
	"upstream_timeout":                 CategoryTimeout,
	"deadline_exceeded":                CategoryTimeout,
	"request_timeout":                  CategoryTimeout,
	"requesttimeout":                   CategoryTimeout,
	"request_cancelled":                CategoryCancelled,
	"task_failed":                      CategoryAsyncFailed,
	"provider_query_failed":            CategoryAsyncFailed,
	"provider_submission_unknown":      CategorySubmissionUncertain,
	"video_submission_unknown":         CategorySubmissionUncertain,
	"provider_reference_invalid":       CategoryInputInaccessible,
	"rate_limited":                     CategoryThrottled,
	"bad_gateway":                      CategoryProviderUnavailable,
	"internal":                         CategoryProviderUnavailable,
	"failed_precondition":              CategoryInvalidParams,
	// BeefAPI stable codes: internal failures without a reliable caller action
	// stay explicitly unknown instead of inheriting a misleading HTTP 400.
	"violation_fee.grok.csam":              CategoryModerationInput,
	"count_token_failed":                   CategoryUnknown,
	"model_price_error":                    CategoryUnknown,
	"invalid_api_type":                     CategoryUnknown,
	"json_marshal_failed":                  CategoryUnknown,
	"do_request_failed":                    CategorySubmissionUncertain,
	"get_channel_failed":                   CategoryProviderUnavailable,
	"no_available_channel":                 CategoryProviderUnavailable,
	"gen_relay_info_failed":                CategoryUnknown,
	"channel:no_available_key":             CategoryProviderUnavailable,
	"channel:param_override_invalid":       CategoryUnknown,
	"channel:header_override_invalid":      CategoryUnknown,
	"channel:model_mapped_error":           CategoryUnknown,
	"channel:aws_client_error":             CategoryProviderUnavailable,
	"channel:invalid_key":                  CategoryProviderUnavailable,
	"channel:response_time_exceeded":       CategoryTimeout,
	"read_request_body_failed":             CategoryUnknown,
	"convert_request_failed":               CategoryUnknown,
	"key_site_mismatch":                    CategoryAuth,
	"bad_request_body":                     CategoryInvalidParams,
	"context_media_limit_exceeded":         CategoryContextTooLong,
	"media_request_capacity_exceeded":      CategoryConcurrency,
	"read_response_body_failed":            CategorySubmissionUncertain,
	"bad_response_status_code":             CategoryUnknown,
	"bad_response":                         CategoryMalformedResponse,
	"bad_response_body":                    CategoryMalformedResponse,
	"empty_response":                       CategoryResultsMissing,
	"aws_invoke_error":                     CategoryUnknown,
	"prompt_blocked":                       CategoryModerationInput,
	"responses_encrypted_context_mismatch": CategoryInvalidParams,
	"query_data_error":                     CategoryUnknown,
	"update_data_error":                    CategoryUnknown,
	"insufficient_user_quota":              CategoryQuotaUser,
	"pre_consume_token_quota_failed":       CategoryUnknown,
	"upstream_crowded":                     CategoryThrottled,
	"upstream_unavailable":                 CategoryProviderUnavailable,
	"upstream_rejected":                    CategoryUnknown,
	"upstream_error":                       CategoryUnknown,
}

func (f Failure) ErrorCode() string {
	if f.Category == "" {
		return string(CategoryUnknown)
	}
	return string(f.Category)
}

func (f Failure) UserMessage() string {
	reason, action := f.displayCopy()
	message := joinSentences(reason, action)
	if ids := f.debugIDLine(); ids != "" {
		message = joinSentences(message, ids)
	}
	return message
}

func (f Failure) IsModeration() bool {
	return f.Category == CategoryModerationInput || f.Category == CategoryModerationReference || f.Category == CategoryModerationOutput
}

func (f Failure) BlocksAutomaticRetry() bool {
	if f.Uncertain {
		return true
	}
	switch f.Category {
	case CategoryThrottled, CategoryConcurrency, CategoryProviderUnavailable, CategoryCancelled:
		return false
	default:
		return true
	}
}

func (f Failure) displayCopy() (string, string) {
	if strings.TrimSpace(f.Reason) != "" {
		return strings.TrimSpace(f.Reason), strings.TrimSpace(f.Action)
	}
	copyText := categoryCopies[f.Category]
	if copyText.Reason == "" {
		copyText = categoryCopies[CategoryUnknown]
	}
	return copyText.Reason, copyText.Action
}

func (f Failure) debugIDLine() string {
	parts := make([]string, 0, 2)
	if id := sanitizeDebugID(f.TaskID); id != "" {
		parts = append(parts, "任务 "+id)
	}
	if id := sanitizeDebugID(f.RequestID); id != "" {
		parts = append(parts, "请求 "+id)
	}
	if len(parts) == 0 {
		return ""
	}
	return "排查编号：" + strings.Join(parts, " · ")
}

func joinSentences(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		part = strings.TrimRight(part, "。.;；")
		out = append(out, part)
	}
	if len(out) == 0 {
		return categoryCopies[CategoryUnknown].Reason + "。" + categoryCopies[CategoryUnknown].Action + "。"
	}
	if len(out) == 1 {
		return out[0]
	}
	return strings.Join(out, "。") + "。"
}

func sanitizeDebugID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > maxDebugIDRunes {
		return ""
	}
	if !safeIDPattern.MatchString(value) || unsafeIDPattern.MatchString(value) {
		return ""
	}
	return value
}

func (e HTTPError) Error() string {
	return ClassifyHTTP(e.StatusCode, e.Status, e.Body).UserMessage()
}

func (e PayloadError) Error() string {
	if strings.TrimSpace(e.message) != "" {
		return e.message
	}
	return ClassifyText(e.raw).UserMessage()
}

func ClassifyHTTP(status int, statusText string, body string) Failure {
	failure := ClassifyText(body)
	failure.HTTPStatus = status
	if failure.Category != CategoryUnknown && !failure.FromCode && ((status != 0 && !trustProviderMessageStatus(status)) || (htmlBodyPattern.MatchString(strings.TrimSpace(body)) && status >= 400)) {
		failure.Category = CategoryUnknown
		failure.Reason = ""
		failure.Action = ""
	}
	if failure.Category == CategoryUnknown && !failure.FromCode {
		if category, ok := categoryFromHTTPStatus(status); ok {
			failure.Category = category
			failure.Reason = ""
			failure.Action = ""
		}
	}
	if status == 413 && failure.Category == CategoryInputTooLarge && !singleFileTooLargePattern.MatchString(body) && (failure.Reason == "" || failure.Reason == "参考素材过大") {
		failure.Reason = "整次请求的数据量超过接口上限"
		failure.Action = "请减少参考素材，或改用可公开访问的素材链接后再提交"
	}
	if status == 524 && (failure.Category == CategoryUnknown || failure.Category == CategoryTimeout || failure.Category == CategoryProviderUnavailable || failure.Category == CategoryMalformedResponse) {
		failure.Category = CategoryTimeout
		failure.Uncertain = true
		failure.Reason = "模型服务响应超时，请求可能仍在服务端执行"
		failure.Action = "请先查询原任务或到供应商核对状态，不要立即重新提交"
	}
	// 网关把**上游**的 404 透传过来（实测「请求路径或资源不存在：上游未找到对应端点」）：
	// 模型名与请求路径都正确，只是这一跳被路由到了没有该端点的上游 —— 换个上游就能过。
	// 必须显式覆盖：404 不在 trustProviderMessageStatus 白名单里，消息级判定会被丢弃，
	// 最终落到 404 → model_missing，提示用户去「检查模型名称和渠道配置」，属于误导。
	if status == http.StatusNotFound && mentionsMissingUpstreamEndpoint(body) {
		failure.Category = CategoryProviderUnavailable
		failure.Reason = ""
		failure.Action = ""
	}
	_ = statusText
	return normalizeFailure(failure)
}

func classifyHTTPErrorCause(err error) Failure {
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return ClassifyHTTP(httpErr.StatusCode, httpErr.Status, httpErr.Body)
	}
	if err == nil {
		return normalizeFailure(Failure{Category: CategoryUnknown})
	}
	return ClassifyText(err.Error())
}

func ClassifyError(err error) Failure {
	if err == nil {
		return normalizeFailure(Failure{Category: CategoryUnknown})
	}
	if errors.Is(err, context.Canceled) {
		return normalizeFailure(Failure{Category: CategoryCancelled})
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return normalizeFailure(Failure{Category: CategoryTimeout, Uncertain: true, Reason: "模型服务响应超时，请求可能仍在执行", Action: "请先查询原任务，不要立即重新提交"})
	}
	var pending StatePendingError
	if errors.As(err, &pending) {
		failure := classifyHTTPErrorCause(pending.Cause)
		failure.Category = CategorySubmissionUncertain
		failure.Uncertain = true
		failure.TaskID = firstNonEmpty(failure.TaskID, pending.TaskID)
		failure.Reason = ""
		failure.Action = ""
		return normalizeFailure(failure)
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return ClassifyHTTP(httpErr.StatusCode, httpErr.Status, httpErr.Body)
	}
	var payload PayloadError
	if errors.As(err, &payload) {
		raw := firstNonEmpty(payload.raw, payload.message)
		failure := ClassifyText(raw)
		if payload.message != "" && failure.Category == CategoryUnknown && !failure.Structured {
			return ClassifyText(payload.message)
		}
		return failure
	}
	return ClassifyText(err.Error())
}

func ClassifyText(raw string) Failure {
	failure := Failure{Category: CategoryUnknown}
	text := strings.TrimSpace(raw)
	if text == "" {
		return normalizeFailure(failure)
	}
	if f, ok := persistedModerationCopy(text); ok {
		f.RequestID, f.TaskID = persistedReferenceIDs(text)
		return normalizeFailure(f)
	}
	if copy, ok := referenceDurationCopy(text); ok {
		requestID, taskID := persistedReferenceIDs(text)
		return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: requestID, TaskID: taskID})
	}
	if copy, ok := referenceMediaConstraintCopy(text); ok {
		requestID, taskID := persistedReferenceIDs(text)
		category := CategoryInvalidParams
		if copy.Action != "" && (strings.Contains(copy.Reason, "过大") || strings.Contains(copy.Action, "压缩")) {
			category = CategoryInputTooLarge
		}
		return normalizeFailure(Failure{Category: category, Reason: copy.Reason, Action: copy.Action, RequestID: requestID, TaskID: taskID})
	}
	if htmlBodyPattern.MatchString(text) {
		if status := extractExplicitHTTPStatus(text); status != 0 {
			return ClassifyHTTP(status, "", "")
		}
		return normalizeFailure(Failure{Category: CategoryMalformedResponse})
	}
	fields := extractProviderFields(text)
	if fields.hasStructured() {
		if strings.EqualFold(fields.Code, "invalid_reference_audio") {
			copy, _ := referenceAudioCopy(fields.Message, true)
			return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: fields.RequestID, TaskID: fields.TaskID, ProviderCode: fields.Code, Structured: true, FromCode: true})
		}
		if copy, ok := referenceDurationCopy(fields.Message); ok {
			return normalizeFailure(Failure{Category: CategoryInvalidParams, Reason: copy.Reason, Action: copy.Action, RequestID: fields.RequestID, TaskID: fields.TaskID})
		}
		failure.Structured = true
		failure.ProviderCode = sanitizeProviderCode(fields.Code)
		failure.ProviderMessage = sanitizeProviderText(fields.Message)
		failure.Param = sanitizeProviderCode(fields.Param)
		failure.RequestID = sanitizeDebugID(fields.RequestID)
		failure.TaskID = sanitizeDebugID(fields.TaskID)
		if category, ok := categoryFromProviderCode(fields.Code, fields.Type, fields.Status); ok {
			failure.Category = category
			failure.FromCode = true
			refineInvalidParams(&failure, fields)
			specializeModeration(&failure, fields)
			specializeThinkingToolChoice(&failure, fields)
			specializeDurationRange(&failure, fields)
			specializeMediaConstraints(&failure, fields)
			return normalizeFailure(failure)
		}
		if category, ok := categoryFromProviderMessage(fields.Message + " " + fields.Type + " " + fields.Status); ok {
			failure.Category = category
			specializeModeration(&failure, fields)
			specializeThinkingToolChoice(&failure, fields)
			specializeDurationRange(&failure, fields)
			specializeMediaConstraints(&failure, fields)
			return normalizeFailure(failure)
		}
		// JSON request echoes and debug fields are never classification input.
		return normalizeFailure(failure)
	}
	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		failure.Structured = true
		return normalizeFailure(failure)
	}
	if matched := matchPersistedCategory(text); matched != CategoryUnknown {
		failure.Category = matched
		failure.FromCode = true
		if matched == CategoryTimeout || matched == CategoryDownloadFailed || matched == CategorySubmissionUncertain {
			failure.Uncertain = true
		}
		return normalizeFailure(failure)
	}
	if isMalformedText(text) {
		failure.Category = CategoryMalformedResponse
		return normalizeFailure(failure)
	}
	if category, ok := categoryFromProviderMessage(text); ok {
		failure.Category = category
		failure.Structured = true
		specializeModeration(&failure, extractedFields{Message: text})
		specializeThinkingToolChoice(&failure, extractedFields{Message: text})
		specializeDurationRange(&failure, extractedFields{Message: text})
		specializeMediaConstraints(&failure, extractedFields{Message: text})
		if status := extractExplicitHTTPStatus(text); status != 0 {
			failure.HTTPStatus = status
		}
		return normalizeFailure(failure)
	}
	if isNetworkText(text) {
		failure.Category = CategoryNetwork
		return normalizeFailure(failure)
	}
	if isDownloadText(text) {
		failure.Category = CategoryDownloadFailed
		failure.Uncertain = true
		return normalizeFailure(failure)
	}
	if isCancelledText(text) {
		failure.Category = CategoryCancelled
		return normalizeFailure(failure)
	}
	if isResultsMissingText(text) {
		failure.Category = CategoryResultsMissing
		return normalizeFailure(failure)
	}
	if status := extractExplicitHTTPStatus(text); status != 0 {
		return ClassifyHTTP(status, "", "")
	}
	if looksLikeUserFacingChinese(text) {
		failure.Reason = sanitizeProviderText(text)
		failure.Action = ""
	}
	return normalizeFailure(failure)
}

func ClassifyAppError(status int, code int, reason string, message string) Failure {
	failure := ClassifyHTTP(status, "", firstNonEmpty(message, reason))
	if !failure.Structured && !failure.FromCode {
		category, matched := categoryFromProviderCode(reason)
		switch code {
		case 40301:
			category, matched = CategoryQuotaUnknown, true
		case 42901:
			category, matched = CategoryThrottled, true
		}
		if matched {
			failure.Category = category
			failure.FromCode = true
			failure.Reason, failure.Action = "", ""
		}
	}
	return normalizeFailure(failure)
}

func WithDownloadFailure(failure Failure, taskID string) Failure {
	if failure.Category == CategoryAuth || failure.Category == CategoryPermission || failure.IsModeration() || failure.Category == CategoryInvalidParams {
		failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
		return normalizeFailure(failure)
	}
	failure.Category = CategoryDownloadFailed
	failure.Uncertain = true
	failure.Reason = ""
	failure.Action = ""
	failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
	return normalizeFailure(failure)
}

func WithConcurrencyFailure(failure Failure) Failure {
	if failure.Structured && failure.Category != CategoryUnknown {
		return failure
	}
	failure.Category = CategoryConcurrency
	failure.Reason = ""
	failure.Action = ""
	return normalizeFailure(failure)
}

func CircuitOpenFailure() Failure {
	return normalizeFailure(Failure{
		Category: CategoryProviderUnavailable,
		Reason:   "当前渠道连续失败，已暂时熔断",
		Action:   "请稍后重试",
	})
}

type extractedFields struct {
	ParsedJSON bool
	Code       string
	Type       string
	Status     string
	Message    string
	Param      string
	RequestID  string
	TaskID     string
}

func (f extractedFields) hasStructured() bool {
	return f.ParsedJSON || f.Code != "" || f.Type != "" || f.Message != "" || f.Status != "" || f.RequestID != "" || f.TaskID != ""
}

func extractProviderFields(raw string) extractedFields {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxJSONExtractBytes {
		return extractedFields{}
	}
	// The gateway appends a public request ID outside its JSON error envelope.
	// Strip only that exact suffix; arbitrary trailing text is not trusted JSON.
	suffix := regexp.MustCompile(`(?i)\s*\(request id:\s*([A-Za-z0-9._:-]{6,127})\)\s*$`).FindStringSubmatchIndex(raw)
	requestID := ""
	if suffix != nil {
		requestID = raw[suffix[2]:suffix[3]]
		raw = strings.TrimSpace(raw[:suffix[0]])
	}
	if fields, ok := fieldsFromJSON([]byte(raw)); ok {
		if fields.RequestID == "" {
			fields.RequestID = requestID
		}
		return fields
	}
	for start := 0; start < len(raw); {
		index := strings.Index(raw[start:], "{")
		if index < 0 {
			break
		}
		absolute := start + index
		if fields, ok := fieldsFromJSON([]byte(raw[absolute:])); ok {
			if fields.RequestID == "" {
				fields.RequestID = requestID
			}
			return fields
		}
		start = absolute + 1
	}
	return extractedFields{}
}

func fieldsFromJSON(data []byte) (extractedFields, bool) {
	data = bytesTrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return extractedFields{}, false
	}
	var payload map[string]any
	if json.Unmarshal(data, &payload) != nil {
		return extractedFields{}, false
	}
	fields := walkProviderFields(payload, 0)
	fields.ParsedJSON = true
	return fields, true
}

func walkProviderFields(payload map[string]any, depth int) extractedFields {
	fields := extractedFields{}
	if payload == nil || depth > maxWalkDepth {
		return fields
	}
	fields.Code = firstNonEmpty(fields.Code, allowlistedString(payload["code"]))
	fields.Type = firstNonEmpty(fields.Type, allowlistedString(payload["type"]))
	fields.Status = firstNonEmpty(fields.Status, allowlistedString(payload["status"]))
	fields.Message = firstNonEmpty(fields.Message, allowlistedString(payload["message"]), allowlistedString(payload["msg"]), allowlistedString(payload["detail"]))
	fields.Param = firstNonEmpty(fields.Param, allowlistedString(payload["param"]), allowlistedString(payload["parameter"]))
	fields.RequestID = firstNonEmpty(fields.RequestID, allowlistedString(payload["request_id"]), allowlistedString(payload["requestId"]), allowlistedString(payload["request-id"]))
	fields.TaskID = firstNonEmpty(fields.TaskID, allowlistedString(payload["task_id"]), allowlistedString(payload["taskId"]))
	if nested := mapValue(payload["error"]); nested != nil {
		child := walkProviderFields(nested, depth+1)
		fields = mergeExtracted(child, fields)
	}
	if nested := mapValue(payload["data"]); nested != nil {
		child := walkProviderFields(nested, depth+1)
		fields = mergeExtracted(child, fields)
	}
	if nested := mapValue(payload["output"]); nested != nil {
		child := walkProviderFields(nested, depth+1)
		fields = mergeExtracted(child, fields)
	}
	if nested := mapValue(payload["promptFeedback"]); nested != nil {
		if reason := allowlistedString(nested["blockReason"]); reason != "" {
			fields.Code = firstNonEmpty(fields.Code, reason)
			fields.Message = firstNonEmpty(fields.Message, "blocked by content safety policy")
		}
	}
	return fields
}

func mergeExtracted(primary extractedFields, fallback extractedFields) extractedFields {
	return extractedFields{
		Code:      firstNonEmpty(primary.Code, fallback.Code),
		Type:      firstNonEmpty(primary.Type, fallback.Type),
		Status:    firstNonEmpty(primary.Status, fallback.Status),
		Message:   firstNonEmpty(primary.Message, fallback.Message),
		Param:     firstNonEmpty(primary.Param, fallback.Param),
		RequestID: firstNonEmpty(primary.RequestID, fallback.RequestID),
		TaskID:    firstNonEmpty(primary.TaskID, fallback.TaskID),
	}
}

func allowlistedString(value any) string {
	switch current := value.(type) {
	case string:
		return strings.TrimSpace(current)
	case json.Number:
		return strings.TrimSpace(current.String())
	case float64:
		if current == 0 {
			return ""
		}
		return strings.TrimSpace(strconvTrimFloat(current))
	case int:
		if current == 0 {
			return ""
		}
		return fmt.Sprintf("%d", current)
	case int64:
		if current == 0 {
			return ""
		}
		return fmt.Sprintf("%d", current)
	default:
		return ""
	}
}

func strconvTrimFloat(value float64) string {
	if value == float64(int64(value)) {
		return fmt.Sprintf("%d", int64(value))
	}
	return strings.TrimSpace(fmt.Sprintf("%g", value))
}

func mapValue(value any) map[string]any {
	current, _ := value.(map[string]any)
	return current
}

func bytesTrimSpace(data []byte) []byte {
	return []byte(strings.TrimSpace(string(data)))
}

func categoryFromProviderCode(values ...string) (FailureCategory, bool) {
	for _, value := range values {
		normalized := normalizeCode(value)
		if normalized == "" || normalized == "0" || normalized == "success" || normalized == "succeeded" || normalized == "ok" {
			continue
		}
		if _, ok := categoryCopies[FailureCategory(normalized)]; ok {
			return FailureCategory(normalized), true
		}
		if category, ok := providerCodeCategories[normalized]; ok {
			return category, true
		}
		if f, ok := moderationErrorCopy(normalized, ""); ok {
			return f.Category, true
		}
		if normalized == "sensitivecontentdetected" || strings.HasPrefix(normalized, "sensitivecontentdetected.") {
			return CategoryModerationInput, true
		}
		if strings.Contains(normalized, "content_filter") || strings.Contains(normalized, "contentpolicy") || strings.Contains(normalized, "datainspection") || strings.Contains(normalized, "sensitive_words") {
			return CategoryModerationInput, true
		}
		if strings.Contains(normalized, "insufficient") && (strings.Contains(normalized, "quota") || strings.Contains(normalized, "balance")) {
			return CategoryQuotaUnknown, true
		}
		if strings.Contains(normalized, "rate_limit") || strings.Contains(normalized, "throttl") {
			return CategoryThrottled, true
		}
		if strings.Contains(normalized, "context_length") || strings.Contains(normalized, "max_tokens") {
			return CategoryContextTooLong, true
		}
		if strings.Contains(normalized, "model_not") || strings.Contains(normalized, "invalid_model") {
			return CategoryModelMissing, true
		}
		if strings.Contains(normalized, "auth") && (strings.Contains(normalized, "invalid") || strings.Contains(normalized, "fail") || strings.Contains(normalized, "unauth")) {
			return CategoryAuth, true
		}
		if strings.Contains(normalized, "permission") || strings.Contains(normalized, "forbidden") {
			return CategoryPermission, true
		}
	}
	return "", false
}

// missingUpstreamEndpointPattern 匹配网关透传的「上游没有对应端点」文案
// （实测：「请求路径或资源不存在：上游未找到对应端点」）。
var missingUpstreamEndpointPattern = regexp.MustCompile(`未找到对应端点|请求路径或资源不存在|endpoint not found`)

// mentionsMissingUpstreamEndpoint 判断这段响应是不是「这一跳的上游没有该端点」。
// 这类 404 与「模型名写错」必须分开：前者换一跳就通，应可重试。
func mentionsMissingUpstreamEndpoint(body string) bool {
	return missingUpstreamEndpointPattern.MatchString(strings.ToLower(body))
}

func categoryFromProviderMessage(raw string) (FailureCategory, bool) {
	normalized := strings.ToLower(strings.TrimSpace(promptEchoPattern.ReplaceAllString(raw, "")))
	if normalized == "" {
		return "", false
	}
	if f, ok := moderationErrorCopy("", normalized); ok {
		return f.Category, true
	}
	switch {
	case durationRangePattern.MatchString(normalized),
		widthRangePattern.MatchString(normalized),
		heightRangePattern.MatchString(normalized),
		aspectRangePattern.MatchString(normalized),
		pixelRangePattern.MatchString(normalized):
		return CategoryInvalidParams, true
	case requestTooLargePattern.MatchString(normalized) || singleFileTooLargePattern.MatchString(normalized) || strings.HasPrefix(normalized, "整次请求的数据量超过接口上限"):
		return CategoryInputTooLarge, true
	case strings.Contains(normalized, "thinking") && strings.Contains(normalized, "tool_choice"),
		strings.Contains(normalized, "reasoning") && strings.Contains(normalized, "tool_choice"),
		strings.Contains(normalized, "tool_choice") && (strings.Contains(normalized, "not support") || strings.Contains(normalized, "unsupported")):
		return CategoryInvalidParams, true
	case containsContentSafety(normalized):
		return moderationCategoryFromMessage(normalized), true
	case strings.Contains(normalized, "insufficient_quota") || ((strings.Contains(normalized, "quota") || strings.Contains(normalized, "balance") || strings.Contains(normalized, "额度") || strings.Contains(normalized, "余额") || strings.Contains(normalized, "欠费")) && !strings.Contains(normalized, "rate")):
		if strings.Contains(normalized, "arrearage") || strings.Contains(normalized, "billing_hard_limit") || strings.Contains(normalized, "供应商") {
			return CategoryQuotaUpstream, true
		}
		return CategoryQuotaUnknown, true
	case strings.Contains(normalized, "rate limit") || strings.Contains(normalized, "too many requests") || strings.Contains(normalized, "throttl") || strings.Contains(normalized, "频繁"):
		return CategoryThrottled, true
	case strings.Contains(normalized, "context length") || strings.Contains(normalized, "maximum context") || strings.Contains(normalized, "too many tokens") || strings.Contains(normalized, "max_tokens") || strings.Contains(normalized, "长度") && (strings.Contains(normalized, "最大") || strings.Contains(normalized, "超出")):
		return CategoryContextTooLong, true
	case strings.Contains(normalized, "未找到对应端点") || strings.Contains(normalized, "请求路径或资源不存在") || strings.Contains(normalized, "endpoint not found"):
		// 中转网关把**上游**的 404 透传过来（实测文案：「请求路径或资源不存在：上游未找到对应端点」）。
		// 此时模型名与请求路径都正确，只是这一跳被路由到了没有该端点的上游 —— 换个上游就能过。
		// 必须判定为「供应商不可用（可重试）」；否则会落到 404 → model_missing 的兜底，
		// 把用户引向「检查模型名称和渠道配置」，而那是误导。
		return CategoryProviderUnavailable, true
	case strings.Contains(normalized, "model_not_found") || strings.Contains(normalized, "model not found") || strings.Contains(normalized, "does not exist") && strings.Contains(normalized, "model") || strings.Contains(normalized, "模型不存在") || strings.Contains(normalized, "模型或模型接口不存在"):
		return CategoryModelMissing, true
	case strings.Contains(normalized, "invalid api key") || strings.Contains(normalized, "incorrect api key") || strings.Contains(normalized, "authentication") || strings.Contains(normalized, "unauthorized") || strings.Contains(normalized, "鉴权失败"):
		return CategoryAuth, true
	case strings.Contains(normalized, "permission") && (strings.Contains(normalized, "denied") || strings.Contains(normalized, "model") || strings.Contains(normalized, "access")):
		return CategoryPermission, true
	case strings.Contains(normalized, "url error") || strings.Contains(normalized, "failed to download") || strings.Contains(normalized, "cannot fetch") || strings.Contains(normalized, "invalid image url") || strings.Contains(normalized, "无法读取"):
		return CategoryInputInaccessible, true
	case strings.Contains(normalized, "too large") || strings.Contains(normalized, "payload too large") || strings.Contains(normalized, "file size") || strings.Contains(normalized, "过大"):
		return CategoryInputTooLarge, true
	case strings.Contains(normalized, "invalid") || strings.Contains(normalized, "parameter") || strings.Contains(normalized, "argument") || strings.Contains(normalized, "请检查模型和参数"):
		return CategoryInvalidParams, true
	}
	return "", false
}

func containsContentSafety(normalized string) bool {
	if strings.Contains(normalized, "sensitive_words_detected") || strings.Contains(normalized, "content policy") || strings.Contains(normalized, "content safety") || strings.Contains(normalized, "safety policy") || strings.Contains(normalized, "data inspection") || strings.Contains(normalized, "prohibited_content") || strings.Contains(normalized, "内容安全审核") || strings.Contains(normalized, "内容审核未通过") {
		return true
	}
	if strings.Contains(normalized, "moderation") || strings.Contains(normalized, "blocked by") && (strings.Contains(normalized, "safety") || strings.Contains(normalized, "policy") || strings.Contains(normalized, "content")) {
		return true
	}
	if strings.Contains(normalized, "safety") && (strings.Contains(normalized, "blocked") || strings.Contains(normalized, "violat") || strings.Contains(normalized, "filter")) {
		return true
	}
	return false
}

func moderationCategoryFromMessage(normalized string) FailureCategory {
	if strings.Contains(normalized, "output") && (strings.Contains(normalized, "image") || strings.Contains(normalized, "video") || strings.Contains(normalized, "result")) || strings.Contains(normalized, "生成结果") {
		return CategoryModerationOutput
	}
	if strings.Contains(normalized, "reference image") || strings.Contains(normalized, "input image") || strings.Contains(normalized, "参考图") || strings.Contains(normalized, "参考图片") {
		return CategoryModerationReference
	}
	return CategoryModerationInput
}

func specializeModeration(failure *Failure, fields extractedFields) {
	if f, ok := persistedModerationCopy(fields.Message); ok && (failure.Category == f.Category || (genericProviderCode(fields.Code) && (failure.Category == CategoryUnknown || failure.Category == CategoryInvalidParams))) {
		failure.Category, failure.Reason, failure.Action = f.Category, f.Reason, f.Action
		requestID, taskID := persistedReferenceIDs(fields.Message)
		failure.RequestID = firstNonEmpty(failure.RequestID, requestID)
		failure.TaskID = firstNonEmpty(failure.TaskID, taskID)
		return
	}
	if failure.RequestID == "" {
		if m := regexp.MustCompile(`(?i)\brequest\s*id:\s*([A-Za-z0-9_-]{6,127})\b`).FindStringSubmatch(sanitizeProviderText(fields.Message)); len(m) == 2 {
			failure.RequestID = sanitizeDebugID(m[1])
		}
	}
	if failure.IsModeration() || ((failure.Category == CategoryUnknown || failure.Category == CategoryInvalidParams) && genericProviderCode(fields.Code)) {
		if f, ok := moderationErrorCopy(fields.Code, sanitizeProviderText(fields.Message)); ok {
			failure.Category, failure.Reason, failure.Action = f.Category, f.Reason, f.Action
			return
		}
	}
	if !failure.IsModeration() {
		return
	}
	for _, code := range []string{fields.Code, fields.Type, fields.Status} {
		if _, ok := categoryCopies[FailureCategory(normalizeCode(code))]; ok {
			return
		}
	}
	normalized := strings.ToLower(fields.Message + " " + fields.Code)
	if (strings.Contains(normalized, "prompt") || strings.Contains(normalized, "提示词")) && (strings.Contains(normalized, "reference image") || strings.Contains(normalized, "input image") || strings.Contains(normalized, "参考")) {
		failure.Category = CategoryModerationInput
		failure.Reason = "提示词或参考素材未通过内容安全审核"
		failure.Action = "请调整提示词或参考素材后重新生成"
		return
	}
	failure.Category = moderationCategoryFromMessage(normalized)
}

func genericProviderCode(code string) bool {
	switch normalizeCode(code) {
	case "", "unknown", "failed", "badrequest", "api_error", "upstream_error", "upstream_rejected", "invalid_request", "invalid_request_error", "invalid_parameter", "invalidparameter", "invalid_argument":
		return true
	}
	return regexp.MustCompile(`^\d{3}$`).MatchString(code)
}

func refineInvalidParams(failure *Failure, fields extractedFields) {
	if genericProviderCode(fields.Code) && (failure.Category == CategoryUnknown || failure.Category == CategoryInvalidParams) {
		if category, ok := categoryFromProviderMessage(fields.Message); ok {
			failure.Category = category
		}
	}
	if failure.Category != CategoryInvalidParams {
		return
	}
	if category, ok := categoryFromProviderMessage(fields.Message); ok {
		switch category {
		case CategoryContextTooLong, CategoryInputInaccessible, CategoryInputTooLarge, CategoryModelMissing:
			failure.Category = category
		}
	}
}

func specializeThinkingToolChoice(failure *Failure, fields extractedFields) {
	if failure.Category != CategoryInvalidParams {
		return
	}
	normalized := strings.ToLower(fields.Message + " " + fields.Code)
	if ((strings.Contains(normalized, "thinking") || strings.Contains(normalized, "reasoning")) && strings.Contains(normalized, "tool_choice")) || (strings.Contains(normalized, "tool_choice") && (strings.Contains(normalized, "not support") || strings.Contains(normalized, "unsupported"))) {
		failure.Category = CategoryInvalidParams
		failure.Reason = "当前模型为思考或推理模式，不支持强制工具调用"
		failure.Action = "请改用自动工具选择或更换非思考模式模型"
	}
}

func referenceDurationCopy(text string) (categoryCopy, bool) {
	if copy, ok := referenceAudioCopy(text, false); ok {
		return copy, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 段参考(音频|视频)时长为 (\d+(?:\.\d+)?) 秒[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒`).FindStringSubmatch(text); len(m) == 6 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s 段参考%s时长为 %s 秒", m[1], m[2], m[3]), Action: fmt.Sprintf("需要 %s–%s 秒；请裁剪或更换这段素材后再提交", m[4], m[5])}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) 段参考(音频|视频)的时长无法读取`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s 段参考%s的时长无法读取", m[1], m[2]), Action: "请重新导入素材后再提交"}, true
	}
	if m := regexp.MustCompile(`^参考素材时长不符合模型要求。请检查每段参考音频和视频，将不符合要求的素材调整为 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒`).FindStringSubmatch(text); len(m) == 3 {
		return categoryCopy{Reason: "参考素材时长不符合模型要求", Action: fmt.Sprintf("请检查每段参考音频和视频，将不符合要求的素材调整为 %s–%s 秒后重新提交", m[1], m[2])}, true
	}
	return categoryCopy{}, false
}

func specializeMediaConstraints(failure *Failure, fields extractedFields) {
	message := promptEchoPattern.ReplaceAllString(fields.Message, "")
	if copy, ok := referenceMediaConstraintCopy(message); ok {
		if strings.Contains(copy.Reason, "过大") {
			failure.Category = CategoryInputTooLarge
		} else {
			failure.Category = CategoryInvalidParams
		}
		failure.Reason = copy.Reason
		failure.Action = copy.Action
		return
	}
	if match := heightRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材高度不符合模型要求"
		failure.Action = fmt.Sprintf("请将高度调整为 %s–%s 像素后重新提交", match[1], match[2])
		return
	}
	if match := widthRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材宽度不符合模型要求"
		failure.Action = fmt.Sprintf("请将宽度调整为 %s–%s 像素后重新提交", match[1], match[2])
		return
	}
	if match := aspectRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材宽高比不符合模型要求"
		failure.Action = fmt.Sprintf("请将宽高比调整为 %s–%s 后重新提交", match[1], match[2])
		return
	}
	if match := pixelRangePattern.FindStringSubmatch(message); len(match) == 3 {
		failure.Category = CategoryInvalidParams
		failure.Reason = "参考素材像素总量不符合模型要求"
		failure.Action = "请调整尺寸或更换后再提交"
		return
	}
	if requestTooLargePattern.MatchString(message) || strings.EqualFold(fields.Code, "video_request_body_too_large") || strings.HasPrefix(message, "整次请求的数据量超过接口上限") {
		failure.Category = CategoryInputTooLarge
		failure.Reason = "整次请求的数据量超过接口上限"
		failure.Action = "请减少参考素材，或改用可公开访问的素材链接后再提交"
		return
	}
	if singleFileTooLargePattern.MatchString(message) {
		failure.Category = CategoryInputTooLarge
		failure.Reason = "单个参考文件过大"
		failure.Action = "请压缩或更换该素材后再提交"
	}
}

func referenceMediaConstraintCopy(text string) (categoryCopy, bool) {
	if m := regexp.MustCompile(`^参考素材(宽度|高度|宽高比)不符合模型要求。请将(?:宽度|高度|宽高比)调整为 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)( 像素| )后重新提交`).FindStringSubmatch(text); len(m) == 5 {
		return categoryCopy{Reason: "参考素材" + m[1] + "不符合模型要求", Action: "请将" + m[1] + "调整为 " + m[2] + "–" + m[3] + m[4] + "后重新提交"}, true
	}
	if m := regexp.MustCompile(`^(第 \d+ (?:张|个|段)参考(?:图|视频|音频)(?:宽度|高度|宽高比|时长)为 \d+(?:\.\d+)?(?: 像素| 秒)?)[，。]需要 ((?:至少|不超过) \d+(?:\.\d+)?(?: 像素| 秒)?)`).FindStringSubmatch(text); len(m) == 3 {
		action := "请调整尺寸或更换后再提交"
		if strings.Contains(m[1], "时长") {
			action = "请裁剪或更换这段素材后再提交"
		}
		return categoryCopy{Reason: m[1], Action: "需要 " + m[2] + "；" + action}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)(宽度|高度)为 (\d+) 像素[，。]需要 (\d+)–(\d+) 像素`).FindStringSubmatch(text); len(m) == 8 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s%s为 %s 像素", m[1], m[2], m[3], m[4], m[5]), Action: fmt.Sprintf("需要 %s–%s 像素；请调整尺寸或更换后再提交", m[6], m[7])}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)宽高比为 (\d+(?:\.\d+)?)[，。]需要 (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)`).FindStringSubmatch(text); len(m) == 7 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s宽高比为 %s", m[1], m[2], m[3], m[4]), Action: fmt.Sprintf("需要 %s–%s；请调整尺寸或更换后再提交", m[5], m[6])}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)像素总量`).FindStringSubmatch(text); len(m) == 4 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s像素总量不符合当前模型要求", m[1], m[2], m[3]), Action: "请调整尺寸或更换后再提交"}, true
	}
	if m := regexp.MustCompile(`^第 (\d+) (张|个|段)参考(图|视频|音频)文件过大[，。]当前模型单文件上限为 ([^；;]+)`).FindStringSubmatch(text); len(m) == 5 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s %s参考%s文件过大", m[1], m[2], m[3]), Action: fmt.Sprintf("当前模型单文件上限为 %s；请压缩或更换后再提交", m[4])}, true
	}
	if strings.HasPrefix(text, "整次请求的参考素材合计过大") {
		return categoryCopy{Reason: "整次请求的参考素材合计过大", Action: "请减少素材后再提交"}, true
	}
	return categoryCopy{}, false
}

func specializeDurationRange(failure *Failure, fields extractedFields) {
	if failure.Category != CategoryInvalidParams {
		return
	}
	// Only a provider's explicit numeric range with units becomes advice. Prompt
	// echoes are excluded so user input cannot invent a model constraint.
	message := promptEchoPattern.ReplaceAllString(fields.Message, "")
	match := durationRangePattern.FindStringSubmatch(message)
	if len(match) != 5 {
		return
	}
	minimum, maximum := firstNonEmpty(match[1], match[3]), firstNonEmpty(match[2], match[4])
	minValue, minErr := strconv.ParseFloat(minimum, 64)
	maxValue, maxErr := strconv.ParseFloat(maximum, 64)
	if minErr != nil || maxErr != nil || minValue < 0 || minValue >= maxValue || maxValue > 86400 {
		return
	}
	failure.Reason = "视频时长不符合模型要求"
	failure.Action = fmt.Sprintf("请将时长调整为 %s–%s 秒后重试", minimum, maximum)
	if strings.Contains(message, "素材") || strings.Contains(strings.ToLower(message), "reference") || strings.Contains(strings.ToLower(message), "audio") {
		failure.Reason = "参考素材时长不符合模型要求"
		failure.Action = fmt.Sprintf("请检查每段参考音频和视频，将不符合要求的素材调整为 %s–%s 秒后重新提交", minimum, maximum)
	}
}

func trustProviderMessageStatus(status int) bool {
	if status >= 200 && status < 300 {
		return true
	}
	switch status {
	case http.StatusBadRequest, http.StatusPaymentRequired, http.StatusConflict, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity, http.StatusTooManyRequests, 451:
		return true
	}
	return false
}

func categoryFromHTTPStatus(status int) (FailureCategory, bool) {
	switch status {
	case http.StatusUnauthorized:
		return CategoryAuth, true
	case http.StatusForbidden:
		return CategoryPermission, true
	case http.StatusPaymentRequired:
		return CategoryQuotaUnknown, true
	case http.StatusNotFound:
		return CategoryModelMissing, true
	case http.StatusRequestTimeout, http.StatusGatewayTimeout, 524:
		return CategoryTimeout, true
	case http.StatusConflict:
		return CategoryInvalidParams, true
	case http.StatusRequestEntityTooLarge:
		return CategoryInputTooLarge, true
	case http.StatusUnprocessableEntity, http.StatusBadRequest:
		return CategoryInvalidParams, true
	case http.StatusTooManyRequests:
		return CategoryThrottled, true
	case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable:
		return CategoryProviderUnavailable, true
	}
	if status >= 500 {
		return CategoryProviderUnavailable, true
	}
	return CategoryUnknown, status != 0
}

func extractExplicitHTTPStatus(raw string) int {
	for _, pattern := range []*regexp.Regexp{httpStatusPattern, wrappedHTTPStatusPattern} {
		match := pattern.FindStringSubmatch(raw)
		if len(match) < 2 {
			continue
		}
		status := 0
		for _, digit := range match[1] {
			status = status*10 + int(digit-'0')
		}
		if status >= 400 && status <= 599 {
			return status
		}
	}
	return 0
}

func isNetworkText(value string) bool {
	return regexp.MustCompile(`(?i)\b(?:dial tcp|connection refused|connection reset|no such host|i/o timeout|network error|failed to fetch|fetch failed|socket hang up|econnrefused|econnreset|etimedout|连接模型服务失败)\b`).MatchString(value)
}

func isMalformedText(value string) bool {
	return regexp.MustCompile(`(?i)(?:接口返回非 JSON|没有返回有效 JSON|invalid character|unexpected end of json|<!doctype|<html)`).MatchString(value)
}

func isDownloadText(value string) bool {
	return strings.Contains(value, "视频结果下载失败") || strings.Contains(value, "下载失败") && strings.Contains(value, "结果")
}

func isCancelledText(value string) bool {
	return strings.Contains(value, "任务已取消") || strings.Contains(value, "请求已取消") || strings.Contains(strings.ToLower(value), "context canceled")
}

func isResultsMissingText(value string) bool {
	return strings.Contains(value, "没有返回图片") || strings.Contains(value, "没有返回视频") || strings.Contains(value, "没有可用结果") || strings.Contains(value, "接口没有返回")
}

func matchPersistedCategory(text string) FailureCategory {
	if strings.HasPrefix(text, "提示词或参考素材未通过内容安全审核") {
		return CategoryModerationInput
	}
	if strings.HasPrefix(text, "视频时长不符合模型要求") {
		return CategoryInvalidParams
	}
	for category, copyText := range categoryCopies {
		if category == CategoryUnknown {
			continue
		}
		if strings.HasPrefix(text, copyText.Reason) {
			return category
		}
	}
	if strings.Contains(text, "真人形象") {
		return CategoryModerationReference
	}
	if strings.Contains(text, "不支持强制工具调用") {
		return CategoryInvalidParams
	}
	if strings.Contains(text, "可能仍在服务端执行") || strings.Contains(text, "请勿立即重试") {
		return CategoryTimeout
	}
	return CategoryUnknown
}

func looksLikeUserFacingChinese(value string) bool {
	for _, r := range value {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

func normalizeCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "_")
	value = strings.ReplaceAll(value, " ", "_")
	return value
}

func sanitizeProviderCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if !providerCodePattern.MatchString(value) || utf8.RuneCountInString(value) > maxProviderCodeRunes {
		return ""
	}
	normalized := normalizeCode(value)
	if _, ok := providerCodeCategories[normalized]; ok {
		return value
	}
	if _, ok := categoryCopies[FailureCategory(normalized)]; ok {
		return value
	}
	if unsafeIDPattern.MatchString(value) {
		return ""
	}
	return value
}

func sanitizeProviderText(value string) string {
	value = html.UnescapeString(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	if htmlBodyPattern.MatchString(value) {
		return ""
	}
	value = urlPattern.ReplaceAllString(value, "")
	value = signedQueryPattern.ReplaceAllString(value, "")
	value = credentialHeaderPattern.ReplaceAllString(value, "[已隐藏]")
	value = secretPattern.ReplaceAllString(value, "")
	value = promptEchoPattern.ReplaceAllString(value, "[已隐藏]")
	value = strings.Join(strings.Fields(value), " ")
	if strings.HasPrefix(value, "{") || strings.HasPrefix(value, "<") {
		return ""
	}
	return truncateRunes(value, maxSanitizedRunes)
}

func applyRetryable(failure *Failure) {
	switch failure.Category {
	case CategoryThrottled, CategoryProviderUnavailable, CategoryNetwork, CategoryTimeout, CategoryConcurrency:
		failure.Retryable = !failure.Uncertain
	default:
		failure.Retryable = false
	}
}

func normalizeFailure(failure Failure) Failure {
	if failure.Category == "" {
		failure.Category = CategoryUnknown
	}
	if failure.IsModeration() {
		failure.Retryable = false
	}
	if failure.Category == CategorySubmissionUncertain {
		failure.Uncertain = true
	}
	applyRetryable(&failure)
	reason, action := failure.displayCopy()
	failure.Reason = reason
	failure.Action = action
	return failure
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 || value == "" {
		return ""
	}
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
