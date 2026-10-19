# 新机器建库、独立下载与离线合并

目录身份来自 metadata，图片只是可选资源：

```text
library/发行语言/set/完整卡号目录/metadata.json
library/zh-Hans/151C/001_151/metadata.json
```

**建库不需要图片。** 缺少语言、set、完整卡号或存在冲突的条目仍进入 `_review/`，
不能因文字资料已下载就认定每一条都能可靠分配印刷身份。

## 1. clone 后直接建目录

在新机器执行：

```sh
git clone https://github.com/niuzheng168/pokemon-tcg.git
cd pokemon-tcg/tools/52poke-cards
python3 bootstrap_library.py
```

Windows 把 `python3` 换成 `py -3`。Python 3.11+ 即可，
这一步**只用标准库**：不要求安装第三方依赖、Node、SQLite 输入、NAS、XML、
图片缓存、`.env` 或 API key，也不进行网络请求。

程序直接读取 Git 中两份约 23.5 MB 的 gzip 快照，先核对压缩/展开 SHA-256 和条目数，
再生成忽略版本控制的 `tools/52poke-cards/library/`。不先在本机展开大体积 JSONL。
默认读取 `snapshots/2026.10.18`，首次生成 43,794 个印刷版目录、743 个系列，
自动校验并复制仓库中的 **10 张样例图（8 简体、2 繁体，约 2.25 MB）**。
这 10 张是随 Git 保存的真实原图，不会把快照里的其他历史图片引用冒充本机文件。
因此不需要另外下载或解压样例 ZIP。
已有 clone 只需在仓库根目录 `git pull`，再执行：

```sh
python3 tools/52poke-cards/bootstrap_library.py
```

可指定任意本机/NAS 位置，或仅建中文发行版：

```sh
python3 bootstrap_library.py --library /path/to/library
python3 bootstrap_library.py --language zh-Hans --language zh-Hant
python3 bootstrap_library.py --dry-run
python3 bootstrap_library.py --no-samples
```

`--dry-run` 只验证与计数，不创建目录。限制语言时，索引/统计只描述本次选择的语言，
不会删除其他语言已存在的目录；后续操作应保持相同选择，或改用默认全语言建库。
`--no-samples` 不复制样例图（空库首次图片数为 0），也不会删除已有图片。
只选 `zh-Hans` 时复制 8 张，只选 `zh-Hant` 时复制 2 张。
自定义不同归档需匹配样例来源，否则用 `--no-samples`。
逐张出处、SHA-256 与图片许可边界见[样例说明](../tools/52poke-cards/samples/README.md)。

重复运行会保留同一快照下已有的完整 metadata、人工文字修正、下载图片及其证据，
并刷新索引。不同页面身份、原始完整卡号、快照或页面修订冲突时停止，不用旧快照覆盖新资料。
仅便携下载器生成的待补简体 metadata 外壳，可在身份一致时升级为完整说明。
已有正常图片若缺失或哈希改变则报错，不静默覆盖或重下。
相同 SHA-256 的样例复用已有文件及其更强的复核证据；
已有不同图片保留为主图，新样例放到该卡的 `images/<SHA-256>.png`，不覆盖主图。

## 2. 在获准的环境独立下载

**多机可各自离线建库，不代表获准多机并行访问源站。**
原环境已经记录 Wiki 403；必须先取得相应许可，不能切换机器/IP、
丢弃阻塞状态或拆清单绕过封禁、请求间隔和全局预算。
同一站点一次只运行一个下载进程；本工具不提供分片并发或身份切换功能。

只有在确认源站允许访问的情况下，准备下载器的 Pillow 依赖并执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install pillow==13.0.0
.venv/bin/python portable_downloader.py --output downloads --library library \
  download --site-authorized --wait
```

Windows 对应解释器为 `.venv\Scripts\python.exe`。

- 建库从完整快照提取印刷身份，但**不代表所有卡牌都有可用图片 URL**。
- 已提交的待下载清单目前为 1,064 条引用：1,013 条有已记录原图 URL，51 条缺 URL。
  它不是 43,794 个印刷版的完整图片清单，程序不会猜 URL。
- 已完成文件校验后跳过，断点续传、夜间窗口、500 秒最低间隔和阻塞停止机制不变。
- 图片完成后按明确身份写入 `library/语言/set/完整卡号/`，完整简体 metadata 不会被外壳覆盖。
  需语义复核、身份不明或冲突的图片留在缓存并记入 `_review/downloads/`。
- 下载和建目录都不调用 OCR、翻译或模型服务。
- 换机器接续**同一任务**时，应保留原下载目录的 `state.json`（含间隔、预算、阻塞状态）、
  回执和已完成文件，不用空目录重置限制。不能两台机器同时接续同一源站任务。

## 3. 手动传回，离线合并

在下载机器打包已验证结果：

```sh
.venv/bin/python portable_downloader.py --output downloads \
  pack-results --zip exports/machine-a-results.zip
```

把 ZIP 手动传回汇总机器，解压到独立空目录，例如 `/path/to/incoming/machine-a`。
主库先按步骤 1 从**相同 Git 版本、相同快照**生成 metadata，然后执行：

```sh
.venv/bin/python portable_downloader.py \
  --manifest /path/to/incoming/machine-a/manifest.json \
  --output /path/to/incoming/machine-a \
  --library /path/to/master-library \
  verify
```

这里的 `verify` **完全离线**：检查 Wiki SHA-1、SHA-256、大小、尺寸和图像解码，
再把明确身份的图片归档到主库。对 machine-b 等其他结果重复相同操作即可。
结果 ZIP 是合并输入，不是重置运行状态或网络授权的手段。

不要直接用文件管理器“全部覆盖”各台机器的 `metadata.json`：

- 同一印刷版、同一图片 SHA-256：重复导入复用，不重复保存。
- 同一印刷版、不同图片：保留为多个资源，不覆盖主图。
- 身份不一致或需语义核对：保留待审，不强行关联。
- 主库完整 metadata、中文文字、人工修正与引擎 ID 不会被下载外壳替换。
- 缺少原文件、SHA、回执冲突或图像校验失败时停止，不改成重新联网下载。

全部结果合并完后，再运行一次建库命令，刷新卡图覆盖数与索引：

```sh
python3 bootstrap_library.py --library /path/to/master-library
```

此时会保留刚合并的图片。下载回执、缓存和生成的目录均不提交 Git；
每台机器只提交程序与必要的 metadata 快照；仓库明确列出的 10 张样例是图片提交的唯一例外。

## 不再需要样例 ZIP

metadata 压缩快照与 10 张样例图均已在仓库中，clone/pull 后运行一次建库脚本即可。
NAS 中以前生成的样例 ZIP 仅为历史产物，不再作为交付或安装步骤；
不要将它当作 `pack-results` 下载回执包导入。后续手动传回实际新下载结果时，
仍可按步骤 3 使用回执 ZIP。
