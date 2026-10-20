# 网站与真实卡牌迁移：可执行只读盘点

本页对应 **CN / V20261019**，盘点实际执行于 **2026-10-20**。
这是主迁移工作的执行入口，**不是“网站已经接入官方引擎”的声明**。
当前网页继续使用旧 `Game`；规则规范测试的 synthetic 卡、测试审批不能发布为真实卡池。

## 1. 先运行，不要手工数卡

从仓库根目录执行；只需要 Node，不联网、不建库、不下载、不生成验证器：

```sh
node scripts/audit-cn-migration.mjs --json > /tmp/cn-migration.json
# 退出码 2 是预期结果：盘点完成，但官方准入仍被阻止。
test "$?" -eq 2

node --test tests/cn-migration.mjs
```

退出码：`0` 仅帮助；`1` 输入格式／哈希／参数错误，没有可用的完整报告；
`2` 完整盘点成功、仍不可准入。没有 `--approve`、`--write`、`--trust-pins`
或“忽略阻塞并返回成功”的开关。
重定向报告文件是调用者的 shell 操作；CLI 本身没有任何文件写入 API。

报告从 `public/data/decks/index.json` 加载全部经典、延迟加载牌组，
并检查磁盘上的其他 `*/cards.json`，不把未被 UI 引用的卡悄悄漏掉。
若存在 `classicBundle` 还会核对它与源目录是否分歧。
同 ID 不同内容列为冲突，保留全部版本及使用位置，不重演旧 `CARDS[id] ??=`
的“第一个定义覆盖后续定义”。非法卡数、重复牌组键、未知目录名、
损坏 JSONL／gzip 都不会被当作空目录或完整成功。

过滤、分页只影响 `queue.cards`，**不缩小全目录检查范围和全局计数**：

```sh
node scripts/audit-cn-migration.mjs --json --deck sv-miraidon
node scripts/audit-cn-migration.mjs --json --card sve-4
node scripts/audit-cn-migration.mjs --json --offset 0 --limit 50
node scripts/audit-cn-migration.mjs --json --offset 50 --limit 50
# 继续使用 queue.nextOffset；null 表示没有下一页。
```

稳定性边界：相同输入字节得到相同 JSON，不含执行时间、绝对机器路径、
文件遍历顺序或随机 ID。`inputs[]` 固定每个实际读取文件的相对路径、
字节数和 SHA-256；上游数据或并行开发中的代码变化会合理地改变报告。
它是内容回执，不是对恶意宿主、metadata 发布者或文件真实性的认证。

## 2. 当前实测数量与入口

| 项目 | 实际读取得到 |
| --- | ---: |
| 旧牌组 | 109 |
| 牌组内定义记录（含重复使用） | 2,278 |
| 不同旧定义 ID | 1,270 |
| 宝可梦／训练家／能量定义 | 910 / 307 / 53 |
| 同 ID 定义冲突／未索引牌组 | 0 / 0 |
| 有指向简中印刷候选的 Wiki 页面 | 741 |
| 没有上述候选的旧定义 | 529 |
| 展示层附带卡图的记录 | 335 |
| 卡图声明简体／繁体 | 108 / 227 |
| 本工具准入的卡牌 | **0** |

“741”是候选关联，不是 741 张已审核卡。“529”仅指**没有关联页面中的
简中印刷候选**，不是说完全没有其他可用证据。例如基本雷能量的展示扫描
另有完整卡号，但 Wiki 页面印刷列表未收录该对应关系。
展示层附图不因此获得规则等价性、商业分发权或引擎审批。

旧入口链：

```text
public/ui.js
  → public/cards.js
  → public/data/decks/index.json
  → 109 个 cards.json（现代牌组按需加载）
  → public/engine.js 的 new Game / Game.restore

public/data/locales/zh-CN.js → public/card-presentation.js
  仅展示翻译、原图／练习卡面，不改变引擎身份或玩法。
```

CLI 用读取源码的静态检查明确报告这些入口，以及
`loadReviewedCatalogRelease` / `createReviewedGame` 是否存在、
`ui.js` 是否引用后者。这不是浏览器运行测试，不能代替最终 UI 验收。
网页构建仍以旧 `ui.js` 为入口；把规则文件复制进产物本身不等于已经接通。

## 3. 每张卡的精确工作队列

`queue.cards[]` 包含：

- `legacyId`、原 set、原 `number`／语言／游戏类型；缺字段就是 `null`。
  **不从 `base1-7` 猜 `007/102`，不从 `SV-P/001` 猜完整促销卡号**。
  `0007/SV-P`、`10 02/04`、`DAR` 等原值原样保留，不能先清洗再声称相同。
- 每个原始定义的规范内容指纹、卡面 HP／属性、招式 damage／cost／effect
  参数、power／trainer／tool 等旧语义、牌组和行号。
  这些是待审核事实，不是自动生成的新 `CardDefinition`。
- 精确关联页面及修订／原文哈希核对结果。只有显式页面引用参与关联，
  不用同名搜索自动创造关联；Pocket 或 TCG/Pocket 混合身份页面不产生实体候选。
- 原语言、完整卡号、商品编号、系列、标记、发行日期的候选列表与缺项。
  `regulationMark: null` 只表示 metadata 未给出标记，
  不能自动当作“已审核卡面确实无标记”。
- 逐卡九类基础缺口：语言、实体身份、卡号、系列／标记／日期、
  官方卡面及勘误绑定、CN handler 语义、定义审批、印刷审批、独立发布审批。
  冲突／缺来源／来源修订不一致另加阻塞项。
- 当前安装代码中出现的 handler ID 清单只是可复用原语线索。
  旧 `trainer:electricGenerator` 不会因存在 `cn.attachDiscard@1` 就被认定等价；
  费用、区域、顺序、效果不成立、公开与隐藏信息仍需逐条实现和测试。

`metadata.printings[].identityIssues` 给出候选级缺项；
`metadata.wikiBlockShapes` 保留可发现 HP／招式版本差异的轮廓。
**轮廓一致不等于效果等价；轮廓不同更不能默认套用旧 handler。**

所有行仍为 `admitted:false`。工具不载入审批配置，所以报告中的
`approvedDefinitions/approvedPrintings = 0` 指它没有授予或导入任何审批，
不是声称扫描了所有外部审批系统。

## 4. 可复用的真实材料与最短审查批次

### 干净 clone 即可使用

CLI 校验已提交 2026.10.18 快照的 gzip 和解压后字节 SHA-256、长度、
记录数和游戏／印刷数：

- 16,645 个页面：实体 TCG 14,680、Pocket 1,965；印刷记录 73,434。
- 这是来源快照，不是当前官网全量卡池。展示转简体不是简中官方核准。
- `tools/52poke-cards/samples/manifest.json` 的 10 张真实样例图片逐张核对
  字节哈希：8 张简体、2 张繁体。简体包括 `151C:001/151`、`004/151`、
  `007/151`、`025/151`、`039/151`、`054/151`、`133/151`、
  `SV-P:001/SV-P`。这些是审查材料，不是它们与旧版本等价的证明。
- 20 张 MIK 历史观察保留完整卡号、原图哈希和 `human_reviewed:false`。
  不读取模型响应、不重跑模型、不把机器通过升级成人工审批。

### 本机已有材料，可显式加读

```sh
node scripts/audit-cn-migration.mjs --json --deck sv-miraidon \
  --library tools/52poke-cards/library \
  --mik-source tools/52poke-cards/exports/mik-full-20261019 \
  > /tmp/cn-migration-local.json
test "$?" -eq 2
```

本机实测：库索引 8,681 条简体印刷；1,860 份 metadata 可按**完整、大小写不变
的印刷身份**关联旧定义来源。MIK 索引记录 13,057 项下载完成声明；
20 张冻结观察的本地图字节全部与记录哈希相符。
下载完成声明不是 13,057 项逐卡语义验证；观察哈希相符也不是卡号、规则和发布审批。
这些目录可能不存在于新 clone，不强制依赖；CLI 不遍历整个 NAS，不 bootstrap。
索引或 metadata 发生变化时以上数值应以新报告为准。

### 先做有限、可交付的批次，而不是宣称审核完 1,270 张

`deckReviewOrder` 按“缺少 Wiki 简中候选数→不同卡数→旧效果类型数”排序，
给出每个牌组的可执行审查命令。**不是合法卡组、工作量或完备支持的保证**。

目前首批候选为 `sv-miraidon`／`sv-victini`：各 **17 个不同定义**，
各 1 个没有 Wiki 简中印刷候选、15 类旧效果 token。以 `sv-miraidon` 为例：

1. 将 17 项作为第一批审核清单：16 项已有 Wiki 简中印刷候选，
   另 1 项 `sve-4` 是基本雷能量；它的展示资料已有
   `csvL2C`、完整卡号 **`135/052`**、官网来源页和原图 SHA-256。
   这条扫描记录仍标注 `human_reviewed:false`，须独立核对官方卡面、
   发行身份与适用规则；不能直接改成 verified。
2. 对每项选择具体实体印刷，而不是把所有同名／同图候选都导入。
   核对简中卡文、编号、系列、标记、首发日期和 V20261019 卡池。
3. 明确电气发生器、能量移附、狙击、检索、弃牌、特性等 CN 实现差异，
   缺 handler 的先实现并测试。不得先隐藏能力或用英文效果凑齐 60 张。
4. 如审核发现原教学牌组不能逐卡合法迁移，另建一副**真实简中**牌组并注明
   新商品／构筑来源，不静默替换旧版本。可以先用同一副获审 60 张牌组作为双方，
   减少首次接通所需的不同定义数；仍需正常构筑校验和引擎语义覆盖。
5. 完成真实批次、独立审核和发布准入后再接官方 UI；之后逐批扩大，
   没有审核的其余旧牌组继续明确归类为旧教学模式。

许可仍按 `tools/52poke-cards/DATA_LICENSE.md`：百科衍生 metadata 为
CC-BY-NC-SA-3.0，不是 MIT；图像权利另属权利人。本地能读到材料不代表可公开打包。

## 5. 网站接入顺序及不可越过的边界

这部分是后续主任务的修改路径，本盘点任务**未修改现有 UI 或 runtime**。

1. **隔离模式**：旧教学模式与 CN/V20261019 官方规则实现模式使用不同入口、
   牌组列表和保存命名空间。简体界面不是选择 CN 规则；不得以 `setLang('zh-CN')`
   切换来冒充。未全部验收时保留“开发中／尚未接通”标识。
2. **准备真实发布包**：逐卡完成 `CardDefinition` 与 `CardPrinting` 分别审批，
   官方卡面／勘误 source of truth、格式审查、测试、固定内核与 schema。
   见 `RELEASE.md`／`FORMATS.md`。`catalogCandidateFacts` 只生成审查指纹；
   本 CLI 的报告甚至不是发布包，交给发布入口会被拒绝。
3. **独立安装信任名单**：应用构建配置安装经独立审核的
   `releaseId → manifest SHA-256` Map。不得从同一次下载的 manifest 自算其哈希，
   然后立即加进名单；不得使用规范测试自动审批 Map。没有生产名单时拒绝启动。
4. **显式选择规则和卡池**：网站选择
   `{region:'CN', version:'V20261019'}` 和版本化
   `{region:'CN', version:'V20261019', id:'standard'}` 或 `open`，
   `matchMode:'normal'`。不得以 `casual60`、`tiebreak60` 开发别名替代官方卡池。
   如使用 `createReviewedGame`，它从已经审批的 manifest 取得规则；
   网站还须对照自己的显式选择拒绝不匹配版本，不能自动跟随下载目录。

```js
// 接入代码的契约示意；json、installedTrust、decksByPrintingId、
// savedSeed 均由宿主提供，不在这里生成生产审批或虚构真实牌组。
const ruleset = { region: 'CN', version: 'V20261019' };
const format = { ...ruleset, id: 'standard' };
const declared = JSON.parse(json).manifest?.ruleset;
if (declared?.region !== ruleset.region || declared?.version !== ruleset.version) {
  throw new Error('规则版本与显式选择不匹配');
}
const { game, catalog, approval } = await createReviewedGame({
  json, trustedReleases: installedTrust,
  decks: decksByPrintingId, seed: savedSeed, format, matchMode: 'normal',
});
// createReviewedGame 来自 public/rules/reviewed-game.js；
// 未经独立审批、格式不支持或不合法牌组会拒绝，不回退旧 Game。
```

5. **重做交互适配器，不直接给旧 UI 塞对象**：旧 UI 读取可变
   `game.players`、`mon.hpLeft` 和 async controller／hooks；
   新入口是 `game.view(player)`、`game.dispatch({player, expectedRevision, action})`、
   `pending` 和 `legalActions`。按玩家投影渲染，禁止向客户端 UI／AI 暴露对手隐藏区。
   UI 不自行减 HP、结算招式或取消限制：从 `effective.maxHp/currentHp` 渲染。
6. **保存与恢复**：新存档保留显式规则／赛制、catalog 内容身份和发布回执。
   使用 `restoreReviewedGame` 重新通过信任发布与快照校验；
   旧 `tcg-academy-save-v2` 不能强转为官方快照，版本冲突明确提示。
7. **失败即停止**：未支持 handler／时序／真实卡牌、发布校验或目录版本失败，
   都显示明确不可运行原因；不得删效果、套国际规则、用同名外语卡、
   fallback 到旧 Game 后仍显示“官方规则模式”。
8. **最终浏览器验收**：两副真实获审批 60 张牌组完成开局、选择与费用、
   行动、伤害与状态、结束、保存恢复和终局；检查不支持／过期存档／未批准发布
   确实拒绝、隐藏信息不泄漏。AI 与教练也只能消费该玩家合法视图。
   完成卡池和条款全覆盖后才可宣布全引擎／网站接入完成。

## 6. 本任务验证范围

2026-10-20 执行 `node --test tests/cn-migration.mjs`：**19 / 19 通过**。

`node --test tests/cn-migration.mjs` 覆盖稳定输出、全目录／冲突盘点、
只读字节与 mtime 不变、完整卡号保留、Pocket 隔离、精确来源修订、
压缩／解压哈希失败、无效 gzip 不挂起、本地 metadata 身份不一致、
MIK 原图哈希、旧 handler 参数、分页、恶意／错误输入与无审批发布拒绝。
最后一项读取实际仓库目录进行集合核对，不以手写常数代替扫描。

此套测试不验证全引擎合规、1,270 张语义审核完成或最终 UI 行为。
它尚未加入 `package.json` 默认测试链；主任务应保留上述显式命令或审查后接入 CI。
