#!/bin/bash
# GitHub Actions 里连进山服务器。
#   server.sh setup              从 SERVER_SSH 里读出服务器地址和部署钥匙
#   server.sh <动作> [参数...]   在服务器上执行 jinshan-ops 的动作；设了 BUNDLE 时把这个文件当代码包传过去
# SERVER_SSH 是在服务器上运行 deploy/jinshan-ops.sh install 最后打印出来的那段内容。
set -euo pipefail

conf=$HOME/.ssh/jinshan.conf
cmd=${1:-}
shift || true

if [ "$cmd" = setup ]; then
  if [ -z "${SERVER_SSH:-}" ]; then
    echo "::error::还没设置 SERVER_SSH：在服务器上运行 deploy/jinshan-ops.sh install，把最后打印的内容填到仓库 Settings → Secrets and variables → Actions → SERVER_SSH"
    exit 1
  fi
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh
  # 从网页终端复制时可能带上 Windows 换行和行首行尾空格
  s=$(printf '%s\n' "$SERVER_SSH" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  host=$(awk '$1 == "host" { print $2; exit }' <<<"$s")
  port=$(awk '$1 == "port" { print $2; exit }' <<<"$s")
  user=$(awk '$1 == "user" { print $2; exit }' <<<"$s")
  awk '$1 == "known_host" { sub(/^known_host[ \t]+/, ""); print }' <<<"$s" >~/.ssh/jinshan_known_hosts
  sed -n '/^-----BEGIN OPENSSH PRIVATE KEY-----$/,/^-----END OPENSSH PRIVATE KEY-----$/p' <<<"$s" >~/.ssh/jinshan_key
  chmod 600 ~/.ssh/jinshan_key
  if [ -z "$host" ] || [ ! -s ~/.ssh/jinshan_known_hosts ] || ! grep -q 'END OPENSSH PRIVATE KEY' ~/.ssh/jinshan_key ||
    ! ssh-keygen -y -f ~/.ssh/jinshan_key >/dev/null 2>&1; then
    echo "::error::SERVER_SSH 的内容不完整：要从 host 那一行一直复制到 -----END OPENSSH PRIVATE KEY----- 那一行"
    exit 1
  fi
  cat >"$conf" <<CONF
Host jinshan
  HostName $host
  Port ${port:-22}
  User ${user:-jinshan-deploy}
  IdentityFile ~/.ssh/jinshan_key
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/jinshan_known_hosts
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 30
  ServerAliveInterval 15
  ServerAliveCountMax 8
CONF
  exit 0
fi

[ -n "$cmd" ] || { echo "用法：server.sh setup | server.sh <动作> [参数...]"; exit 2; }
[ -f "$conf" ] || { echo "::error::先运行 server.sh setup"; exit 2; }

# ssh 自己出错（连不上、断线）时返回 255，最多试 3 次；服务器上的动作重复执行也没问题
for attempt in 1 2 3; do
  rc=0
  if [ -n "${BUNDLE:-}" ]; then
    ssh -F "$conf" jinshan "$cmd $*" <"$BUNDLE" || rc=$?
  else
    ssh -n -F "$conf" jinshan "$cmd $*" || rc=$?
  fi
  [ "$rc" -eq 255 ] || exit "$rc"
  if [ "$attempt" -lt 3 ]; then
    echo "连服务器失败，$((attempt * 15)) 秒后重试……"
    sleep $((attempt * 15))
  fi
done
echo "::error::连不上服务器：看看服务器是否开机、腾讯云轻量服务器的防火墙有没有放行 SSH 端口；如果报 Permission denied，是 SERVER_SSH 里的钥匙不对（服务器上重新运行过 install 的话要把新内容填进 GitHub）"
exit 255
