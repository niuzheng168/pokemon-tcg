# 图片与 metadata 的 NAS 存储

本机的大体积运行数据存放在 **`/nas/share/Pokemon`**，代码仍保留在本地 Git 仓库。
原工作路径通过本机软链接兼容，不要求改写已有图片回执中的路径。
这些软链接是机器配置，不纳入 Git。

## 布局

正式卡牌库采用 **`发行语言/set/完整卡号目录/`**，不再增加 `tcg/` 层：

```text
/nas/share/Pokemon/
├── library/
│   ├── zh-Hans/
│   │   └── 151C/
│   │       ├── set.json
│   │       └── 001_151/
│   │           ├── metadata.json
│   │           └── image.png
│   ├── zh-Hant/…
│   ├── ja/…
│   ├── en/…
│   ├── index.jsonl
│   ├── report.json
│   └── _review/
├── archives/
├── images/                 # 原始下载/待处理缓存，不是正式卡牌库
├── metadata/               # 原始快照及页面级导出，保留追溯依据
├── website/
└── backups/
```

**命名规则**

- `001/151` → `001_151`，`001/SV-P` → `001_SV-P`，
  `10 02/04` → `10_02_04`。保留前导零、分母、字母和后缀，不把编号转换成整数。
- metadata 的 `number` 保留原始完整卡号，`game: "tcg"` 只作为字段；
  内部 `tcg:…` ID 命名空间不因目录简化而改变。Pocket 不混进这个实体卡牌库。
- **目录语言指实物发行语言**，不是说明文字语言。`zh-Hant` 卡图对应的
  `metadata_language` 仍为 `zh-Hans`，孩子阅读的名称和说明放在 `name/display/blocks`。
  原始多语言字段在 `source_printings` 中保留供审计。
- 同一印刷版多个图片保存在 `images` 数组；首图为 `image.<原扩展名>`，其他图片为
  `images/<SHA-256>.<原扩展名>`。不改图、不改格式、不覆盖其他图片。
- `set.json` 是当前可归档记录的系列摘要，不冒充官方完整系列目录。
- Wiki 页面可能汇总多个发行版或规则版本。页面 ID、印刷 ID、图片哈希和引擎 ID 分开保存，
  `blocks` 保留版本区块；归档不表示对应对战效果已经实现或各字段已经人工核准。

| NAS 子目录 | 内容 |
| --- | --- |
| `library/发行语言/set/完整卡号目录/` | 正式印刷身份 metadata 与已确认图片 |
| `library/_review/` | 缺失身份、跨页面身份冲突、未能确定归属的图片引用 |
| `archives/` | 下载的站方归档和原始压缩包 |
| `images/official-candidates/` | 官网候选图片及已标记来源的本地裁取图 |
| `images/wiki-mixed/`、`images/wiki-zh-hans/` | 原有图片缓存 |
| `images/academy-zh-hant/`、`images/samples/` | 网站繁体补图及样本 |
| `metadata/2026.10.18/` | 结构化 JSONL、CSV、原文记录和简体展示 metadata |
| `metadata/git-snapshots/2026.10.18/` | 已提交压缩 metadata 的额外 NAS 副本 |
| `website/zh-scans/`、`website/zh-learning/` | 网站卡图和明确标记的练习卡面 |
| `website/site/` | 可重新生成的静态网站构建产物 |
| `backups/sqlite/` | 迁移时生成的一致性 SQLite 压缩备份 |

迁移报告 `migration-20261019.json` 保存逐文件大小与 SHA-256、目标路径及迁移阶段。
报告仅用于本机维护，不提交到 Git。SQLite 备份是迁移时点快照，不是自动持续同步。

### 本机首次建库结果（2026-10-19）

- 从 14,680 个实体 TCG 页面提取出 **43,794 个可归档印刷身份、743 个系列**；
  其中简体发行版 8,681 个、繁体发行版 12,897 个，其他为日文、英文等发行版。
  这些是印刷版目录数，不是独立规则卡牌数，也不是官网当前全部卡牌数。
- 归档 **1,132 个已有图片文件**，包括明确标记来源的官网配图裁取图；未新增网络下载。
- 308 组身份冲突、27,908 条缺失或暂不支持的印刷行，以及 6 条未确定归属的图片绑定留在待审清单。
  其他落在冲突组的图片证据也保留在冲突记录和原始缓存，不强行选一条覆盖。
- 原始归档、页面级 metadata、图片缓存、回执和本机数据库均保留。
  最新统计以 NAS 上的 `library/report.json` 为准，完整复核结果在
  `library/verification-20261019.json`。

## 必须保留本机的部分

- **正在使用的 SQLite 数据库、WAL/SHM 和队列锁**仍在本机。
  SQLite 的 WAL 模式要求进程在同一主机，不支持网络文件系统；不要让多台机器直接
  写 NAS 上的同一个数据库。
  依据：https://www.sqlite.org/wal.html
- `data/local-research` 与 `PTCG-CHS-Datasets` 的受限研究素材不放进共享目录，
  不扩大访问范围，不进入普通构建或模型服务。需要迁移时应先确认适用条件及私有存储权限。
- Git 已提交的约 23.5 MB 压缩 metadata 继续保留在检出目录，避免把受版本控制的文件
  改成机器专用软链接；大体积运行导出物已在 NAS。
- `.env`、Python 环境、`node_modules`、源码和小体积控制文件仍在本机。

## 兼容与恢复

本仓库 `tools/52poke-cards` 的运行目录连接到原工作缓存；其中活跃数据库仍为本地文件，
图片子目录与大体积 metadata 文件指向 NAS。已有的卡图记录无需按卡名重新匹配。

原始 metadata 的原子导出会写入软链接的实际目标，保留链接本身；若目标不可用则报错，
不会悄悄把大文件重新生成到本机。静态站构建复制卡图时会解引用软链接，
确保生成的网站包含实际文件，而不是无法部署到其他机器的 NAS 绝对路径链接。

运行下载、导出或构建前确认 NAS 已挂载：

```sh
findmnt -T /nas/share
test -d /nas/share/Pokemon/images
```

NAS 离线时，不要删除链接或在同名位置新建替代目录。应恢复挂载后再继续，
避免分裂成两套数据。仅从 Git 克隆的新机器不含这些本机链接，可照工具说明选择自己的
缓存位置；目录布局不要求其他用户必须拥有相同 NAS。

需要恢复 SQLite 时，先停止对应程序，将 `backups/sqlite/` 的所需备份解压回本机，
离线检查后再使用。不要直接把 NAS 压缩备份当作活跃数据库。

## 建库与增量更新

先导入 XML、生成简体展示 metadata，再从工具目录执行。下例假设工具的 Python 环境
已按工具 README 准备好；本机也可使用原工作目录的 `.venv/bin/python`：

```sh
cd tools/52poke-cards
.venv/bin/python card_library.py --library /nas/share/Pokemon/library
```

默认处理所有可明确识别的实体 TCG 发行语言，不会下载新图片、调用 OCR 或模型服务、
更改源 SQLite、搬走原始缓存。使用 `--language zh-Hans --language zh-Hant` 可以限制语言，
但不会删除其他语言已存在的目录。图片从三个本地已完成队列合并，检查归档 SHA-256、
源图片 SHA-256，以及写入后图片 SHA-256。重复运行复用已有图片和未变化的 metadata；
源图或已发布图片损坏时停止，不静默重下或覆盖。

自定义路径：

```sh
.venv/bin/python card_library.py \
  --cards /path/to/cards.jsonl \
  --display /path/to/display-zh-hans/cards.jsonl \
  --images /local/path/to/queue.sqlite \
  --library /nas/share/Pokemon/library
```

`cards.jsonl` 同目录的导入 `audit.json` 用于核对源归档，简体展示记录必须与源页面修订一致。
队列中的图片只允许来自显式公开缓存目录，不读取受限研究目录。

**不能确定身份时不猜：**

- 缺少 set、完整卡号或单一发行语言：`_review/printings.jsonl`。
- 相同语言、set、完整卡号对应多个 Wiki 页面，或不同原始卡号映射到同一目录：
  `_review/collisions.jsonl`。正常目录不任选一条覆盖；若已有目录变成冲突，程序停止供维护者复核。
- 图片语言未确认、身份不一致或一个资源指向多个印刷身份：
  `_review/assets.jsonl`；原文件继续在下载缓存。
- Wiki `set_code` 抽自图标，不保证等于实际印刷系列。对于 `064/SV-P` 这种明确的特典后缀，
  按 `SV-P` 归档，同时保留原图标字段和冲突标记；其他不能解释的形式留待审。

`index.jsonl` 与 `report.json` 是**上次离线同步的快照**；单卡 `metadata.json` 为准。
下载命令可以逐图更新正式库，之后再运行 `card_library.py` 刷新完整简体说明和总索引。
新下载且尚无页面级简体投影的卡，只生成带 `simplified_display_metadata_pending` 的身份外壳，
不会把原文或空字段冒充已完成的简体说明。

## 后续下载

`download_images.py` 与 `download_simplified_sources.py` 都支持 `--library`，
默认 `tools/52poke-cards/library`，本机通过忽略版本控制的软链接指向 NAS 正式库：

```sh
.venv/bin/python download_images.py \
  --directory images-academy-zh-hant --library /nas/share/Pokemon/library run --limit 3
.venv/bin/python download_simplified_sources.py run \
  --library /nas/share/Pokemon/library --limit 3
```

这些是已有来源允许访问时的命令示例，不要求实际发起请求。原限速、阻塞状态、访问限制
与断点续传机制不变。先持久化下载成功，再归档；NAS 写入失败不会把已成功下载的文件变成重下任务。
归档只用已明确的身份，不等待 OCR；`image_pipeline.py` 下载的未确认宣传图继续留缓存，
独立处理/核对后再离线同步。

便携下载器同样支持 `--library`，默认写入 `--output` 下的 `library/`。
`verify` 可以离线整理已经下好的文件。需语义复核的条目不进入正常卡牌目录，
仅生成 `_review/downloads/` 记录。便携包传回的 ZIP 继续只含校验后的原始文件、清单和回执，
在有完整 metadata 的主机重建正式库，不重复打包两份图片。
