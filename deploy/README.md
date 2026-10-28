# 自动部署和运维

设置好以后，服务器程序和电脑网页后台的更新都由 GitHub 自动完成，不用再上传 zip、不用去宝塔点重启：

- `main` 分支上 `server/` 或 `admin-web/dist/` 有改动，就自动部署到服务器。
- 也可以在 GitHub 仓库的 **Actions → 部署到服务器 → Run workflow** 手动部署任意分支或提交。
- 日常运维在 **Actions → 服务器运维 → Run workflow** 里选：`status` 看状态、`logs` 看日志、`restart` 重启、`backup` 马上备份数据库、`rollback` 退回上一版。

小程序本身（`miniprogram/`、`miniprogram-carwash/`）不在这里，改了以后还是在微信开发者工具里上传、提交审核。

## 每次部署做了什么

1. 在 GitHub 上跑一遍测试，没通过就不部署。
2. 把 `server/` 和 `admin-web/dist/` 打成代码包，传到服务器。
3. 服务器检查代码包（只能有这两个文件夹，不能有链接），先试着加载一遍新代码，加载出错就停下，线上不受影响。
4. 备份数据库和现在的代码到 `/www/backup/jinshan/`（数据库留最近 20 份，代码留最近 10 份）。
5. 换上新代码，重启，检查 `/healthz`。启动不了就**自动退回上一版**。

`server/config.json`、`server/data/`（数据库和图片）、`server/cert/`（支付证书）永远不会被覆盖或删除。服务器上手动留的 `config*.json`、`*.pem`、`*.db`、`*.bak` 文件也不会被删。

## 第一次设置（只做一次）

需要的东西：宝塔面板能登录，GitHub 仓库是自己的。全程不需要把任何密码发给别人。

1. **上传脚本**：宝塔「文件」→ 进入 `/www/wwwroot/jinshan` → 上传 `jinshan-ops.sh`（就是本文件夹里那个）。
2. **运行设置**：宝塔「终端」里粘贴下面一行，回车（最后的 IP 换成自己服务器的公网 IP）：

   ```
   sudo bash /www/wwwroot/jinshan/jinshan-ops.sh install 139.155.154.80
   ```

   它会：
   - 把服务器程序改成系统服务 `jinshan`，用 `www` 用户运行，开机自动启动，程序崩了 3 秒后自动拉起来。宝塔「Node 项目」里原来那个项目会被停掉，以后不要再在宝塔里启动它，可以把它的「开机启动」关掉或者删掉这个项目条目（删的时候**不要**勾选删除文件）。
   - 建一个专用账号 `jinshan-deploy` 和一把部署钥匙。这把钥匙只能调用 `jinshan-ops` 的几个动作，不能登录终端、不能转发端口。
   - 把要填到 GitHub 的内容（以 `host` 开头、以 `-----END OPENSSH PRIVATE KEY-----` 结尾）存到 `/root/jinshan-github-secret.txt`，只有 root 能看，终端里不显示。
   - 程序如果不在 `/www/wwwroot/jinshan`，会按正在跑的进程找到实际目录，记在 `/etc/jinshan-ops.conf`。

   如果中途报错，程序会撤销改动，按提示到宝塔「Node 项目」把项目重新启动，再把报错截图发给 Claude。

3. **填到 GitHub**：宝塔「文件」打开 `/root/jinshan-github-secret.txt`，全选复制。仓库 **Settings → Secrets and variables → Actions → New repository secret**，Name 填 `SERVER_SSH`，Secret 粘贴，点 Add secret。GitHub 第一次连上服务器后，`/root/jinshan-github-secret.txt` 会自动删除。

腾讯云轻量服务器的防火墙默认放行 22 端口（SSH），GitHub 就是从这个端口连进来的，不要关掉它。

## 在服务器上直接操作

宝塔「终端」里也能用同样的命令：

```
sudo jinshan-ops status          # 看状态：版本、内存、磁盘、备份
sudo jinshan-ops logs 200        # 最近 200 行日志
sudo jinshan-ops restart         # 重启
sudo jinshan-ops backup          # 马上备份数据库
sudo jinshan-ops rollback        # 退回上一版代码
```

也可以用系统自带的命令：`systemctl status jinshan`、`journalctl -u jinshan -f`。

- 现在线上是哪个版本：`/www/wwwroot/jinshan/.deploy-version`
- 部署记录：`/www/backup/jinshan/history.log`
- 每天凌晨 4 点后程序自己做的数据库备份还在 `server/data/backups/`，保留 14 天

**从备份恢复数据库**：`systemctl stop jinshan` → 把 `server/data/jinshan.db` 改名留底，删掉旁边的 `jinshan.db-wal`、`jinshan.db-shm` → 把要恢复的备份（`/www/backup/jinshan/db/` 或 `server/data/backups/` 里的）复制成 `server/data/jinshan.db`，所有者改成 `www` → `systemctl start jinshan`。

## 备案下来以后配 HTTPS

程序不再归宝塔「Node 项目」管，域名和证书改用反向代理：

1. 宝塔「网站 → 反向代理 → 添加反代」（老版本是「网站 → 添加站点」建一个纯静态站点，再在站点设置里加反向代理）：域名填自己的域名，目标填 `http://127.0.0.1:3000`。
2. 站点设置 →「SSL」→ Let's Encrypt 申请证书，打开「强制 HTTPS」。
3. `server/config.json` 里 `host` 改回 `"127.0.0.1"`，`publicUrl` 填 `https://你的域名`，然后在 GitHub 运行一次「服务器运维 → restart」（或者终端里 `sudo jinshan-ops restart`）。
4. 删掉腾讯云防火墙和宝塔「安全」里放行的 3000 端口。

## 换钥匙、停用自动部署

- **换钥匙**（比如怀疑泄露了）：在服务器上重新运行一次第 2 步，再把新打印的内容更新到 GitHub 的 `SERVER_SSH`。旧钥匙马上失效。
- **停用自动部署**：删掉 GitHub 上的 `SERVER_SSH`，或者删掉服务器上的 `/home/jinshan-deploy/.ssh/authorized_keys`。
- **改回宝塔管理**：`systemctl disable --now jinshan`，然后在宝塔「Node 项目」里重新添加并启动。

## 文件

```
deploy/jinshan-ops.sh            服务器上的运维脚本（install 时装到 /usr/local/bin/jinshan-ops）
.github/workflows/deploy.yml     部署到服务器
.github/workflows/ops.yml        服务器运维
.github/scripts/server.sh        GitHub 上连服务器用的小工具（读 SERVER_SSH、断线重试）
```

改了 `jinshan-ops.sh` 以后，要在服务器上重新运行一次 install 才生效（这个脚本有 root 权限，所以故意不让 GitHub 自动更新它）。
