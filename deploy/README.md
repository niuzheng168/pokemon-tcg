# 生产部署

正式网站在本机用 systemd 用户服务运行，代码就是这个仓库（`~/g/pokemon/pokemon-tcg`）。

| 文件 | 作用 |
|---|---|
| `start.sh` | 启动网站：`server/main.mjs`，HTTPS，端口 1028，关闭注册 |
| `backup.sh` | 每日备份账户数据库和日志到 NAS |
| `systemd/pokemon-cn-site.service` | 网站服务，开机自启，等 NAS 挂好再启动 |
| `systemd/pokemon-cn-backup.service`、`.timer` | 每天 04:17 运行 `backup.sh`，关机错过的开机后补跑 |

## 数据放在哪里

- **不进 git，在 `~/.local/share/pokemon-cn-site/`**：HTTPS 证书 `cert.pem`、私钥 `key.pem`（仓库是公开的，绝不能提交）、
  账户数据库 `accounts.db`、日志 `server.log`。数据库是 SQLite（WAL），不能放在 CIFS 网络盘上，所以留在本机，每天备份。
- **大模型（可选）**：`~/.local/share/pokemon-cn-site/llm.json` 存在时，`start.sh` 用 `--llm` 打开小茂的大模型难度（冠军、
  宝可梦大师）和大模型教练（`ai/llm-levels.mjs`）。它写明每个模型用哪个部署、读哪个 env 文件里的密钥，env 文件也放在
  这个目录（权限 600，绝不能提交）：

  ```json
  { "models": { "sol": { "model": "gpt-6.1-sol-global-standard", "env": "/home/<用户>/.local/share/pokemon-cn-site/foundry-sol.env" },
                "astra": { "model": "gpt-6-astra", "env": "/home/<用户>/.local/share/pokemon-cn-site/foundry-astra.env" } } }
  ```

  env 文件是 Azure AI Foundry 的 `AOAI_ENDPOINT=https://…/openai/v1` 和 `FOUNDRY_KEY=…`。没有这个文件就不提供这两档和教练。
- **NAS（`/nas/share/Pokemon`）**：
  - `website/site`：构建好的网站，仓库的 `site/` 链接到这里。
  - `library_prod`：卡牌资料和卡图。
  - `card-library`：卡牌库索引和缩略图，仓库的 `.data/card-library` 链接到这里。
  - `replays`、`bug-reports`：回放和问题报告。
  - `backups/pokemon-cn-site/{accounts,logs}`：每日备份，数据库保留 30 天、日志保留 90 天（`backup.sh` 里的
    `DB_DAYS`、`LOG_DAYS`）。

## 安装

服务文件以链接方式装进 `~/.config/systemd/user/`，以仓库里的为准：

```sh
loginctl enable-linger "$USER"                      # 不登录也运行、开机自启
systemctl --user enable "$PWD/deploy/systemd/pokemon-cn-site.service"
systemctl --user link "$PWD/deploy/systemd/pokemon-cn-backup.service"
systemctl --user enable --now "$PWD/deploy/systemd/pokemon-cn-backup.timer"
ln -s /nas/share/Pokemon/card-library .data/card-library
```

## 日常操作

```sh
npm run web:build && systemctl --user restart pokemon-cn-site   # 部署：拉取代码后构建网站并重启
systemctl --user start pokemon-cn-backup                        # 立刻备份一次（输出：journalctl --user -u pokemon-cn-backup）
npm run user -- add <用户名> --db ~/.local/share/pokemon-cn-site/accounts.db   # 注册关闭期间开通账号
```

改了 `systemd/` 下的文件后先 `systemctl --user daemon-reload`。

恢复数据库：停网站，把一份备份解压覆盖 `accounts.db`（同时删掉 `accounts.db-wal`、`accounts.db-shm`），再启动网站。
