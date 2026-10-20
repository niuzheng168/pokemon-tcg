# CN / V20261019：官方条款—实现—测试覆盖矩阵

**审查状态：已暂停（2026-10-20）；不是完整合规声明。** 本矩阵于 2026-10-20 对共享
worktree 作静态审查。目标仍是完整的简中官方规则引擎、配套卡牌 schema、
网站接入、完备测试及最终提交／推送，不能把已经写好的子集重新定义为目标。

本矩阵最初由独立审查整理，当前开发状态与最近完整历史检查点分列：
**当前协议为 `CN-game-dev-25`；第二十七轮现场选招／禁用限定范围已完成本轮验收。**
2026-10-20暂停前同一worktree完整门禁退出码0：**1374/1374** 项规则测试通过，
较第二十六轮新增81项；手写行／函数 **100%**、aggregate分支 **98.86%**；
选招纯模块及battle-history均100/100/100。
完整 `npm test`、网页构建、schema/kernel只读检查及八份来源均通过。
用户随后要求暂停；当前功能汇总见[暂停状态与已实现总览](STATUS.md)，没有继续实施。
这不升级C07整条的部分状态：动态总量、其他量词、C08多源转放仍未支持；
真实卡池、其他条款、网站官方入口及最终提交／推送也未完成。
第二十二轮 `CN-game-dev-20` 的历史检查点另保留：
2026-10-20父线同一worktree全部门禁退出码0，
**1000/1000** 项规则测试通过，较Stage21的920项新增80项；
手写代码行／函数 **100%**、aggregate分支 **98.96%**，
`healing.js`／`effect-execution.js`／`effects.js`均为行／分支／函数 **100%**。
完整 `npm test`、网站构建、schema／kernel只读核对、八份固定来源及diff检查通过。
限定程序身份／帧、原始来源与continuation的P1强化已纳入本检查点，
不是仅凭来源核验、专项存在或Stage21旧运行宣布通过；最终日志及指纹见第7节。
以上Stage22数字与指纹仅为历史checkpoint；Stage23—27验收及指纹另见第7节。
以上不代表全部官方条款、真实卡池、网站／赛事宿主目标完成，也不声明已经提交／推送。
D-01 明确硬币／E-33 手牌失败、实际历史、E-28、正式交换及两类牌库原语
已验收列明范围；当前属性、数值／条件表达式、伤害硬币、步骤4冻结及D-17正常60所选目标伤害已加入。
第二十一轮新增己方奖赏零／一张自交换、整手牌独立重洗放底及唯一来源收尾；
第二十二轮增加限定批次／全部回复及本次实际回复者关联弃能。它们均为合成场景，
不是洗翠沉重球、格拉吉欧、玛俐、贪心栗鼠、奥利瓦或芽米的真实整卡批准。
其他失败条件、复杂复制取消、伤害前组合、未列明的隐面区域操作、
奖赏自交换的 E-31 加入手牌前交互和
无附能接收者的未决依据仍保持原目标，不因新测试通过而删除。

## 1. 证据、范围与判读方式

### 1.1 实际阅读的官方来源

本次以 `pypdf` 逐页提取并阅读了两份 PDF 的**完整目录和正文**：
进阶指南第 1—76 页、赛场规则第 1—22 页；不是只根据规则登记或历史总结填表。
下文页码均是 **PDF 的一基页序**，不是网页行号或自拟章节页码。

| 来源标识 | 内容与本地原件核验 | 实际取得日期 | 使用范围 |
| --- | --- | --- | --- |
| `CN-advanced-3.1.0` | 《进阶玩家向规则指南》Ver.3.1.0，76 页，910379 字节；SHA-256 `27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419` | 2026-10-19；旧稳定入口另于2026-10-20复核 | 第 I、II 章逐条索引。目录在 p.1—4，正文在 p.5—76。 |
| `CN-tournament-3.1.0` | 《赛场规则》Ver.3.1.0，最后更新 2026-04-02，22 页，334035 字节；SHA-256 `b5f0c8b87d928f5ca640f1f021863eb78aafcc8216067883e7b2075a25ab1ac6` | 2026-10-19；旧稳定入口另于2026-10-20比较 | 完整第 1—15 章；数字内核与赛事宿主的责任分列。解析器可恢复的交叉引用警告不改变原始字节。 |
| `CN-formats-20260916` | 官网页面声明更新 2026-09-16；原始 `text/html` 38888 字节；SHA-256 `b69f6182818a4b97f0d4b14740a99851018430356219fac03a6c7d08ea85d77a` | 2026-10-20 | 标准／开放卡池；本地实际页面与配置核对，不能使用搜索摘要代替卡名表。 |
| `CN-standard-adjustment-20240519` | 原始 `text/html` 44039 字节；SHA-256 `1015af38fa10465ad8b481eea2b0cdb541cf863f9e217a082705212c6d8d0167` | 2026-10-20 | 基本妖能量退出标准的历史说明；生效日是 **2024-06-18**。 |
| `CN-formats-extra` | 特别卡牌说明的原始 `text/html` 46920 字节；SHA-256 `97893c30b6cbd694fd699b05f4fb376cd600627d085aaba56901e896824d897a` | 2026-10-20 | GX、棱镜之星、究极异兽、TAG TEAM、V／VSTAR／VMAX、光辉及规则框的补充要求。 |
| `CN-basic-conditions` | 特殊状态页原始 `text/html` 48463 字节；SHA-256 `4c2344ddf107efc11aeed5e70f1f5a6caa2ea986b21e2d231e2ad2c2a36f3576`；保留 `pageName=basic_rules07%2F` | 2026-10-20 | 实际正文包含检查、普通状态及互斥；互斥定位为“睡眠；麻痹；混乱”。退化清状态、新中毒覆盖及灼伤量取最大仍用各自进阶出处，不由本页包办。 |
| `CN-basic-guide` | 玩法指引原始 `text/html` 76924 字节；SHA-256 `cdca11d0c4be931eb3e934570a738c1c60990ad3b8354666a39bd2ca0d46ceb8` | 2026-10-20 | 实际正文包含60张、至少一张基础、同名四张、基本能量不限及主动认输；一般卡面特殊限额仍须其他依据，不构成卡牌审批。 |
| `CN-basic-play` | 对战方式页原始 `text/html` 47096 字节；SHA-256 `05b87095fbeda5616cfd7be3a66de8afcaac331c1b5158e5f29a06078927d600`；保留 `pageName=basic_rules05%2F` | 2026-10-20 | 回合开始强制抽牌及空牌库败北、抽完最后一张不立即败北均有明确注释；不足牌库的效果抽牌如何尽量执行，另用进阶出处。 |

原件目录：[官方来源缓存]；实际 URL、取得日期、页数及指纹登记见 [R]。
截至 **2026-10-20**，当前登记的 **八份来源（两PDF、六HTML）** 均已完整取得、阅读并固定原始字节。
六份 HTML 是 **2026-10-20 取得的、用于审查 2026-10-19 快照的当前证据**，
不倒填日期，也没有它们与19日历史响应字节相同的证明。
`V20261019` 是项目审查快照，不是官方文件版本号。HTML含带时效的图片 `auth_key`，
指纹只固定本次响应，不保证未来URL字节不变；05／07虽共用无查询的canonical，
仍是不同正文，不能删去 `pageName` 或用canonical代替登记身份。
三个基础页已核读真实HTML正文，不再是“登记但未固定”的缺口；
其他未登记网页、卡牌原件、勘误与专门裁定仍须各自核验，不由八份来源自动获准。
2026-10-20另完整抓取并逐字节比较旧稳定入口：`basic_rules08.pdf`
与固定进阶3.1.0完全一致；`basic_rules09.pdf` 为2024-07-08赛场3.0.0，
389144字节／21页、SHA-256 `bff14750195fe0a1d3d0cc91135ee0241a0430dd1e17c602f79b1f9a0c62cd69`，
不替代固定的2026-04-02赛场3.1.0。登记见[R]的独立入口核验元数据，
不是从文件名推断，不新增旧版为当前规则来源。

### 1.2 状态的严格含义

- **已实现（限定范围）**：表中明确列出的通则有实际执行路径和相应测试。
  不表示官方示例中的每张真实卡已迁入，不表示该条的任意组合都已覆盖。
- **部分**：已有表达／执行／测试中的一部分，但列明的另一部分仍缺失；
  纯函数测试不能代替 `OfficialGame` 集成测试。
- **缺失**：没有该条完整执行路径或直接证明其语义的测试。
  存在 `ruleId`、schema 字段或可编写自定义 handler 的能力，都不自动构成实现。
- **进行中／待集成**：主任务正在开发，必须在集成后的同一内核、schema、
  来源登记和回归结果下复审。
- **赛事宿主责任（未交付）**：属于赛事／裁判／平台服务，而非卡牌结算函数。
  **仍保留在整体交付审查范围内**；不得借分层把这些功能写成“已完成”或直接删去。

`ruleIds` 列中的“关联”表示现有规则只覆盖相邻基础机制，不冒充该条已有专门登记。
测试列写实际测试文件和可检索的名称前缀／测试主题；负面测试证明“安全拒绝”，
不证明被拒绝的机制已经实现。代码仍在并行变化，因此优先用**函数名和 task 名**
定位，不依赖容易漂移的行号。

### 1.3 路径图例

引用在本workspace逐一核验；既有仓库相对链接保留，新增工作区链接用绝对路径：

- [R]：地区版本及 source-of-truth 登记；[G]：对局状态机。
- [H]：已审核的通用 handler；[FX]：效果执行帧；[SEL]：数量语义。
- [DMG]：伤害管线；[COND]：特殊状态；[ONG]：持续时限；[TR]：触发语义。
- [SUP]：消除依赖；[CS]：场外卡牌选择；[ACQ]：加入手牌前窗口。
- [PEX]、[S-prize-exchange]：己方奖赏自交换纯规划与 schema；[HBOTTOM]、[S-hand-bottom]：整手牌重洗放底纯规划与 schema。
- [HEAL]、[S-healing]：限定批次回复及实际回复结果纯规划与 schema；关联弃能不是通用结果变量。
- [EXEC]、[S-execution]：私有程序身份／顺序恢复协议；纯层不认证来源，第二十五轮起宿主追踪全部效果调用（包括嵌入反应）。
- [REQUEST]、[S-request]：完整选择与暂停控制面私有收据；[JEQUAL]为离线schema的严格JSON等价桥接，不是另一条宝可梦规则。
- [CDIST]、[S-counter-distribution]：固定总数的指示物分配，不代表多来源转放或动态总量。
- [NCHANGE]：使用门槛与E29许可的原件核读边界；`useRule`须独立审核，不能由数据自行签发权限。
- [FIELD]、[S-field]、[DISCARD]及[FIELD-SCOPE]：物理场地主体、self保护及棱镜之星弃牌替代；不是任意区域替代接口。
- [OWNED-LOCK]、[S-owned-lock]及[OWNED-SCOPE]：现场选择卡面招式、专用限时账本与真实路线匹配；不是全同名规则的裁定。
- [COST]：费用分配；[EM]：能量要求／供给／选择；[ES]：附着能量候选。
- [EV]：进化／退化／继承；[FR]：场上返回；[COPY]：招式复制；[GRANT]：额外招式。
- [FMT]、[FMT-CN]：赛制准入与固定配置；[CAT]、[CARD]、[REL]、[RG]：目录与发布信任门禁。
- [S-card]、[S-state]、[S-fx]、[S-cost]：卡牌、对局、效果、费用 schema。
- `T-…` 链接是对应的规范测试文件；以下表格不把旧教学引擎的测试算作 CN 合规证据。

## 2. 进阶指南第 I 章：玩法补充（15 个目录项）

| 条款／PDF 页 | 核验主题 | 现有 ruleIds | 实现文件／函数或任务 | 测试证据 | 状态与确切边界 |
| --- | --- | --- | --- | --- | --- |
| **I.A-01** p.5—8 | 招式宣告、能量、先攻限制、七步使用及六步伤害 | `attack.order`、`attack.first-turn`、`energy.payment`、`energy.requirement`、`damage.*`、`status.confusion`、`attack.failure.*` | [G] `attackLegal`、`imposedAttackCheck`、`ownAttackCheck`、`runTask(attack/after-attack/resolve-attack/finish-attack)`；[DMG] | [T-game] 宣告／混乱／授予；[T-failure] 外加检查→混乱→自身失败、GX/VSTAR、复制与恢复；[T-packets] 伤害快照 | **部分**。基本步骤及明确硬币失败已集成；通用随机加伤／效果、非硬币失败、复杂复制取消和离场后后续伤害仍未完整。 |
| **I.A-02** p.8—9 | 主动／自动特性、条件费用、不可无变化宣告 | `ability.usage`、`effects.activation-cost`、`effects.activation-change`、`effects.partial` | [G] `activationInfo/activationEffectsUsable`、`nativeActivationQualifies/nativeWorkQualifies`；[H]；[COST] `findCostPaymentWitness`；[NCHANGE] | [T-nochange-heal]、[T-nochange-counters]、[T-nochange-switch]主动资格；[T-stadium]场地叶；[T-cost-dependency]付款后属性／保护；[T-nochange-projection]实际宣告／保留投影；[T-cost-witness]独立oracle | **部分**。第二十六轮将已审五个原生叶扩至六个（效果弃场地），完整付款存在性不计费用／次数本身为变化；自动／窗口选择不凭optional布尔泛化。场外主动特性、其他费用及任意整卡程序的使用证明仍缺。 |
| **I.A-03** p.9—10 | 撤退一次、整张能量付款、状态／效果清除 | `retreat.limit`、`retreat.payment`、`energy.units`、`status.clear` | [G] `retreatCost`、`actions`、`runTask(retreat-paid/finish-retreat)`、`switchTo`；[EM] `resolveEnergyRequirements`；`energy.js::validateRetreatPayment` | [T-game] `Retreat chooses whole Energy cards`；[T-foundation] `Retreat payment respects player choice`；[T-energy] `Retreat pays with effective provision`；[T-battle] `Pokémon Retreat lock` | **已实现（限定范围）**：普通撤退、有效费用、不可拆能量、满备战仍可交换、睡眠／麻痹与撤退锁、普通一次额度；特殊撤退机制须逐卡证明。 |
| **I.A-04** p.10 | 手牌基础宝可梦逐只上备战，普通上限五只 | `turn.bench`、`trigger.bench` | [G] `actions`、`dispatch(bench)`、`newMon`；[S-state] `player.bench` | [T-triggers] `E-05/06 optional from-hand`；[T-cards] `C-11: Bench-full search`；[T-game] 准备／出场场景 | **已实现（限定范围）**：普通五格及逐只出场。改变备战容量、非宝可梦卡充当宝可梦等特例未实现，不能通过当前上限 schema 表达。 |
| **I.A-05** p.10 | 普通进化时点、关系、保留与清除、覆盖卡面能力 | `turn.evolve`、`evolution.history`、`status.clear` | [G] `canEvolve`、`evolveMon`、`dispatch(evolve)`；[EV] `evolutionRelation`；[S-card] `pokemon.basicAncestor` | [T-game] `evolution keeps attached cards`；[T-evolution] `ordinary evolution records`、`evolution relations use approved actual ancestry`；[T-battle] `printed HP is immutable` | **已实现（限定范围）**：普通进化及真实来源记录。效果进化另见 II.C-12；特殊部署仍明确拒绝，不能把 schema 接受阶段名算作支持。 |
| **I.B-01** p.11 | 物品条件、展示、依序执行、最后弃置 | `turn.trainer`、`effects.activation-cost`、`effects.partial`、`effects.prize-exchange`、`effects.execution`、`cards.prism-star` | [G] `activationInfo`、`payActivation`、`commitActivation`、`assertTrainerFinish`、`assertExecutionWork`、`validSource`、`runTask(finish-trainer)`；[FX]；[EXEC]；[DISCARD] | [T-cost]费用；[T-effects]条件；[T-acquisition]奖赏源；[T-prize-exchange-state]收尾；[T-healing-program]身份；[T-prism]使用结束 | **部分**。程序／来源恢复保留，非手牌来源须匹配原beforeHand绑定，不能伪装field绕盾。第二十六轮接通Prism使用收尾去向；其他卡文用后回手等仍缺，不等于全体训练家或通用区域替代已支持。 |
| **I.B-02** p.11—12 | 道具一只一张、保留、不可任拆／替换、旧印刷分类 | `turn.tool`、`effects.remove-content` | [G] `activationInfo`、`runTask(attach-tool)`、`sourceModel`；[SUP] `resolveSuppression`；[S-card] `trainer.category` | [T-game] `Tool selection is resumable`；[T-suppression] `Tool-Jammer-like removal retains attachment`；[T-cost] `normal Tool/Stadium placement` | **部分**。单槽、进化／撤退保留、道具效果消除而不弃置已测；多道具槽等特例、旧“物品”印刷的真实卡分类迁移未交付。 |
| **I.B-03** p.12 | 支援者一次、先攻首回合限制、条件及最后弃置 | `turn.supporter`、`turn.trainer`、`effects.activation-cost`、`effects.prize-exchange` | [G] `actions`、`activationInfo`、`commitActivation`、`assertTrainerFinish`、`runTask(finish-trainer)` | [T-game] `Supporter resolves before discarding itself`、`first player cannot attack`；[T-cost] `Supporter and VSTAR limits`；[T-prize-exchange-live] 格拉吉欧形交换／零选收尾；[T-hand-bottom-live] 玛俐形费用后可用性 | **已实现（限定范围）**：普通手牌支援者及本轮明确自交换／放底路径；TAG TEAM 选择整段／首段等扩展仍未实现，不构成真实支援者整卡审批。 |
| **I.B-04** p.12—13 | 竞技场使出额度、同名不能替换、自动／宣告效果 | `turn.stadium`、`turn.trainer`、`effects.activation-cost`、`effects.stadium-discard` | [G] `stadiumUsages`、`activationInfo`、`commitActivation`、`sourceModel`；[FIELD]；[H] `onUse`协议 | [T-game]替换；[T-effects]每玩家额度；[T-cost]共享费用；[T-stadium]物理主体／正常替换／来源分类 | **部分**。第二十六轮新增竞技场本体self保护、效果弃置及Prism去向；普通放置／替换与共享使用仍保留。任意场地onUse整段无变化资格证明、其他区域操作与真实卡审批仍未完整。 |
| **I.C** p.13—14 | 普通附着、基本／特殊能量、九种基本能量、同名限额 | `turn.energy`、`energy.units`、`energy.types`、`energy.provision`、`deck.construction` | [G] `activationInfo/commitActivation(energy)`、`energyCards`、`enforceEnergyRetention`；[CAT] `validateDeck`；[EM] 供给与单位 | [T-game] `normal attachment once`；[T-runtime] `deck limits aggregate`；[T-schema] `Energy definition supports multi-unit cards`；[T-energy] `from-hand`／转附／保留场景 | **部分**。一般附着与效果附着、卡张／能量单位、基本身份、特殊能量条件已实现；指南“九种”与标准卡池“八种”已分离。任意能量特例／复杂冲突和真实卡目录仍缺。 |
| **I.D** p.14—15 | 所有昏厥边界、触发后弃置、奖赏、双方补位次序 | `ko.boundary`、`ko.promote`、`trigger.knockout` | [G] `collectKO`、`runTask(ko/ko-discard/award/finish-ko/promote)`、`afterKO` | [T-triggers] `E-04 simultaneous own KOs`、`a continuous HP source leaving play`；[T-game] `same-time knockouts`；[T-acquisition] `Prize-card effects settle new Knock Outs` | **部分**。普通昏厥批次／连锁及所有奖赏后判胜已测；昏厥防止／替代去向、奖赏增减／处罚、跨持有者全局反应及非昏厥混合补位未完成。 |
| **I.E** p.15—16 | 三种普通败北、简中同时胜负表、一奖赏重新开局抢分 | `turn.draw`、`win.simultaneous`、`win.tiebreak`、`win.concede` | [G] `afterKO`、`finish`、`runTask(start-turn/place-prizes)`、`createGameState`；[FMT] `assertMatchFormat` | [T-game] `CN I.E victory table: all 16 combinations`、`short deck draws, deckout, concede`；[T-return] `I.E waits for all related attack work`；[T-formats] `development pools are not official pools` | **部分**。普通表与一奖赏模式已实现；由平局建立关联的新抢分对局、赛事对局级结果、特殊胜负（II.E-38）和抢分时 II.D-17 的专门核对仍缺。 |
| **I.F** p.16 | 检查不属于回合、双方按状态类别处理、效果前／后插槽 | `checkup.order`、`trigger.checkup`、`status.*`、`history.checkup-not-a-turn` | [G] `runTask(checkup/checkup-plan/checkup-statuses/finish-checkup)`；[COND]；[CHK] | [T-ongoing] 双方状态组次序；[T-triggers] 前后插槽；[T-checkup-live] E-28 来源／时限／双方致死；[T-history-live] 检查时界 | **部分**。普通状态组、灼伤数量替换及局部效果插槽已接通；跨双方全局依赖仍待依据与实现，不以固定玩家顺序代替。 |
| **I.G** p.17—18 | 决定先后攻、起手七张、共同／单方重抽、奖赏先补牌 | `setup.order`、`setup.active`、`setup.mulligan`、`setup.prizes` | [G] `createGameState`、`runTask(deal/prepare/setup-active/setup-bench/place-prizes/retry/bonus/finish-setup)` | [T-game] `game setup honors decision-winner choice`、`mutual mulligans`、`setup projections hide opposing face-down` | **部分**。普通准备与一次决定补牌数、额外备战已测；实体招呼由宿主承担，赛场 11.3 主裁判强制流程和官方赛事准备界面未实现。 |
| **I.H** p.18 | 牌库上方抽取、限定检索可少选、任意卡须足量、重洗隐面 | `effects.draw`、`effects.search`、`effects.shuffle`、`selection.hidden` | [G] `draw`、`cardWindow`、`shuffleZone`、`runEffect(cards)`；[CS] `matchesCardSelector`；[SEL] `selectionBounds` | [T-cards] `full-deck search permits fail-to-find`、`any-card deck search must take the exact count`；[T-game] `effect draws from a short deck` | **部分**。自己牌库检索与效果抽牌、检索后重洗已测；查看后原位放回、指定顶／底顺序、对手隐面区域和获准查看的持久知识模型未完成。 |

## 3. 进阶指南第 II 章：说明文（88 个目录项）

### II.A：通则

| 条款／PDF 页 | 核验主题 | 现有 ruleIds | 实现与测试 | 状态与缺口 |
| --- | --- | --- | --- | --- |
| **II.A** p.19 | 卡牌／最新说明优先、禁止优先、按序尽量执行、指定数量 | `effects.precedence`、`effects.prohibition`、`effects.partial`、`selection.exact`、`effects.execution` | [G] `assertSupportedDefinition`、`attackLegal`、`monProhibited`、`playerProhibited`、`runEffect`、`assertExecutionWork`；[FX] `completeEffectStep`；[EXEC] `replayEffectExecution`／[S-execution]；[CARD] `assertExecutableDefinition`；[FMT] `validateFormatDeck` | [T-effects]独立递归／then；[T-execution]顺序与精确帧oracle；[T-healing-program]程序扩大／嫁接拒绝；[T-battle]限制；[T-formats]最新说明等价 | **部分**。已实现指令内优先关系与限定程序顺序／身份恢复，不允许据保存动作扩大原程序；纯日志不认证来源或任意handler代码，也不是任意卡文解释器。未实现指令、特殊胜负和复杂依赖仍须补齐，而非以拒绝代替完成。 |

### II.B：伤害计算（01—09）

| 条款／PDF 页 | 核验主题 | ruleIds | 实现文件／函数 | 测试证据 | 状态与确切边界 |
| --- | --- | --- | --- | --- | --- |
| **II.B-01** p.19—20 | 说明文自身加算属于基础伤害，不是效果 | `damage.base`、`damage.expression`、`damage.coins` | [G] `prepareDamageCoins/after-attack`；[VALUE] 加算／条件；[COINS] 规范与收据；[H] `cn.damageValue@1` | [T-value] BigInt/RPN；[T-coins] 完整结果串枚举；[T-coins-live] 固定／动态次数、0停止、C18；[T-coins-state] 恢复及源绑定 | **部分（数值／伤害硬币已集成）**。不伪造卡面，随机结果先实际记录再计算；选牌结果统计、非伤害掷币及真实整卡仍未全部覆盖。 |
| **II.B-02** p.20 | 数量乘算及结果为零即终止 | `damage.base`、`damage.zero`、`damage.expression`、`damage.coins` | [COINS] fixed／untilTails；[VALUE] 命名统计；[G] 克隆RNG审计／阶段快照；[DMG] `stopAtZero` | [T-coins-live] 首次反面、heads×30、0不复活、cards与units；[T-coins-state] 一次结果共用、复制隔离、恢复不重掷 | **已实现（限定范围）**。直到首次反面及固定0/正次数可执行并有完整收据，不设20次帽；先选目标的计划、选牌驱动全部统计仍待实现，不代表每张“×”卡已审批。 |
| **II.B-03** p.20 | 招式自身减算及零／负结果终止 | `damage.base`、`damage.zero`、`damage.expression` | [VALUE] BigInt加减乘、最终夹零；[G] 当前指示物／有效撤退费用事实；[DMG] 后续阶段独立 | [T-value] 13,122例独立RPN及有符号事实；[T-value-live] 当前事实、整体负值／中间负值、0不被Tool复活；[T-pred-live] 大整数相消 | **部分（通用数值已集成）**。基础减算不冒充附加伤害修正，不逐小项截零；具体真实卡完整打印／说明文绑定及其所有条件仍须逐卡核验。 |
| **II.B-04** p.21 | 攻击方／防守方“加伤”按实际附着位置入阶段，阶段内合计 | `damage.attacker`、`damage.defender` | [G] `continuous`、`damageModel`；[DMG] 攻击方／防守方阶段 | [T-foundation] `attacker before Weakness`、`attacker modifiers aggregate before zero test`；[T-ongoing] `next-own-turn bonus` | **已实现（限定范围）**：审核修正量、阶段与来源；不含所有动态条件公式。 |
| **II.B-05** p.21—22 | 减伤也按附着对象入相应阶段，阶段内合计 | `damage.attacker`、`damage.defender`、`damage.zero` | [G] `continuous`；[DMG] 攻击／防守阶段 | [T-foundation] `attacker subtraction before Weakness`、`defender modifiers aggregate before zero test`、`defender zero` | **已实现（限定范围）**：来源合计和零终止；卡牌特殊合并顺序另需依据。 |
| **II.B-06** p.22 | 不计弱点／抗性属于伤害步骤，不是招式效果 | `damage.ignore-wr` | [G] `damageOptions`；[DMG] `ignoreWeakness/ignoreResistance` | [T-foundation] `ignore Weakness only`、`ignore Resistance only`、`ignore W/R is not ignore defender effects`；[T-packets] 目标包 | **已实现（限定范围）**：两标记独立、备战默认与特例分离。 |
| **II.B-07** p.22—24 | 无视防守附加效果不恢复已改变的弱点／抗性 | `damage.ignore-defender`、`damage.prevention` | [G] `effectiveProperty`、`damageModel`、`damageOptions`；[DMG] 防守阶段／防止 | [T-effects] `ignore defender effects bypasses damage reduction/protection`；[T-foundation] `removed effective Weakness is not restored` | **已实现（限定范围）**：有效弱抗、防止伤害与效果免疫分别处理；属性替换冲突仍拒绝。 |
| **II.B-08** p.24 | 多目标／备战伤害参与计算，保护目标仍可选择 | `damage.bench`、`attack.order`、`damage.prevention`、`damage.expression` | [G] `runEffect(damage)`、`dealAttackDamage`、`damageModel`；[VALUE] 每目标数值；私有阶段回执 | [T-packets] 固定伤害／数量／保护；[T-value-live] 所选备战HP、整批状态、恢复；[T-value-state] 冻结／篡改／历史隐私及D17型备战 | **已实现（限定范围）**：各目标可依阶段前事实计算；主伤害不能改写后包基数，默认不算备战弱抗。将一个总量任意拆配等方案仍未齐。 |
| **II.B-09** p.24—25 | 自伤／己方备战伤害不是对手招式伤害，仍参与伤害阶段 | `damage.self`、`damage.expression` | [G] 步骤4模型／数值冻结；[H] `cn.recoilDamage@1` 已改为damage时序 | [T-packets] 普通包均阶段4；[T-value-live] 全目标自伤及后包基数；[T-value-state] 特殊时序仅合成能力测试 | **已实现（限定范围）**：普通recoil不默认为阶段5效果，修正旧测试假设；特殊后续伤害必须另有卡文依据，不由一个泛用alias擅自认可。 |

### II.C：效果（01—20）

| 条款／PDF 页 | 核验主题 | ruleIds | 实现文件／函数 | 测试证据 | 状态与确切边界 |
| --- | --- | --- | --- | --- | --- |
| **II.C-01** p.25—26 | 弃到持有者区域；能量单位与整张卡 | `effects.discard`、`energy.attached-selection`、`energy.units`、`effects.stadium-discard`、`cards.prism-star` | [G] `discard`、`runEffect`；[EM]；[FIELD]；[DISCARD] | [T-energy]整张多单位／持有者选择；[T-cost]费用／效果数量；[T-stadium]场地；[T-prism]逐物理卡去向 | **部分**。手牌／选卡／附着能量、场地弃置与Prism原持有者lost替代已接通；全场道具等其他弃置对象、竞争区域替代仍未完整。 |
| **II.C-02** p.26 | 返回持有者区域、整条进化叠层、清伤害／效果 | `effects.return`、`effects.field-return`、`energy.return` | [G] `runEffect(cards/returnPokemon/returnEnergy)`；[FR] `fieldReturnTargets` | [T-return] `C-02 returns the entire evolution stack`、`opponent returns use its holder zones`、`a self-returning attack finishes` | **部分**。场上整组返回／附着卡显式策略已测；查看顶牌再原位放回、物品使用后返回、非昏厥补位默认裁定／混合离场及昏厥替代未完成。 |
| **II.C-03** p.26—27 | 自己互换不是撤退；换下清除；无备战不能执行 | `effects.switch`、`status.clear` | [G] `runEffect(switch)`、`switchTo`；[H] `cn.switch@1` | [T-battle] 撤退锁与交换区分；`switch-handler.test.mjs` 14项：真实物品、费用资格／恢复、睡眠麻痹、状态清除及移动历史 | **已实现（限定范围）**：原生 handler 严格要求 side／chooser／affected，不补国际默认值；普通交换不耗撤退额度及能量。 |
| **II.C-04** p.27—28 | 对手选择替换，受影响对象是其战斗宝可梦 | `effects.switch`、`effects.protection` | [G] `runEffect(switch)` 的 chooser／保护、`switchTo`；[H] `cn.switch@1` | [T-effects] Escape-Rope 型保护组合；`switch-handler.test.mjs` 对手选择与存档；[T-game] 伤害前交换 | **已实现（限定范围）**：战斗对象免疫挡交换，备战免疫不反向挡；一般随机门另缺。 |
| **II.C-05** p.28—29 | 使用者选择对方备战，受影响对象是选中的备战 | `effects.switch`、`effects.protection` | [G] `runEffect(switch)`；[H] `cn.switch@1` | [T-effects] Guzma 型四种位置组合；`switch-handler.test.mjs` 原生 handler、目标资格、保护及对手备战选择 | **已实现（限定范围）**：保护不阻止选中但可阻止执行；抛币捕捉器的通用前置门尚缺。 |
| **II.C-06** p.29 | 回复移除伤害、上限已有伤害、全回复及无变化限制 | `effects.heal`、`effects.heal-results`、`pokemon.effective-hp` | [HEAL] `healingWindow/planPokemonHealing/assertPokemonHealingPlan`；[G] `runEffect(heal/healPokemon)`、`assertHealingChoice`；[H] `cn.heal@1`／`cn.healPokemon@1`；[S-healing] | [T-healing] 独立批次oracle／严格计划；[T-healing-live] 固定／全部回复、统一保护、实际回复者关联弃能；[T-healing-state] 费用／恢复／篡改；[T-healing-contract] action／权限；旧[T-battle]、[T-game]单体路径保留 | **已实现（限定路径；Stage22检查点）**。先收齐选择、冻结本批指示物及回复保护，再统一提交；“全部”移除全部已有指示物，不改印刷HP。无能量不阻止回复；关联后段只取本次实际回复者，另查当前保护／能量。并非任意结果变量、多目标操作通用证明或真实芽米／奥利瓦整卡审批。 |
| **II.C-07** p.30 | 放指示物是效果而非伤害，保护仍可被选中 | `damage.counters`、`damage.counter-distribution`、`effects.protection` | [G] `addCounters`、`runEffect(counters/distributeCounters)`、`assertCounterChoice`；[CDIST]；[S-counter-distribution] | [T-effects]、[T-triggers]伤害／效果区别；[T-counter-distribution]整数分拆oracle；[T-counter-distribution-live]批次／保护／资格／复制；[T-counter-distribution-state]数值回答／恢复／重播；[T-counter-distribution-contract]严格参数及命令 | **部分（第二十三轮固定总数子集）**。固定非负总数可完整分配给公开候选；先选全、统一保护、一次提交，不按HP截断、不重分被挡份额；原生主动来源全保护且整次无变化不可宣告。动态总量、任意数量及其他卡文组合仍缺，且不把本子集代替C-08转放。整体验收见第7节。 |
| **II.C-08** p.30—31 | 转放指示物；目的受保护时来源仍被移除 | `damage.counters`、`effects.protection` | [G] `runEffect(transferCounters)`；[H] `cn.transferCounters@1` | [T-effects] `counter transfer removes the source counters`、`core transfer/attachment legality` | **部分**。单来源／目的固定数已测；任意数量、全量、多来源任意重分配缺 schema／执行／回归。 |
| **II.C-09** p.31—32 | 效果附着只到己方，不耗普通额度；按卡张触发 | `effects.attach`、`turn.energy`、`trigger.energy` | [G] `runEffect(attachHand/attachDiscard/attachDeckEnergy)`、`triggerWork`；[H] `cn.attachDeckEnergy@1`；`deck-energy.js` | [T-triggers] 多单位卡按张触发；[T-game] 弃牌附着；`deck-energy-runtime.test.mjs` 11项：顶五筛选任意分配、全牌库直附使用者、手牌额度独立、origin、特殊保留、保护及恢复 | **部分**。已增加己方牌库直接附着、单目标／逐卡分配及一般特殊能量物理张数／保留路径；属性各不同未实现。没有接收对象时能否先查看的简中依据仍未决，软件不开放该路径，不声称官方禁止。 |
| **II.C-10** p.32—33 | 转附、无目标不动、多单位整卡、对象不符特殊能量弃置 | `energy.move`、`energy.attached-selection`、`energy.provision` | [EM] `attachedEnergySelection`；[ES] `attachedEnergyPool/energyRecipients`；[G] `runEffect(moveEnergy)`、`enforceEnergyRetention` | [T-energy] `C-10 transfer keeps holder ownership`、`Special Energy may move to a forbidden holder`、`separate-recipient transfer collects all choices` | **部分**。主体／所有者／保护／批次／保留已测；多张多单位能量产生的冗余超选仍为 `unresolved-energy-quantity`，不能宣称完整。 |
| **II.C-11** p.33—34 | 效果部署、容量不足截断、满备战不可先看牌库 | `effects.deploy`、`trigger.bench` | [G] `runEffect(cards)`、`newMon`；[CS] `matchesCardSelector`；[H] `cn.cards@1::canUse` | [T-cards] `C-11: Bench-full search`、`a Bench entry effect can fill the last slot`；[T-acquisition] 进化卡直接部署 | **已实现（限定范围）**：己方牌库／弃牌等已列区域、审核指示允许的阶段、真实来源和预留卡；特殊拼合／化石另缺。 |
| **II.C-12** p.34 | 效果进化及卡面具体时点，神奇糖果真实基础祖先 | `effects.evolve`、`turn.evolve`、`evolution.history` | [EV] `evolutionRelation/evolutionTiming/transitionCards`；[G] `runEffect(evolvePokemon)`、`evolveMon` | [T-evolution] `C-12 effect evolution can occur on a first own turn`、`Rare-Candy-like paths`、`from-hand evolution reactions` | **部分**。普通／跳一阶／明确任意一阶及来源已测；同回合已经进化再效果进化的未决策略明确拒绝，特殊关系仍需逐卡依据。 |
| **II.C-13** p.35—36 | 顶部逐层退化、保留伤害附着、清状态效果、视为刚上场 | `effects.devolve`、`status.clear` | [EV] `devolutionDepth`；[G] `runEffect(devolvePokemon)`、`recordTransitionKO` | [T-evolution] `C-13 removes only the top evolution`、`arbitrary top-down depth`、`devolution HP loss is an effect KO` | **已实现（限定范围）**：公开顶层、任意层数、直接部署无下层不退化、同时选择与保护快照；特殊形态不据此自动支持。 |
| **II.C-14** p.36 | 无法撤退与交换分离，按时限及回备战／进化清除 | `effects.pokemon-lock`、`status.clear` | [G] `monProhibited`、`actions`；[ONG] 持续账本；[H] `cn.restriction@1` | [T-battle] `Pokémon Retreat lock`、`live Pokémon restrictions`；[T-ongoing] 清除策略 | **已实现（限定范围）**：实时／有时限普通撤退锁，非交换锁。 |
| **II.C-15** p.36 | 禁用全部／指定招式，不能用能量足够绕过 | `effects.pokemon-lock`、`attack.owned-lock` | [G] `monProhibited/attackLegal`、现场选择／历史／清除；[ONG]；[OWNED-LOCK] | [T-battle]旧指定锁；[T-copy]复制；[T-grant]授予；[T-owned-live]时限／保护／清除；[T-owned-state]原始选择／账本；[T-owned-identity]实际路线／继承 | **部分**。第二十七轮新增真实现场选对手Active卡面招式、限时附锁及恢复，候选不按合法性过滤。跨定义直接提供的同名招式匹配仍缺CN依据，实际竞争明确未决，不冒称所有同名规则已经闭合。 |
| **II.C-16** p.36—37 | 伤害防止仅影响相应目标，可被无视防守效果穿透 | `damage.prevention`、`effects.protection`、`damage.ignore-defender` | [G] `protections/damageModel`；[DMG] 防止阶段 | [T-packets] `Bench attack damage`；[T-effects] `damage shields and effect shields`；[T-foundation] `prevention` | **已实现（限定范围）**：伤害防止不是全效果免疫，多个伤害目标分开。 |
| **II.C-17** p.37—39 | 效果免疫不防伤害、不禁选择、不清既有状态／效果 | `effects.protection`、`effects.remove-content` | [G] `effectBlocked`、各具体操作；[SUP] 可用性；[H] `cn.protection@1` | [T-effects] `damage shields and effect shields`、`counter transfer`；[T-suppression] `removing Ability text does not cancel an effect`；[T-return] `return protection` | **部分**。已实现操作的保护已测；新操作仍须逐个定义实际受影响对象，竞技场自身等非宝可梦对象未齐，不能把现有统一入口扩张为全效果支持。 |
| **II.C-18** p.39—40 | 执行选中招式内容，实际宣告身份不变，通常不付被选费用 | `attack.copy`、`attack.owned`、`evolution.history`、`attack.failure.self` | [COPY]；[G] `beginAttackContent`、`runEffect(copyAttack)`、`runTask(finish-copy)`、`validSource` | [T-copy] 实际使用者／命名锁／嵌套／恢复；[T-grant] 授予后复制；[T-failure] 24 层纯复制链及自身失败、复杂取消拒绝 | **部分**。公开卡面、明确特殊额度策略和纯链失败已测；隐面来源、强制循环、其他 GX/VSTAR 特例及已有其他正文后的取消作用域仍未完成。 |
| **II.C-19** p.40—41 | 不能从手牌使出是玩家效果，不受宝可梦免疫阻止 | `effects.player-lock` | [G] `playerProhibited`、`actions/activationInfo`；[ONG] `createPlayerOngoingEffect` | [T-battle] `C-19 player Trainer lock`、`live player restrictions distinguish every Trainer category` | **部分**。四类训练家及竞技场使用的锁已测；一般宝可梦／能量使出锁、次数改写等更广类别尚未表达，不能把“●●”局限于已写枚举。 |
| **II.C-20** p.41 | 查看牌库／奖赏／对手手牌，原位放回及奖赏任意位置 | `effects.search`（含 C-20 来源）、`selection.prizes`、`effects.prize-exchange` | [G] `cardWindow`、`runEffect(cards/inspectDeck/exchangePrizes)`、`playerView`；[PEX] `prizeExchangeWindow`；[S-prize-exchange] | [T-cards] 检索视窗；`deck-inspection-runtime.test.mjs` 61项；[T-prize-exchange] 物理身份／打印筛选；[T-prize-exchange-live] 己方全部奖赏私有查看、选择、重洗及恢复 | **部分**。明确己方牌库窗口与己方反面奖赏自交换已有执行路径；并非通用查看或任意奖赏重新布置。只查看不移动／原位放回、指定顺序、对手手牌授权视图、持久知识模型仍缺；选中奖赏的 E-31 交互见未决边界。 |

### II.D：术语（01—19）

| 条款／PDF 页 | 核验主题 | ruleIds | 实现文件／函数 | 测试证据 | 状态与确切边界 |
| --- | --- | --- | --- | --- | --- |
| **II.D-01** p.42 | 外加失败：2-a 且未用招式；自身失败：已用招式；无伤害／效果 | `attack.failure.imposed`、`attack.failure.self`、`attack.failure.hand-payment`、`attack.used`、`attack.order` | [FAIL] 硬币条件；[G] `ownAttackCheck`／`attack-payment`，按唯一宣告绑定 `failure-check/body` 及收据 | [T-failure] 固定 N／直到反面；`attack-commitments-integration.test.mjs` 的8项实战测试：零张失败、实际使用者、复制、额度、隐私及恢复 | **部分（已集成明确范围）**。minimum-Heads 硬币和 E-33 完整弃牌或零张失败已接通；相同明确非叠加组可合并，不能由重复 ID 推定。不同 imposed 组排序、自失败＋beforeDamage、复杂复制取消及其他非硬币条件仍缺。 |
| **II.D-02** p.42—43 | 任意数量允许零，训练家／特性仍受无变化限制 | `selection.any`、`effects.activation-cost` | [SEL] `selectionBounds/canSelectCount`；[G] `activationEffectsUsable`、具体指令 | [T-selection] `public any number`；[T-energy] `any-number zero`；[T-effects] 零执行与 then | **已实现（限定范围）**：已接通选择操作的数量语义；任意分配等未实现操作仍缺。 |
| **II.D-03** p.43 | 全部指指定集合无遗漏 | `selection.all` | [SEL]；[G] `runEffect(discardHand/damage/cards)` | [T-selection] `public all`、`optional all does not mean any number`；[T-packets] `multi-target exact/up-to/all` | **部分**。数量通则已实现；全场所有道具等官方示例对象还不能全部执行。 |
| **II.D-04** p.43—44 | 精确数量不足尽量，各种类别分别选择，隐面例外 | `selection.exact`、`selection.hidden`、`selection.hand`、`selection.prizes`、`effects.stadium-discard` | [SEL]；[G]选择任务；[FIELD]；[COST]多费用组**不是**多对象效果 | [T-selection]数量；[T-cards]公开／手牌；[T-packets]多目标；[T-stadium]特殊能量＋场地的独立部分 | **部分**。单集合与特殊能量／场地跨类别synthetic路径已测，不要求两类同时存在；任意跨区多集合以及不看对手手牌的选取仍缺。 |
| **II.D-05** p.44 | 最多一般至少一，隐面限定选择有例外 | `selection.up-to`、`selection.hidden`、`selection.hand`、`selection.prizes` | [SEL]；[EM] `attachedEnergySelection`；[G] 具体选择 | [T-selection] `public up to is not international 0..N`、`any card deck up to needs at least one`；[T-game] `CN up-to discard attach`；[T-prize-exchange] E-34 限定奖赏零／一张 | **已实现（限定范围）**：公共集合、己方限定手牌／牌库数量及能量选择已测；本轮另补 E-34 明确零／一张自交换，不外推所有奖赏数量或交换指令。 |
| **II.D-06** p.44—45 | “拥有”指卡面；额外可用招式不成为卡面拥有 | `attack.owned`、`attack.grant`、`attack.owned-lock` | [COPY]；[GRANT]；[CS]；[G] `attacksFor`；[OWNED-LOCK] | [T-copy]排除道具；[T-grant]额外许可不改打印；[T-owned]独立oracle；[T-owned-identity]顶卡／下层／道具／授予及使用资格 | **已实现（限定范围）**：候选与实际可使用路线分离，现场选招也只看当前打印成员；真实卡对应、跨定义同名匹配仍须各自核验。 |
| **II.D-07** p.45 | 宝可梦／能量属性，场上可被效果改为多属性 | `pokemon.types`；能量仍独立 `energy.types/provision` | [G] `sourceModel/damageModel/modifierTargets`；[TYPES] 替换集合；[TRAITS] 与消除联合求值；[INPLAY] 场上筛选适配器 | [T-types-live] 胡帕V型双属性、弱抗、修正／保护／限制、能量、事件／恢复；[T-inplay-live] 返回／进化／授予／牌库附能；[T-types-copy] 场上复制 vs 弃牌／进化下层；[T-types-guards] 固定效果位置 | **已实现（限定范围）**。当前类型共用管线且不回写打印定义；场外和进化下层卡保留打印筛选。不同替换与未决消除环拒绝；任意条件、完整全局依赖或所有真实卡并未因此获支持。 |
| **II.D-08** p.46 | 所有属性能量十种、不含龙、不能任选一种规避弃置 | `energy.types`、`energy.units`、`energy.provision`、`energy.attached-selection` | [DMG] `ENERGY_TYPES`；[EM] `matchingEnergyUnits/attachedEnergySelection`；[G] `energyCards` | [T-energy] `D-08 all-attribute Energy is included in every matching discard-all filter`；[T-schema] 不凭空添加龙／无色基本能量 | **已实现（限定范围）**：单位属性集合、计数不重复、不是基本能量身份。 |
| **II.D-09** p.46—47 | 使用招式的有效能量要求，额外可用招式仍需满足 | `energy.payment`、`energy.requirement`、`attack.grant` | [G] `attackRequirements/attackLegal`；[EM] `resolveEnergyRequirements/meetsEnergyRequirement`；[GRANT] | [T-energy] `effective attack requirements aggregate`；[T-grant] `directly granted content uses its declared identity`；[T-foundation] 独立匹配 oracle | **已实现（限定范围）**：属性／数量同时满足、额外招式与复制有别；复杂附加费用另缺。 |
| **II.D-10** p.47 | 有效撤退要求与实际付款；也可被伤害公式引用 | `retreat.payment`、`energy.requirement` | [G] `retreatCost`；[EM] 费用运算；`energy.js::validateRetreatPayment` | [T-game] 撤退；[T-energy] 有效供给付款；[T-foundation] 付款 oracle | **部分**。撤退计算／支付已测；以对手有效撤退费计算招式伤害的直接集成回归尚缺，见 II.B-03。 |
| **II.D-11** p.47 | 数值增加叠加，并与减少合并 | `energy.requirement`、`pokemon.effective-hp`、`damage.attacker`、`damage.defender` | [G] `continuous/hp/retreatCost/attackRequirements`；[EM] `resolveEnergyRequirements` | [T-energy] `D-09..13 aggregate typed increases/decreases before clamping`；[T-foundation] 阶段内合计 | **已实现（限定范围）**：已有数值域的增加／减少；不是任意属性域的通用变换。 |
| **II.D-12** p.48 | 数值减少叠加，不逐步截断造成次序依赖 | `energy.requirement`、`damage.zero` | [EM] `resolveEnergyRequirements`；[G] `continuous/retreatCost`；[DMG] | [T-energy] typed increases/decreases 独立断言；[T-foundation] 合计后归零 | **已实现（限定范围）**：要求属性、合计、消除优先；特殊冲突仍须逐卡依据。 |
| **II.D-13** p.48—49 | 消除要求优先；特性／道具效果消除，不是弃置 | `energy.requirement.erase`、`effects.remove-content`、`damage.ignore-defender`、`pokemon.types` | [EM]；[SUP] `resolveSuppression`；[TRAITS] `resolveSourceTraits`；[G] `sourceModel/effectiveProperty` | [T-energy] 消除要求优先；[T-suppression] 真值 oracle／雪道型；[T-traits-oracle] 25,600图、102,400排列，独立完整布尔模型检查 | **部分**。类型与移除联合求值只接受可证明值，不把未知当false；独立域中无模型／多模型全部拒绝。仍有6,232个唯一模型被保守拒绝，不是完整固定点或官方环裁定，不能凭时间戳替代。 |
| **II.D-14** p.49—50 | 全满按无伤害指示物，不等于不受伤害 | `pokemon.effective-hp`；关联 `trigger.knockout` | [G] `hp` 与运行时 `counters` 可判断；没有专门全满条件／昏厥防止原语 | [T-battle] HP／伤害分离；[T-triggers] 昏厥锁定边界；**缺全满致死前状态与保留 10HP 测试** | **部分**。基础判定信息存在；怨恨符咒式受伤前全满快照、坚忍之爪式“不昏厥留 10HP”未实现，不能用 KO 时回复代替。 |
| **II.D-15** p.50 | 最大 HP 只修改场上有效值，不回写定义／场外 | `pokemon.effective-hp` | [G] `hp`、`playerView`；[S-card] `mechanics.hp`；[S-state] `counters` | [T-battle] 卡面不变、BigInt 精确合计、非法数值恢复拒绝；[T-suppression] 来源消除与 HP | **已实现（限定范围）**：有效最大 HP、来源消失引发 KO、打印值不可变，数值边界与恢复已回归。软件精确表示边界不是官方 HP 上限。 |
| **II.D-16** p.50 | 剩余 HP 是有效最大 HP 减伤害 | `pokemon.effective-hp` | [G] `hp`、`playerView`；[S-state] 不存第二个当前 HP | [T-battle] `printed HP is immutable`、`schema forbids mixing printed attributes` | **部分**。视图派生当前 HP 已测；按当前 HP 阈值筛场上目标尚缺通用 schema／直接回归，昏厥防止仍缺。 |
| **II.D-17** p.50—51 | 已获奖赏以规定起始数减当前数；六十／四十／三十张不同 | `prizes.effects-count`、`damage.expression` | [PRIZE] 当前查询；[H] `cn.prizeDamage@1`／`cn.damageValue@1`；[VALUE] 奖赏叶节点与动态包；[CAT] 对局仍仅60张 | [T-prize] 6/4/3纯查询；[T-prize-live] 17项；[T-value-live] 双方／C18／未决；[T-value-state] 留白伤害栏的选定备战奖赏乘40 | **部分（正常60数值／所选目标已集成）**。不按KO事件计数，不伪造打印栏；一般动态连续修正、40/30对局仍缺，抢分作用域／超基数负值继续needsRuling。 |
| **II.D-18** p.51—52 | 规则框不只多奖赏；连击等标记本身不是规则框 | `deck.construction`、`effects.remove-content`、`cards.prism-star`；关联`effects.search` | [S-card]身份／分组；[CARD]可执行检查；[CAT]限额；[CS]筛选；[DISCARD] | [T-schema]不按名称推断；[T-runtime]分组；[T-suppression]雪道型；[T-field-contract]Prism身份 | **部分**。布尔身份、不同奖赏数、光辉式限额及Prism特别去向已表达／执行；真实卡审核、V-UNION等其余规则框机制仍未落地。 |
| **II.D-19** p.52—53 | 继承状态／附着／伤害／效果／同名特性已用信息 | `effects.inherit`、`ability.usage` | [EV] `transitionTargets/transitionCards`；[G] `runEffect(inheritPokemon)` | [T-evolution] `D-19 inherited replacement retains the complete battle identity`、`a different Ability remains usable`、`same-name inherited replacement` | **已实现（限定范围）**：已审核手牌／弃牌替换关系、保留实际 battle identity 与按特性 key 的已用记录；特殊变形／特殊叠放另需实现。 |

### II.E：其他说明文（01—39）

| 条款／PDF 页 | 核验主题 | ruleIds | 实现文件／函数 | 测试证据 | 状态与确切边界 |
| --- | --- | --- | --- | --- | --- |
| **II.E-01** p.53 | 下个对手回合，仅相应回合、不含检查 | `effects.duration.turn-only` | [ONG] `clock/ongoingIsActive/expireOngoing`；[G] `expireAt` | [T-ongoing] `CN E-01/02 vs E-21/22`、`next-opponent-turn damage prevention` | **已实现（限定范围）**：当前已支持持续载荷的边界。 |
| **II.E-02** p.53 | 下个自己回合，不立即生效、不含检查 | `effects.duration.turn-only` | [ONG]；[G] `expireAt` | [T-ongoing] `next-own-turn bonus`；[T-battle] 下回合招式锁 | **已实现（限定范围）**：绑定目标、自己回合次数及清除策略。 |
| **II.E-03** p.53—54 | 至少 10 点伤害；招式效果后、昏厥前反应，持有者排序 | `trigger.damage` | [G] `makeTriggerEvent/collectTriggers/triggerWork`、`runTask(finish-attack/trigger-window)`；[TR] `triggerMatches` | [T-triggers] `E-03 reactions follow the attack effects`、`damage prevented, zero printed damage and pure counters`；[T-packets] `delayed attack reaction retains original source` | **部分**。普通本地／同持有者反应及延后反击已测；完整受伤前 LKI、源离场后的附着 epoch、跨双方全局反应和粗硬头盔型完整组合待补。 |
| **II.E-04** p.54—55 | 昏厥时效果先全部执行，再弃置全部昏厥宝可梦 | `trigger.knockout`、`ko.boundary` | [G] `runTask(ko/ko-discard)`、`collectTriggers`；[TR] 排序约束 | [T-triggers] `E-04 simultaneous own KOs`、`a damage-time heal may avert KO`；[T-energy] 转附候选及批次 | **部分**。普通锁定批次和反应连锁已测；完整学习装置真实场景、昏厥替代／保护、跨持有者全局依赖仍缺。 |
| **II.E-05** p.55 | 从手牌进化的立即触发，神奇糖果也算 | `trigger.evolve`、`effects.evolve` | [G] `evolveMon`、`triggerWork`；[TR] `triggerMatches(origin)` | [T-triggers] `E-05/06 optional from-hand`；[T-evolution] `from-hand evolution reactions recognize effect evolution from hand` | **已实现（限定范围）**：真实手牌来源及不能延后补用，牌库／继承不冒充。 |
| **II.E-06** p.55—56 | 从手牌放备战的立即触发，准备阶段不算 | `trigger.bench` | [G] `dispatch(bench)`、`runEffect(cards)`；[TR] 来源过滤 | [T-triggers] `E-05/06`；[T-cards] 部署真实来源；[T-acquisition] `turn-start incoming Evolution card` | **已实现（限定范围）**：手牌、牌库、弃牌、加入前及准备来源不混淆。 |
| **II.E-07** p.56—57 | 从手牌附着、按物理张数、立即窗口与持有者排序 | `trigger.energy`、`effects.attach` | [G] `commitActivation(energy)`、`runEffect(attachHand)`、`triggerWork`；[TR] | [T-triggers] `E-07 one multi-unit Energy card triggers once`、`an attached Special Energy can distinguish this card`；[T-cost] 付款收据 | **已实现（限定范围）**：已接通附着路径的物理卡事件；跨双方全局排序仍受共同缺口限制。 |
| **II.E-08** p.57 | 检查效果由受影响宝可梦持有者排序 | `trigger.checkup`、`checkup.order` | [G] `runTask(checkup-plan/trigger-window)`；[TR] `assertOwnerIndependence/assertSubjectProgram` | [T-triggers] `two holders independently place local Stadium effects`、`unresolved cross-holder global interactions fail atomically` | **部分**。局部双方效果可独立排序；全局相互依赖被拒绝，仍需要 CN 排序依据和实现。 |
| **II.E-09** p.57—58 | 伤害前先支付／移动等，结果参与随后伤害 | `attack.order` | [G] `beginAttackContent`、`effectTasks(beforeDamage)`、`runTask(after-attack)` | [T-game] `before-damage switching`；[T-return] `returning declaration Energy during the before-damage phase`；[T-copy] `copied before-damage steps` | **部分**。现有伤害前指令已接通；丢任意道具后按张数加伤、场上宝可梦先离场和与自身失败结合的时序仍缺完整实现。 |
| **II.E-10** p.58 | 若希望可不执行整段；执行后才成立后续依赖 | `selection.optional`、`effects.partial` | [FX] 控制帧；[G] `runEffect(optional)` | [T-effects] `optional is a whole-effect decision`、`empty/zero instructions do not unlock then` | **已实现（限定范围）**：整段可选，不暗改精确数量；实际选择结果供数值公式引用仍需对应机制。 |
| **II.E-11** p.58—59 | 上个实际对手回合的己方 KO 事实／原因；多只只成立一次 | `history.previous-opponent-ko`、`history.knockout-cause`、`history.checkup-not-a-turn` | [HIST] 严格账本、`hadKnockoutInPreviousOpponentTurn`；[G] 锁定 KO 原因／收据、提交历史、恢复核验 | [T-history] 回合序列独立穷举；[T-history-live] 伤害／效果／检查、多个 KO、触发回复后原原因；[T-history-card] 真实行动→条件加伤 | **已实现（限定范围）**：任意 KO／招式伤害与实际攻击方筛选、检查排除、一次布尔条件和恢复已接通。真实示例卡及其其他筛选／条件仍须逐卡审核，不宣称全部卡已迁入。 |
| **II.E-12** p.59 | 每只每回合次数；离场重入成为新宝可梦 | `ability.usage`、`ability.reentry` | [G] `usageAllowed/recordUsage/newMon`、`runEffect(returnPokemon)` | [T-game] `Ability usage is explicit`；[T-return] `E-12 new entry gets a fresh Pokémon identity`、`return/re-entry cannot revive another undeclared native trigger` | **已实现（限定范围）**：次数、个人与玩家账本分开，离场重入重置个人记录。 |
| **II.E-13** p.59—60 | 只在场上／指定位置生效，源消失动态失效 | 关联 `effects.remove-content`、各持续效果 ruleId；**无独立在场条件 ruleId** | [G] `sourceModel`、`modifierTargets`、`continuousEntries`、`enforceEnergyRetention` | [T-suppression] `removal follows stage and live Active source`；[T-return] `returning an HP-granting continuous source`；[T-triggers] HP 源离场 | **已实现（限定范围）**：已支持持续载荷的源存在性／位置；变属性等未支持载荷不能因此视为已覆盖。 |
| **II.E-14** p.60—61 | 同名特性玩家共享一次，源离场不返还 | `ability.usage`、`ability.reentry` | [G] `usageAllowed/recordUsage` 的 `scope:player`；[S-card] `usage.key` | [T-game] `Ability usage is explicit`；[T-triggers] `triggered shared usage is consumed only on acceptance`；[T-return] `E-12 new entry` | **已实现（限定范围）**：审核规范化共享 key，不依赖显示名猜测；真实同名归一化须逐卡审查。 |
| **II.E-15** p.61 | 相同明确不叠加效果只算一次 | 关联 `damage.attacker`、`pokemon.effective-hp`、`energy.provision`；**无该条独立 ruleId** | [G] `continuous/attackRequirements` 的 group；[EM] `resolveEnergyProvision` | [T-effects] `nonstacking groups deduplicate identical modifiers`；[T-energy] `nonstacking requirement groups`、`E-39 Basic Energy replacement` | **部分**。相同语义去重已测；同组不同量不擅自选，而是报冲突，仍缺可被 CN 裁定决定的复杂组合。 |
| **II.E-16** p.61 | 新中毒覆盖旧数量，恢复方式相同 | `status.poison` | [COND] `applyCondition/checkConditions`；[G] `runEffect(condition)` | [T-runtime] `rotation conditions overwrite each other, not poison/burn`；[T-effects] 保护不清毒 | **已实现（限定范围）**：中毒强度属于运行时状态，新毒覆盖而非相加。 |
| **II.E-17** p.61—62 | 场外指定区域主动特性，离开再回该区域重置 | `ability.usage` 目前把 E-17 列为来源，**不是已执行证明** | [G] `actions` 只枚举 `mons(p)` 的主动特性；无场外特性身份／区域 epoch／宣告路径 | **缺场外主动特性直接测试**；[T-acquisition] 加入前触发是另一机制 | **缺失**。手牌拳海参、弃牌帝王拿波、区域重入次数都未实现；需在卡牌实例而非虚构场上 Mon 上建账。 |
| **II.E-18** p.62 | 查看检索后即使未找到也重洗 | `effects.search`、`effects.shuffle` | [G] `runEffect(cards)`、`shuffleZone`；[S-fx] 明确 `shuffleAfter` | [T-cards] `full-deck search permits fail-to-find`、`search with no eligible cards still offers private inspection`；[T-evolution] `deck evolution can fail to find` | **已实现（限定范围）**：已有完整牌库检索和效果进化；未看的满备战不伪造检索／重洗。 |
| **II.E-19** p.62—63 | 然后取决于前文至少部分执行，不要求全部执行 | `effects.partial`、`effects.hand-bottom`、`effects.heal-results`、`effects.execution` | [FX] `completeEffectStep/expandEffectStep`；[EXEC]顺序重放／[S-execution]；[G] `runEffect(shuffleHandToBottom/healPokemon)`／`finishEffect`；[HBOTTOM] `planHandBottom`；[HEAL] `planPokemonHealing`；[H]对应handler | [T-effects]、[T-execution]独立递归／帧oracle；[T-hand-bottom]、[T-hand-bottom-live] FAQ2；[T-healing]、[T-healing-live] FAQ3；[T-healing-state]旧事实排除；[T-healing-contract]弃能权限；[T-healing-program] then嫁接／重播拒绝；[T-healing-execution-live]嵌套暂停恢复 | **已实现（限定路径；Stage22检查点）**：FAQ2非空／费用后资格；FAQ3只关联本次实际回复者，无能量不否定已发生回复。声明含healPokemon的程序增加唯一身份、精确动作／控制帧及advance顺序恢复，不能改then后段或借其他调用重播。不是任意结果集AST、所有handler恢复完备或整条官方条款全部完成声明。 |
| **II.E-20** p.64 | 回合结束早于检查、持有者排序；效果可导致立即结束回合 | `turn.end`、`trigger.turn-end` | [G] `runTask(end-turn)`、`collectTriggers`；[TR] | [T-triggers] `end-turn effects precede checkup`；[T-ongoing] 四种边界 | **部分**。正常结束／招式后结束及触发排序已接通；“使用此特性则回合结束”、延后直接昏厥等例子无相应完整指令，跨双方全局依赖仍拒绝。 |
| **II.E-21** p.64—65 | 直到下个自己回合结束前，涵盖检查；消除特性的伤害／反应时点 | `effects.duration.until-end`、`effects.remove-content` | [ONG]；[G] `sourceModel`、`expireAt` | [T-ongoing] `until-next-own-turn-end HP lasts`；[T-suppression] `removed native damage/KO/Tool reactions do not activate`、`timed removal` | **已实现（限定范围）**：既有持续载荷、伤害先于随后消除、反应重新检查可用性。 |
| **II.E-22** p.65 | 直到下个对手回合结束前，当前起持续、涵盖中间检查 | `effects.duration.until-end` | [ONG] `clock/ongoingIsActive/expireOngoing`；[G] 边界调度 | [T-ongoing] `CN E-01/02 vs E-21/22`；[T-triggers] 从手牌备战时保护 | **已实现（限定范围）**：双方持有者时钟及保存恢复，不拓展到尚缺载荷。 |
| **II.E-23** p.65—66 | 实际本回合从谁进化；复制仍检查实际使用者；回备战不清 | `evolution.history`、`attack.copy` | [G] `evolveMon`、`switchTo`；[S-state] `facts.evolution`；审核公式 hook | [T-evolution] `a reviewed any-Stage-1 exception records the actual evolved-from card`、`ordinary evolution records`；[T-copy] `copied formula and E-23 conditions` | **已实现（限定范围）**：保存真实 from/to/origin/method，不从卡面通常前身推断。 |
| **II.E-24** p.66—67 | 本回合实际备战移入战斗场，多次不倍增 | `history.bench-to-active-this-turn` | [G] `switchTo`／`promote` 记真实行动；[HIST] `wasMovedFromBenchToActiveThisTurn` | [T-history-live] 撤退／补位／往返和恢复；[T-history-card] 实际撤退后条件招式加伤 | **已实现（限定范围）**：原使用者身份和实际发生回合的布尔条件，不从手工 cache 推断，不把检查补位算入回合。复制／特殊变形的其他卡牌要求仍需逐卡审查。 |
| **II.E-25** p.67 | 本回合实际从手牌使出支援者，不等于使用额度标记 | `history.supporter-from-hand-this-turn`、`turn.supporter` | [G] `commitActivation` 写独立事件；[HIST] `wasSupporterPlayedFromHandThisTurn` | [T-history-live] 生效前入账、旗标／弃牌诱饵不能造事实、恢复；[T-history-card] 条件伤害；[T-cost] 付费成功后才使用 | **部分（基础条件已接通）**。正常手牌行动与额度已分开；额外支援者许可、其他来源使出机制仍未实现，不将字段存在等同于完整支持。 |
| **II.E-26** p.67 | 实际回复至少 10HP；多次仅成立一次、回备战保留 | `history.healed-this-turn`、`effects.heal` | [G] 记录实际移除指示物×10；[HIST] `wasHealedThisTurn` | [T-history] 零／多次条件；[T-history-live] 封顶回复、备战限定、往返／恢复；[T-history-card] 实际回复后条件伤害 | **已实现（限定范围）**：实际量、原主体和同回合布尔条件；不从请求量或旧 cache 推断。真实复制／变形示例仍须结合各卡审核。 |
| **II.E-27** p.67—68 | 招式明确许可突破某基础限制，不等于解除其他禁止 | `attack.first-turn`、`effects.prohibition` | [G] `permissions/attackLegal`；[H] `cn.attackPermissions@1` | [T-game] `first player cannot attack`；[T-battle] `live Pokémon restrictions and attack permissions are separate`；[T-grant] `a granted move keeps its own first-turn permission` | **已实现（限定范围）**：首回合及 schema 已列睡眠／麻痹许可，仍不能越过明确招式锁；其他具体许可逐卡扩展。 |
| **II.E-28** p.68 | 多个有效灼伤量替换取最大，不相加 | `status.burn` | [CHK] `resolveBurnCounters`；[H] `cn.burnCounters@1`；[G] `checkup-statuses` 过滤来源后传入数量；[S-fx] 连续载荷 | [T-checkup] 独立最大值 oracle／严格参数／零一默认；[T-checkup-live] 14 项实战场景：多源、消除、离场、范围、时限、恢复、双方致死 | **已实现（限定范围）**：正常来源管线与固定持续目标已接通；明确零／一仍恢复抛币，默认二只用于无替换。更复杂卡牌条件仍须逐卡审核，不宣称所有全局依赖已解决。 |
| **II.E-29** p.68—69 | 从手牌使出指定训练家时不受效果，但不禁止其使用 | `effects.protection`、`effects.trainer-hand-use`、`effects.activation-change`、`effects.stadium-discard`；玩家锁另分 | [G] `protectionEntries/stadiumProtections`、原生资格投影；[FIELD]；[S-fx]必填`useRule`；[NCHANGE] | [T-use-rule-contract]分类／审批／timed拒绝；[T-use-rule-live]重叠；[T-nochange-heal]、[T-nochange-counters]、[T-nochange-switch]；[T-stadium]卡本体self、来源及then | **部分**。第二十六轮将连续主体扩至实际场地卡，明确许可使用而不伪造performed；CN.E29只接受hand／item-supporter／effects明示分类，普通替换不受其阻止。timed许可、未审混合与任意整卡资格仍未解决，未宣称全部E29支持。 |
| **II.E-30** p.69—70 | 手牌弃置是完整使用条件；后续也须符合使用规则 | `effects.activation-cost`、`effects.activation-change`、`ability.usage` | [COST] `findCostPayment/findCostPaymentWitness/readCostPayment`；[G] `projectedPayment/nativeActivationBody/nativePaymentQualifies` | [T-cost]费用匹配／原子；[T-cost-witness]30,976配置；[T-cost-dependency]实际付款后保护／属性；[T-nochange-projection]替代付款、正常使出、能量保留及次数；[NCHANGE] | **已实现（限定范围）**：完整手牌费用及指定原生叶的真实后续资格；搜索组分配与组内顺序，不以首匹配失败推全部失败，预算耗尽不伪称非法。其余费用区域、触发／物理附着和其他复杂依赖仍未由此证明。 |
| **II.E-31** p.70—71 | 抽牌／拿奖赏加入手牌前逐张处理，不算从手牌使出 | `trigger.before-hand`；交互 `effects.prize-exchange` | [ACQ] `acquisitionMatches`；[G] `entryWork/acquisitionUnits`、`runTask(draw-cards/entry-window/entry-use/entry-finish)`、`runEffect(exchangePrizes)` | [T-acquisition] 逐张／嵌套／最后奖赏延迟判胜／恢复；[T-prize-exchange-live] `E31 Prize-before-hand interaction`；[T-prize-exchange-state] 已存在的 entry 来源自交换不被收尾取回 | **已实现（限定范围）＋未决交互**：本轮若实际选中奖赏具有匹配的 beforeHand descriptor，保留 **needsRuling**，以 `unresolved-prize-before-hand` 原子拒绝本次选择，不移动牌／消耗 RNG，绝非 unknown→skip。未选中受影响牌或仅匹配 draw 的 descriptor 不阻断普通交换；不是完整场外主动特性或任意获牌触发。 |
| **II.E-32** p.71—72 | 满足条件可用字面替代费用，不再叠加普通增减 | `energy.requirement.alternative` | [EM] `resolveEnergyRequirements/meetsEnergyRequirement`；[G] `attackRequirements`；[H] `cn.energyOptions@1` | [T-energy] `E-32 conditional literal cost is independent`；[T-copy] `effective selected-cost options use actual-user conditions` | **已实现（限定范围）**：合法替代路线与普通路线分开，使用实际使用者条件；不豁免明确行为禁止。 |
| **II.E-33** p.72—73 | 己方手牌限定选择可少选／零；明确失败条件另行执行 | `selection.hand`、`attack.failure.hand-payment`、`attack.used` | [SEL]；[G] `runEffect(cards/attachHand)`／`ownAttackCheck`／`attack-payment`；`attack-commitments.schema.json` | [T-selection] 普通限定手牌；[T-cost] 费用不可套例外；`attack-commitments.test.mjs`／`attack-commitments-integration.test.mjs` 独立支付、0/1/2/3资源、主动失败、实际使用者及恢复 | **已实现（限定范围）**。FAQ3 完整弃置或零张失败独立于宣告费用；资源不足仍可宣告、资源足够仍可选零，不得部分弃置，招式已使用且无正文。其他失败条件不因该付款模型自动获支持。 |
| **II.E-34** p.73 | 己方反面奖赏限定选择可少选／零，交换后反面重洗 | `selection.prizes`、`effects.prize-exchange`、`effects.shuffle` | [PEX] `prizeExchangeWindow/planPrizeExchange/assertPrizeExchangePlan`；[S-prize-exchange]；[H] `cn.prizeExchange@1`；[G] `assertPrizeChoice/prizeCompletion`、`runEffect(exchangePrizes)` | [T-prize-exchange] 独立选择／位置守恒 oracle；[T-prize-exchange-live] 洗翠沉重球形／格拉吉欧形、零选、真实 RNG、私密投影、原子拒绝及恢复；[T-prize-exchange-state] 唯一来源收尾 | **已实现（限定范围）**：查看己方全部反面奖赏，与正在 resolving 的本身物品／支援者作零／一张交换；限定条件可零选，任意卡有牌须选一。零选仍重洗原奖赏并正常弃来源；成功交换保持奖赏张数，不当作拿奖赏／KO 获牌。E-31 匹配交互仍 needsRuling，其他数量／来源和真实整卡审批不在此范围。 |
| **II.E-35** p.73—74 | 隐面重洗，空集合不算；之后可放底或奖赏 | `effects.shuffle`、`effects.return`、`effects.hand-bottom`、`effects.prize-exchange` | [G] `shuffleZone`、`runEffect(shuffle/inspectDeck/shuffleHandToBottom/exchangePrizes)`；[HBOTTOM]、[PEX]；[S-hand-bottom]、[S-prize-exchange]；[H] 对应原生 handler | [T-cards] 已列区域；`deck-inspection-runtime.test.mjs`；[T-hand-bottom]／[T-hand-bottom-live] 整手牌独立置底、旧 deck 不变、空／单张、then／费用／恢复；[T-prize-exchange-live] 交换后全奖赏重洗及无顺序泄漏 | **已实现（限定范围）**：查看余牌子集、指定一方／双方各自整手牌、交换后的整个奖赏池均有实际路径；不洗原 deck，不把双方手牌合并，零选奖赏仍洗，空集合不算、单张算。新顺序不向任何玩家记录；通用任意子集／授权知识与所有卡文组合并未完成。 |
| **II.E-36** p.74 | 返回牌库再重洗，一张也算；空手牌但非空牌库仍可洗 | `effects.return`、`effects.shuffle` | [G] `runEffect(cards)`、`shuffleZone` | [T-cards] `E-36 empty-hand return still shuffles a nonempty deck`；[T-return] 返回叠层及能量到牌库 | **已实现（限定范围）**：已有返回牌库并重洗路径的 performed 语义；查看顶七选一剩余原样／指定顺序等另见 C-20。 |
| **II.E-37** p.74—75 | 按区域内卡面招式筛选，不含额外获准使用招式 | `attack.owned`、`effects.search`、`attack.grant` | [CS] `matchesCardSelector(attackIds)`；[COPY]；[GRANT] 与 [G] `attacksFor` 分层 | [T-cards] `out-of-play selectors use reviewed printed fields`；[T-copy] `printed attack selection excludes granted Tool attacks`；[T-grant] `direct-use permission never changes` | **已实现（限定范围）**：审核 ID 的印刷身份与可用招式分离；区域计数公式和真实同名招式归一化须逐卡补审。 |
| **II.E-38** p.75—76 | 卡文另行宣告本场胜／负，不是施加于玩家的效果 | **无该条专门 ruleId**；`win.simultaneous` 不是替代品 | [G] `SUPPORTED_EFFECTS` 无特殊胜负指令；`finish/afterKO` 仅普通结果、认输等 | 官方正文已核读：未知图腾V招式在剩一奖赏时胜利；未知图腾战斗场特性在手牌至少35张时胜利；呆壳兽三币全反面败北。**仍缺这些特殊结果、保护交互及恢复测试** | **缺失／时序未决**。具体条件、普通I.E以外的结果及非玩家效果性质有依据；立即终止还是继续处理、与普通判胜先后及冲突优先级未由该正文明确，不能自行推定。须独立结果语义／来源与依据，不以 `playerRestriction`、直接调用 `finish` 或读取条件冒充实现。 |
| **II.E-39** p.76 | 基本能量按卡名身份；数量替换不改张数；旧措辞同义 | `energy.provision`、`energy.types`、`effects.attach` | [CS] `matchesCardSelector`；[EM] `resolveEnergyProvision`；[G] `energyCards`；[S-card] 基本身份 | [T-energy] `E-39 Basic Energy replacement is live`、`D-08 all-attribute Energy`；[T-cards] 基本卡名筛选 | **部分**。基本身份／替换供给与有效可用性已测；故勒顿型任意分配并结束回合的整卡流程仍缺，不能以供给测试代替。 |

## 4. 赛场规则：完整主要章节与宿主责任

赛场规则并非另一个伤害公式。以下功能需要宿主／赛事系统／裁判权限；
对局内核只能提供其中部分事实和受控接口。当前没有完整赛事宿主实现，
所以保留为**待交付责任**，而非从用户目标中删除。

| 章节／PDF 页 | 要求索引（概述） | ruleIds／当前实现与测试 | 状态与交付缺口 |
| --- | --- | --- | --- |
| **序章** p.1 | 官方活动共同规范及规则优先层级 | [R] 登记文档版本；[T-foundation] 地区版本固定／来源检查 | **赛事宿主责任（未交付）**。活动规则与会员协议、特定赛事附加规则的适用层级／固定版本需要宿主声明，不能只用 CN 内核版本替代。 |
| **1.1** p.2 | 参与资格、尊重、场馆行为与工作人员指示 | 无专门 ruleId、宿主模块或直接测试 | **赛事宿主责任（未交付）**：资格／入场、行为准则、处置记录及授权人员。 |
| **1.2** p.2 | 禁止赌博、贿赂、危险物及未经许可经营等 | 无专门 ruleId、宿主模块或直接测试 | **赛事宿主责任（未交付）**：举报、审核、执行与审计；不得由卡牌 handler 自行判罚。 |
| **2.1** p.3 | 选手操作时限、结果确认、会员、合法卡组、对战用品 | 关联 `deck.construction`、`deck.language`；[CAT] `validateDeck`；[FMT] `validateFormatDeck`；[T-runtime]、[T-formats] | **部分内核＋赛事宿主责任（未交付）**：已检查数字卡组；会员／身份／活动资格、结果排名、用品及时间责任尚缺。 |
| **2.2** p.3 | 配对确认、明确宣告、隐面信息、沟通与申诉 | [G] `reduceGame`、`playerView`、revision／原子命令；[T-game] `setup projections`、`illegal/stale/foreign commands` | **部分内核＋赛事宿主责任（未交付）**：私有投影不是在线鉴权；配对、消息确认、裁判呼叫／二次评估、最终裁判权与公开信息 UI 未完成。 |
| **2.3** p.4 | 禁止外部当前对战信息及不必要设备、预先笔记 | 无赛事访问策略／直接测试 | **赛事宿主责任（未交付）**：线上可执行部分需防观战／分析泄漏和外部信息政策，实体设备限制由赛事组织执行。 |
| **3／3.1** p.4 | 观赛者不得影响对局，观赛区域与关联人员责任 | [G] 只允许玩家 0／1 投影；无观战角色／服务测试 | **赛事宿主责任（未交付）**：脱敏／延时观战、角色隔离、观赛管理和处罚关联；不能把缺观战 API 当作赛事观战已合规。 |
| **4** p.4—5 | 裁判中立、介入、主裁判与主办方最终决定 | 无裁判服务、权限命令或测试 | **赛事宿主责任（未交付）**：裁判身份、权限、申诉／最终裁定和不可篡改审计。 |
| **5.1** p.5 | 对战与对局：单局／多局／团队及抢分结果归属 | 关联 `win.tiebreak`；[G] 仅一场游戏；[T-game] 一奖赏模式 | **赛事宿主责任（未交付）**：Match 聚合、局分、平局、重新开局及抢分关联。 |
| **5.2** p.5 | 轮与开始时间 | 无模块／测试 | **赛事宿主责任（未交付）**：轮状态、统一开始、参赛名单与时间。 |
| **5.3** p.5 | 卡组禁用／选择、队员选择等额外阶段 | 无模块／测试 | **赛事宿主责任（未交付）**：阶段状态与信息披露；不得误用宝可梦检查 phase。 |
| **5.4** p.5 | 预赛／正赛／突破赛等赛事环节 | 无模块／测试 | **赛事宿主责任（未交付）**：赛程层级与晋级。 |
| **5.5** p.5—6 | 按年龄等区分组别 | 无模块／测试 | **赛事宿主责任（未交付）**：组别、资格验证及隐私控制。 |
| **5.6** p.6 | 迟到 | 无模块／测试 | **赛事宿主责任（未交付）**：签到与开始时点、授权处置。 |
| **5.7** p.6 | 缺席及重复缺席可能导致弃赛／取消资格 | 无模块／测试 | **赛事宿主责任（未交付）**：特定赛事阈值，不能凭此通则写死分钟数。 |
| **5.8** p.6 | 瑞士轮、按成绩近似配对与随机轮空 | 无模块／测试 | **赛事宿主责任（未交付）**：配对、跨分组、排名及轮空记录。 |
| **5.9** p.6 | 排位赛实时匹配、分数、次数／最低人数 | 无模块／测试 | **赛事宿主责任（未交付）**：活动配置、匹配、计分与并发一致性。 |
| **5.10** p.7 | 团队与按队配对 | 无模块／测试 | **赛事宿主责任（未交付）**：队员／队伍、局分聚合及各赛事组队要求。 |
| **5.11** p.7 | 单败淘汰与非二次幂轮空 | 无模块／测试 | **赛事宿主责任（未交付）**：种子、淘汰树、晋级／轮空。 |
| **5.12** p.7 | 双败淘汰、胜败者组及决赛 | 无模块／测试 | **赛事宿主责任（未交付）**：败场次数、分组晋级与赛事特定决赛规则。 |
| **5.13** p.7 | 循环战及小组内对局 | 无模块／测试 | **赛事宿主责任（未交付）**：组内全配对、结果聚合。 |
| **5.14** p.7 | 随机轮空算胜，通常低胜场且不重复 | 无模块／测试 | **赛事宿主责任（未交付）**：候选范围、历史和获胜记录，不制造虚构单场游戏。 |
| **5.15** p.8 | 首轮轮空资格 | 无模块／测试 | **赛事宿主责任（未交付）**：第二轮入场及一胜初始成绩。 |
| **5.16** p.8 | 首两轮轮空资格 | 无模块／测试 | **赛事宿主责任（未交付）**：第三轮入场及两胜初始成绩。 |
| **6.1** p.8 | 指定赛事的赛制卡池 | `deck.format.standard/open`；[FMT]、[FMT-CN]；[T-formats] 固定版本／名单／禁卡／恢复 | **部分**。固定标准／开放准入已实现；活动选择／发布、真实印刷批准目录、商品发行审核与全部获准卡牌机制仍缺。 |
| **6.2** p.8 | 简中赛事限简体中文卡牌 | `deck.language`；[CARD] `assertPrintingBinding`；[T-schema] `cross-region rules and Pocket/non-simplified` | **已实现（限定范围）＋赛事宿主责任**：数字印刷准入已测；实体真伪、可用印刷核验仍须裁判／官方数据，不是 language 字段自行证明。 |
| **6.3** p.8—9 | 卡组清单字段及可以合并记录的条件 | 关联 `deck.language`、`deck.construction`；[S-card] 与 printing 已有部分身份字段 | **赛事宿主责任（未交付）**：清单导入／导出、种类／商品号／卡号／名称／张数和相同内容合并规则测试缺失；目录不等于参赛提交清单。 |
| **6.4** p.9 | 任意赛事时点检查卡组与清单、非法／记号卡 | 无 deck-check／审计模块；[CAT] 只校验数字定义与印刷 | **赛事宿主责任（未交付）**：检查流程、名单对账、期间状态与裁判决定，不能用恢复时守恒检查替代。 |
| **6.5** p.9 | 记号／修改／伪造卡不可用 | [REL] 独立内容批准防数据自批；[T-release] `verified metadata never substitutes` | **部分软件门禁＋赛事宿主责任（未交付）**：不提供实体鉴真。真实卡图／勘误／印刷证据、人工拒绝及审计尚未形成生产数据。 |
| **6.6** p.10 | 裁判批准替代卡、原卡保留、使用期限与告知 | 无替代印刷授权、批准书／期限／对手告知模型及测试 | **赛事宿主责任（未交付）**：替代物不得通过伪造普通 `verified` 印刷绕过；需与官方卡牌内容身份分离。 |
| **7** p.10—11 | 卡套一致、不标记、不反光、层数、轮间检查及更换 | 无宿主检查记录或测试 | **赛事宿主责任（未交付）**：实体检查与主办方附加要求；线上展示卡背统一不等于本章验收。 |
| **8／8.1** p.11—12 | 随机化、选手／对手洗切顺序及禁止再洗 | `effects.shuffle`；`random.js::shuffleIds`；[T-runtime] `private local RNG` | **部分内核＋赛事宿主责任（未交付）**：本地可重放 RNG 不是多人公平随机／不可预测服务；洗切确认、权限、服务器私有种子与审计未交付。 |
| **8.2** p.12 | 裁判洗牌后不得再洗切 | 无裁判洗牌接口／权限／测试 | **赛事宿主责任（未交付）**：授权、替换私有随机状态的审计与重放一致性。 |
| **8.3** p.12 | 实体洗牌方法及随机性区别 | [R] 已登记全文；无实体管理模块 | **赛事宿主责任（未交付）**：说明与裁判审核；数字随机算法不需要仿造实体动作，但须单独证明其公平性，不将分堆次数当随机证明。 |
| **8.4** p.13—14 | 准备／首次查看／后续／连续检索洗牌规范，参考值非机械判罚 | [G] 检索后立即 `shuffleZone`；[T-cards] 重洗时机 | **部分内核＋赛事宿主责任（未交付）**：实体延后洗牌沟通与裁判处理缺失；当前不优化合并洗牌，不能未经依据省略。 |
| **9** p.14—15 | 笔记空白开始、同对局沿用、不能跨轮／共享、裁判可读 | 无 Match 笔记、访问控制与测试 | **赛事宿主责任（未交付）**：实体仅纸笔要求不能被网站电子笔记宣称满足；线上比赛需明确授权差异、隐私与审计。 |
| **10** p.15 | 各类操作合理用时参考、反拖延，非每步可耗满配额 | 无时钟、暂停／补时、超时裁定与测试 | **赛事宿主责任（未交付）**：不得把参考 10／15 秒等直接变成自动判负；赛事配置和裁判依据需要独立模型。 |
| **11.1** p.15—16 | 无基础立即告知，展示等对方放完奖赏 | `setup.mulligan`、`setup.prizes`；[G] `runTask(deal/prepare/retry/place-prizes)`；[T-game] 准备时序 | **已实现（限定数字流程）＋宿主 UI 未交付**：数字顺序已测；真实告知／展示确认及违规判罚没有宿主交付。 |
| **11.2** p.16 | 记录净重抽数、先决定补牌总数、补牌后不能更改已放场上卡 | `setup.mulligan`、`setup.prizes`；[G] `runTask(bonus/setup-bench)`；[T-game] `game setup honors`、`mutual mulligans` | **已实现（限定数字流程）**：一次选数量、不能边看边补、不可替换已选战斗宝可梦；网站准备交互仍待接入。 |
| **11.3** p.16—17 | 九次以上仍无基础时由主裁判决定强制流程；补牌上限为净重抽 X 加 `ceil(Y/7)` | **无专门 ruleId／强制流程**；普通 `setup.mulligan` 不替代 | **赛事宿主责任及内核接口（未交付）**：权限、确认卡数／有基础、翻到首基础 Y、抽其余六张、补牌上限、补时及恢复测试均缺；不能第九次自动偷偷改发牌。 |
| **12** p.17 | 按赛事决定结果、双方签字确认、更正／异常裁决 | [G] `result` 只是一场内核结果；无签署／更正模块 | **赛事宿主责任（未交付）**：不可变已签结果、授权更正、理由／证据与 Match 聚合；不得允许普通玩家改写快照实现。 |
| **13①** p.17 | 结束前可认输或双方合意平手，禁止附代价 | `win.concede`；[G] `dispatch/finish`；[T-game] `short deck draws, deckout, concede` | **部分**。单方认输已实现；合意平手提案／确认／撤回／并发、对局级结果、贿赂举报与审计未实现。 |
| **13②** p.17—18 | 中途弃赛相对于配对／已结算结果的不同处理 | 无赛事退出／后续配对模块或测试 | **赛事宿主责任（未交付）**：弃赛≠取消资格，保留排名，当前轮判负边界必须准确。 |
| **14** p.18 | 禁止操弄结果、缺席擅填胜利与后续处罚 | 无防结果篡改／举报／处罚模块 | **赛事宿主责任（未交付）**：鉴权、双方结果一致、裁判复核及证据；内核原子命令不能证明这一层。 |
| **15 总则** p.18—19 | 仅裁判／主办方依权限和情节处罚，可升级 | 无判罚权限／命令／日志测试 | **赛事宿主责任（未交付）**：处罚与游戏动作分离；禁止卡牌效果伪造赛事判罚。 |
| **15①** p.19 | 告诫 | 无模块／测试 | **赛事宿主责任（未交付）**：记录、通知、复犯关联与授权。 |
| **15②** p.19 | 警告及可恢复场面 | 无裁判修复／警告模块或测试 | **赛事宿主责任（未交付）**：受控修复、隐面信息泄漏评估和历史审计，不能开放任意客户端 restore。 |
| **15③** p.20 | 奖赏卡处罚／复数处罚改变胜利阈值，并非拿走奖赏 | 普通 `afterKO` 只检查对手奖赏为零；无处罚阈值字段／schema／测试 | **赛事宿主责任＋内核判胜接口（缺失）**：对方剩余奖赏 `<=X` 的特定胜利条件、授权、立即判定时点及同时条件组合须实现；**不得用删除奖赏模拟**。 |
| **15④** p.20—21 | 对战败北／对局败北、团队层级、双方均可能败北 | [G] 普通 `winner:0/1/null` 不能表达赛事双方败北；无 Match 层 | **赛事宿主责任（未交付）**：结果类型、影响层级、双败结果与排名／晋级一致性。 |
| **15⑤** p.21—22 | 取消资格、取消成绩／奖励、可追溯追加 | 无模块／测试 | **赛事宿主责任（未交付）**：活动资格、成绩更正、后续配对、证据及通知。 |
| **15⑥** p.22 | 官方评估禁赛及期间／积分等后果 | 无模块／测试 | **赛事宿主责任（未交付）**：官方身份／权限与通知接入；网站不得冒充官方作出禁赛决定。 |

## 5. 目录之外仍必须审查的配套交付

### 5.1 卡池与特别卡：准入不是执行证明

| 交付面 | 当前证据 | 剩余确切缺口 |
| --- | --- | --- |
| 固定地区／规则／卡池版本 | [R]、[FMT]、[FMT-CN]、[T-formats] 要求确切 `CN/V20261019/standard` 或 `CN/V20261019/open`；模式与卡池分离；登记八份来源均有固定原件 | 当前三个登记基础页已完整核读并固定20日响应；其他未登记网页、适用勘误／卡牌裁定清单及逐条来源登记仍不完整。没有19日HTML历史字节等同性证明。开放≠国际 Expanded，不能借国际名单补缺。 |
| 标准／开放能量与旧印刷 | 标准 G/H/I/J、八种基本能量；开放额外基本妖；旧系列指定名单、最新版锚点、发行时间、禁卡条件均有独立预期测试 | 真实旧印刷→当前卡文等价性证据、`series/releasedOn` 人工审核、生产发布信任记录未安装。不要使用曾经错误的搜索摘要名单。 |
| GX、V、VSTAR、VMAX | [S-card] `prizeCount/ruleBox/specialRule`；[G] `gxUsed/vstarUsed`、普通进化；[T-game] 额度和多奖赏 | 没有真实获批目录；TAG TEAM GX 的额外条件／追加效果等不因存在 GX 布尔量自动支持。 |
| 棱镜之星 | [S-card]显式根身份／来源、同名一张；[DISCARD]与[G]集中弃牌替代；[T-discard]、[T-prism]、[T-field-contract]、[T-stadium]覆盖费用／使用收尾／附件／继承／KO／场地及旧审批失效 | 第二十六轮限定任意原因would-discard到原持有者lost；不同卡名不跨普通／Prism合并。竞争去向替代、区分实际进入discard的专门触发、真实印刷及整卡审批仍须另审；不提供通用lost回收。 |
| TAG TEAM 训练家 | 费用与效果 sequence 有基础构件 | 缺使用前宣告“首段或全段”、不同条件费用／结果、保存恢复和无变化合法性证明。不能把它偷偷处理成结算到一半再任意选。 |
| 光辉／究极异兽／TAG TEAM 标记 | `deckLimits.groups`、`tags`、`ruleBox` 分离，有分组限额测试 | 实际印刷及标签审核、具体效果筛选、光辉一张总限额生产目录；究极异兽标记本身不是规则框。 |
| V-UNION／特殊部署／化石等 | [G] `assertSupportedDefinition` 明确拒绝 `special`、`V-UNION` | 缺多张物理卡构成一只、特殊出场／组牌／区域／保留规则及非宝可梦卡成为宝可梦的状态模型。拒绝是诚实门禁，不是完整规则交付。 |
| 真实卡牌 schema 与 52Poké metadata | [S-card]、printing schema、[CARD]、[REL] 分离基础定义／印刷／运行时；[T-schema]、[T-release] 防自批 | 52Poké 仅作为 metadata 来源；不能自动授予官方卡文／合法印刷／效果批准。真实卡逐卡迁移、证据、对应 testIds、生产信任名单与未知卡 UI 尚缺。 |
| 网站运行入口 | [RG] 提供带审核发布的创建／恢复；README 明确开发中；现有网站仍使用旧教学引擎 | 版本／赛制选择、真实目录、合法操作／私有选择 UI、双方服务鉴权、存档／重放、可见来源 trace、旧模式清晰隔离及浏览器端集成测试未完成。 |

### 5.2 本次发现的高优先级缺口（不能被代码覆盖率掩盖）

1. **F01／灼伤变更未接到实战**：`checkConditions` 能取最大，但
   `runTask(checkup-statuses)` 没传 `burnCounterChanges`，持续 schema 也无对应载荷。
   先补派生源值再接检查，测试两个不同值／同值、失效、消除、保存恢复。
2. **F02／场外主动特性缺失**：`actions` 仅枚举场上 Mon。
   要新增 card-zone identity／epoch、使用记录和受控可见性；加入前窗口不等价。
3. **F03／特殊胜负及判罚胜利阈值缺失**：II.E-38具体胜败条件及非玩家效果性质
   已核读，但立即终止／后续处理、普通判胜先后与冲突优先级仍未决，尚未实现。
   它与赛场15③是不同来源的结果，都不能塞入普通奖赏清空逻辑；
   还需Match层的双方败北／合意平手。
4. **F04／通用查看、隐面知识与顶底排序仍不完整**：第二十一轮已用独立指令接通
   己方奖赏零／一张自交换和玛俐／贪心栗鼠形整手牌独立重洗放底，
   不再列为“只有数量纯函数”。`cards.from` 仍非通用区域接口；
   只查看／顶牌原位放回、指定排序、对手手牌授权知识和跨区域关系仍缺。
   选中奖赏匹配 beforeHand 的自交换交互明确 needsRuling（`unresolved-prize-before-hand`），
   不因拒绝安全或没有触发日志而记成已解决。
5. **F05／有效宝可梦属性缺失**：伤害／筛选仍读打印 `types`；
   需要独立派生属性层，同时更新伤害、目标、触发、保护和视图，不能改 `CardDefinition`。
6. **F06／伤害前信息与昏厥替代缺失**：全满致死反应和留 10HP 需要受伤前事实、
   伤害包／效果阶段与 KO 替代窗口；KO 已锁定后回复不能冒充不昏厥。
7. **F07／完整历史条件与生命周期**：第十六轮接通 E-11／24／25／26 的严格账本、
   真实行动和条件伤害；KO 原因锁定、检查时界与恢复已测。完整区域 epoch／LKI、
   所有其他卡牌条件与旧兼容 cache 的后续审查仍未完成；
   D-17 仍只有登记，无专门执行／计算测试。
8. **F08／完整多目标与费用关系缺失**：第二十二轮已增加限定批次回复、
   全回复及FAQ3“本次实际回复者→后续弃能”，不再把这条明确关联列为完全缺失。
   任意分配指示物、其他按已支付／回复／弃置对象计算伤害或后续对象、
   不同区域及可选额外付款仍缺，不能全由 `performed:boolean` 表达。
9. **F09／跨持有者全局排序未决**：当前 `assertOwnerIndependence` 拒绝非局部双持有者
   交互。需要补 CN 权威依据／卡牌具体裁定及执行，不能直接导入国际版 APNAP。
10. **F10／非昏厥离场与 LKI 未齐**：双返回／返回与 KO 混合补位、伤害前离场、
    附着卡离场重附 epoch、后续伤害所用最后信息、KO 替代去向仍缺。
11. **F11／区域替代未齐**：第二十六轮已接通Prism任意原因弃牌到原持有者lost；
    用后回手牌、竞争替代等其余机制仍需要带来源且可追踪的
    区域替代，不只修 `discard` 一个调用点。否则费用、竞技场替换、KO 和退化会分歧。
    本轮仅补自交换来源绑定的唯一 finalizer，不是这些一般区域替代的实现。
12. **F12／数值和存档精确度仍须逐项补齐**：第十六轮主任务已验证
    `mechanics.hp <= 9007199254740990`、`counters <= 900719925474099`，
    派生 HP 用 BigInt 合计后检查，以及未来 `healedTurn/movedActiveTurn/lastUsedAttack`
    事实拒绝；`battleHistory` 替代原宽历史，KO continuation 及原始收据已收紧并回归。
    声明含healPokemon的程序已有P1身份／continuation强化，并纳入Stage22最终检查点；
    其他内部任务仍须逐一审查。
    高覆盖率不能证明所有 JSON 数值、生命周期、
    历史缓存或队列关系都已验证。
13. **F13／来源粒度未齐**：多个触发／时限 rule 的来源登记只写 section，
    尚无 `pdfPages`。第十六轮已经登记历史细则并接入 E-28 来源 trace；
    E-17 细分执行、E-38 等仍需独立或更精确的规则 ID／trace。
    此矩阵的页码不自动修补 runtime 登记。
14. **F14／真实目录与网站未交付**：当前规范用虚构 fixtures。
    独立内容封签只能证明审核对象没漂移，不能证明卡牌内容是真的、
    handler 闭包可信或所有官方卡已支持。
15. **F15／赛事宿主未交付**：第 4 节列出的服务／授权／结果／处罚功能必须有
    实际接口及测试，或由用户明确批准交付边界；不能由本文自行减掉。

### 5.3 第二十一至二十二轮有限实现与来源收尾边界

- **奖赏交换**：依据 II.C-20 p.41、II.E-34 p.73、II.E-35 p.73—74；
  [PEX] 与 [S-prize-exchange] 只规划己方全部反面奖赏中的零／一张，
  [H] `cn.prizeExchange@1`／[G] `runEffect(exchangePrizes)` 执行。筛选使用打印定义，
  不借场上有效 HP／类型；成功只交换正在结算的物理物品／支援者本身。
  换入来源和其余奖赏一起实际隐面重洗，零选也重洗；空奖赏池不能宣告，
  单张算重洗但不强求 RNG 变化。完整请求及精确交换位置的历史收据仅宿主持有；
  获准查看的原奖赏牌面只给使用者，重洗后不向任何玩家公开新顺序。
  [T-prize-exchange]、[T-prize-exchange-live] 分别证明独立 oracle 与真实执行，
  不批准真实洗翠沉重球／格拉吉欧卡面或其所有交互。
- **手牌放底及然后**：依据 II.E-19 FAQ2 p.63、II.E-35 p.73—74；
  [HBOTTOM] 与 [S-hand-bottom] 读取真实 commit 后的完整目标手牌，
  `source.owner` 决定 own；双方各自洗副本，以 bottom-first 结果直接 prefix 原 deck，
  不倒序、不洗原 deck、不发布新顺序。`cn.shuffleHandToBottom@1`／`cn.handBottomDraw@1`
  的原生 post-cost proof 在宣告前按移除正在使用的 Trainer 并完成本次手牌费用后的
  手牌证明可执行性，不提前实际支付；
  `plan.performed` 依据至少一方手牌非空而非 RNG 是否变化。FAQ2 的双空不可用，
  任一方单张可执行整段然后、包括空手一方后续抽牌。
  [T-hand-bottom] 的守恒／放置检查及 [T-hand-bottom-live] 的真实抽5／4、短牌库、
  实际使出者、费用原子性、E-31 抽牌暂停／恢复只证明这些路径，不扩张为任意 then。
- **全部／同时回复及明确关联弃能（第二十二轮）**：依据II.C-06 p.29、
  II.C-17 p.37—39及II.E-19／FAQ3 p.62—63；[HEAL]、[S-healing]与
  `cn.healPokemon@1`只接受显式目标／筛选／数量、固定正十点倍数或`all`及弃能开关。
  单体主动回复排除健康对象；多体可包含健康对象，但所选集合须含受伤者。
  类型读场上有效值，阶段／名称／HP仍读打印；不靠进化叠层厚度猜阶段。
  宿主收齐全部选择并冻结回复前保护／指示物，统一提交；仅实际移除正数量者写历史。
  后段只取本次`plan.healed`，在全部回复与保留条件处理后重查当前保护及实际能量，
  再按物理卡统一弃置；无能量不妨碍前文回复，旧`healedTurn`不能借用。
  [T-healing]的独立oracle、[T-healing-live]的真实执行、[T-healing-state]的
  来源／窗口／回合／顶卡／指示物／数量／唯一请求恢复约束均已落文件；
  [T-healing-contract]另要求显式声明`discardEnergy`，不执行的分支也不得漏报权限。
  这些限定路径不等于通用结果变量AST、任意多目标操作或真实卡批准；
  下述程序身份P1强化已纳入Stage22同一worktree最终门禁，记录见第7节；
  仍不能用专项文件存在或这个历史检查点代替整个目标及后续改动的验收。
- **限定程序身份／帧与来源（第二十二轮）**：[EXEC]／[S-execution]定义全部私有的
  `scheduled/opened/advance`记录，纯层按原有[FX]机器重放sequence／then／optional与
  叶结果，不执行效果、不消费RNG，也不认证卡牌、来源或宿主。
  [G] `tracksExecution`目前只接声明操作或嵌入操作含`healPokemon`的绑定；
  `scheduleTrackedEffect/executionGroups/requireExecutionReference/assertExecutionWork`
  将唯一`programId`、原绑定／来源／回合／入口／费用／local与原程序绑定，
  重算当前动作和精确控制帧，不能删除身份降级为新工作、复制叶、嫁接后段、
  借已完成调用或混用复制父子程序；正常待抽牌completion也必须保留独立继续处理。
  原生回复／延后反应的opened程序另与目录参数核对，不靠公开请求或可编辑日志自证授权。
  [T-execution]检验纯重放、严格JSON、顺序／重复／缺口与未执行分支权限；
  [T-healing-program]现有15项专项检验连同请求／私有记录一起改写的扩大、
  嫁接、重播及源替换，原始playerView也不能借改名／visibility公开日志。
  [T-healing-execution-live]现有6项真实路径覆盖拒绝optional、嵌套beforeHand暂停、
  同程序两个回复叶、复制父子恢复、同卡两次独立调用及原生延后反应。
  这些是文件内专项数量与有限路径，不是最终全量统计、所有handler／闭包可信性、
  密码学认证或真实卡审批；其他操作／程序的恢复完备性仍须逐项证明。
- **唯一来源 finalizer**：[G] `prizeCompletion/assertPrizeChoice/assertTrainerFinish`
  将私有请求、原奖赏窗口、当前回合、物理来源与唯一 outstanding `finish-trainer`
  completion token 或 `entry-finish` entry ID 绑定；普通 Trainer 另核对本次公开
  `trainer-open` 声明，不能借同卡早先的使用记录。成功自交换不再由收尾从奖赏取回，
  零选仍正常弃置一次。请求／token／声明／来源被篡改或 finalizer 缺失／重复须拒绝。
  [T-prize-exchange-state]、[T-prize-exchange-live] 覆盖这两类实际来源和恢复，
  并拒绝把 Pokémon 特性或留场 Tool 冒充本身交换来源；这不是任意来源用后去向的许可。
  首次完整门禁后又补普通非交换 Trainer 的全局 completion／card 唯一性、
  正在执行的正常手牌 Trainer 工作（含 draw completion）必须保留 finalizer 的恢复约束；
  [T-prize-exchange-state] 另覆盖普通HEAL目标选择及嵌套抽牌的真实收尾约束。
  [G] `validSource`对正在结算的物品／支援者另要求非手牌origin确有匹配的原始
  `beforeHand`绑定（effectId、origin及出处）；一致改写所有请求／程序来源为field
  也不能绕过仅从手牌使出时的保护。[T-healing-program]包含该真实保护反例。
  来源成立仍不能省略收尾：[T-prize-exchange-state]另用真实奖赏beforeHand绑定，
  同时移除entry上下文及全部entry工作，恢复仍须拒绝孤立的自交换继续处理，
  而不是仅靠不可能来源的提前拒绝代替completion守卫。
  隐私审查复现的历史kind改名漏洞已由严格事件schema与公开摘要交叉核验关闭；
  [T-prize-exchange-privacy] 同时检查restore和原始playerView，未知字段、
  未获准展示、伪造卡牌引用、缺失／重复原请求和结果都不能成为公开摘要。
  新增数量参数边界见 [T-hand-bottom-parameters]，不实际执行巨大数量的抽牌。
  第二十一轮及第二十二轮最终同一worktree门禁分别见第7节；
  新回复／程序强化属于Stage22检查点，不借旧运行证明新状态，也不外推下一轮开发。
- **保留 needsRuling**：实际选中的 Prize 卡若匹配 `acquisitionUnits` 的
  `beforeHand` descriptor，先抛 `unresolved-prize-before-hand`，保持牌区／RNG／
  pending 原子不变；未选中的该类卡或仅适用于 draw 的 descriptor 不阻断普通交换。
  这是未有 CN 依据的交换入手交互，不是 unknown→skip，更不是官方非法裁定。
  已存在的 E-31 entry 来源可完成本身自交换的 finalizer 测试，不等于上述新入手交互已解决。

## 6. 按依赖排列的剩余最短交付路径

这是一条**保留原目标**的依赖路径，不是建议把范围缩成“408 项通过即完成”。
可以并行的工作包应各自拥有不冲突的文件；共享生成器只由集成主任务运行。

| 顺序／依赖 | 可并行工作包与最小真实产物 | 关闭条件 |
| --- | --- | --- |
| **P0：来源基线**（可与P1并行） | 八份登记来源固定后，继续补缺页码／缺ruleId、其他未登记网页及卡牌裁定原件；将本矩阵细化到可执行子例，保留E-38时序未决 | 每个实施规则能指向 CN 适用条款／卡牌；找不到依据的行为保留未决，不借国际版填补。 |
| **P1：共用状态语义**（依赖 P0） | 声明含healPokemon程序的身份／continuation强化已纳入Stage22检查点；继续补其他程序、区域epoch／LKI、派生属性复杂依赖、安全整数及内部恢复不变量 | 状态只存事实，打印属性不变；派生属性在伤害、筛选、保护、触发与视图一致；每轮新增状态恢复／篡改测试及同一worktree完整门禁仍须通过，不沿用历史结果。 |
| **P2-A：隐面与区域操作**（依赖 P1 的区域身份） | 在已接通己方奖赏自交换／整手牌独立放底／窗口余牌放底基础上，继续补通用查看、授权知识、指定顶底排序、奖赏交换 E-31 未决交互、跨区选择及统一区域替代 | C-20、E-17／33—36、棱镜之星、TAG TEAM 使用选择等真实规范场景可执行，双方投影无泄漏，逐选择恢复／重放一致；有限原语完成不抵消其余缺口。 |
| **P2-B：伤害／反应／结果**（依赖 P1） | 全满快照、伤害失败全部边界、多目标分配／动作收据、昏厥防止／替代、E-11／24—26／38、结束回合／额外回合 | 官方条款／示例及交互测试证明正确；源离场仍保持准确身份，不用当前 Active 临时替换原使用者。 |
| **P2-C：顺序与特殊规则**（依赖 P0、P1） | 跨双方全局依赖排序、混合补位、复杂消除／供给冲突、复制特例／限时授予、特殊部署／化石／V-UNION | 明确的 CN 依据、严格 schema、实际执行与回归同时具备；被安全拒绝的机制不记为实现。 |
| **P2-D：赛事宿主**（P0 后设计；判胜接口依赖 P2-B） | Match／round／pairing／身份角色、时间／暂停／补时、11.3 主裁判准备、结果签署／合意平手／更正、处罚阈值与记录 | 第 4 节每项有受控实现、授权／审计及相应测试；线下人工责任有明确流程，不假称数字系统能鉴真或代替官方裁判。 |
| **P3：真实卡迁移与审查**（可在 P1／P2 按机制逐批进行） | 52Poké 原 metadata 保留；真实 CN 印刷、卡文／勘误、规范化定义、最新版锚点、机制测试、生产发布审核记录 | 每张上线卡都有独立印刷与定义批准、真实证据和可追溯测试；完整目标卡池不能靠跳过难卡或把它们永远标 unsupported 宣告完成。 |
| **P4：网站／服务接入**（依赖可用真实目录及必要 P2、P3） | 明确 CN/V20261019 与赛制选择、审核发布创建／恢复、合法动作与私有 UI、服务器鉴权／随机私密、来源 trace、旧教学模式隔离 | 两个独立客户端完成真实批准牌组对局；强制选择、状态／锁、所有隐藏窗口及断线恢复通过浏览器／服务集成测试，不能只 build。 |
| **P5：完整验收→commit/push**（依赖全部前项） | 按本矩阵逐条复审；schema／kernel／sources 检查、规范／不变量／交互／重放／全站回归及构建；审查 Git 归属 | 每个显式需求都有当前证据，无未解释缺口；最后仅提交本目标文件，保留用户原有工具改动，commit 并确认 push 成功。 |

### 最小验收用例必须以语义组织

- **打印／运行／派生分离**：同定义两实例独立伤害；有效 HP／类型／能量变化不改卡面；
  锁带目标、来源与到期条件；当前 HP 不再存第二份真值。
- **时序／随机**：外加失败→混乱→自身内容／失败；所有前置／后置、检查／KO／奖赏
  窗口；拒绝操作不消耗随机；多币和顺序能被错误实现的测试确实捕获。
- **公共／隐面操作**：限定／任意选择区别、真实支付与效果少选不同、各知情者权限、
  展示后恢复、盲选、子集放底、奖赏交换及不可见卡身份不泄漏。
- **反应／来源**：实际使用者、卡牌持有者、控制者、内容来源、授权来源、
  原生／延后触发、离场重入、有效类型／特性／道具、附着 epoch、LKI。
- **胜负／赛事**：CN 普通完整胜负表、特殊胜败、最后奖赏加入前、
  抢分、处罚阈值、合意平手、双败／Match、授权更正，不混用普通平局和双方判负。
- **真实迁移／入口**：未批准／部分实现卡拒绝；内容、印刷、来源或 handler 改动导致
  审批失效；线上不允许伪造快照或借公开本地 seed 推断牌序。

## 7. 本次检查与证据强度

- 初次独立审查曾核对 `git status` 与适用 instructions；本轮仅修改本矩阵，
  只读核对相关实现、测试、最终日志及链接，没有运行 Git 或修改其他任务文件。
- 历次审查累计读取缓存PDF的页数、完整目录／正文和SHA-256；本轮只读核对
  回复相关schema／规则登记／任务／测试与E-38 p.75—76原文，
  三份新固定基础HTML均按完整原件正文阅读，不根据200响应或导航模板判定规则证据。
- 已阅读现存 `/tmp/cn-stage15-acceptance-coverage.log` 和
  `/tmp/cn-stage15-acceptance.log`：它们记录上一集成基线 **408 项通过**、
  手写代码行／函数 100%、aggregate 分支 98.27%，以及构建和五份来源核验。
  **它们只证明第十五轮。** 后续第十六轮以 `/tmp/cn-stage16-final-coverage.log`
  和 `/tmp/cn-stage16-final-acceptance.log` 为本机验证记录：503 条规则、19 条迁移与15 条逐卡审查测试、
  完整回归及构建通过，行／函数 100%、分支 98.57%。
  第十七轮以 `/tmp/cn-stage17-final-coverage.log` 和
  `/tmp/cn-stage17-final-acceptance.log` 为本机记录：656条规则、19条迁移、19条逐卡审查、
  完整回归／构建／五份来源通过，行／函数100%、分支98.76%。
  第十八轮记录为 `/tmp/cn-stage18-final-coverage.log` 和
  `/tmp/cn-stage18-final-acceptance.log`：747规则、19迁移、19逐卡审查及14条旧引擎
  确定性批次回归、完整测试／构建／五份来源通过，行／函数100%、分支98.87%。
  最初随机奖赏失败已复现并修复，不是忽略失败后只重跑。本表仍不宣称完整引擎完成。
  第十九轮记录为 `/tmp/cn-stage19-final-coverage.log` 和
  `/tmp/cn-stage19-final-acceptance.log`：805规则、19迁移、19逐卡审查、14旧批次测试，
  完整回归／构建／五份来源通过；手写行／函数100%、分支98.89%。
  第二十轮记录为 `/tmp/cn-stage20-final-coverage.log` 和
  `/tmp/cn-stage20-final-acceptance.log`：848规则、19迁移、19逐卡审查、14旧批次测试及
  完整回归／构建／五份来源通过；手写行／函数100%、分支98.86%。
- 第二十一轮最终同一worktree核对
  `/tmp/cn-stage21-final-coverage.log` 和 `/tmp/cn-stage21-final-acceptance.log`：
  各命令退出码均为0，日志包含 **920/920** 规则测试通过（比第二十轮新增72项），
  失败／取消／跳过均0，手写行／函数100%、分支98.88%，阈值／排除项未降低。
  完整 `npm test` 包含19项迁移、19项逐卡审查、14项旧引擎奖赏批次测试；
  另有257个scenario、2033次KO检查坏数0、493局恢复并完成、
  15130局组合对战（`long:0`、最大95回合）。
  网站构建、schema／kernel只读核对及当时五份固定PDF／HTML原件检查通过；
  这是历史来源数量，当前八份登记来源的固定情况另见下一项。
  构建成功不是网站完整官方接入或真实卡审批证明。
  该历史运行的state协议为 `CN-game-dev-19`，下列指纹不是当前dev20产物的验收声明；
  schema SHA-256 `8bb7892a716565911c2cf465db46149775e795805ce638d6040e8d3cc37bbe30`，
  kernel SHA-256 `ebb0684b3fcfa4abbc9c16383925127b6f67f23c6af1b72c88028abc4a18f38f`。
  普通HEAL／嵌套抽牌finalizer、历史私有记录改名／夹带字段／越权展示回归
  与两个稳定入口的完整字节审计均已纳入该历史验收；文件见下方对应引用。
- 第二十二轮来源及专项范围：该检查点协议为 `CN-game-dev-20`；
  来源专项 `node --test tests/official-rules/sources.test.mjs` **10/10通过**，
  `node scripts/check-rules-sources.mjs` 离线核验 **8/8原件通过**（两PDF、六HTML）。
  [T-sources]固定当前HTML日期、字节与指纹、05／07独立查询身份、冻结定位及证据范围，
  不将旧09赛场3.0.0纳入八份主来源，也不证明HTML与19日历史字节一致。
  C-06／E-19新纯层、真实执行、状态与合约测试见[HEAL]及[T-healing]、
  [T-healing-live]、[T-healing-state]、[T-healing-contract]，仅列实际存在的文件。
  新增[EXEC]、[S-execution]、[T-execution]、[T-healing-program]（15项）及
  [T-healing-execution-live]（6项）实际引用，限定范围见第5.3节。
  这些专项与来源都纳入以下最终检查点，不将它们单独当作整个目标或后续开发验收。
- **第二十二轮最终同一worktree检查点（2026-10-20）**：
  已读取 `/tmp/cn-stage22-final-coverage.log` 和
  `/tmp/cn-stage22-final-acceptance.log`；父线确认全部门禁退出码0。
  规则测试 **1000/1000通过**，比Stage21的920项新增80项，
  失败／取消／跳过均0；手写行／函数 **100%**、aggregate分支 **98.96%**，
  `healing.js`、`effect-execution.js`、`effects.js`均为行／分支／函数 **100%**，
  未降低阈值或增加排除项。
  完整 `npm test` 包含1000项官方规则、19项迁移、19项逐卡审查及14项旧引擎批次回归；
  另有257个旧scenario通过、2076次随机KO奖赏检查`bad:0`、478局恢复并完成，
  15130局组合对战（`long:0`、最大96回合）。
  网站构建、schema／kernel只读核对、八份固定PDF／HTML原件及diff检查均通过。
  schema SHA-256 `200a033e28f9cc45f8319fe69570e7163024c137e38c344e28a8537948e4deb7`，
  kernel SHA-256 `22afa12377ce2fa966c90f6451c60891f4bc32f9be5c74cbbac33dffc4bb8d65`。
  最终回归包含一致篡改程序／请求来源不能把手牌物品伪装为field，
  以及真实奖赏beforeHand来源丢失全部entry工作的孤立继续处理拒绝；
  不以早期拒绝导致旧守卫未覆盖的中间运行代替此最终结果。
  **仅登记Stage22历史checkpoint；随后Stage23或其他新改动须重新验收。**
  本矩阵不声明全部规则／真实卡池／网站／赛事宿主目标完成，尚未commit／push；
  不把任何旧的未跟踪文件数或引用总数当作实时库存。
- 第二十三轮 `CN-game-dev-21` 最终同一worktree验收：**1052/1052** 项，
  相比Stage22新增52项；手写行／函数100%、aggregate分支99.00%，
  [CDIST]纯模块行／分支／函数100%。17纯层、18恢复、13宿主及4合约测试
  均在最终运行内，不用较早1049项运行替代追加主动无变化门槛测试后的结果。
  完整 `npm test` 含19迁移、19逐卡、14旧批次通过；257旧场景、
  2132次随机KO奖赏检查坏数0、472场恢复及15,130组合对局通过，最大95回合。
  网页构建、schema/kernel只读核对、八份来源及tracked diff检查通过；
  178个本任务未跟踪文件空白、103条六列目录及112个引用路径复核通过。
  日志 `/tmp/cn-stage23-final-coverage.log`／`/tmp/cn-stage23-final-acceptance.log`；
  schema SHA-256 `392f335cf6bb7f6981b7bb30cfecb5d8b865c588d20fa7031e1c63def96927dc`，
  kernel SHA-256 `c57d6557c0a021b76d06f07acc899b11e686cf1e37aa24946a481ba47ac57def`。
  数值请求nonce绑定与原生主动全保护／整段无变化资格均纳入该有限子集验收；
  不证明所有旧handler、任意连续源、复杂费用依赖或全体卡牌已经支持。
- 第二十四轮 `CN-game-dev-22` 最终同一worktree验收：**1144/1144** 项，
  较Stage23新增92项；手写行／函数100%、aggregate分支99.05%，
  activation-cost整个模块100/100/100。8动态费用、12完整付款oracle、
  19实际入口／保留投影、14回复、10互换、11固定指示物、10分类合约及8许可主体测试
  均纳入该运行；旧JSON错误分支也已固化，不依靠临时probe取得覆盖。
  完整 `npm test` 含19迁移、19逐卡、14旧批次通过；
  257旧场景、2042次随机KO奖赏检查坏数0、496场恢复、15,130组合对局通过，最大95回合。
  网页构建、schema/kernel只读核验、八份来源及tracked diff空白检查通过。
  187个本任务未跟踪文件空白检查、103条六列目录及121个引用路径复核通过。
  日志 `/tmp/cn-stage24-final-coverage.log`／`/tmp/cn-stage24-final-acceptance.log`；
  schema SHA-256 `1ca9f5ba869e836300873cf4bd4d8088b455c968d8d46fb5e77693d9c7b54947`，
  kernel SHA-256 `ba6ecd617ecef022c3728bd26c31b40e45e456af493f4c4fca26d70beb9df103`。
  E29是明文例外，不能用“全保护”推全部禁用；新必填分类不等于实卡审核已完成。
  竞技场卡自身、timed许可、未审混合与其余触发／费用仍保留明确缺口。
- 第二十五轮 `CN-game-dev-23` 最终同一worktree验收：**1217/1217** 项，
  较Stage24新增73项；手写行／函数100%、aggregate分支98.94%，
  selection-request与json-equal均100/100/100。
  13请求协议、29JSON等价、17恢复、8有效组合与6原生绑定专项均在最终全套内；
  全效果调用不再有无programId的旧操作降级，静态原生参数另行独立绑定，
  上下文输出及整个可编辑宿主仍保留明示信任边界。
  完整 `npm test` 含19迁移、19逐卡、14旧批次通过；257旧场景、
  2123次随机KO奖赏检查坏数0、484场恢复、15,130组合对局通过，最大95回合。
  网页构建、schema/kernel只读核验、八份来源及tracked diff空白检查通过。
  197个本任务未跟踪文件空白、103条六列目录及131个引用路径复核通过。
  日志 `/tmp/cn-stage25-coverage-initial.log`（冻结代码的全量覆盖运行）及
  `/tmp/cn-stage25-final-acceptance.log`；schema SHA-256
  `80cd119593f26d93d370eaf9e4eaeedaa0f6615f60109d2c757c63920b1ed480`，
  kernel SHA-256 `99c8ee5c71e9583a4a32a9b9ab47fb22419c1018c3f31da1b316dc44de3413cb`。
  [SPECIAL-SCOPE]与[ENERGY-SCOPE]是独立原件／身份审查提案，尚不是实卡审批或特殊终局实现。
- 第二十六轮`CN-game-dev-24`最终同一worktree验收：**1293/1293**项，
  较Stage25新增76项；手写行／函数100%、aggregate分支98.96%。
  [FIELD]与[DISCARD]两个纯模块均100/100/100；13纯场地、21去向策略、
  13实际Prism、15实际场地及14合约测试均纳入全套。
  新增固定程序“特殊能量＋场地各一”独立执行、普通／自定义旧self误用拒绝及
  摘要不可见JS字段的旧审批拒绝回归，不凭pure用例代替真实对局。
  完整`npm test`含19迁移、19逐卡、14旧批次通过；257旧场景、
  2008次随机KO奖赏检查坏数0、474场恢复、15,130组合对局通过，最大95回合。
  网页构建、schema/kernel只读核验、八份来源及tracked diff空白检查通过。
  206个本任务未跟踪文件空白、103条六列目录及140个引用路径复核通过。
  日志`/tmp/cn-stage26-final-coverage.log`及`/tmp/cn-stage26-final-acceptance.log`；
  schema SHA-256`ced062d12b28fccbe6e71609b4c0c6b1a8799f5c05e70928d0ba74d54d55b3ed`，
  kernel SHA-256`e96b4835e31115158e901ae342ca062c17eb1daa712dd78021da4190eaaea6df`。
  [FIELD-SCOPE]明确一般推导与真实审批的边界；其余条款、真实卡池、
  网站官方入口及最终commit／push仍未完成。
- 第二十七轮`CN-game-dev-25`暂停前最终同一worktree验收：
  **1374/1374**项规则测试，新增81项；手写行／函数100%、aggregate分支98.86%。
  [OWNED-LOCK]与battle-history均100/100/100；12纯选招、14合约、
  14实际对局、17恢复、9身份、4复合程序及11实际事实用例纳入全套。
  [T-owned-composition]验证合法延后反应、同一程序多个选择、认输及历史暂停；
  [T-field-history]与[T-owned-state]锁定真实转场／回合结束事实，
  原P1的“只伪造clear＋通用日志”三种攻击在保留原实际历史时均被拒绝。
  完整`npm test`含19迁移、19逐卡、14旧批次及257旧场景通过；
  2088次随机KO奖赏检查坏数0、476场恢复及15,130组合对局通过，最大95回合。
  网页构建、schema/kernel只读核验、八份来源与tracked diff检查通过。
  原运行日志`/tmp/cn-stage27-final-coverage.log`、
  `/tmp/cn-stage27-final-acceptance.log`；schema SHA-256
  `85987f3a6a79078c4a3ae708127ad7bff82ba3158e5fc7aa5439ed06bd71fee6`，
  kernel SHA-256`e9b2026917f391a32dadedc11d490acb1eb911bf26c7eaf0a2a83e13304966a2`。
  此后按用户要求暂停，只有文档整理；不将本轮、代码覆盖率或安全拒绝当作整目标完成，
  未commit／push，也未启动下一项实现。
- 初次独立审查不运行生成器或全套测试，避免覆盖并行产物；后续主任务已完成
  第十六至二十二轮本机完整验收，并按实际有限范围更新相关行，
  未将未支持边界一并算成完成。
  文档本身的条款数量、引用和空白检查不代替内核与端到端验收。
- 本表列全第 I 章 **15** 个目录项、第 II 章 **88** 个目录项（A 1、B 9、C 20、
  D 19、E 39），共 **103** 项。目录粒度不是所有子情形的分母，不计算所谓
  “官方完成率”；赛事主章与主要子章另列，未把宿主责任藏到表外。

<!-- Repository-relative references remain usable after cloning; prefer symbols/tasks to drifting line numbers. -->
[官方来源缓存]: ../../../../.cache/rules/sources
[R]: ../../../../public/rules/zh-CN/V20261019.js
[G]: ../../../../public/rules/game.js
[H]: ../../../../public/rules/handlers.js
[FX]: ../../../../public/rules/effects.js
[SEL]: ../../../../public/rules/selection.js
[DMG]: ../../../../public/rules/damage.js
[COND]: ../../../../public/rules/conditions.js
[ONG]: ../../../../public/rules/ongoing.js
[TR]: ../../../../public/rules/triggers.js
[SUP]: ../../../../public/rules/suppression.js
[CS]: ../../../../public/rules/card-selection.js
[ACQ]: ../../../../public/rules/acquisition.js
[COST]: ../../../../public/rules/activation-cost.js
[EM]: ../../../../public/rules/energy-mechanics.js
[ES]: ../../../../public/rules/energy-selection.js
[EV]: ../../../../public/rules/evolution.js
[FR]: ../../../../public/rules/field-return.js
[COPY]: ../../../../public/rules/attack-copy.js
[GRANT]: ../../../../public/rules/attack-grant.js
[FMT]: ../../../../public/rules/formats.js
[FMT-CN]: ../../../../public/rules/zh-CN/formats/V20261019.js
[CAT]: ../../../../public/rules/catalog.js
[CARD]: ../../../../public/rules/card-schema.js
[REL]: ../../../../public/rules/catalog-release.js
[RG]: ../../../../public/rules/reviewed-game.js
[S-card]: ../../../../schemas/card-definition.schema.json
[S-state]: ../../../../schemas/game-state.schema.json
[S-fx]: ../../../../schemas/effect-program.schema.json
[S-cost]: ../../../../schemas/activation-cost.schema.json
[T-foundation]: ../../../../tests/official-rules/foundation.test.mjs
[T-runtime]: ../../../../tests/official-rules/runtime.test.mjs
[T-game]: ../../../../tests/official-rules/game.test.mjs
[T-battle]: ../../../../tests/official-rules/battle-state.test.mjs
[T-selection]: ../../../../tests/official-rules/selection.test.mjs
[T-cards]: ../../../../tests/official-rules/card-selection.test.mjs
[T-effects]: ../../../../tests/official-rules/effects.test.mjs
[T-energy]: ../../../../tests/official-rules/energy-mechanics.test.mjs
[T-evolution]: ../../../../tests/official-rules/evolution.test.mjs
[T-return]: ../../../../tests/official-rules/field-return.test.mjs
[T-cost]: ../../../../tests/official-rules/activation-cost.test.mjs
[T-acquisition]: ../../../../tests/official-rules/acquisition.test.mjs
[T-copy]: ../../../../tests/official-rules/attack-copy.test.mjs
[T-grant]: ../../../../tests/official-rules/attack-grant.test.mjs
[T-packets]: ../../../../tests/official-rules/attack-packets.test.mjs
[T-ongoing]: ../../../../tests/official-rules/ongoing.test.mjs
[T-triggers]: ../../../../tests/official-rules/triggers.test.mjs
[T-suppression]: ../../../../tests/official-rules/suppression.test.mjs
[T-schema]: ../../../../tests/official-rules/schema.test.mjs
[T-release]: ../../../../tests/official-rules/catalog-release.test.mjs
[T-formats]: ../../../../tests/official-rules/formats.test.mjs
[T-failure]: ../../../../tests/official-rules/attack-failure.test.mjs

[FAIL]: ../../../../public/rules/attack-failure.js
[HIST]: ../../../../public/rules/battle-history.js
[CHK]: ../../../../public/rules/checkup-effects.js
[T-history]: ../../../../tests/official-rules/battle-history.test.mjs
[T-history-live]: ../../../../tests/official-rules/battle-history-integration.test.mjs
[T-history-card]: ../../../../tests/official-rules/history-card-conditions.test.mjs
[T-checkup]: ../../../../tests/official-rules/checkup-effects.test.mjs
[T-checkup-live]: ../../../../tests/official-rules/checkup-effects-integration.test.mjs
[TYPES]: ../../../../public/rules/pokemon-types.js
[TRAITS]: ../../../../public/rules/source-traits.js
[INPLAY]: ../../../../public/rules/in-play-selection.js
[PRIZE]: ../../../../public/rules/prize-count.js
[T-types-live]: ../../../../tests/official-rules/pokemon-types-runtime.test.mjs
[T-inplay-live]: ../../../../tests/official-rules/in-play-selection-runtime.test.mjs
[T-types-copy]: ../../../../tests/official-rules/pokemon-types-copy.test.mjs
[T-types-guards]: ../../../../tests/official-rules/pokemon-types-guards.test.mjs
[T-traits-oracle]: ../../../../tests/official-rules/source-traits-oracle.test.mjs
[T-prize]: ../../../../tests/official-rules/prize-count.test.mjs
[T-prize-live]: ../../../../tests/official-rules/prize-count-runtime.test.mjs
[VALUE]: ../../../../public/rules/battle-value.js
[PRED]: ../../../../public/rules/battle-predicate.js
[T-value]: ../../../../tests/official-rules/battle-value.test.mjs
[T-pred]: ../../../../tests/official-rules/battle-predicate.test.mjs
[T-value-live]: ../../../../tests/official-rules/battle-value-runtime.test.mjs
[T-pred-live]: ../../../../tests/official-rules/battle-predicate-runtime.test.mjs
[T-value-state]: ../../../../tests/official-rules/battle-value-state.test.mjs
[COINS]: ../../../../public/rules/damage-coins.js
[T-coins]: ../../../../tests/official-rules/damage-coins.test.mjs
[T-coins-live]: ../../../../tests/official-rules/damage-coins-runtime.test.mjs
[T-coins-state]: ../../../../tests/official-rules/damage-coins-state.test.mjs
[T-coins-guards]: ../../../../tests/official-rules/damage-coins-guards.test.mjs

<!-- Stage21 absolute workspace targets are verified to exist; only the stated limited paths are covered. -->
[PEX]: /home/zhn/pokemon-tcg/public/rules/prize-exchange.js
[HBOTTOM]: /home/zhn/pokemon-tcg/public/rules/hand-bottom.js
[S-prize-exchange]: /home/zhn/pokemon-tcg/schemas/prize-exchange.schema.json
[S-hand-bottom]: /home/zhn/pokemon-tcg/schemas/hand-bottom.schema.json
[T-prize-exchange]: /home/zhn/pokemon-tcg/tests/official-rules/prize-exchange.test.mjs
[T-prize-exchange-live]: /home/zhn/pokemon-tcg/tests/official-rules/prize-exchange-runtime.test.mjs
[T-prize-exchange-state]: /home/zhn/pokemon-tcg/tests/official-rules/prize-exchange-state.test.mjs
[T-prize-exchange-privacy]: /home/zhn/pokemon-tcg/tests/official-rules/prize-exchange-privacy.test.mjs
[T-hand-bottom]: /home/zhn/pokemon-tcg/tests/official-rules/hand-bottom.test.mjs
[T-hand-bottom-live]: /home/zhn/pokemon-tcg/tests/official-rules/hand-bottom-runtime.test.mjs
[T-hand-bottom-parameters]: /home/zhn/pokemon-tcg/tests/official-rules/hand-bottom-parameters.test.mjs

<!-- Stage22 references exist and its checkpoint passed; neither completeness nor later edits are certified. -->
[HEAL]: /home/zhn/pokemon-tcg/public/rules/healing.js
[S-healing]: /home/zhn/pokemon-tcg/schemas/healing.schema.json
[T-healing]: /home/zhn/pokemon-tcg/tests/official-rules/healing.test.mjs
[T-healing-live]: /home/zhn/pokemon-tcg/tests/official-rules/healing-runtime.test.mjs
[T-healing-state]: /home/zhn/pokemon-tcg/tests/official-rules/healing-state.test.mjs
[T-healing-contract]: /home/zhn/pokemon-tcg/tests/official-rules/healing-contract.test.mjs
[T-sources]: /home/zhn/pokemon-tcg/tests/official-rules/sources.test.mjs
[CDIST]: /home/zhn/pokemon-tcg/public/rules/counter-distribution.js
[S-counter-distribution]: /home/zhn/pokemon-tcg/schemas/counter-distribution.schema.json
[T-counter-distribution]: /home/zhn/pokemon-tcg/tests/official-rules/counter-distribution.test.mjs
[T-counter-distribution-live]: /home/zhn/pokemon-tcg/tests/official-rules/counter-distribution-runtime.test.mjs
[T-counter-distribution-state]: /home/zhn/pokemon-tcg/tests/official-rules/counter-distribution-state.test.mjs
[T-counter-distribution-contract]: /home/zhn/pokemon-tcg/tests/official-rules/counter-distribution-contract.test.mjs
[NCHANGE]: /home/zhn/pokemon-tcg/docs/rules/zh-CN/V20261019/NO-CHANGE-SCOPE.md
[T-nochange-heal]: /home/zhn/pokemon-tcg/tests/official-rules/no-change-healing-runtime.test.mjs
[T-nochange-switch]: /home/zhn/pokemon-tcg/tests/official-rules/no-change-switch-runtime.test.mjs
[T-nochange-counters]: /home/zhn/pokemon-tcg/tests/official-rules/no-change-counters-runtime.test.mjs
[T-cost-dependency]: /home/zhn/pokemon-tcg/tests/official-rules/no-change-cost-dependency.test.mjs
[T-cost-witness]: /home/zhn/pokemon-tcg/tests/official-rules/cost-witness.test.mjs
[T-nochange-projection]: /home/zhn/pokemon-tcg/tests/official-rules/no-change-projection-runtime.test.mjs
[T-use-rule-contract]: /home/zhn/pokemon-tcg/tests/official-rules/protection-use-rule-contract.test.mjs
[T-use-rule-live]: /home/zhn/pokemon-tcg/tests/official-rules/protection-use-rule-runtime.test.mjs
[REQUEST]: /home/zhn/pokemon-tcg/public/rules/selection-request.js
[S-request]: /home/zhn/pokemon-tcg/schemas/selection-request.schema.json
[T-request]: /home/zhn/pokemon-tcg/tests/official-rules/selection-request.test.mjs
[JEQUAL]: /home/zhn/pokemon-tcg/public/rules/json-equal.js
[T-json-equal]: /home/zhn/pokemon-tcg/tests/official-rules/json-equal.test.mjs
[T-program-state]: /home/zhn/pokemon-tcg/tests/official-rules/program-binding-runtime.test.mjs
[T-program-flows]: /home/zhn/pokemon-tcg/tests/official-rules/program-binding-flows.test.mjs
[T-native-program]: /home/zhn/pokemon-tcg/tests/official-rules/native-program-binding.test.mjs
[SPECIAL-SCOPE]: /home/zhn/pokemon-tcg/docs/rules/zh-CN/V20261019/SPECIAL-RESULT-SCOPE.md
[ENERGY-SCOPE]: /home/zhn/pokemon-tcg/docs/rules/zh-CN/V20261019/cards/UNNUMBERED-ENERGY-SCOPE.md
[FIELD]: /home/zhn/pokemon-tcg/public/rules/field-cards.js
[S-field]: /home/zhn/pokemon-tcg/schemas/field-cards.schema.json
[DISCARD]: /home/zhn/pokemon-tcg/public/rules/discard-policy.js
[FIELD-SCOPE]: /home/zhn/pokemon-tcg/docs/rules/zh-CN/V20261019/FIELD-CARD-SCOPE.md
[T-field]: /home/zhn/pokemon-tcg/tests/official-rules/field-cards.test.mjs
[T-discard]: /home/zhn/pokemon-tcg/tests/official-rules/discard-policy.test.mjs
[T-prism]: /home/zhn/pokemon-tcg/tests/official-rules/prism-star-runtime.test.mjs
[T-stadium]: /home/zhn/pokemon-tcg/tests/official-rules/stadium-runtime.test.mjs
[T-field-contract]: /home/zhn/pokemon-tcg/tests/official-rules/field-card-contract.test.mjs
[OWNED-LOCK]: /home/zhn/pokemon-tcg/public/rules/owned-attack-lock.js
[S-owned-lock]: /home/zhn/pokemon-tcg/schemas/owned-attack-lock.schema.json
[OWNED-SCOPE]: /home/zhn/pokemon-tcg/docs/rules/zh-CN/V20261019/OWNED-ATTACK-LOCK-SCOPE.md
[T-owned]: /home/zhn/pokemon-tcg/tests/official-rules/owned-attack-lock.test.mjs
[T-owned-live]: /home/zhn/pokemon-tcg/tests/official-rules/owned-attack-lock-runtime.test.mjs
[T-owned-state]: /home/zhn/pokemon-tcg/tests/official-rules/owned-attack-lock-state.test.mjs
[T-owned-identity]: /home/zhn/pokemon-tcg/tests/official-rules/owned-attack-lock-identity.test.mjs
[T-owned-contract]: /home/zhn/pokemon-tcg/tests/official-rules/owned-attack-lock-contract.test.mjs
[T-owned-composition]: /home/zhn/pokemon-tcg/tests/official-rules/owned-attack-lock-composition.test.mjs
[T-field-history]: /home/zhn/pokemon-tcg/tests/official-rules/field-transition-history.test.mjs
[EXEC]: /home/zhn/pokemon-tcg/public/rules/effect-execution.js
[S-execution]: /home/zhn/pokemon-tcg/schemas/effect-execution.schema.json
[T-execution]: /home/zhn/pokemon-tcg/tests/official-rules/effect-execution.test.mjs
[T-healing-program]: /home/zhn/pokemon-tcg/tests/official-rules/healing-program.test.mjs
[T-healing-execution-live]: /home/zhn/pokemon-tcg/tests/official-rules/healing-execution-runtime.test.mjs
