package model

// IsVolcengineArkImageProtocol 识别官方 Ark 图片与 Agent Plan 图片协议。
func IsVolcengineArkImageProtocol(protocol ChannelInterfaceType) bool {
	return protocol == ChannelInterfaceVolcengineArkImage || protocol == ChannelInterfaceVolcengineArkAgentPlanImage
}

// IsVolcengineArkVideoProtocol 识别官方 Ark 视频、Agent Plan 视频，以及中转网关的豆包 Seedance 协议。
// 中转网关的 body 与官方 Ark 一致，只是路径前缀落在 /v1 下，因此共用同一套 Ark 语义
// （参考素材约束、duration=-1 自适应、请求体体积上限等）。
func IsVolcengineArkVideoProtocol(protocol ChannelInterfaceType) bool {
	return protocol == ChannelInterfaceVolcengineArkVideo ||
		protocol == ChannelInterfaceVolcengineArkAgentPlanVideo ||
		protocol == ChannelInterfaceArkTaskGatewayVideo
}
