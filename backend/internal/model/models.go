package model

import (
	"time"
)

type TaskStatus string
type ProviderCancelStatus string
type UserRole string
type UserStatus string
type ChannelScope string
type ChannelInterfaceType string
type ApiCallStatus string
type ResourceStatus string
type ResourceDeletionStatus string
type ProjectStatus string
type ProjectUnitKind string
type ProjectUnitStatus string
type AssetCategory string
type AssetVersionStatus string
type WorkflowStatus string
type WorkflowStepStatus string

// AdminAuditEvent 只允许追加，用于还原管理员写操作，禁止作为可编辑业务状态使用。
type AdminAuditEvent struct {
	ID           string    `json:"id" gorm:"primaryKey;size:36"`
	ActorUserID  string    `json:"actorUserId" gorm:"index;size:36"`
	Action       string    `json:"action" gorm:"index;size:80"`
	TargetType   string    `json:"targetType" gorm:"index;size:40"`
	TargetID     string    `json:"targetId" gorm:"index;size:160"`
	Summary      string    `json:"summary" gorm:"size:500"`
	MetadataJSON string    `json:"metadataJson" gorm:"type:text"`
	CreatedAt    time.Time `json:"createdAt" gorm:"index"`
}

const (
	TaskStatusQueued    TaskStatus = "queued"
	TaskStatusRunning   TaskStatus = "running"
	TaskStatusSucceeded TaskStatus = "succeeded"
	TaskStatusFailed    TaskStatus = "failed"
	TaskStatusCancelled TaskStatus = "cancelled"
	// text_replay 任务是前端自管、不经过 worker 队列的文本生成存档容器：
	// 前端直连模型流式生成，把增量 POST 到 /tasks/:id/text-deltas 存档，
	// 完成后调用 /tasks/:id/text-replay-complete 归并为最终正文。
	TaskStatusTextReplay TaskStatus = "text_replay"

	UserRoleAdmin UserRole = "admin"
	UserRoleUser  UserRole = "user"

	UserStatusActive   UserStatus = "active"
	UserStatusDisabled UserStatus = "disabled"

	ChannelScopeSystem ChannelScope = "system"
	ChannelScopeUser   ChannelScope = "user"

	ChannelInterfaceChatCompletion              ChannelInterfaceType = "chat-completion"
	ChannelInterfaceOpenAIResponse              ChannelInterfaceType = "openai-response"
	ChannelInterfaceClaudeAPI                   ChannelInterfaceType = "claude-api"
	ChannelInterfaceOpenAIImage                 ChannelInterfaceType = "openai-image"
	ChannelInterfaceGrokImage                   ChannelInterfaceType = "grok-image"
	ChannelInterfaceVolcengineArkImage          ChannelInterfaceType = "volcengine-ark-image"
	ChannelInterfaceVolcengineArkAgentPlanImage ChannelInterfaceType = "volcengine-ark-agent-plan-image"
	ChannelInterfaceVolcengineJiMengImage       ChannelInterfaceType = "volcengine-jimeng-image"
	ChannelInterfaceGeminiImage                 ChannelInterfaceType = "gemini-image"
	ChannelInterfaceOpenAIAudio                 ChannelInterfaceType = "openai-audio"
	ChannelInterfaceAsyncAudio                  ChannelInterfaceType = "async-audio"
	ChannelInterfaceNewAPIVideo                 ChannelInterfaceType = "newapi"
	ChannelInterfaceNewAPIChannel1              ChannelInterfaceType = "newapi-channel-1"
	ChannelInterfaceNewAPIChannel2              ChannelInterfaceType = "newapi-channel-2"
	ChannelInterfaceXAIVideo                    ChannelInterfaceType = "xai-video"
	ChannelInterfaceVolcengineArkVideo          ChannelInterfaceType = "volcengine-ark-video"
	ChannelInterfaceVolcengineArkAgentPlanVideo ChannelInterfaceType = "volcengine-ark-agent-plan-video"
	ChannelInterfaceVolcengineJiMengVideo       ChannelInterfaceType = "volcengine-jimeng-video"
	ChannelInterfaceGeminiVeo                   ChannelInterfaceType = "gemini-veo"
	ChannelInterfaceNovitaVideo                 ChannelInterfaceType = "novita-video"
	ChannelInterfaceMiniMaxVideo                ChannelInterfaceType = "minimax-video"
	ChannelInterfaceAgnesVideo                  ChannelInterfaceType = "agnes-video"
	ChannelInterfaceRunningHubImage             ChannelInterfaceType = "runninghub-workflow-image"
	ChannelInterfaceRunningHubVideo             ChannelInterfaceType = "runninghub-workflow-video"
	ChannelInterfaceRunningHubAudio             ChannelInterfaceType = "runninghub-workflow-audio"

	// ChannelInterfaceArkTaskGatewayVideo 面向前置中转网关的豆包 Seedance 任务式视频协议：
	// body 与官方 Ark 完全一致，但网关把厂商原生路径统一挂到 /v1 下，
	// 即 /v1/contents/generations/tasks，而非官方 Ark 的 /api/v3/contents/generations/tasks。
	ChannelInterfaceArkTaskGatewayVideo ChannelInterfaceType = "ark-task-gateway-video"

	ApiCallStatusSucceeded ApiCallStatus = "succeeded"
	ApiCallStatusFailed    ApiCallStatus = "failed"

	ResourceStatusPending ResourceStatus = "pending"
	ResourceStatusReady   ResourceStatus = "ready"
	ResourceStatusFailed  ResourceStatus = "failed"
	ResourceStatusDeleted ResourceStatus = "deleted"

	// 播放副本转码状态：空串/"none" = 无需转码（H.264 等可直接播放）。
	PlaybackStatusNone       = "none"
	PlaybackStatusProcessing = "processing"
	PlaybackStatusReady      = "ready"
	PlaybackStatusFailed     = "failed"

	ResourceDeletionStatusPending    ResourceDeletionStatus = "pending"
	ResourceDeletionStatusProcessing ResourceDeletionStatus = "processing"

	ProviderCancelStatusRequested ProviderCancelStatus = "requested"
	ProviderCancelStatusConfirmed ProviderCancelStatus = "confirmed"
	ProviderCancelStatusUncertain ProviderCancelStatus = "uncertain"

	ProjectStatusActive   ProjectStatus = "active"
	ProjectStatusArchived ProjectStatus = "archived"

	ProjectUnitKindChapter ProjectUnitKind = "chapter"
	ProjectUnitKindEpisode ProjectUnitKind = "episode"

	ProjectUnitStatusDraft     ProjectUnitStatus = "draft"
	ProjectUnitStatusReady     ProjectUnitStatus = "ready"
	ProjectUnitStatusCompleted ProjectUnitStatus = "completed"

	AssetCategoryCharacter   AssetCategory = "character"
	AssetCategoryEnvironment AssetCategory = "environment"
	AssetCategoryProp        AssetCategory = "prop"
	AssetCategoryMaterial    AssetCategory = "material"
	AssetCategoryOther       AssetCategory = "other"

	AssetVersionStatusDraft     AssetVersionStatus = "draft"
	AssetVersionStatusReview    AssetVersionStatus = "review"
	AssetVersionStatusConfirmed AssetVersionStatus = "confirmed"
	AssetVersionStatusArchived  AssetVersionStatus = "archived"

	WorkflowStatusActive    WorkflowStatus = "active"
	WorkflowStatusCompleted WorkflowStatus = "completed"
	WorkflowStatusFailed    WorkflowStatus = "failed"

	WorkflowStepStatusPending   WorkflowStepStatus = "pending"
	WorkflowStepStatusReady     WorkflowStepStatus = "ready"
	WorkflowStepStatusRunning   WorkflowStepStatus = "running"
	WorkflowStepStatusReview    WorkflowStepStatus = "review"
	WorkflowStepStatusCompleted WorkflowStepStatus = "completed"
	WorkflowStepStatusFailed    WorkflowStepStatus = "failed"
	WorkflowStepStatusSkipped   WorkflowStepStatus = "skipped"
)
