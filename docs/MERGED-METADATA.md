# 卡牌合并视图 `metadata.merged.json`

网站用的卡牌库（`/nas/share/Pokemon/library_prod`，由 `npm run library:prod` 从原始库 `/nas/share/Pokemon/library_raw` 同步）中，每个 `metadata.json` 旁边生成一个 `metadata.merged.json`。
它把两部分放在同一个文件里：

1. **简化后的印刷 metadata**：卡牌库原记录汇集了 52Poké、MIK、官网等多个来源，带逐字段来源、迁移与语义比对记录，
   中位数约 11 KB。合并视图只留下读者需要的部分，中位数约 1.8 KB。
2. **对战定义**：该印刷在已审核规则版本中的 `CardDefinition`（原样复制），以及卡图核对后的卡文与差异。

格式由 [`schemas/card-metadata-merged.schema.json`](../schemas/card-metadata-merged.schema.json) 定义。

## 1. 它是生成的只读视图

| 要修改的内容 | 改哪里 | 然后 |
| --- | --- | --- |
| 印刷信息、卡文、图片、来源 | 卡牌库的 `metadata.json`（卡牌库流程） | `npm run cn:merged` |
| 对战定义、审核卡文 | `catalog/zh-CN/V20261019/*.mjs` → `node scripts/build-cn-release.mjs` | `npm run cn:merged` |

- 生成器只写 `metadata.merged.json`，不改 `metadata.json`、`index.jsonl`，也不改卡牌库的 `files-manifest.json`，
  所以合并文件不在卡牌库的哈希清单内。
- `npm run cn:merged:check` 只比较不写入；任何一个文件过期即失败。
- 全部合并视图另有一份提交在仓库里：`catalog/zh-CN/V20261019/library/snapshot/merged.jsonl`，每行一张卡
  `{"dir": "<卡包>/<目录>", "view": {...}}`。`npm run cn:merged` 之后用 `npm run library:snapshot` 更新它，
  卡文的变动在 git 里就能看到 diff。挂着 NAS 的机器上，`npm test` 会检查它和 library_prod 是否一致。
- 引擎和网站仍只从带信任钉的发布包（`public/data/cn/V20261019/release.json`）载入定义；
  合并视图里的定义附带发布包清单中的 SHA-256，可以据此核对，但它本身不是信任来源。
- 只生成 `zh-Hans`（`--language` 可改）；目前只有简中规则版本有对战定义。
- **对局状态不在卡牌文件中**：`game-state.schema.json` 描述的是一局对战的快照（各区卡牌、伤害指示物、附着、持续效果等），
  属于对局，不属于某张卡。

## 2. 字段

省略的可选字段表示空或未知。

| 字段 | 内容 | 来源 |
| --- | --- | --- |
| `schema` | `pokemon-card-merged/1` | — |
| `id` | 卡牌库记录 ID（`tcg:zh-Hans:CSV8C:083/207`，或 MIK 来源 ID `CSV1C/109`） | `metadata.json` |
| `generatedFrom.metadata.sha256` | 生成时 `metadata.json` 的 SHA-256；完整来源细节查原文件 | 生成器 |
| `printing` | 语言、系列代码与名称、完整卡号（只有来源 ID 时为 `null`，并给出 `sourceCardId`，不推测分母）、稀有度、画师、发售日、标记 | `source_printings` 中对应本印刷的一行 |
| `card` | 卡名、种类、属性、阶段、HP、进化来源、特性、招式（名称／费用／伤害／说明）、效果段落、弱点、抗性、撤退，以及 MIK 的 `mechanic`（如 `ex`、`ACE SPEC`）和 `labels`（如 `Ancient`） | 卡牌库选定的卡文区块 |
| `otherVersions` | 同一来源页上的其他卡文版本，不合并、不选定 | 其余区块 |
| `images` | 文件名、SHA-256、来源、尺寸；主图在前 | `images` |
| `sources` | 52Poké 页面与修订、MIK 卡号、官网商品页 | `source_pages`、`external_source_records` |
| `review.level` | `machine`、`machine-image-checked`（两模型卡图核对通过）、`human-fields`（只核准了 `fields` 所列字段）、`human` | 各审核记录 |
| `review.warnings` | 卡牌库的文字审核警告与复核标记 | `text_review`、`review_flags` |
| `license` | 署名与许可（或权利声明） | `attribution` |
| `rules` | 以 `地区/版本`（如 `CN/V20261019`）为键的已审核绑定；没有对战定义时为 `{}` | 信任发布包 |

**简化时去掉的内容**（仍完整保留在 `metadata.json`）：逐字段来源 `field_provenance`、语义等价判定、
迁移与收养历史、模型核对过程、繁简转换记录、来源缓存路径、重复的资产 ID，以及空的维基模板格。

## 3. `rules["CN/V20261019"]`

| 字段 | 内容 |
| --- | --- |
| `release` | 发布包 ID 与安装的信任钉（SHA-256） |
| `printingId`、`printingSha256` | 审核过的 `CardPrinting` 及其在发布包清单中的哈希 |
| `identityReview`、`printing` | 卡图核对后的卡号、标记、系列、发售日 |
| `definitionId`、`definitionSha256`、`definition` | `CardDefinition` 原样及其清单哈希 |
| `text` | 按卡图转录的卡文（键为招式／特性 slug，或 `card`、`rule`、`tera`） |
| `image` | 审核时读取并记录指纹的卡图；可能在同一印刷的另一个目录中 |
| `differences` | 卡牌库字段与审核结果不一致之处；`metadata: null` 表示卡牌库缺少该项 |

同一印刷在卡牌库中可能有两个目录（完整卡号目录与 MIK 来源 ID 目录），两个目录都会带上同一个绑定。
定位规则：记录 ID 等于该印刷，或同一系列目录中含有审核所用的同一张卡图（字节完全相同）。

比较 `differences` 时忽略空白和卡牌库的【】关键字标记；ACE SPEC／ex 等规则框文字在卡牌库中以 `mechanic` 表示，不参与比较。

## 4. 当前结果（2026-10-21）

- zh-Hans 共 14,244 个目录全部生成并通过 schema 校验；原 metadata 共 266 MB，合并视图共 26.5 MB。
- 88 个目录带 `CN/V20261019` 绑定（83 个审核印刷，其中 5 个印刷各有两个目录）。
- 自动比较出 21 处差异，与逐卡审核时人工发现的问题一致：
  - 标记：12 处卡牌库记录没有标记（10 个 MIK 来源 ID 目录，以及 151C 百变怪、CSV6C 爬地翅）；
    30thC 103/103 宝可梦交替 记为 J，卡图为 I。
  - 缺少太晶规则：多龙巴鲁托ex、厄诡椪 碧草面具ex。
  - 卡文：夜光能量（漏「的」「还」）、新冲天能量（重复「2阶进化宝可梦」）、席蓝（漏「ex」）；
    厉害钓竿、能量回收、宝可装置3.0 的完整卡号目录是未转换的维基繁简标记。
