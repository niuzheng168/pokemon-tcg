# 52Poké metadata 与图片下载工具

这是原工作目录 `52poke-cards` 的版本控制副本，随 Academy fork 保存。
程序和测试纳入代码版本控制；**仅 10 张明确列出的公开来源样例图随 Git 保存**，
其余下载图片、私有研究资料、密钥、模型输出、SQLite、XML/ZIP 原归档和运行缓存均不提交。
现有外部工作目录及缓存不会被搬走或清空。

代码遵循仓库的 MIT 许可；百科数据不是 MIT，详见 [DATA_LICENSE.md](DATA_LICENSE.md)。
本机已将大体积运行数据放在 NAS，活跃数据库保留本机；目录与安全边界见
[存储说明](../../docs/STORAGE.md)。

## 新机器 clone 后直接建库

不需要 ZIP、本机 SQLite、NAS、原始 XML 或图片缓存。Python 3.11+ 标准库即可，
在本工具目录运行：

```sh
python3 bootstrap_library.py
```

直接验证并读取已提交的 gzip metadata，生成 `library/发行语言/set/完整卡号/metadata.json`；
首次为 43,794 个印刷版目录、743 个系列，自动复制仓库内的 **10 张样例图**
（8 简体、2 繁体，约 2.25 MB），不联网下载。
从仓库根目录运行时用 `python3 tools/52poke-cards/bootstrap_library.py`。
`--library` 可选其他位置，`--language` 可重复传入限制语言，
`--dry-run` 只验证与计数，`--no-samples` 只生成 metadata。
重复运行保留已有完整 metadata、人工修正和校验通过的图片，刷新索引；
身份/快照冲突时停止，不覆盖。样例的来源、哈希、权利与规则版本边界见
[`samples/README.md`](samples/README.md)；10 张样例不等于全量图或已实现的对战卡牌。

建库、获准后的独立下载、手动传回和**离线合并**的完整步骤见
[多机工作流](../../docs/MULTI_MACHINE.md)。
各台机器可离线建库，但不能用多机分片、换 IP 或重置状态绕过源站限制。

### 官网图片来源（仅简体中文）

建库仍完全离线；下载器新增可选 `--source official`，不请求 52Poké，
支持 Windows/macOS/Linux，不需要旧 SQLite 或 OCR：

```sh
python3 tools/52poke-cards/bootstrap_library.py --language zh-Hans
python3 tools/52poke-cards/portable_downloader.py --source official plan
python3 tools/52poke-cards/portable_downloader.py --source official \
  --library tools/52poke-cards/library download --site-authorized --limit 3
```

以上从仓库根目录执行；在本工具目录则去掉路径前缀。
官网独立缓存为 `downloads-official/`，串行、至少 10 秒间隔、250 KB/s、
不请求或检查官网 `robots.txt`，401/403/429 持久停止；没有套用 Wiki 的夜间窗口。
仅字节一致且身份门禁通过的卡图自动入库，其他留作候选，不按图片文件名猜卡号。
原有默认 `--source 52poke` 与限制不变。范围、续下、打包与离线合并见
[官网来源说明](OFFICIAL_DOWNLOADS.md)；已知官网来源不保证覆盖全部印刷版。

### AREAZERO 卡牌详情与图片

独立的 `mik_downloader.py` 支持按源站系列枚举、每个印刷版的完整 metadata、
网页图片（按实际格式原样保存）、有限并发及事务性断点续传。数据保存在忽略 Git 的独立目录，
不自动合并进正式库，不启动 Wiki 或官网的旧队列。
运行、暂停、完整性回读及访问边界见 [AREAZERO 下载说明](MIK_DOWNLOADS.md)。

## 按发行语言、系列和完整卡号归档

正式库路径为 `library/发行语言/set/完整卡号目录/`，没有 `tcg/` 层。
例如 `library/zh-Hans/151C/001_151/{metadata.json,image.png}`。
`001/SV-P` 用 `001_SV-P`，`10 02/04` 用 `10_02_04`；
metadata 保留原样 `number`，文字显示仍为简体，图片保持真实发行语言。

已有原始/简体展示导出和本地图片队列时，离线执行：

```sh
.venv/bin/python card_library.py --library /nas/share/Pokemon/library
```

`card_library.py` 不联网，合并确定的印刷身份并核对图片 SHA-256；无法确定或相互冲突的记录
写入 `_review/`，不按文件名猜 set/卡号、不把 Pocket 混进来、不覆盖原始缓存。
默认包含所有支持的单一发行语言，可重复传 `--language` 限定语言。
`card_storage.py` 是完整/便携下载器共用的命名、校验和逐图归档逻辑；
下载命令的 `--library` 指向正式库，原始缓存只负责来源追溯和断点续传。
完整命令、单卡 metadata 边界和恢复规则见[存储说明](../../docs/STORAGE.md)。
本机 `library` 是忽略版本控制的 NAS 链接，其中图片和生成的单卡 metadata 不提交 Git；
上述 10 张 Git 样例在独立的 `samples/` 目录保存，不扩大其他图片的提交范围。

## 已提交的 metadata

来源是站方发布的 **2026.10.18 XML 快照**，不宣称是当前网站全量数据。
精确大小、SHA-256、转换与来源信息见
[`snapshots/2026.10.18/manifest.json`](snapshots/2026.10.18/manifest.json)。

| 文件 | 条目数 | 原始本地大小 | Git 中 gzip 大小 |
| --- | ---: | ---: | ---: |
| `cards.jsonl.gz` | 16,645 个卡牌页面 | 196,546,548 字节 | 20,058,426 字节 |
| `display-zh-hans.jsonl.gz` | 14,680 条 TCG 简体展示记录 | 56,863,489 字节 | 3,443,956 字节 |

- 第一份包含 **14,680 个实体 TCG 页面 + 1,965 个 Pocket 页面**；
  其中内嵌 **73,434 条印刷记录**，不是 73,434 张独立可对战卡牌。
- 两个 gzip 合计 **23,502,382 字节（约 23.5 MB）**。
- SQLite 本地为 366,280,704 字节，结构化 JSONL 可再生成；不重复提交数据库、CSV、
  印刷 JSONL 或全站 XML。完整原始维基文本继续保留在本地归档中。
- 第一份压缩前后逐字节一致。第二份移除机器专用的图片路径后为 53,311,680 字节，
  保留图片语言、来源、编号、尺寸、哈希和转换审计，**不含图片字节**。
- 展示资料仍有缺失和待审字段：154 条缺少部分中文内容，复杂模板、历史译名等需复核。
  不将繁简转换说成官方核准译文，不因有 metadata 就宣称已实现对战效果。
- `display-audit.json` 中缓存图片覆盖数是原工作环境导出时的历史统计，
  **不是新克隆就能获得的图片数**。没有包含受限研究数据集的图片、JSON 或映射。
- `sources/wiki-file-metadata/` 另保留 2,454 个文件的最新元数据读取证据；
  这是附件信息，不是新增 2,454 张卡牌或已下载图片。

gzip 使用固定时间戳和空文件名头，重复构建可得到相同内容哈希。

## 环境与离线验证

在本目录运行，推荐 Python 3.11+：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python snapshot_metadata.py --verify snapshots/2026.10.18
.venv/bin/python portable_downloader.py status
```

`status` 不联网；`--verify` 会逐条读取快照，核对压缩/解压哈希、大小、条目数和游戏分类。
只看 metadata 时可以直接以 Python 标准库 `gzip.open(..., "rt", encoding="utf-8")`
逐行解析，无需安装 Pillow、下载图片或获得模型密钥。
完整采集流水线使用 Unix 文件锁；Windows 下载请使用便携下载程序，见下一节。

## 下载清单与便携包

- `manifests/remaining-images.json`：当前冻结的 1,064 条未完成图片引用；
  其中 1,013 条有真实原图 URL 和 SHA-1/大小/尺寸，51 条缺 URL，不猜地址。
- 它只表示已整理清单，不是全站所有简体卡图；部分恢复引用下载后还需语义核对。
- [`PORTABLE_DOWNLOAD_README.md`](PORTABLE_DOWNLOAD_README.md)：
  Windows/macOS/Linux 的便携下载、续下、校验和传回结果说明。
- 从新克隆可以直接生成便携包，无需数据库或 XML：

```sh
.venv/bin/python build_portable_bundle.py --destination exports
```

本地存在新队列/报告时，打包器会检查二者一致，避免无声使用过期列表。
生成的 ZIP 不纳入 Git。

**站方禁止更换 IP/身份绕过封禁。迁移机器不代表获准访问；
请先取得所需许可。** 程序使用固定身份、串行下载、至少 500 秒请求间隔、
UTC+08 的 02:00–08:00 窗口及带宽限制，遇到 401/403/429 停止。
本段为默认 52Poké 模式；官网模式使用上节所述独立政策。
缺图不是放宽限制或把教学示意图算作下载成功的理由。

## 完整采集与网站导出

有权访问时可重新获取官方 XML，再在本目录创建忽略版本控制的数据库：

```sh
.venv/bin/python fetch_archive.py --release 2026.10.18
.venv/bin/python import_cards.py build \
  --archive downloads/52poke-2026.10.18.xml.gz \
  --output data/2026.10.18 --release 2026.10.18
```

`fetch_archive.py` 验证发布者的 ZIP 校验值，解压可选用系统 `unzip` 或 Python。
已提交的 JSONL 是 metadata 阅读/存档快照，不冒充包含全部页面的 SQLite：
需要原始页面查询、图像来源解析时，使用上面的 XML 导入重建。

- `image_pipeline.py plan/download/process`：
  URL 准备、串行下载、模型处理相互独立；处理慢不会堵住下载。
- `download_images.py`：明确声明来源的下载与恢复。
- `card_library.py`：离线生成 `发行语言/set/完整卡号` 正式库、简体说明、索引和待审清单。
- `bootstrap_library.py`：直接从 Git 中压缩快照建库，无第三方依赖、数据库输入或 NAS 要求。
- `wiki_image_hashes.py`：最新文件元数据与已有官方图片的字节哈希核对。
- `export_display_metadata.py`：文字简体、图片语言独立的展示投影。
- `export_academy.py`：只按相同版本证据关联现有引擎卡牌。
- `local_research_cards.py`：可选本机研究工具；**其数据和素材不提交，不公开分发**。
- [`IMAGE_DOWNLOADS.md`](IMAGE_DOWNLOADS.md)：历史采集过程与限制，旧统计不是当前完成数。

仓库内路径已适配：默认 Academy 是本仓库，模型工具默认读取仓库根目录 `.env`，
也可在支持的命令上传 `--env`。本次不复制旧 `.env`，不在前端打包密钥。
`export_academy.py --academy /path/to/repo` 可显式选择目标仓库。
普通下载程序不读取任何模型密钥；只有处理命令会调用配置的服务。

重新制作数据快照：

```sh
.venv/bin/python snapshot_metadata.py \
  --source data/2026.10.18 --output snapshots/2026.10.18
```

提交前请运行测试和离线快照校验；检查 Git 暂存区中只有代码、文档、清单及压缩 metadata。
