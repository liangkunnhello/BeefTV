#!/bin/bash
# =====================================================================
# BeefTV 一键启动（macOS）
# ---------------------------------------------------------------------
# 用法：在「访达」里双击本文件；或终端执行 ./一键启动_BeefTV.command
#
# 它做什么（按顺序）：
#   1. 准备 Go —— 本机没装就**自动下载到项目内 .local/go**，不碰系统、不需要 Homebrew
#   2. 准备前端依赖 —— 只在 web/node_modules 缺失时跑 bun install --frozen-lockfile
#   3. 起后端 Go API  http://127.0.0.1:8080
#   4. 起前端 Vite    http://127.0.0.1:3000
#   5. 等两个都就绪后**自动打开浏览器**
#
# 数据目录：.local/project-workbench-debug   （与官方 start-local.ps1 同口径）
# 日志：    .local/logs/{backend,frontend}.log
# 停止：    双击「一键停止_BeefTV.command」
#
# 口径来源（改动前请先读）：
#   · scripts/start-local.ps1        —— Windows 的浏览器模式一键启动（本脚本对标它）
#   · scripts/beeftv-shared-dev.sh   —— 官方「浏览器预览 + Wails 桌面」统一开发脚本
#   · docs/desktop-local-development.md
#   官方只提供了 .ps1（Windows）；macOS/Linux 一直没有对应的一键脚本，本脚本补这个缺口。
#   注意：桌面（Wails）模式需要额外系统组件，本脚本走**浏览器模式**，依赖更少。
#
# 可用环境变量覆盖：
#   BEEFTV_BACKEND_PORT / BEEFTV_WEB_PORT / BEEFTV_GO_DIR / BEEFTV_NO_OPEN=1
# =====================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BEEFTV_BACKEND_PORT:-8080}"
WEB_PORT="${BEEFTV_WEB_PORT:-3000}"
DATA_DIR="$ROOT/.local/project-workbench-debug"
CACHE_DIR="$ROOT/.local/cache"
BIN_DIR="$ROOT/.local/bin"
RUN_DIR="$ROOT/.local/run"
LOG_DIR="$ROOT/.local/logs"
GO_DIR="${BEEFTV_GO_DIR:-$ROOT/.local/go}"
GO_MIN_MAJOR_MINOR="1.25"

# 双击启动时 PATH 往往不含这些位置 —— 先补上，否则明明装了也找不到
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin:$GO_DIR/bin:$PATH"

B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
CY=$'\033[0;36m'; GR=$'\033[0;32m'; YE=$'\033[0;33m'; RD=$'\033[0;31m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$GR" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YE" "$R" "$*"; }
die()  { printf '\n%s✗ %s%s\n\n' "$RD" "$*" "$R"; [ -t 0 ] && { printf '按回车关闭…'; read -r _ || true; }; exit 1; }

cd "$ROOT" || die "进不去项目目录：$ROOT"

say "${B}BeefTV 一键启动${R}"
say "${DIM}项目：$ROOT${R}"

mkdir -p "$DATA_DIR" "$CACHE_DIR" "$BIN_DIR" "$RUN_DIR" "$LOG_DIR"

# ---------------------------------------------------------------- 0. 已在运行？
port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

BPID_F="$RUN_DIR/backend.pid"; WPID_F="$RUN_DIR/frontend.pid"
B_ALIVE=0; W_ALIVE=0
pid_alive "$(cat "$BPID_F" 2>/dev/null)" && B_ALIVE=1
pid_alive "$(cat "$WPID_F" 2>/dev/null)" && W_ALIVE=1
if [ "$B_ALIVE" = 1 ] && [ "$W_ALIVE" = 1 ]; then
  ok "检测到 BeefTV 已经在运行（后端 pid $(cat "$BPID_F")、前端 pid $(cat "$WPID_F")）"
  [ "${BEEFTV_NO_OPEN:-0}" = 1 ] || open "http://localhost:$WEB_PORT" 2>/dev/null
  say ""
  say "已经帮你把页面打开了：${CY}http://localhost:${WEB_PORT}${R}"
  say "${DIM}要重启用「一键停止_BeefTV.command」，再跑本脚本。${R}"
  exit 0
fi

# ---------------------------------------------------------------- 1. Go
step "准备 Go（要求 ≥ ${GO_MIN_MAJOR_MINOR}，go.mod 写的是 1.25.0）"
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
      || die "Go 下载失败。可手动下载 ${DL_BASE}${FILE} 解压到 $GO_DIR 后重试。"
  fi
  rm -rf "$GO_DIR"
  tar -C "$(dirname "$GO_DIR")" -xzf "$TMP_TGZ" || die "解压 Go 失败：$TMP_TGZ"
  GO_BIN="$GO_DIR/bin/go"
  [ -x "$GO_BIN" ] || die "解压后没找到 $GO_BIN"
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
  if ! command -v node >/dev/null 2>&1; then
    warn "没找到 node，无法打包官方插件 —— 本次启动所有插件协议渠道都会报「接口类型…未安装」"
    warn "装好 node（或 bun）后重新双击本文件即可；也可用 CANVAS_OFFICIAL_PLUGIN_DIR 指向已有插件包目录。"
  elif ! command -v zip >/dev/null 2>&1; then
    warn "没找到 zip，无法打包官方插件 —— 同上，插件协议渠道会不可用"
  elif ( cd "$PKG_DIR" && sh ./build-packages.sh ) >"$LOG_DIR/plugin-packages.log" 2>&1; then
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
    die "端口 $PORT 已被占用（pid ${HOLDER}：$(ps -o command= -p "$HOLDER" 2>/dev/null | cut -c1-90)）
  先跑「一键停止_BeefTV.command」，或手动：kill $HOLDER"
  fi
done
ok "端口 ${BACKEND_PORT}（后端）与 ${WEB_PORT}（前端）都空着"

# ---------------------------------------------------------------- 5. 编译后端
step "编译后端（第一次要下载 Go 依赖并编译，可能几分钟）"
SERVER_BIN="$BIN_DIR/beeftv-server"
if ( cd "$ROOT/backend" \
     && GOCACHE="$CACHE_DIR/go-build" GOMODCACHE="$CACHE_DIR/go-mod" GOTOOLCHAIN=local \
        "$GO_BIN" build -o "$SERVER_BIN" ./cmd/server ) >"$LOG_DIR/backend-build.log" 2>&1; then
  ok "编译完成：${DIM}$SERVER_BIN${R}"
else
  say "${RD}—— 编译失败，日志末尾 ——${R}"
  tail -25 "$LOG_DIR/backend-build.log"
  die "后端编译失败（完整日志：$LOG_DIR/backend-build.log）"
fi

# ---------------------------------------------------------------- 6. 起后端
step "启动后端 API"
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
step "启动前端 Vite"
: >"$LOG_DIR/frontend.log"
( cd "$ROOT/web" && \
  VITE_API_PROXY_TARGET="http://127.0.0.1:$BACKEND_PORT" \
  nohup "$BUN_BIN" run dev -- --host 127.0.0.1 --port "$WEB_PORT" >>"$LOG_DIR/frontend.log" 2>&1 </dev/null & echo $! >"$WPID_F" )
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

# ---------------------------------------------------------------- 8. 打开浏览器
if [ "${BEEFTV_NO_OPEN:-0}" = 1 ]; then
  warn "BEEFTV_NO_OPEN=1，跳过自动打开浏览器"
else
  open "http://localhost:$WEB_PORT" 2>/dev/null || warn "没能自动打开浏览器，手动访问 http://localhost:$WEB_PORT"
fi

cat <<EOF

${GR}${B}BeefTV 已启动${R}
  前端（用这个） ${CY}http://localhost:$WEB_PORT${R}
  后端 API       http://127.0.0.1:$BACKEND_PORT
  数据目录       $DATA_DIR
  日志           $LOG_DIR/{backend,frontend}.log
  进程           backend pid $BPID · frontend pid $WPID

${DIM}停止：双击「一键停止_BeefTV.command」（或 kill $BPID ${WPID}）${R}
${DIM}本窗口可以直接关掉，服务在后台继续跑。${R}
EOF
