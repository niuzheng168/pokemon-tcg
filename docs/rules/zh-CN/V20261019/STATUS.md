# CN / V20261019：已实现内容与进度

**状态：工作恢复中（换机后继续），记录日期 2026-10-21。里程碑 1、2、3 均已完成并推送；赛事宿主系统按约定延后。**
**旧教学模式（109 副英文预组、旧引擎、界面、桌面版及其测试）已按用户要求于 2026-10-21 删除，网站只有简中官方模式。**
分支 `cn-rules-v20261019-wip`，**未合入 main、未发布网站**（不运行 `web:publish`）。

本页按功能汇总当前代码，不必从三十一轮实施记录中逐段查找。
精确条款边界以 [覆盖矩阵](CLAUSE-COVERAGE.md) 为准；
历史过程见 [实施记录](IMPLEMENTATION.md)，架构见 [设计文档](DESIGN.md)。

## 0. 里程碑进度

| 里程碑 | 完成标准 | 状态 |
| --- | --- | --- |
| 1. 网站接入官方模式 + 嗨皮卡组完整对局 | 独立 CN/V20261019 模式；简中预组对电脑打完整局；浏览器测试 | **完成（2026-10-21）** |
| 2. 猛雷鼓ex 赛事卡组 | 近期简中赛事卡表（记录来源）；迁移全部所需机制；对局与浏览器测试 | **完成（2026-10-21）** |
| 3. 按机制批量扩充卡池 | 卡图＋metadata 核对、记录来源、机制测试 | **完成（2026-10-21）**：第 1 批 使用最多的多龙巴鲁托ex 赛事卡组（21 个印刷）；第 2 批 使用率最高的 13 张训练家 |
| 延后 | 赛事宿主（配对、裁判、判罚、补时） | 不在当前范围 |

## 1. 当前可以确认的结论

- 已有独立、可在 Node／浏览器环境使用的简中规则内核及严格 schema。
  地区／规则快照明确为 `CN/V20261019`，私有开发协议仍为 `CN-game-dev-25`，
  它不是官方文档的版本号，也不是稳定发布协议。
- **网站只有官方规则模式** `play/cn/`（`/` 与 `/play/` 都转到这里）。
  它只经安装的信任钉载入审核发布包，通过 `view()/dispatch()` 驱动内核，存档键独立；
  卡组只有下面 3 副审核过的简中卡组。
- **真实卡牌准入：3 副卡组、定义 78／印刷 83**：
  - 嗨皮组合 皮卡丘卡组（CSVH1C，60 张），按开放赛制使用（含 E／F 标记，不属于标准赛制）。
    见 [逐卡审核](cards/CSVH1C-PIKACHU-REVIEW.md)。
  - 猛雷鼓ex 赛事卡组（标准赛制 G—J，60 张，26 个印刷，11 个商品）：2026城市赛第四赛季上海站
    （2026-09-27，256 人）第 1 名卡表，来源 OmniTCG 简中赛事卡表（第三方汇总）。
    见 [逐卡审核](cards/RAGING-BOLT-679141-REVIEW.md)。
  - 多龙巴鲁托ex／黑夜魔灵 赛事卡组（标准赛制，60 张，新增 21 个印刷、2 个新商品）：2026城市赛第四赛季广州站
    （2026-10-18，248 人）第 1 名卡表，同一来源。见 [逐卡审核](cards/DRAGAPULT-676815-REVIEW.md)。
    选卡依据是对 73 场城市赛前 8 的统计（该卡组出现最多，并覆盖未入池卡中使用率最高的 6 张）。
  - 高频训练家 13 张（神奇糖果、派帕、勇气护符、秘密箱、能量转移、厉害钓竿、深钵镇、博士的研究、席蓝、重力山、
    野餐篮、宝可梦交替、能量回收）：同一统计中使用率最高、尚未入池的训练家，不在网站预组中。
    见 [逐卡审核](cards/STAPLES-REVIEW.md)。
  - 早先 sv-miraidon 的 17 项候选审查仍未准入。
- 下文“已实现”均指代码和测试已经覆盖的限定机制，**不是全部简中规则已合规**。

## 2. 卡牌基础属性与战斗状态已分层

| 层次 | 已采用的表示 | 保存什么 |
| --- | --- | --- |
| 卡牌规则定义 | `CardDefinition` | 卡面 HP、属性、弱抗、费用、招式／特性、规则框、特别规则、效果绑定及来源；独立审核后不可被对局改写 |
| 实体印刷身份 | `CardPrinting` | 语言、系列／完整卡号、标记、印刷与地区版本定义的绑定及审核信息 |
| 物理卡记录 | `GameState.cards[instanceId]` | 唯一实体实例、印刷／定义 ID、原持有者；区域移动不创造另一张卡 |
| 宝可梦运行时状态 | `players[].active/bench` | 进化叠、附着卡、伤害指示物、特殊状态、入场／进化事实、已使用次数 |
| 持续与历史状态 | `ongoing`、`playerOngoing`、`battleHistory` | 固定目标、来源、期限、清除规则、实际行动与致因；不回写卡面 |
| 派生属性 | 玩家视图中的 `effective` | 有效最大／当前 HP、当前属性、弱抗、撤退及招式能量要求等 |

**HP 示例：** 卡面 HP 为 100，运行时有 3 个伤害指示物，无其他效果时当前 HP 为 70；
若有效效果使最大 HP 增加 50，则有效最大 HP 为 150、当前 HP 为 120。
卡面 `mechanics.hp` 始终还是 100；运行时不保存一个会覆盖卡面的“剩余 HP”。

“下回合不能使用某招式”也不是永久删招式或一个任意可写的布尔值：
它是有原始来源、固定受影响对象、招式身份、回合期限及清除策略的运行时效果。
现场选招的禁用还绑定原选择、实际回答和真实清除事实。

Schema 入口：
[卡牌定义](../../../../schemas/card-definition.schema.json)、
[印刷身份](../../../../schemas/card-printing.schema.json)、
[对局状态](../../../../schemas/game-state.schema.json)、
[效果与持续账本](../../../../schemas/effect-program.schema.json)。

卡牌库每个 zh-Hans 目录另有生成的 `metadata.merged.json`：简化后的印刷 metadata 加上已审核的 `CardDefinition`
及卡文差异（只读视图，信任来源仍是发布包）。见 [合并视图](../../../MERGED-METADATA.md)，
schema 为 [card-metadata-merged](../../../../schemas/card-metadata-merged.schema.json)。

## 3. 已实现的功能地图

| 功能 | 当前已有的执行能力 | 主要实现 |
| --- | --- | --- |
| 地区／版本与来源 | 明确选择版本，不接受 locale／`latest` 回退；规则 ID 关联官方文档、章节、页码和固定来源 | `index.js`、`registry.js`、`zh-CN/V20261019.js` |
| 目录及卡组准入 | 60 张、基础宝可梦、同名／组限额；标准／开放版本化卡池；定义／印刷独立内容审批及发布封签 | `catalog.js`、`catalog-release.js`、`formats.js`、`reviewed-game.js` |
| 基础状态机 | 起手／共同重抽、先后攻、设置奖赏、回合抽牌、出场、普通进化、附能、撤退、训练家、检查、昏厥／奖赏及普通简中胜负表 | `game.js`、`conditions.js`、`energy.js` |
| 伤害计算 | 六阶段计算、修正量、弱抗、提前结束、防伤害与防效果分离；已审动态数值／条件、硬币、所选目标伤害及伤害阶段快照 | `damage.js`、`battle-value.js`、`battle-predicate.js`、`damage-coins.js` |
| 效果顺序与选择 | sequence／then／optional、实际执行结果、数量及隐面例外、已审费用与完整付款搜索、使用许可与实际执行分离 | `effects.js`、`selection.js`、`activation-cost.js`、`handlers.js` |
| 场上效果 | 连续属性、保护／封锁、时限、特性／道具消除、已审触发及反击、能量供给／保留和移动 | `ongoing.js`、`suppression.js`、`triggers.js`、`energy-mechanics.js` |
| 卡牌与区域操作 | 已审检索、牌库窗口及附能、己方奖赏零／一张自交换、整手牌重洗放底、场上返回、效果进化／退化／继承 | `card-selection.js`、`deck-window.js`、`deck-energy.js`、`prize-exchange.js`、`hand-bottom.js`、`field-return.js`、`evolution.js` |
| 回复与指示物 | 单体／批次／全部回复、实际回复者关联弃能、固定总数指示物分配及既有转放路径；不当作伤害 | `healing.js`、`counter-distribution.js`、`game.js` |
| 招式复制／授予 | 分开处理卡面“拥有”、额外可用路线、实际使用者、内容来源、已审复制和失败流程 | `attack-copy.js`、`attack-grant.js`、`attack-failure.js` |
| 场地卡与棱镜之星 | 场地本体独立主体／self 保护、效果弃置与普通替换分开；Prism 弃牌统一改到原持有者放逐区，涵盖费用、KO、附件和使用收尾 | `field-cards.js`、`discard-policy.js` |
| 现场选招禁用 | 选择对手 Active 顶层卡面的一招，建立下一对手回合的专用锁；保护、清除、继承保留及真实路线匹配 | `owned-attack-lock.js`、`ongoing.js`、`game.js` |
| 存档与投影 | 原子命令、revision、随机状态隔离、每方 60 张守恒、私有投影、原效果程序／暂停／回答／实际事实绑定及 JSON 恢复 | `effect-execution.js`、`selection-request.js`、`battle-history.js`、`game.js` |
| 各1张检索／按阶段改变HP／竞技场宣告效果（2026-10-21，里程碑 3 第 2 批） | `cn.cards@1` 的 `onePerAlternative`（「「A」和「B」各1张」）；`cn.modifier@1` 的 `stages`；`cn.stadiumUse@1`（每位玩家每回合按卡计 1 次） | `card-selection.js`、`game.js`、`handlers.js` |
| 自身昏厥／指示物／奖赏卡条件／特殊能量（2026-10-21，里程碑 3） | 「令这只宝可梦昏厥」（`cn.knockOut@1`，与其他昏厥一起确认）；「给N只各放置」与「最多N个」转放；训练家使用条件与按剩余奖赏卡抽牌；按对手已获奖赏卡减少所需能量；特性条件「附着了【X】能量」；能量供给 `stages`／`otherAttached`；保护排除拥有规则的宝可梦 | `game.js`、`handlers.js` |
| 特性条件／依赖效果／备战上限（2026-10-21，里程碑 2） | 特性使用条件（最初的自己的回合、在战斗场、上个对手回合己方昏厥）；「然后」依赖前文实际执行（`cn.then@1`、`cn.attachThenDraw@1`）；对手牌库上方弃牌；原位替换为牌库中的宝可梦（百变怪）；竞技场改变备战上限与 `bench-trim` 弃至上限；太晶备战区防伤；属性各不相同的能量与一张加入手牌；计数弃能×伤害；ACE SPEC 组限额；`excludePaid`、`excludeNameKeys` | `game.js`、`handlers.js`、`deck-energy.js`、`card-selection.js` |
| 掷币／或者／整手牌回牌库（2026-10-21） | 非伤害掷币后续门（`coin`／`cn.coin@1`）、「A。或者，B」（`orElse`／`cn.orElse@1`）、整手牌放回牌库重洗再抽（`cn.handDeckDraw@1`）、按对手场上宝可梦数抽牌、弃1张然后抽牌 | `effects.js`、`effect-execution.js`、`handlers.js`、`game.js` |

上述文件均位于 [`public/rules`](../../../../public/rules)。
“已有执行能力”不意味着能解释任意卡文；每个实际准入的效果仍须明确 handler、
严格参数、独立来源及测试，未支持或依据不足的组合不静默猜测。

### 网站官方模式与审核卡池（里程碑 1—3）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 卡牌数据（作者源） | `catalog/zh-CN/V20261019/` | 定义／印刷构建器；`csvh1c.mjs`、`raging-bolt.mjs`、`dragapult.mjs`、`staples.mjs` 卡面记录（商品页、卡图路径、SHA-256、图源、转录卡文）；`decks.mjs` 卡组及赛事卡表来源 |
| 发布与信任 | `scripts/build-cn-release.mjs` → `public/data/cn/V20261019/{release,decks}.json`、`public/cn/trusted-releases.js` | 审核人步骤生成；`--check` 进入 `npm test` 与网页构建；内核／schema／handler 任何改动都会使旧发布失效，须重新生成 |
| 卡图 | `npm run cn:images` → `public/img/cn-cards/`（gitignore） | 从本机卡库复制并复核指纹；缺图时页面显示文字卡 |
| 页面 | `public/cn/{index.html,app.js,ai.js,style.css}` | 原生 ES 模块，不打包（发布包钉住 handler 函数源码）；`build-web` 校验 `play/cn`、`play/rules` 与源文件逐字节一致 |
| 电脑对手 | `public/cn/ai.js` | 只读自己的玩家视图＋已审目录；确定性启发式，规则判断全部来自内核 |
| 卡组选择 | 开始页 | 双方各选一副；两副赛制不同时按开放赛制开局；显示卡表来源（赛事、日期、名次）与赛制；备战区显示当前上限 |
| 数量分配 | `public/cn/app.js` | 「以任意方式放置」伤害指示物的逐目标加减界面（`allocateCounters`），放满总数才可确认 |

### 第二十七轮完成：现场选招禁用

- 候选只看当前顶层卡面，不按能量、已用 GX／VSTAR、旧锁或额外授予过滤。
- 非空严格选一；效果保护可以阻止附锁，但不把候选删掉或伪造 then 成功。
- 期限不包含检查；回备战、进退化、离场／KO和到期有实际清除路径；
  施招者离场不自动撤销对方身上已附效果，真实继承替换保留原锁。
- 清除关联原 `battleHistory` 事实；仅伪造相邻公开日志不能解除真实禁用。
- 同 ID 异名不误锁；复制内容不替代外层宣告身份。
  跨定义直接使用的同名招式仍可能需要裁定，明确列为 `unresolvedActions`，
  不顺带封掉其他确定合法路线。

## 4. 官方依据与 52Poké 的定位

当前已阅读并固定 **8 份登记来源（2 PDF＋6 HTML）**：
进阶指南、赛场规则、标准／开放卡池及调整说明、特别卡牌说明和基础规则页。
实际 URL、版本、取得日期、章节及 SHA-256 见
[规则登记](../../../../public/rules/zh-CN/V20261019.js) 和 [来源清单](CLAUSE-COVERAGE.md#11-实际阅读的官方来源)。

HTML 的本次取得日期是 **2026-10-20**；没有把它倒填为19日，
也没有宣称已证明与19日历史响应逐字节相同。
缓存原件不作为 MIT 项目素材重新分发。

**52Poké metadata 可以保留为资料及 provenance，不直接成为执行规则或审批。**
它不能自动决定某实体印刷的身份、简中卡文、赛制合法性或 handler 语义。
原始 metadata、获审静态定义和运行时状态分开；不是对下载 JSON 原地加战斗属性。

## 5. 最新验证（2026-10-21，本机）

| 检查 | 结果 |
| --- | --- |
| `npm run test:rules:official:coverage` | **1434/1434 通过**（里程碑 3 新增奖赏卡条件 5、自身昏厥与指示物 4、特殊能量与保护 4、训练家 4 项合成测试）；手写行／函数 100%、总分支 98.93% |
| `npm run rules:sources:check` | 8 份固定原始来源核验通过（`.cache/rules` 由迁移包恢复） |
| `npm run test:cn-cards` | 发布检查通过；真实卡机制测试 **59/59**（嗨皮 19、猛雷鼓 17、多龙 16、高频训练家 7），含八局电脑对电脑完整对局与中途存档恢复 |
| 完整 `npm test` | 通过：官方规则 1434、真实卡 59、审查记录 19、合并视图 4（旧教学引擎测试随旧模式删除） |
| `npx playwright test` | 4 通过（`cn-official.spec.mjs`）：`/` 与 `/play/` 转到官方模式，嗨皮卡组手动准备与首回合、刷新恢复、打完整局；猛雷鼓ex、多龙巴鲁托ex 标准赛制完整局并显示卡表来源；幻影潜袭的指示物分配界面 |
| 电脑对局模拟 | 猛雷鼓镜像与跨卡组 40 局；多龙对三副卡组 18 局；高频训练家测试卡表 6 局；均无引擎错误 |
| 卡图指纹 | `node scripts/build-cn-release.mjs --verify-images`：83 张核对一致 |
| 合并视图 | `npm run test:cn-merged` 4 项；`npm run cn:merged:check`：zh-Hans 14,244 个 `metadata.merged.json` 均为最新并通过 schema，88 个目录带 CN 绑定，21 处差异 |

覆盖率排除了生成验证器及生成内核指纹，不降低原100%行／函数和95%分支门槛。
测试数量与代码覆盖率**不代表全部官方条款已覆盖**。

对应实现快照：

```text
protocol:      CN-game-dev-25
schemaSha256:  21e84585b98fc6100aa5b51a4e28e45ec967beb8f17deb09fd93ce01f17bb6b9
kernelSha256:  21166d8eb576d5d0c4cf251606e76d15a9a548c293e4ad55ccfcde18705b1489
release:       cn-v20261019-reviewed-pool → 793e77f47bbe0ca09561563019d37079e21d85244c163a1a6f1bed08ed4225bc
```

## 6. 尚未完成

- 卡池后续批次（不在当前里程碑内）：招式学习器 进化／退化（回合结束时弃置的道具招式）、紧急滑板（撤退能量减少与按剩余HP消除）、
  弗图博士的剧本，以及统计中的其他卡组（电电虫Box、N的索罗亚克、玛俐的长毛巨魔、沙奈朵等）。
- 「令这只宝可梦昏厥」目前只接通「这只宝可梦」自身；令其他宝可梦直接昏厥的效果仍拒绝。
- 抢分赛中「已经获得的奖赏卡张数」没有简中依据：按其计算费用的招式（血月）在该模式下不能宣告。
- 猛雷鼓ex 卡表来自第三方汇总；简中官方没有公开赛事卡表的渠道（见审核记录 §2）。
- 「零之大空洞」离场／失去太晶后弃至上限，与战斗宝可梦昏厥后派出新宝可梦的先后没有简中条款；
  当前在规则检查时点立即执行（先于派出），双方同时超限且无竞技场持有者时安全拒绝。
- 「梦幻ex·基因侵入」复制 GX／VSTAR 招式仍需裁定（`needsRuling`，当前卡池没有此类招式）。
- 场外主动特性、特殊胜败、更多触发／费用／区域／多目标及复杂复制组合，
  以及矩阵中的其他缺失、部分和未决条款。
- 同名跨来源招式等尚缺简中依据的组合；不导入国际版结论填空，继续安全拒绝。
- `cn.coin@1` 包裹交换时，宣告可用性尚未逐只核对效果保护重叠（当前卡池没有保护效果）。
- 网站官方模式目前只做本地对电脑；服务鉴权、联网对战与赛事宿主（配对、裁判、判罚、补时）延后。

## 7. 换机器继续

最初的暂停快照（2026-10-20）已从原机器提交；本机（2026-10-21）用 git worktree
`/home/largeniu/g/pokemon/pokemon-tcg-cn-rules` 检出本分支继续，主检出保留在 main。

以下内容**不随 Git 迁移**：

| 内容 | 位置 | 处理方式 |
| --- | --- | --- |
| 8 份官方来源原件（2 PDF＋6 HTML） | `.cache/rules/sources/` | 已被 `.gitignore` 忽略。拷贝原件，或运行 `npm run rules:sources:download`（HTML 含时效 `auth_key`，哈希可能对不上） |
| sv-miraidon 逐卡审查原始取证 | `.cache/rules/card-review/V20261019/sv-miraidon/` | `tests/cn-card-review.mjs` 读取；拷贝到同一相对路径 |
| 本机卡图与 metadata | `/nas/share/Pokemon/library_v1/`、MIK 归档 | 审核与 `--verify-images`、`cn:images` 使用；缺失时测试跳过指纹比对、页面显示文字卡 |

新机器上建议依次运行（`NODE_ENV=production` 时需 `--include=dev`）：

```bash
npm ci --include=dev
npm run test:rules:official:coverage
npm test
npx playwright test cn-official.spec.mjs
```
