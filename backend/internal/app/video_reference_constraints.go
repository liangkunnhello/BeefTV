package app

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
)

var opaqueVideoAssetPattern = regexp.MustCompile(`^asset://[A-Za-z0-9_-]+$`)

func referenceDurationIsOpaqueAsset(media providerMedia) bool {
	return media.DurationMs == 0 && !strings.HasPrefix(media.StorageKey, "resource:") && opaqueVideoAssetPattern.MatchString(strings.TrimSpace(media.URL))
}

const (
	officialSeedanceImageMinEdge    = 300
	officialSeedanceImageMaxEdge    = 6000
	officialSeedanceImageMinAspect  = 0.4
	officialSeedanceImageMaxAspect  = 2.5
	officialSeedanceVideoMinPixels  = 409600
	officialSeedanceVideoMaxPixels  = 8295044
	officialSeedanceMinAudioSeconds = 1.8
)

// isWanGatewayVideoProtocol 判定「阿里系经中转网关」的声明式视频协议。
// 该协议没有内置 ChannelInterface 常量（纯声明式插件），因此按字符串比较。
func isWanGatewayVideoProtocol(protocol string) bool {
	return strings.TrimSpace(protocol) == "wan-task-gateway-video"
}

// isWan3VideoModel 判定万相 3.0 视频模型。
// 官方文档（Model Studio「Wan3.0 视频生成」）：wan3.0-video / wan3.0-video-prime
// 的 parameters.duration 取 2–30 秒整数；其分辨率档位为 480P/720P/1080P。
// `wan-3.0` 是网关侧文档给出的同族别名（2026-10-12 实测该 Key 下无可用上游，
// 但模型 ID 被网关识别），一并按 3.0 处理，避免上游开通后还要再改一次。
func isWan3VideoModel(modelName string) bool {
	switch strings.ToLower(strings.TrimSpace(modelName)) {
	case "wan3.0-video", "wan3.0-video-prime", "wan-3.0":
		return true
	default:
		return false
	}
}

func isSeedance2Family(protocol, modelName string) bool {
	normalizedProtocol := strings.TrimSpace(protocol)
	if normalizedProtocol != "newapi-channel-2" && normalizedProtocol != "newapi" && normalizedProtocol != "openai" && !model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(normalizedProtocol)) {
		return false
	}
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "seedance-2")
}

func isSeedance25Model(modelName string) bool {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(modelName)), "/")
	base := parts[len(parts)-1]
	return base == "seedance-2.5" || base == "seedance-2.5-self-developed" || strings.HasPrefix(base, "doubao-seedance-2-5") || strings.HasPrefix(base, "doubao-seedance-2.5")
}

func overlayOfficialSeedance2References(base VideoReferenceConfig, is25 bool) VideoReferenceConfig {
	refs := base
	if is25 {
		refs.MaxImages = 30
		refs.MaxVideos = 10
		refs.MaxAudios = 10
		refs.MaxVideoDuration = 30
		refs.MaxAudioDuration = 30
		refs.MaxAudioTotalDuration = 30
		refs.MaxVideoTotalDuration = 30
	} else {
		refs.MaxImages = 9
		refs.MaxVideos = 3
		refs.MaxAudios = 3
		refs.MaxVideoDuration = 15
		refs.MaxAudioDuration = 15
		refs.MaxAudioTotalDuration = 15
		refs.MaxVideoTotalDuration = 15
	}
	refs.MinVideoDuration = 2
	refs.MinAudioDuration = officialSeedanceMinAudioSeconds
	if refs.MaxImageBytes <= 0 {
		refs.MaxImageBytes = 30 * 1024 * 1024
	}
	refs.MaxVideoBytes = 200 * 1024 * 1024
	refs.MaxAudioBytes = 15 * 1024 * 1024
	refs.MinImageWidth, refs.MaxImageWidth = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinImageHeight, refs.MaxImageHeight = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinImageAspect, refs.MaxImageAspect = officialSeedanceImageMinAspect, officialSeedanceImageMaxAspect
	refs.MinVideoWidth, refs.MaxVideoWidth = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinVideoHeight, refs.MaxVideoHeight = officialSeedanceImageMinEdge, officialSeedanceImageMaxEdge
	refs.MinVideoAspect, refs.MaxVideoAspect = officialSeedanceImageMinAspect, officialSeedanceImageMaxAspect
	refs.MinVideoPixels, refs.MaxVideoPixels = officialSeedanceVideoMinPixels, officialSeedanceVideoMaxPixels
	return refs
}

func validateVideoReferenceMedia(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	if profile == nil {
		return BadAuthRequest("当前视频模型能力参数无效")
	}
	refs := profile.References
	if len(input.ReferenceImages) > refs.MaxImages {
		return BadAuthRequest(fmt.Sprintf("当前视频模型最多支持 %d 张参考图", refs.MaxImages))
	}
	if len(input.ReferenceVideos) > refs.MaxVideos {
		return BadAuthRequest(fmt.Sprintf("当前视频模型最多支持 %d 个参考视频", refs.MaxVideos))
	}
	if len(input.ReferenceAudios) > refs.MaxAudios {
		return BadAuthRequest(fmt.Sprintf("当前视频模型最多支持 %d 段参考音频", refs.MaxAudios))
	}
	if !videoCapabilityAllowsAudioOnly(profile) && len(input.ReferenceAudios) > 0 && len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 {
		return BadAuthRequest("当前视频模型不支持只用音频生成视频，请同时添加参考图片或参考视频")
	}
	if len(input.ReferenceImages) < refs.MinImages {
		return BadAuthRequest(fmt.Sprintf("当前视频模型至少需要 %d 张参考图", refs.MinImages))
	}
	for index, media := range input.ReferenceImages {
		if err := validateReferenceFileBytes("图", index, media.Bytes, refs.MaxImageBytes); err != nil {
			return err
		}
		if err := validateReferenceGeometry("图", index, media.Width, media.Height, refs.MinImageWidth, refs.MaxImageWidth, refs.MinImageHeight, refs.MaxImageHeight, refs.MinImageAspect, refs.MaxImageAspect, refs.MinImagePixels, refs.MaxImagePixels); err != nil {
			return err
		}
	}
	var totalVideoMs int64
	for index, media := range input.ReferenceVideos {
		totalVideoMs += media.DurationMs
		if err := validateReferenceDurationUnlessOpaqueAsset("视频", index, media, float64(refs.MinVideoDuration), float64(refs.MaxVideoDuration)); err != nil {
			return err
		}
		if err := validateReferenceFileBytes("视频", index, media.Bytes, refs.MaxVideoBytes); err != nil {
			return err
		}
		if err := validateReferenceGeometry("视频", index, media.Width, media.Height, refs.MinVideoWidth, refs.MaxVideoWidth, refs.MinVideoHeight, refs.MaxVideoHeight, refs.MinVideoAspect, refs.MaxVideoAspect, refs.MinVideoPixels, refs.MaxVideoPixels); err != nil {
			return err
		}
	}
	if maximum := refs.MaxVideoTotalDuration; maximum > 0 && totalVideoMs > int64(maximum)*1000 {
		return BadAuthRequest(fmt.Sprintf("参考视频总时长为 %.2f 秒，当前模型最多支持 %d 秒；请裁剪或减少参考视频后再提交", float64(totalVideoMs)/1000, maximum))
	}
	var totalAudioMs int64
	for index, media := range input.ReferenceAudios {
		if err := validateReferenceDurationUnlessOpaqueAsset("音频", index, media, refs.MinAudioDuration, float64(refs.MaxAudioDuration)); err != nil {
			return err
		}
		if err := validateReferenceFileBytes("音频", index, media.Bytes, refs.MaxAudioBytes); err != nil {
			return err
		}
		totalAudioMs += media.DurationMs
	}
	if maximum := refs.MaxAudioTotalDuration; maximum > 0 && totalAudioMs > int64(maximum)*1000 {
		return BadAuthRequest(fmt.Sprintf("参考音频总时长为 %.2f 秒，当前模型最多支持 %d 秒；请裁剪或减少参考音频后再提交", float64(totalAudioMs)/1000, maximum))
	}
	return nil
}

func validateReferenceFileBytes(kind string, index int, bytes, maximum int64) error {
	if maximum <= 0 || bytes <= 0 || bytes <= maximum {
		return nil
	}
	unit := "张"
	if kind != "图" {
		unit = "个"
		if kind == "音频" {
			unit = "段"
		}
	}
	return BadAuthRequest(fmt.Sprintf("第 %d %s参考%s文件过大，当前模型单文件上限为 %s；请压缩或更换后再提交", index+1, unit, kind, formatMediaByteLimit(maximum)))
}

func validateReferenceDurationUnlessOpaqueAsset(kind string, index int, media providerMedia, minimum, maximum float64) error {
	if referenceDurationIsOpaqueAsset(media) {
		return nil
	}
	return validateReferenceDuration(kind, index, media.DurationMs, minimum, maximum)
}

func validateReferenceGeometry(kind string, index, width, height, minWidth, maxWidth, minHeight, maxHeight int, minAspect, maxAspect float64, minPixels, maxPixels int64) error {
	if width <= 0 || height <= 0 {
		return nil
	}
	unit := "张"
	if kind != "图" {
		unit = "个"
	}
	label := fmt.Sprintf("第 %d %s参考%s", index+1, unit, kind)
	if minWidth > 0 && width < minWidth || maxWidth > 0 && width > maxWidth {
		return BadAuthRequest(fmt.Sprintf("%s宽度为 %d 像素，需要 %s 像素；请调整尺寸或更换后再提交", label, width, referenceBound(float64(minWidth), float64(maxWidth))))
	}
	if minHeight > 0 && height < minHeight || maxHeight > 0 && height > maxHeight {
		return BadAuthRequest(fmt.Sprintf("%s高度为 %d 像素，需要 %s 像素；请调整尺寸或更换后再提交", label, height, referenceBound(float64(minHeight), float64(maxHeight))))
	}
	aspect := float64(width) / float64(height)
	if minAspect > 0 && aspect < minAspect || maxAspect > 0 && aspect > maxAspect {
		return BadAuthRequest(fmt.Sprintf("%s宽高比为 %.2f，需要 %s；请调整尺寸或更换后再提交", label, aspect, referenceBound(minAspect, maxAspect)))
	}
	pixels := int64(width) * int64(height)
	if minPixels > 0 && pixels < minPixels || maxPixels > 0 && pixels > maxPixels {
		return BadAuthRequest(fmt.Sprintf("%s像素总量为 %d，不符合当前模型要求；请调整尺寸或更换后再提交", label, pixels))
	}
	return nil
}

func referenceBound(min, max float64) string {
	if min <= 0 {
		return "不超过 " + formatDurationBound(max)
	}
	if max <= 0 {
		return "至少 " + formatDurationBound(min)
	}
	return formatDurationBound(min) + "–" + formatDurationBound(max)
}

func formatMediaByteLimit(bytes int64) string {
	if bytes%(1024*1024) == 0 {
		return fmt.Sprintf("%dMB", bytes/(1024*1024))
	}
	return fmt.Sprintf("%d 字节", bytes)
}

func formatDurationBound(value float64) string {
	if value == math.Trunc(value) {
		return strconv.Itoa(int(value))
	}
	return strconv.FormatFloat(value, 'f', 1, 64)
}

func durationLimitMs(seconds float64) int64 {
	return int64(math.Round(seconds * 1000))
}

func videoCapabilityAllowsAudioOnly(profile *VideoCapabilityConfig) bool {
	if profile == nil {
		return false
	}
	return containsCapabilityString(profile.Operations, "audio_to_video")
}
