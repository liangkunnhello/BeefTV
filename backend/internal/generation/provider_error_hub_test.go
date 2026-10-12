package generation_test

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
)

// 中转网关（ai-claude-code-hub.jetmobo.com）错误响应的归类合同。
// 响应体为 2026-10-12 实测抓取，改动归类规则时以此为准。
func TestHubGatewayErrorClassification(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		category   generation.FailureCategory
		wantReason string
	}{
		{
			// 403 {"error":{"code":"model_not_allowed"}} ——「当前账号未开通模型 X」
			name:       "账号未开通模型归为权限，而不是模型名错误",
			status:     403,
			body:       `{"error":{"message":"当前账号未开通模型 gpt-image-9，请联系管理员开通后重试 (cch_session_id: sess_x)","type":"model_not_allowed","code":"model_not_allowed","details":{"model":"gpt-image-9"}}}`,
			category:   generation.CategoryPermission,
			wantReason: "权限",
		},
		{
			// 503 {"error":{"code":"service_unavailable_error"}} ——「所有供应商暂时不可用」
			name:       "无可用上游归为供应商不可用且允许重试",
			status:     503,
			body:       `{"error":{"message":"所有供应商暂时不可用，请稍后重试 (cch_session_id: sess_y)","type":"service_unavailable_error","code":"service_unavailable_error"}}`,
			category:   generation.CategoryProviderUnavailable,
			wantReason: "暂时不可用",
		},
		{
			// one-api / new-api 系网关的经典无上游码（该系列其它渠道也会返回）
			name:       "经典无上游码同样归为供应商不可用",
			status:     503,
			body:       `{"error":{"code":"no_available_providers","message":"no available providers"}}`,
			category:   generation.CategoryProviderUnavailable,
			wantReason: "",
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			failure := generation.ClassifyHTTP(item.status, "", item.body)
			if failure.Category != item.category {
				t.Fatalf("category = %s, want %s", failure.Category, item.category)
			}
			if item.wantReason != "" && !strings.Contains(failure.UserMessage(), item.wantReason) {
				t.Fatalf("userMessage = %q, want it to contain %q", failure.UserMessage(), item.wantReason)
			}
			// 「账号未开通」是可行动失败（换模型/找管理员），不是可重试的偶发故障。
			if item.category == generation.CategoryPermission && !failure.BlocksAutomaticRetry() {
				t.Fatalf("permission failure must block automatic retry")
			}
		})
	}
}
