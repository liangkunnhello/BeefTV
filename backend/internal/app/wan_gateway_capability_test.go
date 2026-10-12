package app

import (
	"slices"
	"testing"
)

// 阿里系中转网关（wan-task-gateway-video）的能力画像合同。
// 依据：Model Studio「Wan3.0 视频生成」官方文档（2026-10-12 核对）——
// parameters.duration 为 2–30 秒整数、resolution 为 480P/720P/1080P、ratio 支持 adaptive。
// 注意：必须与前端 `web/src/lib/model-capabilities.ts` 的同名分支保持一致。

func TestWanGatewayVideoCapabilityProfile(t *testing.T) {
	// `wan-3.0` 是网关文档里的同族别名，必须与 wan3.0-video 拿到同一份画像。
	for _, name := range []string{"wan3.0-video", "wan3.0-video-prime", "wan-3.0"} {
		profile := DefaultModelCapabilityConfigForModel("wan-task-gateway-video", name).Video
		if profile == nil || profile.Duration.Max != 30 {
			t.Fatalf("%s 时长上限应为 30，实际 %#v", name, profile)
		}
		if !slices.Contains(profile.Ratios, "adaptive") {
			t.Fatalf("%s 应支持 adaptive，实际 %#v", name, profile.Ratios)
		}
	}
	wan3 := DefaultModelCapabilityConfigForModel("wan-task-gateway-video", "wan3.0-video").Video
	if wan3 == nil {
		t.Fatal("wan-task-gateway-video 必须给出视频能力画像")
	}
	if wan3.Duration.Selection != "range" || wan3.Duration.Min != 2 || wan3.Duration.Max != 30 {
		t.Fatalf("wan3.0-video 时长应为 2–30 秒整数，实际 %#v", wan3.Duration)
	}
	if !slices.Contains(wan3.Ratios, "adaptive") {
		t.Fatalf("wan3.0-video 画幅应支持 adaptive（官方默认值），实际 %#v", wan3.Ratios)
	}
	if !slices.Contains(wan3.Ratios, "21:9") {
		t.Fatalf("wan3.0-video 画幅应支持 21:9（官方枚举值），实际 %#v", wan3.Ratios)
	}
	for _, resolution := range []string{"480p", "720p", "1080p"} {
		if !slices.Contains(wan3.Resolutions, resolution) {
			t.Fatalf("wan3.0-video 缺少分辨率 %s，实际 %#v", resolution, wan3.Resolutions)
		}
	}
	if !wan3.Watermark.Supported {
		t.Fatal("wan3.0-video 应支持 watermark 开关")
	}
	// 本版不发送官方 `audio`，因此不放开「生成音频」开关（避免「开关无效」的假能力）。
	if wan3.GenerateAudio.Supported {
		t.Fatalf("未发送 audio 时不应放开 generateAudio，实际 %#v", wan3.GenerateAudio)
	}
	for _, operation := range []string{"text_to_video", "image_to_video", "reference_to_video", "video_to_video"} {
		if !slices.Contains(wan3.Operations, operation) {
			t.Fatalf("wan3.0-video 缺少操作 %s，实际 %#v", operation, wan3.Operations)
		}
	}

	// happyhorse 的枚举与 wan3.0 不同：时长保守维持 2–15，且实测拒绝 adaptive。
	happyhorse := DefaultModelCapabilityConfigForModel("wan-task-gateway-video", "happyhorse-1.1-i2v").Video
	if happyhorse.Duration.Max != 15 {
		t.Fatalf("happyhorse 时长上限应保守维持 15，实际 %d", happyhorse.Duration.Max)
	}
	if slices.Contains(happyhorse.Ratios, "adaptive") {
		t.Fatalf("happyhorse 不得给出 adaptive（实测被拒），实际 %#v", happyhorse.Ratios)
	}
	for _, ratio := range []string{"16:9", "9:16", "5:4", "4:5", "9:21", "21:9"} {
		if !slices.Contains(happyhorse.Ratios, ratio) {
			t.Fatalf("happyhorse 缺少实测可用画幅 %s，实际 %#v", ratio, happyhorse.Ratios)
		}
	}

	// 其它协议不应被这条画像影响。
	if other := DefaultModelCapabilityConfigForModel("ark-task-gateway-video", "doubao-seedance-2.0").Video; slices.Contains(other.Ratios, "adaptive") {
		t.Fatalf("adaptive 不应泄漏到其它协议，实际 %#v", other.Ratios)
	}
}
