# 从宝可梦中国官网下载简体中文卡图

`portable_downloader.py --source official` 是独立的官网来源选项，支持 Windows、
macOS、Linux；不依赖 SQLite、旧队列、NAS、Unix 文件锁、OCR 或模型密钥。
默认仍为 `--source 52poke`，原来的下载方式和阻塞记录不变。
官网模式**不请求 52Poké**，也不绕过它的 403。

## 合并原清单与全部商品分类的原始图片归档

`official_bulk_download.py` 是独立的归档入口：将原清单的官网来源页面，与
`https://www.pokemon.cn/category/tcg/product` 全部分页列出的文章做**并集去重**，
不覆盖 `manifests/remaining-images.json`，也不修改旧下载队列或卡牌库。
此入口用于完整 Git checkout，不包含在旧的 `52poke-image-downloader.zip` 便携包中。
它保存所有发现的图片（包含非卡形图片、小图、原图、srcset 和页面背景图），
按 SHA-256 去重；复用已校验历史回执对应的本地文件，不能把图片数量当成已确认卡牌数。

随 Git 提供的下载清单快照（2026-10-19）：

- `manifests/official-bulk-sources.json`：原清单 74 页 + 商品分类 177 页 − 重复 11 页，
  共 **240 个来源页**，分类分页已遍历 12/12。
- `manifests/official-bulk-images.jsonl`：**4,164 条去重图片引用**（含 3 个页面内嵌图片）。
  是发现清单，不是 4,164 张已下载或已确认卡牌。签名参数不提交；
  **不要直接批量请求此文件中的无签名 CDN 地址**，运行脚本会重新读取来源页获取有效链接。
- 原始 `manifests/remaining-images.json` 保持不变。新发现的商品文章仍继续并入，
  不以快照替代实时分类遍历。

### 在另一台 Linux 机器运行

需要 Python 3.11+、curl 和 Pillow；不需要旧机器的数据库或个人目录：

```sh
# 已 clone 本仓库时：
git pull --ff-only origin main
python3 -m venv tools/52poke-cards/.venv
tools/52poke-cards/.venv/bin/python -m pip install pillow==13.0.0

# 确认获准访问官网后：
tools/52poke-cards/.venv/bin/python tools/52poke-cards/official_bulk_download.py \
  run --site-authorized --workers 32 --max-rps 4
```

不要同时在多台机器运行同一采集任务。当前机器已停止采集；本次是连接超时，
没有收到 401/403/429，不能将迁移机器用来绕过已有访问限制。
Git **不包含已下载图片或私有状态**。只 pull 代码不会在新机器自动获得旧图片；
如果需要复用历史集合，可完整复制历史集合后传入 `--collection /path/to/collection`。
同一输出目录重跑会跳过已校验的完成项；不读取旧 52Poké 队列。

```sh
# 获准执行原始图片采集后，从仓库根目录运行：
tools/52poke-cards/.venv/bin/python tools/52poke-cards/official_bulk_download.py \
  run --site-authorized --workers 32
tools/52poke-cards/.venv/bin/python tools/52poke-cards/official_bulk_download.py status
tools/52poke-cards/.venv/bin/python tools/52poke-cards/official_bulk_download.py verify
```

默认输出为 `downloads-official/all-public-images/`：
`images/` 为去重图片，`documents/` 为来源页面与公开样式/151脚本缓存，
`merged-source-pages.json` 为合并后的来源记录，`images.jsonl` 为脱敏图片回执，
`summary.json` 为进度统计，`unavailable-or-unfinished.json` 为缺失与未完成项。
`archive.sqlite` 是私有任务状态，可能含站方发布的临时签名参数，不提交或公开。

这个显式高速入口不套用下文便携补图器的 10 秒/250 KB/s 串行配置：
最多 32 个工作线程，官网网页主机最多 4 个并行连接，请求发起速率根据成功记录
从每主机每秒 1 次逐步升至最多 4 次。实际并发受限速门控和网络状态限制；
这不是对源站承载能力或“绝不会封禁”的保证。401/403/429 会持久停止、取消待发请求，
不换身份、代理或 IP 重试；与旧官网任务共享网络阻塞记录和排他锁。
404/410 单列为不可用，其他暂时网络错误最多尝试 3 次。分页和未完成项必须分别核验，
同一主机连续 3 次传输失败会持久暂停该主机，其他可用主机仍可处理；
已有本地图片在发请求前统一校验复用。不会自动清除访问限制或传输暂停。
不能把一页或一批下载成功说成全量完成。退出码 2 表示仍有未完成或缺失项，
具体看 `unavailable-or-unfinished.json`，不是全部成功。
不会恢复旧 52Poké 任务或自动汇报。

离线重新导出不含临时签名的下载清单：

```sh
tools/52poke-cards/.venv/bin/python tools/52poke-cards/official_bulk_download.py export-list
```

## 新 clone 的使用顺序

从仓库根目录执行，Windows 可将 `python3` 换成 `py -3`：

```sh
# 1. 离线建立简体中文 metadata 与 8 张随 Git 提供的简体样例。
python3 tools/52poke-cards/bootstrap_library.py --language zh-Hans

# 2. 离线查看官网来源计划，不创建输出、不联网、不需要 Pillow。
python3 tools/52poke-cards/portable_downloader.py --source official plan

# 3. 图片解码需要 Pillow；可使用现有虚拟环境，或另建本工具的环境。
python3 -m pip install -r tools/52poke-cards/requirements.txt

# 4. 确认有权访问官网后，先做最多 3 个图片任务的串行小批次。
python3 tools/52poke-cards/portable_downloader.py --source official \
  --library tools/52poke-cards/library download --site-authorized --limit 3
```

上述 `--library` 很重要：它把确认的图片合并到 bootstrap 建立的库。
若不指定，下载器使用 `downloads-official/library`，不自动寻找其他库。
全局参数 `--source`、`--library`、`--output`、`--manifest` 放在子命令前。

官网默认缓存为 `tools/52poke-cards/downloads-official/`；不与旧 `downloads/` 混用。
继续同一任务可重复第 4 个命令，去掉 `--limit 3` 则处理所有已知来源。
官网模式中 `--limit` 限制本批**尝试的图片任务数**，404、无效图片等也占名额；
页面和脚本请求不占图片名额。`plan`/`status` 只读、不重新解码图片。

## 来源、范围与身份

- 目前读取已提交的 `manifests/remaining-images.json`，只选择全部引用语言明确为
  `zh-Hans` 的目标。它是 **1,064 条历史未解决引用**，不是 bootstrap 全部印刷版的图片目录。
  默认可整理出 74 个官网来源页面；这不是 74 个均可访问或均有图片的承诺。
- 请求只允许 HTTPS 的 `pokemon.cn`、`pokemon.com.cn` 及其子域名。
  从目标记录明确声明的官方页面提取文章图片，优先原图链接、lazy 图和大尺寸 srcset。
  不抓全站、不从百科文件名或卡号猜图片地址、不访问繁体/日文站。
- 收集啦 151 另识别已审阅的公开 JavaScript URL 生成器。
  生成器必须匹配预期结构；脚本改变或消失会记录错误，不猜新的 chunk。
  候选 URL 可能 404；`151_172.png` 等文件标识**不是自动的卡号/版本映射证据**。
- 完整下载后解码并核对 SHA-1、SHA-256、尺寸和大小。
  图片像素尺寸并不固定；纵横比只判断是否保留为候选，不用 `868×1212` 排除其他卡图。
  只有与清单原图 **SHA-1、字节数、尺寸同时一致**，并通过原有语言、身份、冲突和
  semantic-review 门禁的图片，才自动合并到 `library/zh-Hans/set/完整卡号/`。
- 官网图片可能是缩放版、另一个版本或海报。未匹配的卡形图片只保存为候选，
  `identity_status=candidate_requires_identity_review`，**不按文件名强行入库**。
  没有来源、没有匹配字节、需复核的条目仍缺图；不会将候选数当成完成卡牌数。
  不自动调用 OCR、翻译或对战引擎。

## 网络与断点

官网使用固定应用身份，单进程串行请求，每次完成到下次请求至少 **10 秒**，
限速 **250,000 字节/秒**。官网没有套用 Wiki 的夜间窗口或 500 秒间隔；
**官网模式不请求或解析 `robots.txt`**，也不使用其中的 Crawl-delay 或 Request-rate。
此变更仅适用于 `--source official`，默认 52Poké 模式的 robots 检查与限制不变。
所有重定向都重新检查官网域名和请求间隔，外站跳转不跟随。
页面内相对图片链接按重定向后的最终页面地址解析，同时保留声明页与最终页的来源记录；
图片回执记录最终图片地址，但不保留临时查询参数。

401、403、429 会持久停止，不改 IP、身份或清除限制重试。
旧网络状态中残留的 robots 缓存不再读取或刷新；已有持久停止记录不会自动清除。
其他失败记录到队列，重启不自动反复重试。Ctrl+C 保留已完成图片；
中断时状态不明的请求留为错误待检查，不盲目重发。
官网暂不续传半张图片，`.part` 不算成功文件。

运行文件：

- `official-queue.json`：私有队列、来源状态；**可能含官网页面发布的临时签名 URL 查询参数**。
- `official-network.json`：请求间隔、在途标记与持久阻塞状态。
- `official-receipts.json`：去掉查询参数的可传回回执、哈希、来源和匹配情况。
- `files/<SHA-256>.<扩展名>`：完整校验的候选图片，按内容去重。

这些运行文件和下载图片均不提交 Git。迁移网络任务应保留整个原输出目录及网络状态，
不能利用新空目录、多机并行或更换身份重置限制。
临时签名仅使用官网页面实际发布的值，不生成签名或猜参数；过期导致拒绝时停止。

## 离线复核、打包和合并

```sh
python3 tools/52poke-cards/portable_downloader.py --source official \
  --library tools/52poke-cards/library verify
python3 tools/52poke-cards/portable_downloader.py --source official pack-results
```

默认生成 `tools/52poke-cards/official-downloaded-images.zip`，只包含校验后的图片、
`official-receipts.json` 和 `manifest.json`，**不含私有队列/网络状态**。
结果包不能用于清除网络任务的阻塞状态。
结果目录缺少原队列/网络状态时，下载命令会拒绝重新建立网络任务；请使用离线 `verify`，
或恢复完整原任务目录，不通过结果包重置间隔、阻塞和已知请求状态。
即使还没有回执，只剩网络状态或中断图片缓存，也不能当作空白新任务重建队列。
自定义 `pack-results --zip` 必须使用 `.zip` 文件，不能覆盖输入清单、任务状态、图片缓存或库；
打包使用独立临时文件，失败保留原结果包，不复用遗留的同名 `.tmp` 文件。
解压到独立目录后完全离线导入已有库：

```sh
python3 tools/52poke-cards/portable_downloader.py --source official \
  --manifest /path/to/incoming/manifest.json --output /path/to/incoming \
  --library /path/to/master-library verify
python3 tools/52poke-cards/bootstrap_library.py --language zh-Hans \
  --library /path/to/master-library
```

旧图片缺失、改动或身份冲突时报告错误，不覆盖、不静默重下。
完整 metadata 和人工文字修正保留；重复 bootstrap 可刷新索引。
候选图留在传回缓存中，不会因为打包或离线导入而变成已确认卡图。
卡图版权仍属于各自权利人；本程序不授予商用或再分发许可。

## 离线测试

在 `tools/52poke-cards` 目录运行，不访问源站：

```sh
python3 -m unittest discover -s tests -p test_official_downloader.py -v
python3 -m unittest discover -s tests -p test_portable_downloader.py -v
```

仓库旧采集流水线的部分其他测试需要 Linux `fcntl` 及完整依赖；
这不影响新的跨平台官网下载器和标准库离线建库。

Linux 完整回归可从仓库根目录使用独立环境：

```sh
python3 -m venv tools/52poke-cards/.venv
tools/52poke-cards/.venv/bin/python -m pip install -r tools/52poke-cards/requirements.txt
PYTHONPATH=tools/52poke-cards tools/52poke-cards/.venv/bin/python \
  -m unittest discover -s tools/52poke-cards/tests -v
python3 -S tools/52poke-cards/bootstrap_library.py --language zh-Hans --dry-run
```

离线回归覆盖官网页面、脚本、图片与重定向均不发起 robots 请求，以及间隔、限速、
持久停止与身份门禁；还包含便携包解压后移除工作区导入路径的独立测试。
离线/mock 测试通过不等于实时官网下载成功。
便携包中不含 bootstrap 脚本与全量快照；解压后用包根目录的
`portable_downloader.py --source official plan` 和 `python -m unittest discover -s tests -v`。
