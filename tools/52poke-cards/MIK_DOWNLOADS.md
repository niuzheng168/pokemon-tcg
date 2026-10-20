# AREAZERO 单独来源下载

`mik_downloader.py` 从 `https://tcg.mik.moe/cards` 对应的公开接口保存系列清单、
**每个印刷版的完整单卡详情**和网页提供的图片。不是宝可梦官方数据，
不把同名/同规则印刷版合并，不猜测卡号分母，不自动写入现有 `library/`。
源站图片可能只有 300 × 419 像素，不宣称为高清原图。

运行环境为 Python 3.11+ 和 Pillow，可使用工具目录现有 `.venv`。
以下命令从仓库根目录执行：

```sh
tools/52poke-cards/.venv/bin/python tools/52poke-cards/mik_downloader.py \
  run --user-authorized --purpose '本地查看卡组配合'

# 以下均不联网
python3 tools/52poke-cards/mik_downloader.py status
python3 tools/52poke-cards/mik_downloader.py pause
# 完整回读已完成的 metadata、原始响应、图片和回执
tools/52poke-cards/.venv/bin/python tools/52poke-cards/mik_downloader.py verify

# 显式恢复本地暂停，不会清除源站封禁
tools/52poke-cards/.venv/bin/python tools/52poke-cards/mik_downloader.py \
  run --resume --user-authorized --purpose '本地查看卡组配合'

# 仅补抓旧版 PNG-only 检查误拒绝的图片，不重试访问封禁或其他失败
tools/52poke-cards/.venv/bin/python tools/52poke-cards/mik_downloader.py \
  run --resume --retry-image-formats --user-authorized --purpose '本地查看卡组配合'
```

默认独立输出为 `exports/mik-full-20261019/`，已忽略 Git：

- `catalog.json`、`catalog-response.json`：系列索引与原始响应。
- `sets/{setId}/`：系列 metadata、原始卡牌清单与来源回执。
- `cards/{setCode}/{cardIndex}/`：`metadata.json`、`source-response.json`、
  `image.png`（或实际格式的 `.jpg` / `.webp` / `.gif`）及两个来源回执；
  严格保留大小写与前导零。源 URL 即使以 `.png` 结尾，也按解码得到的真实格式
  原字节保存；文件名记录在图片回执 `file` 和索引 `image_file`，不转换或压缩。
- `queue.sqlite`：事务性断点，单个输出目录只能有一个下载进程。
- `progress.json`：进度、错误、缺图与源站计数差异。
- `verification.json`：离线完整解码/哈希回读报告；全部完成时自动执行。
- `index.jsonl`：停止/完成时导出的本来源索引，不是引擎卡牌映射。
- `requests.jsonl`：请求与哈希审计，不保存或复用服务器会话 Cookie。
- `format-retries.jsonl`：显式补抓 PNG-only 误拒绝条目的历史错误与次数。
- `PAUSE`：本地暂停标记；`access-block.json`：持久访问停止。

真实 User-Agent 标识为 Codex，`Agent-Intent` 只发送具体操作和最小用途，不发送对话、
邮箱、密钥、Cookie 或浏览器身份。`--user-authorized` **只表示用户授权本机操作，
不是站方批量授权凭证**；使用者仍须确认符合源站的适用访问要求。
该站已发布逐请求人工确认、真实标识及不鼓励批量抓取的访问声明；
本程序不声称用户的全量指令就是站方对该声明的豁免。

最多 4 个工作线程，全局请求启动间隔不小于 0.25 秒；不会自适应提高到无限并发。
401/403/429、跳转、HTML 验证页面立即持久停止，`--resume` 不解除限制。
网络超时和 5xx 最多尝试 3 次并退避；404 记为缺失而非成功，不换域名、换 IP 或重置身份。
单卡图片完整解码并计算 SHA-1/SHA-256；已存文件及其回执必须一致，否则保留现场并报错。
暂停或进程中断后的正常文件会被复用，不重新抓取；冲突文件不覆盖。
`--limit` 可用于有限现场验证，`--seed` 可复用先前已验证的单卡导出。
正式 Wiki/官网下载器和旧队列完全独立，不会被此程序启动或恢复。
