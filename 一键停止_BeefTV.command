#!/bin/bash
# =====================================================================
# BeefTV 一键停止（macOS）
# ---------------------------------------------------------------------
# 用法：在「访达」里双击本文件；或终端执行 ./一键停止_BeefTV.command
#
# 停止顺序：
#   1. 按 .local/run/*.pid 精确杀（正常路径）
#   2. 兜底：按命令行特征清理残留（例如 go run / vite 派生的子进程）
#   3. 确认端口真的释放了，并如实报告
#
# 只杀 BeefTV 自己的进程（匹配项目路径 / 专属端口），不做全局 pkill node。
# =====================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BEEFTV_BACKEND_PORT:-8080}"
WEB_PORT="${BEEFTV_WEB_PORT:-3000}"
RUN_DIR="$ROOT/.local/run"

B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
CY=$'\033[0;36m'; GR=$'\033[0;32m'; YE=$'\033[0;33m'; RD=$'\033[0;31m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$GR" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YE" "$R" "$*"; }
info() { printf '  %s·%s %s\n' "$DIM" "$R" "$*"; }

cd "$ROOT" || { printf '%s✗ 进不去项目目录：%s%s\n' "$RD" "$ROOT" "$R"; exit 1; }

say "${B}BeefTV 一键停止${R}"

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

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
  pid_alive "$pid" && warn "${name}（pid ${pid}）还在" || ok "${name}（pid ${pid}）已停"
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

# ---------------------------------------------------------------- 2. 兜底清理残留
step "兜底清理残留进程"
LEFTOVER=0
# 只认「本项目的」进程：命令行里同时出现项目路径与专属特征
for pat in "$ROOT/web.*vite" "$ROOT/web.*bun run dev" "$ROOT/.local/bin/beeftv-server" "$ROOT/backend.*cmd/server"; do
  PIDS="$(pgrep -f "$pat" 2>/dev/null || true)"
  [ -n "$PIDS" ] || continue
  LEFTOVER=1
  for p in $PIDS; do
    warn "残留：pid $p  $(ps -o command= -p "$p" 2>/dev/null | cut -c1-80)"
    kill "$p" 2>/dev/null; sleep 0.4
    pid_alive "$p" && kill -9 "$p" 2>/dev/null
  done
done
[ "$LEFTOVER" = 1 ] || ok "没有残留"

# ---------------------------------------------------------------- 3. 核实端口
step "核实端口"
ALL_FREE=1
for pair in "$BACKEND_PORT:后端" "$WEB_PORT:前端"; do
  PORT="${pair%%:*}"; NAME="${pair##*:}"
  HOLDER="$(port_pid "$PORT")"
  if [ -n "$HOLDER" ]; then
    ALL_FREE=0
    warn "${NAME}端口 $PORT 仍被占用：pid $HOLDER  $(ps -o command= -p "$HOLDER" 2>/dev/null | cut -c1-80)"
  else
    ok "${NAME}端口 $PORT 已释放"
  fi
done

if [ "$ALL_FREE" = 1 ]; then
  printf '\n%sBeefTV 已停止。%s\n' "$GR" "$R"
  printf '%s数据与日志都留着（.local/），下次启动会接着用。%s\n' "$DIM" "$R"
else
  printf '\n%s有端口没释放 —— 上面列出了占用进程，可手动 kill 后重试。%s\n' "$YE" "$R"
fi
