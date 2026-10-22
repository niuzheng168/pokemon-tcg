# 提案：全卡池发布包（按卡包分片，清单为信任根，按对局载入）

状态：**已批准，待分步实施**。用户于 2026-10-21 确认清单信任根、按卡包分片及按对局载入方案；
同意过渡期先将机器层并入现有单文件发布包、机器重印绑定审核定义、提交分片，以及机器卡默认允许对战并标注。
2026-10-21 起草，依据对现有代码的通读和实测。

## 0. 实测依据
- `release.json` 里证据（`sourceOfTruth`）占卡牌记录 302 KB 中的 186 KB（62%）：323 条证据只有 83 个不同来源，每个定义平均重复约 4 次；文件还是缩进格式（`scripts/build-cn-release.mjs:42`）。
- 证据改成引用 `{sourceId, kind}` 后实测：白板宝可梦 2,460 → 1,032 B，宝可梦平均 3,918 → 1,646 B，训练家 1,961 → 806 B，印刷 1,120 → 603 B。
- 卡牌库：13,706 张印刷，142 个卡包（最大 507，中位 49）。
- 每条指令重建全部定义：一局猛雷鼓对多龙巴鲁托，30 条指令重建 350 次（每条约 11.7 次），位置 `public/rules/game.js:90`（`attacksFor`）和 `:1146`（`effectContext`）。

## 1. 包结构
```
public/data/cn/V20261019/
  manifest.json                  信任根（约 40 KB），no-cache
  shards/<SET>.<sha16>.json      每个卡包一个（142 个），按内容命名，immutable
  pool-index.<sha16>.json        印刷 → 组卡器需要的事实（约 1.6 MB，brotli 约 200 KB）
  decks.json                     不变
public/cn/trusted-releases.js    格式不变：releaseId → sha256(canonicalJSON(manifest))
```
- **清单**（schemaVersion 2.0.0）：保留 releaseId、ruleset、kernel/schema/rules SHA、handler 钉；新增 `shards[]`（shardId、文件、原始字节 SHA-256、字节数、各层级张数、定义数）、`index`、`reviews[]`（每个层级一条审核记录；机器层记录流水线版本、模型、金标准结果和日期）。不再逐定义/逐印刷钉哈希（2.17 万行会让每次载入多 2.4 MB），由分片摘要覆盖。
- **分片**：`{shardId, setCode, sources: {sourceId → 证据}, definitions, printings}`。每个分片自含它的印刷所绑定的全部定义（重印定义会在多个分片各存一份，构建时检查逐字节相同，载入时再核对），一局只需一轮取数。
- **粒度按卡包**：新卡包只新增一个分片，其他分片的摘要和缓存都不变。
- **层级**：同一个包、同一个分片里混合两种层级，每条记录都标注（`implementation.tier` / `identityReview` 已在摘要覆盖范围内）；宿主按层级选择接受 `['reviewed']` 或 `['reviewed','machine']`，对局凭据记录实际用到的层级。
- **估计大小**（紧凑 JSON）：约 8 千个定义（含重印复制约 1.1 万份）约 12 MB，1.37 万印刷约 8.2 MB，来源表约 2.7 MB，合计 **21–24 MB，brotli 约 2.5 MB**；最大分片约 0.8 MB，一局取 10–20 个分片约 1–2 MB。16 MiB 上限改为按文件：清单 ≤1 MiB、分片 ≤4 MiB、索引 ≤8 MiB。

## 2. 证据压缩
- `schemas/card-definition.schema.json` 新增 `$defs/evidenceRef = {sourceId, kind}`；证据列表接受完整证据或引用（现有内核测试和夹具不变）。发布构建只写引用。
- 内核检查只读 `kind`，引用里保留 `kind`，检查不变；新增 `resolveEvidenceRefs(records, sources)`：引用必须在分片来源表里且 `kind` 一致。
- `canonicalDefinition` / `canonicalPrinting` 不变，但 78 个定义、83 个印刷的内容变成引用，人工审核发布包要重新钉一次。
- `createCardCatalog` 新增可选 `provenance`（所含记录的已解析来源），计入 `catalog.id`。
- 人工审核的 locator 原文保留（在来源表里只存一次）；机器层用短模板。

## 3. 信任与校验流程
- **构建时（Node）全检**：一次 `createCardCatalog` 跑全部记录（唯一性、名称↔名称键双射、2 阶进化祖先；祖先检查先按名称键建索引），解析全部证据引用，检查分片自含和卡包代码，校验全部卡组，按 §4 计算每张印刷的赛制合法性写入索引，输出确定性字节，`--check` 逐字节比对。
- **浏览器/服务器只检对局用到的**：
  1. `openReviewedRelease({manifestJson, trustedReleases, handlers, readShard, tiers})`：信任钉、kernel/schema/rules SHA、handler 行（沿用现有检查）。
  2. `release.catalogFor(printingIds)`：按卡包找分片 → 字节预算 → 解析前先比对原始字节 SHA-256 → 严格 UTF-8 → JSON → 分片 schema → 取需要的印刷和定义（加上最新文本锚点）→ 解析证据引用 → 层级策略 → `createCardCatalog`（只跑 30–60 个定义的完整检查，毫秒级，原来全量约 3.5 s）。
  3. `createReviewedGame` / `restoreReviewedGame` 改为传 `release`；凭据记录 releaseId、manifestSha256、catalogId、各 SHA、所用分片、层级。
- **可复现**：子集是 (清单, 印刷集合) 的纯函数，`catalog.id` 只哈希本局记录、内核/schema、handler 和来源，不含清单，所以不涉及本局卡牌的发布不影响存档和回放。存档和对局记录加上 manifestSha256 和 catalogId，不一致时报出来。

## 4. 内核热点修复（独立、小改动）
- `game.js:90`、`:1146` 每次调用都 `Object.fromEntries(catalog.definitions().map(...))`：在 `createCardCatalog` 里一次性建好冻结的记录，`catalog.definitionRecord()` 暴露，两处改用它。
- `formats.js:73` 的 `catalog.printings().find(...)` 改为直接查找。
- `deck-check.js:27-43` 的 `printingLegality` 对每张印刷构造整副卡组跑两次 `validateFormatDeck`：把 `formats.js:58-79` 的逐卡部分抽成导出的 `printingFormatStatus(catalog, printingId, reference, matchMode)`，`validateFormatDeck` 逐卡调用它（行为不变），`printingLegality` 每张印刷每个赛制调用一次。

## 5. 服务器与网站
- 组卡器和卡牌库改读索引（`card-pool.js` `buildPool(library, index)`），不再载入整个 catalog；最终的内核卡组检查改为异步 `catalogFor(deck)` 再 `validateFormatDeck`；服务器仍是权威。
- `server/catalog.mjs` 改为 `openRelease` + 读文件的 `readShard`，缓存已验证分片。
- 对局桌面：`describeDeck` 读索引；开局/续局/回放传 `release`；机器实现卡的展示文字和卡图来自 `/api/library`，显示「机器实现」标记。
- 静态服务：`shards/*` 和 `pool-index.*` 设为 immutable 并压缩；清单 no-cache + ETag。

## 6. 迁移步骤（每步都能单独通过 `npm test` 和覆盖率门槛）
| # | 改动 | 估计 |
| --- | --- | --- |
| 1 | §4 的定义记录缓存和 formats.js:73 直接查找；重建内核并重新钉 | 0.5 天 |
| 2 | §4 `printingFormatStatus` 和新的 `printingLegality` | 1 天 |
| 3 | 工具链与「每张印刷都有人工审核记录」解耦（build-merged-metadata 只遍历人工审核印刷；机器层单独载入） | 0.5 天 |
| 4 | `evidenceRef` schema 和 `resolveEvidenceRefs`；重新生成校验器和内核戳 | 1 天 |
| 5 | 内核 v2 载入器：清单/分片 schema、`openReviewedRelease`、`catalogFor`、`index()`、凭据、provenance、层级策略；移除 v1 载入器；`catalog-release.test.mjs` 全部移植并补充新测试 | 4–5 天 |
| 6 | 只用人工审核卡池的 v2 构建（15 个分片 + 索引 + 清单 + 钉），切换全部调用方；83 张卡行为不变 | 3–4 天 |
| 7 | 静态服务缓存头和压缩 | 0.5–1 天 |
| 8 | 机器层：生成器输出按卡包的 JSON，全卡池构建，界面标记，层级选择 | 2–3 天 |
| 9 | 文档 RELEASE.md、STATUS.md | 0.5 天 |

合计约 2.5–3 周的专注工作量（不含提高机器翻译质量）。

## 7. 需要确认的问题
1. **信任模型变化**：浏览器不再每次载入都全量复检；全局不变量（双射、祖先）只在构建时检查，浏览器只检分片字节完整性和本局记录的内核检查。是否接受？
2. **机器层策略**：同一个包内逐条标注（建议），还是单独的发布包和钉？机器实现卡默认是否允许进入记录的对局？内核目前**不强制**「机器印刷只能绑定机器定义」（`card-printing.schema.json:36` 的描述这样写，但 `card-schema.js:169-185` 没检查）：是否允许机器核对的重印印刷绑定到人工审核的定义（对训练家重印很有用）？
3. **Git 体积**：提交的分片从 410 KB 增到约 22 MB，每次重新生成会改写受影响的卡包。另一种做法是只提交输入、清单和钉，`cn:release:check` 重新生成并与清单核对。
4. **一次性不兼容**：第 5 步之后旧的浏览器存档无法续局；旧的对局记录只能在当时的构建版本上回放。
5. **重新钉的频率**：每次内核改动只会重新钉清单，分片不带内核 SHA，不受影响。
6. **全量 Node 构建耗时**未实测，预计几秒到几十秒。
7. **电脑对手**：`public/cn/ai.js` 的 `CARD_VALUE` 只认识人工审核卡，机器实现卡用通用估值。
8. **分片摘要用原始字节**（像 SRI 一样解析前校验），清单仍用规范化 JSON 摘要。
