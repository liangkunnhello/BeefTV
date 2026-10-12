package modelcatalog

import "strings"

// isWanGatewayVideoProtocol 判定「阿里系经中转网关」的声明式视频协议。
// 该协议没有内置 ChannelInterface 常量（纯声明式插件，见 plugin-packages/wan-task-gateway），
// 因此按字符串比较。
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
