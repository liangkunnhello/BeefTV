// 本地开发旁路配置（本文件不属于上游仓库，随时可删）。
//
// 为什么需要它：
//   v1.7.16 把「整份画布文档提交」挪到了操作层 POST /api/ops/canvas.document.commit，
//   而操作层与 /api/assistant/ui-session 都要求可信身份（见 backend/internal/handler/agent_ops.go
//   的 resolveCaller 与 agent_ui_session.go）。身份有三种：已登记的 Agent 客户端、
//   owner 凭据（请求头 X-Beeftv-Owner）、受信任的桌面界面（Wails 注入的 launch token +
//   UI bootstrap token）。纯浏览器运行时 bootstrapDesktopRuntime() 拿不到桌面令牌，
//   于是这两个入口一律 403 —— 表现就是画布保存失败、生成前报「画布尚未保存，未开始生成」。
//
//   本文件给 Vite 的 /api 代理补上 X-Beeftv-Owner 头，让浏览器模式以 owner 身份授权。
//
// 为什么不直接改 web/vite.config.ts：
//   避免改动上游文件，拉取新版本时不会冲突。
//
// 用法（由 一键启动_BeefTV.command 自动带上）：
//   cd web && VITE_API_PROXY_TARGET=http://127.0.0.1:8082 \
//     bun run dev -- --host 127.0.0.1 --port 8081 --config vite.config.local-owner.ts
//
// 令牌来源：优先环境变量 BEEFTV_OWNER_TOKEN，否则读 <数据目录>/agent_owner_token。
// 数据目录：环境变量 BEEFTV_DATA_DIR，默认 ../.local/project-workbench-debug。
//
// ⚠️ 安全边界：这个头等于本机 owner 权限，所以 dev server 必须只绑 127.0.0.1
//    （一键启动脚本已固定 --host 127.0.0.1）。不要把它暴露到局域网。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type UserConfig } from "vite";

import base from "./vite.config.ts";

const webDir = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.BEEFTV_DATA_DIR?.trim() || resolve(webDir, "../.local/project-workbench-debug");

function resolveOwnerToken(): string {
    const fromEnv = process.env.BEEFTV_OWNER_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
        return readFileSync(resolve(dataDir, "agent_owner_token"), "utf8").trim();
    } catch {
        return "";
    }
}

const ownerToken = resolveOwnerToken();

export default mergeConfig(
    base,
    defineConfig({
        server: {
            proxy: {
                "/api": {
                    ...(ownerToken ? { headers: { "X-Beeftv-Owner": ownerToken } } : {}),
                },
            },
        },
    }) as UserConfig,
);
