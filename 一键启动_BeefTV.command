#!/bin/bash
# =====================================================================
# BeefTV 一键启动（macOS）· 新版 beeftv
# ---------------------------------------------------------------------
# 用法：在「访达」里双击本文件；或终端执行 ./一键启动_BeefTV.command
#
# 端口布局（本脚本与旧实例共存的关键）：
#   前端 Vite（你访问的入口）  http://localhost:8081
#   后端 Go API（内部，不对外开放） http://127.0.0.1:8082
#   —— 旧实例 <桌面>/BeefTV 用的是 3000 + 8080，两边互不冲突，可同时运行。
#   想改端口：BEEFTV_WEB_PORT=9001 BEEFTV_BACKEND_PORT=9002 ./一键启动_BeefTV.command
#
# 它做什么（按顺序）：
#   1. 准备 Go —— 本机没装就用项目内 .local/go，都没有才自动下载到项目内（不碰系统、不需要 Homebrew）
#   2. 准备 Bun —— 前端运行时，缺了就报错并给出一条安装命令
#   3. 准备前端依赖 —— 只在 web/node_modules 缺失时跑 bun install --frozen-lockfile
#   4. 打包官方插件 —— plugin-packages/*.beeftv-plugin 是运行时依赖且被 .gitignore 忽略
#                          （新克隆的仓库必然缺，缺了会报「接口类型 X 未安装」）
#   5. 编译后端 Go → .local/bin/beeftv-server
#   5.5 编译随包 CLI → .local/bin/cli/beeftv（外部工具接入 BeefTV MCP 必需）
#   6. 起后端 :8082 → 起前端 :8081 → 都就绪后自动打开浏览器
#
# 数据目录：.local/project-workbench-debug   （与旧实例、官方 start-local.ps1 同口径）
# 日志：    .local/logs/{backend-build,backend,frontend,plugin-packages}.log
# 停止：    双击「一键停止_BeefTV.command」
#
# 口径来源（改动前请先读）：
#   · <桌面>/BeefTV/一键启动_BeefTV.command  —— 旧实例的同名脚本，本脚本按端口改口径
#   · scripts/start-local.ps1                —— 官方 Windows 一键启动（浏览器模式）
#   · scripts/beeftv-shared-dev.sh           —— 官方「浏览器预览 + Wails 桌面」统一开发脚本
#   · docs/desktop-local-development.md
#   注意：桌面（Wails）模式需要额外系统组件，本脚本走**浏览器模式**，依赖更少。
#
# 可用环境变量覆盖：
#   BEEFTV_WEB_PORT / BEEFTV_BACKEND_PORT / BEEFTV_GO_DIR / BEEFTV_NO_OPEN=1
#
# ⚠️ 改本文件的铁律：变量展开一律写成 ${VAR} 带花括号。
#    macOS 自带 /bin/bash 是 3.2，它会把 $VAR 紧跟的中文/全角字符的多字节字节
#    吞进变量名 → 报「VARxx: unbound variable」（本脚本初次运行时就在「$WPID）」
#    这一处踩过）。同样原因，别让 $VAR 后面紧跟中文标点。
# =====================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BEEFTV_BACKEND_PORT:-8082}"
WEB_PORT="${BEEFTV_WEB_PORT:-8081}"
DATA_DIR="$ROOT/.local/project-workbench-debug"
CACHE_DIR="$ROOT/.local/cache"
BIN_DIR="$ROOT/.local/bin"
RUN_DIR="$ROOT/.local/run"
LOG_DIR="$ROOT/.local/logs"
GO_DIR="${BEEFTV_GO_DIR:-$ROOT/.local/go}"
GO_MIN_MAJOR_MINOR="1.25"

# 双击启动时 PATH 往往不含这些位置 —— 先补上，否则明明装了也找不到。
# /usr/bin:/usr/sbin 放在前面，保证 zip / lsof 用系统自带的，而不是被会话注入的代理 shim 顶掉。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:$HOME/.bun/bin:$HOME/.local/bin:$GO_DIR/bin:$PATH"

B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
CY=$'\033[0;36m'; GR=$'\033[0;32m'; YE=$'\033[0;33m'; RD=$'\033[0;31m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$GR" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YE" "$R" "$*"; }
die()  { printf '\n%s✗ %s%s\n\n' "$RD" "$*" "$R"; [ -t 0 ] && { printf '按回车关闭…'; read -r _ || true; }; exit 1; }

cd "$ROOT" || die "进不去项目目录：$ROOT"

say "${B}BeefTV 一键启动（新版）${R}"
say "${DIM}项目：$ROOT${R}"
say "${DIM}入口：http://localhost:$WEB_PORT   ·   后端：http://127.0.0.1:$BACKEND_PORT${R}"

mkdir -p "$DATA_DIR" "$CACHE_DIR" "$BIN_DIR" "$RUN_DIR" "$LOG_DIR"

# 随包 CLI 的构建（「已在运行」分支与正常启动分支都要用，抽成函数避免两处漂移）。
# 外部工具（Codex / Claude Code / Cursor）接入 BeefTV MCP 靠它；后端 bundledCLIPath() 找的是
# <beeftv-server 同级>/cli/beeftv。接口每次请求实时 stat 该文件，构建完不需要重启后端。
build_cli() {
  local gobin=""
  if command -v go >/dev/null 2>&1; then gobin="$(command -v go)"
  elif [ -x "$GO_DIR/bin/go" ]; then gobin="$GO_DIR/bin/go"; fi
  [ -n "$gobin" ] || return 1
  mkdir -p "$BIN_DIR/cli"
  ( cd "$ROOT/backend" \
    && GOCACHE="$CACHE_DIR/go-build" GOMODCACHE="$CACHE_DIR/go-mod" GOTOOLCHAIN=local \
       "$gobin" build -o "$BIN_DIR/cli/beeftv" ./cmd/beeftv ) >>"$LOG_DIR/backend-build.log" 2>&1 || return 1
  chmod 755 "$BIN_DIR/cli/beeftv"
  return 0
}

# ---------------------------------------------------------------- 0. 已在运行？
port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

BPID_F="$RUN_DIR/backend.pid"; WPID_F="$RUN_DIR/frontend.pid"
B_ALIVE=0; W_ALIVE=0
pid_alive "$(cat "$BPID_F" 2>/dev/null)" && B_ALIVE=1
pid_alive "$(cat "$WPID_F" 2>/dev/null)" && W_ALIVE=1
if [ "$B_ALIVE" = 1 ] && [ "$W_ALIVE" = 1 ]; then
  ok "检测到新版 BeefTV 已经在运行（后端 pid $(cat "$BPID_F")、前端 pid $(cat "$WPID_F")）"
  # 已经跑起来了但随包 CLI 缺失（例如手工删过、或装在旧版脚本之后）→ 就地补上，
  # 否则 Agents 页会一直显示「安装文件不完整」。不需要重启后端。
  if [ ! -x "$BIN_DIR/cli/beeftv" ]; then
    step "补齐随包 CLI（外部工具接入 BeefTV MCP 用）"
    if build_cli; then ok "CLI 已就绪：${DIM}$BIN_DIR/cli/beeftv${R}"
    else warn "CLI 构建失败（日志：$LOG_DIR/backend-build.log）—— 外部工具仍无法接入"; fi
  fi
  [ "${BEEFTV_NO_OPEN:-0}" = 1 ] || open "http://localhost:$WEB_PORT" 2>/dev/null
  say ""
  say "已经帮你把页面打开了：${CY}http://localhost:${WEB_PORT}${R}"
  say "${DIM}要重启用「一键停止_BeefTV.command」，再跑本脚本。${R}"
  exit 0
fi

# ---------------------------------------------------------------- 1. Go
step "准备 Go（要求 ≥ ${GO_MIN_MAJOR_MINOR}，backend/go.mod 写的是 1.25.0）"
GO_BIN=""
if command -v go >/dev/null 2>&1; then
  GO_BIN="$(command -v go)"
  ok "用系统已装的 Go：$("$GO_BIN" version | awk '{print $3}')  ${DIM}($GO_BIN)${R}"
elif [ -x "$GO_DIR/bin/go" ]; then
  GO_BIN="$GO_DIR/bin/go"
  ok "用项目内置的 Go：$("$GO_BIN" version | awk '{print $3}')  ${DIM}($GO_BIN)${R}"
else
  warn "本机没有 Go —— 下载到项目内 ${DIM}$GO_DIR${R}（不装进系统、不需要 Homebrew）"
  case "$(uname -m)" in
    arm64|aarch64) GARCH="arm64" ;;
    x86_64)        GARCH="amd64" ;;
    *) die "不认识的 CPU 架构：$(uname -m)" ;;
  esac
  if [ "$(uname -s)" != "Darwin" ]; then
    die "本脚本只覆盖 macOS（当前 $(uname -s)）。Linux 可自行下载 go*tar.gz 解到 ${GO_DIR}。"
  fi

  FILE=""
  for MIRROR in "https://go.dev/dl/" "https://golang.google.cn/dl/"; do
    JSON="$(curl -fsSL --max-time 30 "${MIRROR}?mode=json" 2>/dev/null)" || continue
    FILE="$(printf '%s' "$JSON" | tr ',' '\n' \
            | grep -oE "go[0-9]+\.[0-9.]+\.darwin-${GARCH}\.tar\.gz" | head -1)"
    [ -n "$FILE" ] && { DL_BASE="$MIRROR"; break; }
  done
  [ -n "$FILE" ] || FILE="go1.27.1.darwin-${GARCH}.tar.gz"   # 取不到清单时的兜底版本
  [ -n "${DL_BASE:-}" ] || DL_BASE="https://go.dev/dl/"

  say "  ${DIM}下载 ${FILE}（约 70–90 MB，只在第一次跑）…${R}"
  TMP_TGZ="$CACHE_DIR/$FILE"
  if [ ! -s "$TMP_TGZ" ]; then
    curl -fL --progress-bar --max-time 900 -o "$TMP_TGZ" "${DL_BASE}${FILE}" \
      || curl -fL --progress-bar --max-time 900 -o "$TMP_TGZ" "https://golang.google.cn/dl/${FILE}" \
      || die "Go 下载失败。可手动下载 ${DL_BASE}${FILE} 解压到 ${GO_DIR} 后重试。"
  fi
  rm -rf "$GO_DIR"
  tar -C "$(dirname "$GO_DIR")" -xzf "$TMP_TGZ" || die "解压 Go 失败：${TMP_TGZ}"
  GO_BIN="$GO_DIR/bin/go"
  [ -x "$GO_BIN" ] || die "解压后没找到 ${GO_BIN}"
  ok "Go 就绪：$("$GO_BIN" version | awk '{print $3}')  ${DIM}($GO_BIN)${R}"
fi

# ---------------------------------------------------------------- 2. Bun
step "准备前端运行时 Bun"
BUN_BIN=""
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN_BIN" ]; then
  die "没找到 bun。装一个再回来（一条命令）：
    curl -fsSL https://bun.sh/install | bash
  装完重开一个终端（或重新双击本文件）即可。"
fi
ok "Bun 就绪：$("$BUN_BIN" --version)  ${DIM}($BUN_BIN)${R}"

# ---------------------------------------------------------------- 3. 前端依赖
step "准备前端依赖"
if [ -x "$ROOT/web/node_modules/.bin/vite" ]; then
  ok "web/node_modules 已就绪，跳过安装"
else
  warn "web/node_modules 不存在 —— 执行 bun install --frozen-lockfile（第一次较慢）"
  ( cd "$ROOT/web" && "$BUN_BIN" install --frozen-lockfile ) \
    || die "bun install 失败。可手动进 web/ 跑一次 bun install 看详细报错。"
  ok "前端依赖装好了"
fi

# ---------------------------------------------------------------- 3.5 官方插件包
# 协议插件（*.beeftv-plugin）是**运行时依赖**，而且被 .gitignore 忽略：
# 只有 plugin-packages/<插件>/ 源码目录，没有归档的话，后端启动时会扫到 0 个官方插件，
# 于是任何走插件协议的渠道（如 newapi-channel-2 / seedance）都会报「接口类型 X 未安装」。
step "准备官方插件包"
PKG_DIR="$ROOT/plugin-packages"
PKG_STAMP="$CACHE_DIR/plugin-packages.stamp"
pkg_count() { find "$PKG_DIR" -maxdepth 1 -name '*.beeftv-plugin' -type f 2>/dev/null | wc -l | tr -d ' '; }
pkg_src_count() { find "$PKG_DIR" -mindepth 2 -maxdepth 2 -name manifest.json -type f 2>/dev/null | wc -l | tr -d ' '; }
# 比 mtime 更省事也更准：有任何插件源文件比 stamp 新，就认为需要重新打包
pkg_stale() {
  find "$PKG_DIR" -mindepth 2 -type f \
       \( -name manifest.json -o -name '*.md' -o -path '*/docs/*' -o -path '*/assets/*' \
          -o -path '*/web/*' -o -path '*/backend/*' \) \
       -newer "$PKG_STAMP" -print -quit 2>/dev/null
}
NEED_PKG=1
if [ "$(pkg_count)" = "$(pkg_src_count)" ] && [ "$(pkg_count)" != 0 ] && [ -f "$PKG_STAMP" ]; then
  [ -z "$(pkg_stale)" ] && NEED_PKG=0
fi
if [ "$NEED_PKG" = 0 ]; then
  ok "官方插件包已是最新（$(pkg_count) 个）"
else
  # zip 判定：优先系统自带 /usr/bin/zip，避免被会话注入的代理 shim 顶掉
  ZIP_OK=0
  command -v zip >/dev/null 2>&1 && ZIP_OK=1
  [ "$ZIP_OK" = 1 ] || { [ -x /usr/bin/zip ] && ZIP_OK=1; }
  if ! command -v node >/dev/null 2>&1; then
    warn "没找到 node，无法打包官方插件 —— 本次启动所有插件协议渠道都会报「接口类型…未安装」"
    warn "装好 node（或 bun）后重新双击本文件即可；也可用 CANVAS_OFFICIAL_PLUGIN_DIR 指向已有插件包目录。"
  elif [ "$ZIP_OK" = 0 ]; then
    warn "没找到 zip，无法打包官方插件 —— 同上，插件协议渠道会不可用"
  elif ( cd "$PKG_DIR" && PATH="/usr/bin:/bin:$PATH" sh ./build-packages.sh ) >"$LOG_DIR/plugin-packages.log" 2>&1; then
    touch "$PKG_STAMP"
    ok "官方插件包已生成 / 刷新（$(pkg_count) 个）"
  else
    warn "官方插件包打包失败（日志：$LOG_DIR/plugin-packages.log），插件协议渠道可能不可用"
    tail -15 "$LOG_DIR/plugin-packages.log" 2>/dev/null
  fi
fi

# ---------------------------------------------------------------- 4. 端口
step "检查端口"
for PORT in "$BACKEND_PORT" "$WEB_PORT"; do
  HOLDER="$(port_pid "$PORT")"
  if [ -n "$HOLDER" ]; then
    ROLE="后端"; [ "$PORT" = "$WEB_PORT" ] && ROLE="前端"
    die "${ROLE}端口 ${PORT} 已被占用（pid ${HOLDER}：$(ps -o command= -p "$HOLDER" 2>/dev/null | cut -c1-90)）
  先跑「一键停止_BeefTV.command」，或手动：kill ${HOLDER}
  若占用者是旧实例（<桌面>/BeefTV，占 3000 与 8080），本次新实例的端口不应撞上；确认是不是改过端口。"
  fi
done
ok "端口 ${WEB_PORT}（前端・入口）与 ${BACKEND_PORT}（后端）都空着"

# ---------------------------------------------------------------- 5. 编译后端
step "编译后端（有 .local/cache/go-mod 时通常几十秒）"
SERVER_BIN="$BIN_DIR/beeftv-server"
if ( cd "$ROOT/backend" \
     && GOCACHE="$CACHE_DIR/go-build" GOMODCACHE="$CACHE_DIR/go-mod" GOTOOLCHAIN=local \
        "$GO_BIN" build -o "$SERVER_BIN" ./cmd/server ) >"$LOG_DIR/backend-build.log" 2>&1; then
  ok "编译完成：${DIM}${SERVER_BIN}${R}"
else
  say "${RD}—— 编译失败，日志末尾 ——${R}"
  tail -25 "$LOG_DIR/backend-build.log"
  die "后端编译失败（完整日志：$LOG_DIR/backend-build.log）"
fi

# ---------------------------------------------------------------- 5.5 构建随包 CLI
# 「BeefTV MCP」（Agents 页）要连 Codex / Claude Code / Cursor，靠的是随包 CLI
# cmd/beeftv（含 MCP go-sdk）。后端的 bundledCLIPath() 找的是 <beeftv-server 同级>/cli/beeftv，
# 只编译 cmd/server 的话这个文件不存在 → 接口回 cli.available=false → 点「连接」被拒
# 「安装文件不完整，无法连接外部工具」。所以这里一并构建。
# 接口每次请求实时 stat 该文件，构建完不需要重启后端。
step "构建随包 CLI（外部工具接入 BeefTV MCP 用）"
if build_cli; then
  ok "CLI 就绪：${DIM}$BIN_DIR/cli/beeftv${R}"
else
  warn "CLI 构建失败 —— Agents 页会显示「安装文件不完整」，外部工具无法接入"
  warn "日志：$LOG_DIR/backend-build.log；可手动 cd backend && go build -o ../.local/bin/cli/beeftv ./cmd/beeftv"
fi

# ---------------------------------------------------------------- 6. 起后端
step "启动后端 API（:${BACKEND_PORT}）"
: >"$LOG_DIR/backend.log"
# CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS：放行本机上游。
# 后端默认策略拒绝环回/私有地址（internal/outbound/outbound.go 的 blockedOutboundIP），
# 不放行的话，把渠道 baseUrl 指向 http://127.0.0.1:8866（瀚海视频板块）会在发出请求前
# 就被 SSRF 校验挡掉，界面只报「网络连接失败 / 类别 network」，极易误判成上游挂了。
# 这里只放行本机两个写法，不放宽到全部私有网段。
( cd "$ROOT/backend" && \
  CANVAS_BACKEND_ADDR="127.0.0.1:$BACKEND_PORT" \
  CANVAS_BACKEND_DATA_DIR="$DATA_DIR" \
  CANVAS_OFFICIAL_PLUGIN_DIR="$PKG_DIR" \
  CANVAS_DATABASE_DRIVER=sqlite \
  CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS="127.0.0.1,localhost" \
  CANVAS_CORS_ORIGINS="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT,http://127.0.0.1:8866,http://localhost:8866" \
  BEEFTV_ALLOWED_ORIGINS="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT" \
  GOCACHE="$CACHE_DIR/go-build" GOMODCACHE="$CACHE_DIR/go-mod" GOTOOLCHAIN=local \
  nohup "$SERVER_BIN" >>"$LOG_DIR/backend.log" 2>&1 </dev/null & echo $! >"$BPID_F" )
BPID="$(cat "$BPID_F" 2>/dev/null)"
sleep 1
pid_alive "$BPID" || { tail -25 "$LOG_DIR/backend.log"; die "后端进程起不来（pid ${BPID}），日志：$LOG_DIR/backend.log"; }

printf '  等后端就绪'
READY=0
for i in $(seq 1 120); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/health/ready" >/dev/null 2>&1; then READY=1; break; fi
  pid_alive "$BPID" || break
  printf '.'; sleep 1
done
printf '\n'
[ "$READY" = 1 ] || { tail -25 "$LOG_DIR/backend.log"; die "后端 60 秒内没就绪（pid ${BPID}），日志：$LOG_DIR/backend.log"; }
ok "后端已就绪：${CY}http://127.0.0.1:$BACKEND_PORT${R}  ${DIM}(/api/health/ready 200)${R}"
# pid 文件里原本记的是包装进程（子 shell），真正的服务进程是监听该端口的那个。
# 记真实 pid，停止 / 重启才精确。
REAL_BPID="$(port_pid "$BACKEND_PORT")"
[ -n "$REAL_BPID" ] && { BPID="$REAL_BPID"; echo "$BPID" >"$BPID_F"; }

# ---------------------------------------------------------------- 7. 起前端
step "启动前端 Vite（:${WEB_PORT}）"
: >"$LOG_DIR/frontend.log"
# --config vite.config.local-owner.ts（本仓库新增的旁路配置，不属于上游）：
#   v1.7.16 把「整份画布文档提交」挪到了操作层 POST /api/ops/canvas.document.commit，
#   该入口与 /api/assistant/ui-session 都要求可信身份；纯浏览器拿不到 Wails 桌面令牌，
#   于是 403 → 画布保存失败 → 生成前报「画布尚未保存，未开始生成」。
#   旁路配置给 Vite 的 /api 代理补上 X-Beeftv-Owner 头（读 <数据目录>/agent_owner_token），
#   以 owner 身份授权。缺这个文件时仍能启动，但画布保存/生成会失败。
VITE_CFG_ARG=""
if [ -f "$ROOT/web/vite.config.local-owner.ts" ]; then
  VITE_CFG_ARG="--config vite.config.local-owner.ts"
else
  warn "缺少 web/vite.config.local-owner.ts —— 画布保存会因操作层 403 失败（生成前会提示「画布尚未保存」）"
fi
( cd "$ROOT/web" && \
  VITE_API_PROXY_TARGET="http://127.0.0.1:$BACKEND_PORT" \
  BEEFTV_DATA_DIR="$DATA_DIR" \
  nohup "$BUN_BIN" run dev -- --host 127.0.0.1 --port "$WEB_PORT" ${VITE_CFG_ARG} >>"$LOG_DIR/frontend.log" 2>&1 </dev/null & echo $! >"$WPID_F" )
WPID="$(cat "$WPID_F" 2>/dev/null)"
sleep 1
pid_alive "$WPID" || { tail -25 "$LOG_DIR/frontend.log"; die "前端进程起不来（pid ${WPID}），日志：$LOG_DIR/frontend.log"; }

printf '  等前端就绪'
WREADY=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then WREADY=1; break; fi
  pid_alive "$WPID" || break
  printf '.'; sleep 1
done
printf '\n'
[ "$WREADY" = 1 ] || { tail -25 "$LOG_DIR/frontend.log"; die "前端 60 秒内没就绪（pid ${WPID}），日志：$LOG_DIR/frontend.log"; }
ok "前端已就绪：${CY}http://localhost:$WEB_PORT${R}"
REAL_WPID="$(port_pid "$WEB_PORT")"
[ -n "$REAL_WPID" ] && { WPID="$REAL_WPID"; echo "$WPID" >"$WPID_F"; }

# ---------------------------------------------------------------- 7.5 自检：操作层身份
# 画布保存走 POST /api/ops/canvas.document.commit，该入口要求**两个**条件同时成立：
#   ① 来源判定 isLoopbackRequest：浏览器 POST 必带 Origin，后端要求「Origin 的 host:port
#      与请求 Host 完全一致」，或 Origin 列在 BEEFTV_ALLOWED_ORIGINS 里；
#      而 Vite 代理带 changeOrigin → 请求 Host 变成后端地址，必然不同源 → 所以必须靠
#      BEEFTV_ALLOWED_ORIGINS 放行（已在上面的后端环境变量里设置）。
#   ② 可信身份：owner 凭据（靠 web/vite.config.local-owner.ts 让代理补 X-Beeftv-Owner）
# ⚠️ 所以自检必须**带上 Origin 头**——只测「不带 Origin」会漏掉浏览器的真实情况（踩过）。
step "自检操作层身份（画布保存依赖它）"
OPS_PROBE="$(curl -s --max-time 5 -X POST "http://127.0.0.1:$WEB_PORT/api/ops/canvas.get" \
  -H 'Content-Type: application/json' -H "Origin: http://localhost:$WEB_PORT" -d '{"params":{}}' 2>/dev/null)"
if printf '%s' "$OPS_PROBE" | grep -qE 'canvasId|"code":0'; then
  ok "身份已打通（带 Origin 也通过，画布保存可用）"
else
  warn "身份未打通 —— 画布保存会失败，生成时会提示「画布尚未保存，未开始生成」"
  warn "回应：$(printf '%s' "$OPS_PROBE" | cut -c1-120)"
  warn "排查：BEEFTV_ALLOWED_ORIGINS 是否含 http://localhost:$WEB_PORT、"
  warn "      web/vite.config.local-owner.ts 是否存在、<数据目录>/agent_owner_token 是否可读"
fi

# ---------------------------------------------------------------- 8. 打开浏览器
if [ "${BEEFTV_NO_OPEN:-0}" = 1 ]; then
  warn "BEEFTV_NO_OPEN=1，跳过自动打开浏览器"
else
  open "http://localhost:$WEB_PORT" 2>/dev/null || warn "没能自动打开浏览器，手动访问 http://localhost:$WEB_PORT"
fi

cat <<EOF

${GR}${B}BeefTV（新版）已启动${R}
  前端（用这个） ${CY}http://localhost:$WEB_PORT${R}
  后端 API       http://127.0.0.1:$BACKEND_PORT     ${DIM}(仅内部，浏览器不用它)${R}
  数据目录       $DATA_DIR
  日志           $LOG_DIR/{backend,frontend}.log
  进程           backend pid $BPID · frontend pid $WPID

${DIM}旧实例（<桌面>/BeefTV）若也在跑，用的是 3000 + 8080，两边互不干扰。${R}
${DIM}停止：双击「一键停止_BeefTV.command」（或 kill ${BPID} ${WPID}）${R}
${DIM}本窗口可以直接关掉，服务在后台继续跑。${R}
EOF
