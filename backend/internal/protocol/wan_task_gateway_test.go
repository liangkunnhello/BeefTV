package protocol

import (
	"context"
	"testing"
)

// 依据 Model Studio「Wan3.0 视频生成 API 参考」（2026-10-12 核对）：
// input.media[].type 的合法枚举为 first_frame / last_frame / reference_image /
// reference_video / reference_audio / file / link —— **没有 driving_audio，也没有 video**。
// 上游对枚举是严格校验的（ratio 就有过实测被拒的先例），因此这里锁死宿主实际发出的 type。
func TestWanGatewayMediaTypesMatchOfficialContract(t *testing.T) {
	adapter := officialPackageAdapter(t, "wan-task-gateway.beeftv-plugin", "wan-task-gateway-video")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model:       "wan3.0-video",
		Prompt:      "海边日落，镜头缓慢推移",
		Operation:   "reference_to_video",
		AspectRatio: "adaptive",
		Resolution:  "720p",
		Duration:    10,
		Watermark:   true,
		Images:      []MediaReference{{URL: "https://cdn.example/a.png", Role: "reference_image", Order: 1}},
		Videos:      []MediaReference{{URL: "https://cdn.example/b.mp4", Role: "reference_video", Order: 1}},
		Audios:      []MediaReference{{URL: "https://cdn.example/c.mp3", Role: "reference_audio", Order: 1}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/wan/video-generation/video-synthesis" {
		t.Fatalf("create = %#v", create)
	}
	if create.Headers["X-DashScope-Async"] != "enable" {
		t.Fatalf("官方要求必须带 X-DashScope-Async: enable，实际 %#v", create.Headers)
	}

	body := manifestTestBody(t, create)
	input, _ := body["input"].(map[string]any)
	if input["prompt"] != "海边日落，镜头缓慢推移" {
		t.Fatalf("input.prompt = %#v", input["prompt"])
	}
	media, _ := input["media"].([]any)
	if len(media) != 3 {
		t.Fatalf("media = %#v，期望 图/视频/音频 各 1 项", media)
	}
	wantTypes := []string{"reference_image", "reference_video", "reference_audio"}
	for index, want := range wantTypes {
		entry, _ := media[index].(map[string]any)
		if entry["type"] != want {
			t.Fatalf("media[%d].type = %#v, want %q（官方枚举里没有 driving_audio/video）", index, entry["type"], want)
		}
	}

	parameters, _ := body["parameters"].(map[string]any)
	if parameters["resolution"] != "720P" {
		t.Fatalf("resolution 必须大写 P，实际 %#v", parameters["resolution"])
	}
	if parameters["ratio"] != "adaptive" {
		t.Fatalf("ratio = %#v", parameters["ratio"])
	}
	if parameters["duration"] != float64(10) {
		t.Fatalf("duration 必须是数字（整数秒），实际 %#v", parameters["duration"])
	}
	if parameters["watermark"] != true || parameters["prompt_extend"] != true {
		t.Fatalf("watermark/prompt_extend = %#v", parameters)
	}
	// 尚未发送官方 `audio`（默认 true 与官方一致），一旦发送必须同步放开能力开关。
	if _, present := parameters["audio"]; present {
		t.Fatalf("本版未发送 audio，实际 %#v", parameters)
	}
}

// 图生视频（i2v）：确认宿主确实把画布上的比例/分辨率发了出去。
// 2026-10-12 实测发现 happyhorse i2v 的**产出比例跟随首帧参考图**（参考图 2304x1728=4:3 →
// 产出 1108x832=4:3），与请求里的 ratio 无关 —— 这是上游行为（官方文档：
// 图生视频「实际宽高比由首帧图像决定，resolution 控制总像素量」）。
// 本测试锁住「我们这边没有漏发参数」，避免以后把上游行为误判成前端参数丢失。
func TestWanGatewaySendsRatioAndResolutionForImageToVideo(t *testing.T) {
	adapter := officialPackageAdapter(t, "wan-task-gateway.beeftv-plugin", "wan-task-gateway-video")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model:       "happyhorse-1.1-i2v",
		Prompt:      "走在街上",
		Operation:   "image_to_video",
		AspectRatio: "16:9",
		Resolution:  "720p",
		Duration:    6,
		Images:      []MediaReference{{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, create)
	parameters, _ := body["parameters"].(map[string]any)
	if parameters["ratio"] != "16:9" {
		t.Fatalf("图生视频也必须带上画布比例，实际 %#v", parameters["ratio"])
	}
	if parameters["resolution"] != "720P" {
		t.Fatalf("分辨率必须大写 P，实际 %#v", parameters["resolution"])
	}
	if parameters["duration"] != float64(6) {
		t.Fatalf("duration = %#v", parameters["duration"])
	}
	input, _ := body["input"].(map[string]any)
	media, _ := input["media"].([]any)
	if len(media) != 1 {
		t.Fatalf("media = %#v", media)
	}
	entry, _ := media[0].(map[string]any)
	if entry["type"] != "first_frame" {
		t.Fatalf("首帧参考图应映射为 first_frame，实际 %#v", entry["type"])
	}
}

// 缺省 ratio 必须是 16:9：happyhorse 在 2026-10-09 实测拒绝 `adaptive`
// （返回 InvalidParameter）。wan3.0 虽然官方默认 adaptive，但两者共用本协议。
func TestWanGatewayDefaultsToWideRatio(t *testing.T) {
	adapter := officialPackageAdapter(t, "wan-task-gateway.beeftv-plugin", "wan-task-gateway-video")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "happyhorse-1.1-i2v", Prompt: "猫在窗台打盹",
	}})
	if err != nil {
		t.Fatal(err)
	}
	parameters, _ := manifestTestBody(t, create)["parameters"].(map[string]any)
	if parameters["ratio"] != "16:9" {
		t.Fatalf("缺省 ratio 必须是 16:9，实际 %#v", parameters["ratio"])
	}
	if parameters["resolution"] != "720P" {
		t.Fatalf("缺省 resolution = %#v", parameters["resolution"])
	}
	if _, present := parameters["duration"]; present {
		t.Fatalf("时长未提供时不应发送 duration，实际 %#v", parameters)
	}
}
