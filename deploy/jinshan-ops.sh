#!/bin/bash
# 进山服务器的运维脚本：部署、重启、看状态、备份、回滚。
#
# 第一次设置（在服务器上用 root 运行一次，以后要换钥匙或升级本脚本时再运行）：
#   sudo bash jinshan-ops.sh install
# 它会把自己装成 /usr/local/bin/jinshan-ops，把服务器程序改成系统服务 jinshan（崩了自动拉起来），
# 再生成一把只能调用本脚本的部署钥匙，最后打印出要填到 GitHub 仓库 SERVER_SSH 里的内容。
#
# 之后 GitHub Actions 用这把钥匙登录服务器，只能做这些事：
#   status | logs [行数] | restart | backup | rollback | deploy <提交号> [分支]（代码包从标准输入传进来）
# 在服务器终端里也可以直接用，比如：sudo jinshan-ops status
#
# config.json、data/、cert/ 永远不会被覆盖或删除。
set -euo pipefail
umask 022
export TZ=Asia/Shanghai

CONF_FILE=/etc/jinshan-ops.conf
APP_ROOT=/www/wwwroot/jinshan
# 程序不在默认目录时，install 会把实际目录记在 CONF_FILE 里
if [ -f "$CONF_FILE" ]; then
  APP_ROOT=$(sed -n 's/^APP_ROOT=//p' "$CONF_FILE" | head -n 1)
fi
set_paths() {
  SERVER_DIR=$APP_ROOT/server
  ADMIN_DIR=$APP_ROOT/admin-web/dist
  VERSION_FILE=$APP_ROOT/.deploy-version
}
set_paths
BACKUP_ROOT=/www/backup/jinshan
HISTORY_FILE=$BACKUP_ROOT/history.log
SERVICE=jinshan
RUN_USER=www
DEPLOY_USER=jinshan-deploy
OPS_BIN=/usr/local/bin/jinshan-ops
NODE_BIN=/usr/local/bin/jinshan-node
UNIT_FILE=/etc/systemd/system/$SERVICE.service
SUDOERS_FILE=/etc/sudoers.d/jinshan-deploy
SECRET_FILE=/root/jinshan-github-secret.txt
LOCK_FILE=/run/jinshan-ops.lock
MIN_NODE=22.13.0
MAX_BUNDLE_BYTES=$((100 * 1024 * 1024))
KEEP_CODE=10
KEEP_DB=20
REMOTE=0

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
stamp() { date '+%Y%m%d-%H%M%S'; }
as_app() { runuser -u "$RUN_USER" -- "$@"; }
node_run() { "$NODE_BIN" --disable-warning=ExperimentalWarning "$@"; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

backup_root() {
  mkdir -p "$BACKUP_ROOT/$1"
  chmod 700 "$BACKUP_ROOT"
}

log_history() {
  backup_root .
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$HISTORY_FILE"
}

# 从 config.json 读端口、地址和数据目录
load_cfg() {
  IFS=$'\t' read -r PORT HOST DATA_DIR < <(node_run -e '
    const fs = require("fs"), path = require("path")
    const dir = process.argv[1]
    let c = {}
    try { c = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) } catch (e) {}
    let host = c.host || "127.0.0.1"
    if (host === "0.0.0.0" || host === "::") host = "127.0.0.1"
    console.log([c.port || 3000, host, path.resolve(dir, c.dataDir || "data")].join("\t"))
  ' "$SERVER_DIR")
}

version_field() { [ -f "$VERSION_FILE" ] && sed -n "s/^$1=//p" "$VERSION_FILE" | head -n 1 || true; }

port_pids() { ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true; }
main_pid() { systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0; }
healthy() { curl -fsS -m 3 -o /dev/null "http://$HOST:$PORT/healthz" 2>/dev/null; }

# 健康检查通过，而且端口确实是系统服务里的进程在听（不是宝塔留下的旧进程）
ours_healthy() {
  local main
  main=$(main_pid)
  [ "${main:-0}" != 0 ] && port_pids | grep -qx "$main" && healthy
}

wait_healthy() {
  local i
  for ((i = 0; i < ${1:-30}; i++)); do
    if ours_healthy; then
      sleep 2
      ours_healthy && return 0
    fi
    sleep 1
  done
  return 1
}

restart_service() {
  local since
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart "$SERVICE" || true
  if wait_healthy 30; then return 0; fi
  say "服务器程序没有正常启动，启动日志："
  journalctl -u "$SERVICE" --since "$since" --no-pager -o cat 2>/dev/null | tail -n 40 || true
  return 1
}

# 系统服务启动前调用（ExecStartPre）：停掉宝塔 Node 项目启动的旧进程，免得抢端口
kill_stray() {
  load_cfg
  local main pid cwd real
  main=$(main_pid)
  real=$(readlink -f "$SERVER_DIR")
  for pid in $(port_pids); do
    [ "$pid" = "$main" ] && continue
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    case $cwd in
      "$real" | "$real"/*) ;;
      *)
        say "端口 $PORT 被别的程序占着（pid $pid，目录 ${cwd:-未知}），不是进山服务器，没有动它"
        continue
        ;;
    esac
    say "停掉宝塔启动的旧进程 pid $pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  done
}

count_files() { find "$1" -maxdepth 1 -name "$2" 2>/dev/null | wc -l || true; }

# 按修改时间只留最新的几个
prune() {
  find "$1" -maxdepth 1 -name "$2" -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n +$(($3 + 1)) | cut -d' ' -f2- | xargs -r rm -f --
}

backup_db() {
  local db="$DATA_DIR/jinshan.db" tmp out
  if [ ! -f "$db" ]; then
    say "还没有数据库，跳过备份"
    return 0
  fi
  backup_root db
  # 用 www 身份导出（程序在跑也能导出一致的副本），导完再挪进只有 root 能看的备份目录
  tmp=$(mktemp -d /tmp/jinshan-db.XXXXXX)
  chown "$RUN_USER:" "$tmp"
  out="$BACKUP_ROOT/db/jinshan-$(stamp)-$1.db"
  if ! (cd / && as_app "$NODE_BIN" --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1])
    db.exec("PRAGMA busy_timeout = 10000")
    db.prepare("VACUUM INTO ?").run(process.argv[2])
    db.close()
  ' "$db" "$tmp/backup.db"); then
    rm -rf "$tmp"
    die "数据库备份失败，没有继续"
  fi
  mv "$tmp/backup.db" "$out"
  rm -rf "$tmp"
  chown root:root "$out"
  chmod 600 "$out"
  say "数据库已备份：$out（$(du -h "$out" | cut -f1)）"
  prune "$BACKUP_ROOT/db" 'jinshan-*.db' "$KEEP_DB"
}

# 把现在线上的代码（不含配置和数据）打包备份，输出备份文件路径
backup_code() {
  local sha out items=(server)
  sha=$(version_field sha)
  sha=${sha:-manual}
  backup_root code
  out="$BACKUP_ROOT/code/code-$(stamp)-${sha:0:12}.tar.gz"
  [ -d "$ADMIN_DIR" ] && items+=(admin-web/dist)
  [ -f "$VERSION_FILE" ] && items+=(.deploy-version)
  tar -czf "$out" -C "$APP_ROOT" \
    --exclude=server/config.json --exclude=server/data --exclude=server/cert --exclude=server/node_modules \
    "${items[@]}"
  chmod 600 "$out"
  prune "$BACKUP_ROOT/code" 'code-*.tar.gz' "$KEEP_CODE"
  say "$out"
}

# 把 $1/server 和 $1/admin-web/dist 同步到线上；配置、数据、证书和手动留的备份文件都不动
sync_code() {
  local src=$1
  chown -R "$RUN_USER:$RUN_USER" "$src"
  rsync -a --delete \
    --exclude=/config.json --exclude=/data --exclude=/cert --exclude=/node_modules \
    --filter='P /config*' --filter='P *.pem' --filter='P *.db' --filter='P *.db-*' --filter='P *.bak' \
    "$src/server/" "$SERVER_DIR/"
  if [ -d "$src/admin-web/dist" ]; then
    mkdir -p "$ADMIN_DIR"
    rsync -a --delete "$src/admin-web/dist/" "$ADMIN_DIR/"
    chown "$RUN_USER:$RUN_USER" "$APP_ROOT/admin-web"
  fi
}

restore_code() {
  local file=$1 dir
  [ -f "$file" ] || die "找不到代码备份 $file"
  dir=$(mktemp -d /tmp/jinshan-restore.XXXXXX)
  tar -xzf "$file" -C "$dir" --no-same-owner
  if [ ! -f "$dir/server/app.js" ]; then
    rm -rf "$dir"
    die "代码备份不完整：$file"
  fi
  sync_code "$dir"
  if [ -f "$dir/.deploy-version" ]; then
    install -m 644 -o root -g root "$dir/.deploy-version" "$VERSION_FILE"
  else
    printf 'sha=manual\ntime=%s\nnote=自动部署之前手动上传的版本\n' "$(date '+%Y-%m-%d %H:%M:%S')" >"$VERSION_FILE"
  fi
  rm -rf "$dir"
}

check_bundle() {
  local f=$1 types names n
  types=$(tar -tvzf "$f" | cut -c1 | sort -u | tr -d '\n') || die "代码包打不开"
  [[ $types =~ ^[-d]+$ ]] || die "代码包里有链接或特殊文件，不部署"
  names=$(tar -tzf "$f") || die "代码包打不开"
  while IFS= read -r n; do
    [[ $n =~ ^(server(/.*)?|admin-web/?|admin-web/dist(/.*)?)$ ]] || die "代码包里有不该有的文件：$n"
    [[ /$n/ != */../* ]] || die "代码包里有可疑的路径：$n"
    case $n in
      server/config.json | server/data | server/data/* | server/cert | server/cert/*) die "代码包里不能有 $n" ;;
    esac
  done <<<"$names"
  grep -qx 'server/app.js' <<<"$names" || die "代码包里没有 server/app.js"
  grep -qx 'admin-web/dist/index.html' <<<"$names" || die "代码包里没有 admin-web/dist/index.html"
}

deploy() {
  local sha=$1 ref=${2:-} work size prev
  work=$(mktemp -d /tmp/jinshan-deploy.XXXXXX)
  chmod 755 "$work"
  # shellcheck disable=SC2064 # 现在就展开，退出时 work 已经不在作用域里
  trap "rm -rf '$work'" EXIT
  # 先把标准输入里的代码包收完，再做别的
  head -c $((MAX_BUNDLE_BYTES + 1)) >"$work/bundle.tar.gz"
  size=$(stat -c %s "$work/bundle.tar.gz")
  [ "$size" -gt 0 ] || die "没收到代码包"
  [ "$size" -le "$MAX_BUNDLE_BYTES" ] || die "代码包超过 100MB，不像正常的代码包"
  load_cfg
  [ -f "$SERVER_DIR/config.json" ] || die "服务器上没有 $SERVER_DIR/config.json，先按 README 把配置文件放好"
  check_bundle "$work/bundle.tar.gz"
  mkdir "$work/new"
  tar -xzf "$work/bundle.tar.gz" -C "$work/new" --no-same-owner
  chown -R "$RUN_USER:$RUN_USER" "$work/new"
  say "收到代码包 $((size / 1024)) KB，版本 ${sha:0:12}"

  say "检查新代码能不能加载……"
  (cd "$work/new/server" && as_app timeout 60 "$NODE_BIN" --disable-warning=ExperimentalWarning \
    -e 'require("./app.js"); process.exit(0)') ||
    die "新代码加载出错（见上面的报错），没有部署，线上不受影响"

  backup_db "before-${sha:0:12}"
  prev=$(backup_code)
  say "旧代码已备份：$prev"

  sync_code "$work/new"
  printf 'sha=%s\nref=%s\ntime=%s\nprev=%s\n' "$sha" "$ref" "$(date '+%Y-%m-%d %H:%M:%S')" "$prev" >"$VERSION_FILE"

  say "重启服务器程序……"
  if restart_service; then
    log_history "部署 ${sha:0:12} ${ref} 成功"
    say "部署成功：${sha:0:12}，健康检查正常"
    return 0
  fi
  say "新版本启动失败，自动退回上一版……"
  restore_code "$prev"
  if restart_service; then
    say "已经退回上一版，线上正常"
  else
    say "退回上一版以后还是启动不了，需要人工处理"
  fi
  log_history "部署 ${sha:0:12} ${ref} 失败，已退回"
  exit 1
}

rollback() {
  local prev cur
  load_cfg
  prev=$(version_field prev)
  [ -n "$prev" ] && [ -f "$prev" ] || die "没有上一版的代码备份，回滚不了（可以在 GitHub 上重新部署某个旧版本）"
  cur=$(backup_code)
  say "现在的代码已备份：$cur"
  restore_code "$prev"
  if restart_service; then
    log_history "回滚到 $(version_field sha | cut -c1-12)"
    say "已回滚到 $(version_field sha | cut -c1-12)（$(version_field time) 部署的版本）"
    return 0
  fi
  say "回滚后的版本启动不了，恢复回滚前的代码……"
  restore_code "$cur"
  restart_service || true
  log_history "回滚失败，已恢复"
  exit 1
}

status() {
  load_cfg
  local main rss stray="" pid daily
  main=$(main_pid)
  say "版本：$(version_field sha | cut -c1-12)  分支：$(version_field ref)  部署时间：$(version_field time)"
  rss=$(ps -o rss= -p "$main" 2>/dev/null | awk '{printf "%d MB", $1 / 1024}' || true)
  say "程序：$(systemctl is-active "$SERVICE" 2>/dev/null || true)，启动于 $(systemctl show -p ActiveEnterTimestamp --value "$SERVICE")，占内存 ${rss:-?}"
  if healthy; then say "健康检查：正常"; else say "健康检查：失败"; fi
  for pid in $(port_pids); do [ "$pid" = "$main" ] || stray="$stray $pid"; done
  [ -z "$stray" ] || say "注意：端口 $PORT 还被系统服务以外的进程占着：pid$stray"
  say "Node：$(node_run -v)"
  df -h / | awk 'NR == 2 { print "磁盘：已用 " $5 "，剩余 " $4 }'
  free -m | awk '/^Mem/ { print "内存：共 " $2 " MB，可用 " $7 " MB" }'
  say "服务器已开机：$(uptime -p 2>/dev/null || true)"
  if [ -f "$DATA_DIR/jinshan.db" ]; then
    say "数据库：$(du -h "$DATA_DIR/jinshan.db" | cut -f1)；数据目录共 $(du -sh "$DATA_DIR" | cut -f1)"
  fi
  daily=$(find "$DATA_DIR/backups" -maxdepth 1 -name 'jinshan-*.db' -printf '%f\n' 2>/dev/null | sort | tail -n 1 || true)
  say "每日自动备份：最近一份 ${daily:-还没有}"
  say "部署前备份：数据库 $(count_files "$BACKUP_ROOT/db" '*.db') 份，代码 $(count_files "$BACKUP_ROOT/code" '*.tar.gz') 份（在 $BACKUP_ROOT）"
  if [ -f "$HISTORY_FILE" ]; then
    say "最近的操作："
    tail -n 5 "$HISTORY_FILE"
  fi
}

restart_cmd() {
  load_cfg
  if restart_service; then
    log_history "重启"
    say "已重启，健康检查正常"
  else
    log_history "重启失败"
    exit 1
  fi
}

backup_cmd() {
  load_cfg
  backup_db manual
  log_history "手动备份数据库"
}

with_lock() {
  exec 9>"$LOCK_FILE"
  flock -w 900 9 || die "另一个部署或运维操作还没做完"
  "$@"
}

run_action() {
  local line=$1 args ok='^[A-Za-z0-9._/ -]*$'
  [[ ${#line} -le 300 && $line =~ $ok ]] || die "不认识的命令"
  read -r -a args <<<"$line"
  if [ "${args[0]:-}" = ping ]; then
    say pong
    return 0
  fi
  # GitHub 能连上了，说明钥匙已经填进 GitHub，服务器上的那份不用留
  [ "$REMOTE" = 1 ] && rm -f "$SECRET_FILE"
  case ${args[0]:-} in
    status) status ;;
    logs)
      local n=${args[1]:-200}
      [[ $n =~ ^[0-9]{1,5}$ ]] || die "行数要是数字"
      ((n <= 2000)) || n=2000
      journalctl -u "$SERVICE" -n "$n" --no-pager -o short-iso
      ;;
    restart) with_lock restart_cmd ;;
    backup) with_lock backup_cmd ;;
    rollback) with_lock rollback ;;
    deploy)
      [[ ${args[1]:-} =~ ^[0-9a-f]{40}$ ]] || die "提交号不对"
      with_lock deploy "${args[1]}" "${args[2]:-}"
      ;;
    *) die "不认识的动作：${args[0]:-（空）}。能用的：status、logs、restart、backup、rollback、deploy" ;;
  esac
}

# ---------- 第一次设置 ----------

find_node() {
  local n v pid best="" bestv=""
  # 优先用宝塔现在跑这个项目的那个 Node，它肯定能跑
  load_cfg_fallback
  for pid in $(port_pids); do
    n=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
    case $n in */node) ;; *) continue ;; esac
    v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
    if ver_ge "$v" "$MIN_NODE"; then
      printf '%s\n' "$n"
      return 0
    fi
  done
  # 否则挑宝塔装的 Node 里版本最高的
  for n in /www/server/nodejs/*/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -n "$n" ] && [ -x "$n" ] || continue
    v=$("$n" -p 'process.versions.node' 2>/dev/null) || continue
    ver_ge "$v" "$MIN_NODE" || continue
    if [ -z "$best" ] || ! ver_ge "$bestv" "$v"; then
      best=$n
      bestv=$v
    fi
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# 默认目录里没有程序时，看正在跑的服务器程序在哪个目录
find_app_root() {
  local pid cwd
  if [ ! -f "$SERVER_DIR/app.js" ]; then
    load_cfg_fallback
    for pid in $(port_pids); do
      cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
      if [ -f "$cwd/app.js" ] && [ "${cwd##*/}" = server ]; then
        APP_ROOT=${cwd%/server}
        set_paths
        say "服务器程序实际在 $SERVER_DIR"
        break
      fi
    done
  fi
  [ -f "$SERVER_DIR/app.js" ] || die "找不到服务器程序：$SERVER_DIR/app.js 不存在，端口上也没有正在跑的进山服务器"
  if [ "$APP_ROOT" = /www/wwwroot/jinshan ]; then
    rm -f "$CONF_FILE"
  else
    printf 'APP_ROOT=%s\n' "$APP_ROOT" >"$CONF_FILE"
  fi
}

# 装 Node 之前读不了 config.json，先按默认端口找
load_cfg_fallback() {
  PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$SERVER_DIR/config.json" 2>/dev/null | grep -o '[0-9]*$' || true)
  PORT=${PORT:-3000}
}

public_ip() {
  local ip=${1:-}
  if [ -z "$ip" ]; then
    ip=$(curl -fsS -m 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null || true)
  fi
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "查不到这台服务器的公网 IP，请在命令后面加上 IP 再运行：sudo bash jinshan-ops.sh install 你的公网IP"
  printf '%s\n' "$ip"
}

ensure_tools() {
  local need=() t
  for t in rsync curl flock runuser ss ssh-keygen ssh sudo visudo; do
    command -v "$t" >/dev/null 2>&1 && continue
    case $t in
      flock | runuser) need+=(util-linux) ;;
      ss) need+=(iproute) ;;
      ssh-keygen) need+=(openssh) ;;
      ssh) need+=(openssh-clients) ;;
      visudo) need+=(sudo) ;;
      *) need+=("$t") ;;
    esac
  done
  [ ${#need[@]} -eq 0 ] && return 0
  say "安装缺的工具：${need[*]}"
  if command -v dnf >/dev/null 2>&1; then dnf -y install "${need[@]}"; else yum -y install "${need[@]}"; fi
}

write_unit() {
  cat >"$UNIT_FILE" <<EOF
# 进山小程序服务器。由 jinshan-ops install 生成，改端口等配置请改 $SERVER_DIR/config.json
[Unit]
Description=Jinshan mini program server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$SERVER_DIR
Environment=NODE_ENV=production
ExecStartPre=-+$OPS_BIN kill-stray
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning app.js
Restart=always
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
}

setup_deploy_user() {
  local key=$1 home tmp
  id "$DEPLOY_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash -c "GitHub deploy for jinshan" "$DEPLOY_USER"
  # 没有密码，只能用钥匙登录
  usermod -p '*' "$DEPLOY_USER"
  home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)

  tmp=$(mktemp)
  printf 'Defaults:%s !requiretty\n%s ALL=(root) NOPASSWD: %s remote *\n' "$DEPLOY_USER" "$DEPLOY_USER" "$OPS_BIN" >"$tmp"
  visudo -cf "$tmp" >/dev/null || die "sudo 配置检查没通过"
  install -m 440 -o root -g root "$tmp" "$SUDOERS_FILE"
  rm -f "$tmp"

  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  # 这把钥匙登录后只能执行 jinshan-ops，不能开终端、不能转发端口（$SSH_ORIGINAL_COMMAND 要原样写进文件）
  # shellcheck disable=SC2016
  printf 'command="sudo -n %s remote \\"$SSH_ORIGINAL_COMMAND\\"",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc %s\n' \
    "$OPS_BIN" "$(cat "$key.pub")" >"$home/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"
  command -v restorecon >/dev/null 2>&1 && restorecon -R "$home/.ssh" 2>/dev/null || true
}

install_all() {
  local ip_arg=${1:-} self node ip ssh_port hostkey known work
  [ "$(id -u)" = 0 ] || die "要用 root 运行：sudo bash $0 install"
  command -v systemctl >/dev/null 2>&1 || die "这台服务器没有 systemd"
  find_app_root
  [ -f "$SERVER_DIR/config.json" ] || die "找不到 $SERVER_DIR/config.json，先按 README 填好配置文件"
  id "$RUN_USER" >/dev/null 2>&1 || die "没有 $RUN_USER 用户（宝塔装好后会有）"
  ip=$(public_ip "$ip_arg")

  say "[1/5] 检查工具和 Node.js"
  ensure_tools
  node=$(find_node) || true
  [ -n "$node" ] || die "没找到 $MIN_NODE 以上的 Node.js：在宝塔「网站 → Node 项目 → Node 版本管理器」装一个 v22 或 v24 再运行"
  ln -sfn "$node" "$NODE_BIN"
  say "用 $node（$("$NODE_BIN" -v)）"
  self=$(readlink -f "${BASH_SOURCE[0]}")
  [ "$self" = "$OPS_BIN" ] || install -m 755 -o root -g root "$self" "$OPS_BIN"

  say "[2/5] 把服务器程序改成系统服务 $SERVICE"
  load_cfg
  chown -R "$RUN_USER:$RUN_USER" "$SERVER_DIR"
  [ -d "$APP_ROOT/admin-web" ] && chown -R "$RUN_USER:$RUN_USER" "$APP_ROOT/admin-web"
  (cd "$SERVER_DIR" && as_app timeout 60 "$NODE_BIN" --disable-warning=ExperimentalWarning -e 'require("./app.js"); process.exit(0)') ||
    die "现在服务器上的代码加载出错（见上面的报错），先别改，把这段截图发给 Claude"
  write_unit
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  if ! restart_service; then
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    die "系统服务启动不了，已经撤销。请到宝塔「网站 → Node 项目」把项目重新点「启动」，再把上面的输出截图发给 Claude"
  fi
  say "系统服务已启动，健康检查正常"
  [ -f "$VERSION_FILE" ] || printf 'sha=manual\ntime=%s\nnote=自动部署之前手动上传的版本\n' "$(date '+%Y-%m-%d %H:%M:%S')" >"$VERSION_FILE"
  log_history "安装自动部署"

  say "[3/5] 建部署专用账号 $DEPLOY_USER，生成钥匙"
  work=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N '' -C "github-actions@jinshan" -f "$work/key"
  setup_deploy_user "$work/key"

  say "[4/5] 在本机试一下这把钥匙"
  ssh_port=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)
  ssh_port=${ssh_port:-22}
  if [ "$(ssh -n -i "$work/key" -p "$ssh_port" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 "$DEPLOY_USER@127.0.0.1" ping 2>/dev/null)" = pong ]; then
    say "钥匙可以用"
  else
    say "注意：本机试连没成功。下面是 SSH 的相关设置，连同这段输出截图发给 Claude："
    sshd -T 2>/dev/null | grep -Ei '^(port|listenaddress|pubkeyauthentication|allowusers|allowgroups|denyusers|usepam) ' || true
  fi

  say "[5/5] 生成要填到 GitHub 的内容"
  hostkey=""
  for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
    [ -f "$f" ] && hostkey=$(awk '{ print $1, $2 }' "$f") && break
  done
  [ -n "$hostkey" ] || die "找不到这台服务器的 SSH 主机公钥"
  if [ "$ssh_port" = 22 ]; then known="$ip $hostkey"; else known="[$ip]:$ssh_port $hostkey"; fi
  (
    umask 077
    {
      printf 'host %s\nport %s\nuser %s\nknown_host %s\n' "$ip" "$ssh_port" "$DEPLOY_USER" "$known"
      cat "$work/key"
    } >"$SECRET_FILE"
  )
  rm -rf "$work"

  say ""
  say "================ 设置完成，还差最后一步 ================"
  say "钥匙存在 $SECRET_FILE（只有 root 能看，这里不显示，免得被截图）。"
  say "1. 宝塔「文件」打开 $SECRET_FILE，Ctrl+A 全选，Ctrl+C 复制"
  say "2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret"
  say "   Name 填 SERVER_SSH，Secret 粘贴刚才复制的全部内容，点 Add secret"
  say "这把钥匙只能用来部署和运维进山服务器，不能登录终端。不要发到聊天里。"
  say "GitHub 第一次连上服务器后，$SECRET_FILE 会自动删除。"
  say "宝塔「Node 项目」里那个项目现在会显示已停止，这是正常的，不要再点启动；"
  say "可以在它的设置里把「开机启动」关掉。以后程序由系统服务 $SERVICE 管。"
}

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cd /
case ${1:-} in
  install) install_all "${2:-}" ;;
  remote)
    REMOTE=1
    run_action "${2:-}"
    ;;
  kill-stray) kill_stray ;;
  "" | -h | --help | help) usage ;;
  *)
    [ "$(id -u)" = 0 ] || die "要用 root 运行：sudo jinshan-ops $*"
    run_action "$*"
    ;;
esac
