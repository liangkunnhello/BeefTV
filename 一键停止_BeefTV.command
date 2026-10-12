#!/bin/bash
# =====================================================================
# BeefTV 一键停止（macOS）· 新版 beeftv
# ---------------------------------------------------------------------
# 用法：在「访达」里双击本文件；或终端执行 ./一键停止_BeefTV.command
#
# 停的端口：8081（前端 Vite）、8082（后端 Go API）
# 只停**本项目**的进程（匹配本项目路径 / 本项目专属端口），不会碰旧实例
# <桌面>/BeefTV 的 3000 与 8080，也不会做全局 pkill node。
#
# 停止顺序：
#   1. 按 .local/run/*.pid 精确杀（正常路径，先子后父）
#   2. 按端口监听者清理（只用命令行里能证明是「本项目的」进程）
#   3. 兜底：按命令行特征清理残留（vite / bun run dev / 本项目编译产物）
#   4. 确认端口真的释放了，并如实报告
# =====================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BEEFTV_BACKEND_PORT:-8082}"
WEB_PORT="${BEEFTV_WEB_PORT:-8081}"
RUN_DIR="$ROOT/.local/run"
BIN_PATH="$ROOT/.local/bin/beeftv-server"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:$PATH"

B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
CY=$'\033[0;36m'; GR=$'\033[0;32m'; YE=$'\033[0;33m'; RD=$'\033[0;31m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$GR" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YE" "$R" "$*"; }
info() { printf '  %s·%s %s\n' "$DIM" "$R" "$*"; }

cd "$ROOT" || { printf '%s✗ 进不去项目目录：%s%s\n' "$RD" "$ROOT" "$R"; exit 1; }

say "${B}BeefTV 一键停止（新版）${R}"
say "${DIM}项目：$ROOT${R}"

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
cmd_of() { ps -o command= -p "$1" 2>/dev/null | cut -c1-90; }
# 命令行里出现本项目的两个硬标记，才算「我们的」进程，避免误杀同名进程
is_ours() {
  local c="$1"
  case "$c" in
    *"$ROOT"*) return 0 ;;
    *"$BIN_PATH"*) return 0 ;;
  esac
  return 1
}
# 端口占用者是否「可证明是本项目的」：
#   优先看 ps 的完整命令行；ps 取不到时（受限环境会 return 空）退到 lsof 的进程名，
#   只认本项目独有的可执行文件名 beeftv-server —— 这样不会误杀别人放在 8081/8082 的东西。
port_owner_is_ours() {   # $1=port
  local port="$1" pid cmd name
  pid="$(port_pid "$port")"
  [ -n "$pid" ] || return 1
  cmd="$(cmd_of "$pid")"
  if [ -n "$cmd" ]; then
    is_ours "$cmd" && return 0
    return 1
  fi
  name="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -F c 2>/dev/null | sed -n 's/^c//p' | head -1)"
  [ "$name" = "beeftv-server" ] && return 0
  return 1
}

stop_pid() {   # $1=pid  $2=名字
  local pid="$1" name="$2"
  [ -n "$pid" ] || return 0
  pid_alive "$pid" || { info "${name}（pid ${pid}）已经不在了"; return 0; }
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.25; done
  if pid_alive "$pid"; then
    warn "${name}（pid ${pid}）没响应 TERM，改用 KILL"
    kill -9 "$pid" 2>/dev/null
    sleep 0.5
  fi
  if pid_alive "$pid"; then warn "${name}（pid ${pid}）还在"; else ok "${name}（pid ${pid}）已停"; fi
}

# ---------------------------------------------------------------- 1. 按 pid 文件停
step "按 pid 文件停止"
BPID="$(cat "$RUN_DIR/backend.pid"  2>/dev/null || true)"
WPID="$(cat "$RUN_DIR/frontend.pid" 2>/dev/null || true)"
# 先杀子进程再杀父进程：vite 常由 bun 派生，go 编译产物也可能有子进程
for p in "$WPID" "$BPID"; do
  [ -n "$p" ] && pkill -TERM -P "$p" 2>/dev/null || true
done
stop_pid "$WPID" "前端"
stop_pid "$BPID" "后端"
rm -f "$RUN_DIR/backend.pid" "$RUN_DIR/frontend.pid"

# ---------------------------------------------------------------- 2. 按端口监听者收尾
step "检查监听端口的进程"
for pair in "$WEB_PORT:前端" "$BACKEND_PORT:后端"; do
  PORT="${pair%%:*}"; NAME="${pair##*:}"
  HOLDER="$(port_pid "$PORT")"
  [ -n "$HOLDER" ] || { info "${NAME}端口 ${PORT} 无监听者"; continue; }
  CMD="$(cmd_of "$HOLDER")"
  if port_owner_is_ours "$PORT"; then
    warn "${NAME}端口 ${PORT} 仍被本项目进程占用：pid ${HOLDER}  ${CMD}"
    stop_pid "$HOLDER" "${NAME}（端口残留）"
  else
    warn "${NAME}端口 ${PORT} 被**非本项目**进程占用，不动它：pid ${HOLDER}  ${CMD}"
    info "确认这是别的东西就忽略；要腾端口请手动处理该 pid。"
  fi
done

# ---------------------------------------------------------------- 3. 兜底清理残留
step "兜底清理残留进程"
LEFTOVER=0
# 只认「本项目的」进程：命令行里同时出现项目路径与专属特征
for pat in "$ROOT/web.*vite" "$ROOT/web.*bun run dev" "$ROOT/.local/bin/beeftv-server" "$ROOT/backend.*cmd/server"; do
  PIDS="$(pgrep -f "$pat" 2>/dev/null || true)"
  [ -n "$PIDS" ] || continue
  LEFTOVER=1
  for p in $PIDS; do
    warn "残留：pid $p  $(cmd_of "$p")"
    kill "$p" 2>/dev/null; sleep 0.4
    pid_alive "$p" && kill -9 "$p" 2>/dev/null
  done
done
[ "$LEFTOVER" = 1 ] || ok "没有残留"

# ---------------------------------------------------------------- 4. 核实端口
step "核实端口"
ALL_FREE=1
for pair in "$WEB_PORT:前端" "$BACKEND_PORT:后端"; do
  PORT="${pair%%:*}"; NAME="${pair##*:}"
  HOLDER="$(port_pid "$PORT")"
  if [ -n "$HOLDER" ]; then
    ALL_FREE=0
    warn "${NAME}端口 ${PORT} 仍被占用：pid ${HOLDER}  $(cmd_of "$HOLDER")"
  else
    ok "${NAME}端口 ${PORT} 已释放"
  fi
done

if [ "$ALL_FREE" = 1 ]; then
  printf '\n%sBeefTV（新版）已停止。%s\n' "$GR" "$R"
  printf '%s数据与日志都留着（.local/），下次启动会接着用。%s\n' "$DIM" "$R"
  printf '%s旧实例（<桌面>/BeefTV）的 3000 / 8080 未受影响。%s\n' "$DIM" "$R"
else
  printf '\n%s有端口没释放 —— 上面列出了占用进程，可手动 kill 后重试。%s\n' "$YE" "$R"
fi
