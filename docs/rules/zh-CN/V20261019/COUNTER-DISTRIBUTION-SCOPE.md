# 伤害指示物：总数分配／多来源转放的证据与显式选择协议

**状态：规则核读与方案记录，不作当前实现完备声明。**
本次仅新增本文件；不修改共享引擎、schema、生成器、healing 或 execution-trace
工作，不签发真实卡牌审批，也不声明 CN/V20261019 或全部组合已经完成。
下文区分 **原件明确规则**、**协议解释／设计** 与 **needsRuling**；
软件安全拒绝不等于官方判定某局面非法。核读日期：**2026-10-20**。
本文件保留原始方案及实现接点冻结记录；Stage23 后续接线历史见第 0／2.3 节。
本次只统一证据结论和历史状态，不验收现有代码，也不宣称多源扩展已实现。
第二十四轮补充审查另见 `NO-CHANGE-SCOPE.md`：本文早期“全部受保护且无变化”
结论只适用于没有专门许可的题设，不能覆盖E29 p68—69的手牌训练家使用许可。
当前保护定义须明确审核 `useRule`；许可、实际执行及then是不同判定。

## 0. C07 固定总数第一子集：原始规范与接线历史

**C07 第一子集不依赖 C08 或第 4 节扩展先完成。**
本节记录安全第一子集的原始规范；下列 API／字段保留为方案示意，
不要求与父端已精简的实际接口逐项同名。
只涵盖一个公开的场上宝可梦候选池、一个明确效果来源、固定非负整数总数，
不包含取来源指示物、动态总量、任意数量、来源回流或隐面区域。

**2026-10-20 后续接线历史（父线反馈，非本工作者代码验收）：**
Stage23 的 C07 固定总数 native 路径已落地，并已在宿主加入 source-aware 的
主动使用无变化资格检查；纯函数仍保留可选候选，不因保护剔除目标。
随后父线完成Stage23同一worktree验收：1052项规则测试及完整项目回归／构建通过，
手写行／函数100%、aggregate分支99.00%；详见 `IMPLEMENTATION.md` 第二十三轮。
该结果不是本文工作者的独立代码验收，也不能由本文前轮定向基线推导。
这不表示第 4 节尚属方案的多源／动态 API 已编写或通过验收。

建议新指令严格为：

```json
{
  "op": "distributeCounters",
  "side": "opponent",
  "target": "any",
  "selector": { "kind": "pokemon" },
  "count": 5
}
```

- `side` 显式 own／opponent，相对 `source.owner`；`target` 首批可限定为
  any／active／bench／self；`selector` 是严格的 Pokémon CardSelector，
  不看隐面卡，不从 UI 文本推断条件。字段都必填，不默认为对手全场。
- `count` 单位为指示物个数，固定且非负；不是每只宝可梦各放该数，
  不是伤害点，不以宝可梦只数或 HP 限制它。
- 权威候选池按 side、target、selector **共同**筛选，保留受保护者。
  若匹配在场属性，宿主提供实际有效属性；卡面 HP 谓词仍是卡面值。

**显式回答与严格总量：**

```js
{ choiceId: 'counter-7', allocations: [
  { targetId: 'mA', count: 2 },
  { targetId: 'mB', count: 3 },
] }
```

每个目标只出现一次，每项是正整数，所有 ID 属于原始公开候选池。
`count > 0` 且池非空时，**必须 `sum(allocations.count) === action.count`**：
没有“剩余不放”“最多 N”“选到哪里算哪里”或 UI 默认弃掉未分配部分。
A／D04 的指定数量不可主动缩小，C07 的任意方式只授予拆分方式的自由。
例如固定 5 只交 4，或有候选池却提交空分配，均拒绝且无任何写入。
分给受保护者的数也计入完整选择的 5，但实际可能不放置；这不是主动少选。
全部给同一只合法，超过它的剩余 HP 仍按完整份额放置。

**建议第一子集纯 API：**

```js
prepareFixedCounterWindow(ctx, action);
// {status:'resolved', window:{id, source, action, targets, ...}, sourceOfTruth}

assertFixedCounterAllocation(window, choice);
// 无变更；核验完整结构、ID、唯一性、正整数和精确总和。

planFixedCounterPlacement(window, choice, frozenProtection);
// {status:'resolved', updates, selectedTotal, placedTotal, preventedTotal,
//  performed: placedTotal > 0, sourceOfTruth}
```

宿主提交顺序必须固定：

1. 验证命令身份／当前 revision、原窗口／获审 binding 锚定、全部 allocation；
   没选全、未知目标、重复目标或总和错误时直接拒绝。
2. 在尚未改动任何 counters 的同一局面，解析**整个候选池**对本次 source 的
   effects 通道保护；完成所有查询后，冻结 mask 及其证据。纯规划器只读这个
   mask，不在循环加指示物之后重查另一只的保护。
   现有 `effectBlocked` 会记录日志，不应在预验证时循环调用并留下半份回执；
   使用无写入的保护事实读取，最终成功提交时再统一记录。
3. 依据完整 allocation 和冻结 mask，一次计算所有 `afterCounters`、
   实际放置数／防止数及数值边界；先算全，不能算一项写一项。
4. 在一次宿主事务中写入全部 updates，统一记录来源／保护／实际执行回执，
   然后才交回效果控制机和既有昏厥流程。保护挡住的份额不返还预算、不重选、
   不改派给其他目标。该游戏内部分失败与非法回答的整笔拒绝是两回事。

`frozenProtection` 每个候选都必须有显式 true／false，且与窗口同源、同池；
缺失／unknown 不是 false，客户端不得提供权威 mask。数值溢出必须在写入前
整笔拒绝，不截到 HP 或软件最大值。纯模块不得直接改状态、HP、RNG、历史或 KO。

**零与空池是可实现的分支，不依赖 C08 裁定：**

| 第一子集情形 | 招式效果 | 只含此效果的普通物品／支援者／主动特性 |
| --- | --- | --- |
| `count === 0` | 不提示选目标；空 allocation，0 放置，performed=false | 可预知不会变化，不可使用 |
| `count > 0`、候选池空 | 无可执行的放置部分，不扣／加任何东西；其他招式内容照常 | 无对象且可知无变化，不可使用 |
| `count > 0`、池非空，静态来源适用明确且全部受保护 | 仍须足额分配；实际放置 0，performed=false | 整段确定无变化，**禁止使用，不是 needsRuling** |
| `count > 0`、池非空，有可实际执行的份额 | 必须足额分配；整批冻结保护后放置可执行份额 | 宿主按完整卡文检查使用资格，不仅检查候选池非空 |

复合训练家有其他可执行内容时，由完整卡文／使用门槛审核处理，不把本节的
单效果资格结论错误扩大成整卡禁止。`count=0` 不需要让未来的 any/upTo 语义先落地。
表中不含道具／竞技场本身的普通放置；放置本身可能造成变化，不能因其某段
指示物效果为 0 就禁止使出。补读的 USE 依据见第 1 节。
第一子集计划结果可记 `selectedTotal=0`、`placedTotal=0` 来表达空池略过，
但必须另记 `noTargets` 原因；不能把这个例外伪装成“有目标时允许欠分配”。

第一子集的最小独立 oracle：N=0..5、0..3 个目的，枚举全部总和为 N 的分拆
及目的保护位图；拒绝总和 N-1／N+1、重复／未知 ID；逐次恢复选择期间 counters
不变；验证保护全部冻结后才执行、整批回执与 then、零值资格、超 HP、数值溢出
无半写入。C08 的任何未决只阻止 C08 路径，不阻止这些 C07 用例。

## 1. 固定 primary 原件与实际核读范围

原件为既存忽略缓存：

`/home/zhn/pokemon-tcg/.cache/rules/sources/CN-advanced-3.1.0-27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419.pdf`

| 项目 | 实际核验结果 |
| --- | --- |
| 文档 | 《宝可梦集换式卡牌游戏 进阶玩家向规则指南》Ver.3.1.0 |
| 登记身份 | `CN-advanced-3.1.0`；规则集 `CN/V20261019` 是项目快照，不是官方文件版本号 |
| 原始字节 | 910379 字节；76 页 |
| SHA-256 | `27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419` |
| 本轮方法 | `sha256sum`；以 `PYTHONPATH=/tmp/pokemon-tcg-rule-pdf-reader` 的 `pypdf` 实际读取下表各页 |

**以下全部是从 1 开始的 PDF 页序**，不是从 0 开始的 reader 索引。
只作短语定位和释义，不复制正文或卡面图，不把原 PDF 纳入 MIT 分发。
本轮官方 CDN 在线取读尝试超时，未取得可比较的在线响应；
本文件的证据来自上述本地固定原件，不声称重新验证了线上最新文件或勘误。

| 证据键 | 章节／一基页码 | 实际读到的要点与适用边界 |
| --- | --- | --- |
| USE | I.A-02 p8；I.B-01 p11；I.B-03 p12（补读；另读相邻 p9） | 主动特性、普通物品和支援者的使用条件：宣告前即可判断执行说明文不会产生任何变化时不能使用；不靠“把来源卡弃掉”制造使用资格 |
| A | II.A，p19 | 卡文／更新说明优先；禁止优先；不可执行部分略过；指定数不可任意缩小；对象不足按最接近数执行；特定连接文另有约束 |
| C07 | II.C-07，标题在 p29，正文 p30 | 一个指示物代表 10 点；按指定个数放置；可将一个总数任意分配；招式放指示物属于步骤 5 的效果，不是伤害 |
| C07P | II.C-07 FAQ，p30 | 受招式效果保护者仍可被选为放置对象，但不会因该招式实际增加指示物 |
| C08 | II.C-08，p30–31 | 转放已有指示物；指定数、所选一只的全部，以及跨场上宝可梦选择任意数量再任意转放均有文例；没有指定目的宝可梦则不能转放 |
| C08P | II.C-08 FAQ，p31 | 目的受招式效果保护时仍可选；已从原宝可梦移除的指示物不放回，目的也不获得它们 |
| C17 | II.C-17，p37–39 | 保护针对步骤 5；p38 将放指示物列作不受影响的效果；p39 说明后来取得保护不消除此前已经存在的效果／特殊状态 |
| D02 | II.D-02，p42–43 | 任意数量；并列有训练家／特性因无法选择任何卡牌而确定无变化时不能使用的条件 |
| D03 | II.D-03，p43 | 所有／全部是一个不剩地选择指定对象 |
| D04 | II.D-04，p43–44 | 必须选足指定数，不足选最近数；位置上不存在则不能选择；多种对象各自处理；训练家／特性另有无对象且无变化的使用门槛 |
| D05 | II.D-05，p44 | 通常在 1 到上限之间选择；隐面区域另参专门条款；训练家／特性也受上述使用门槛约束 |
| D06 | II.D-06，p44–45 | **不是数量条款**，而是卡上“拥有”的招式等身份；效果获准使用的招式不因此成为卡上拥有的招式 |
| THEN | II.E-19，p62–63（补读） | 前文至少有一部分实际执行才继续“然后”；不是必须全部成功，也不是仅选了对象就成功 |

需要注册新条款时，`sourceOfTruth` 使用现有 `documentId / section / pdfPages`
结构并经来源登记解析到此哈希。例如总数分配应至少包含 C07、A、D04；
任意数量转放应再包含 C08、D02；目的保护丢失必须含 C08P。
不能只挂一个宽泛 `damage.counters` 就声称所有新分支都有证据。

## 2. 数量语义：分清“几个指示物”和“几只宝可梦”

### 2.1 总量边界

设 `N` 为卡文指定的指示物个数，`A` 为选择时实际已有且可用于该指令的
指示物数。`A` **不是来源宝可梦只数**，也不是剩余 HP 除以 10。

| 语义 | 转放已有指示物的选择边界 | 简中依据／解释 |
| --- | --- | --- |
| `exact(N)` | 只能选 `min(N, A)`，不能主动少选 | A、D04；有 2 个却要求转 3 个时转 2 个，不制造第 3 个 |
| `upTo(N)` | 有可选指示物且上限为正时选 `1..min(N,A)`；没有可选物时实际为 0 | D05；不能套用国际版“最多通常可选 0”的默认 |
| `any` | 协议采用 `0..A` | D02 的任意数量解释，与现有 `selectionBounds` 一致；p42–43 没有另外逐字列出 `0..A` 的数轴或零选 FAQ |
| `all` | 选定范围已有的全部 `A` 个 | D03；C08 的七夕青鸟文例明确是先选一只自己的备战宝可梦，再转其全部指示物 |

`any` 的零下界是明确公开的术语解释，不能把现有代码或测试当成新 primary
裁定；某张卡“零选仍可宣告／仍执行后文”等额外交互须独立审核。
选择数量为 0，与该训练家／特性是否可以开始使用，是两个不同问题。

**新放置的总量没有“来源现存指示物 A”的上限。**
例如放置固定 5 个，在有目标时合计分配必须为 5，不是每只各放 5 个；
只有 1 只目标也可分给它 5 个。不能把宝可梦只数传给
`selectionBounds({available: ...})` 当指示物库存。受到保护的份额仍占据已选总量，
实际放置阶段可能损失，不自动改派。没有目标则没有可执行的放置部分，
不是向不存在对象写入指示物。`upTo / any` 只有在获审卡文确有对应量词时启用，
不因 API 可表达就改写一个固定总数。

**目标只数独立。** “选择 1 只，转其全部”必须先选那一只，不能把全场合计
当成 `all`；“选择场上指示物中的任意数量”则是整个限定池的指示物选择，
不是先任意选一只。也不把“以任意方式”误译为可缩小固定总量。
有足量可选对象时，不能因其中一只受保护就降低 `exact` 的选择数。

### 2.2 零、空池与使用资格

- `exact(0)` 或计算结果为 0 是零效果，不凭空要求选 1 只；静态真实卡通常
  是否允许印出该参数，是卡文审批问题。`upTo(0)` 不属于 D05 明确的正上限
  文例，建议静态描述拒绝，动态变 0 的真实卡组合另核。
- 转放没有来源指示物时 `A=0`；没有指定目的时 C08 明确不能转放，
  **不先扣来源再发现无处可放**。招式仍可执行其他伤害／效果，依 A 处理。
- 训练家／特性：若没有任何可选对象而可预先确定整个使用没有变化，
  D04／D05 禁止使用。必须审查完整卡文、其他部分和费用后局面，
  不是看到本原语空池就一概禁止整卡。
- 能选择一个受保护目标，不等于该目标实际受到效果；反过来，
  `someUnprotectedTarget === false` 也不等于“没有可选择对象”。
  D04 的“无对象”门槛不能独自代替完整使用资格。结合 USE，
  若保护适用本身已有证据、主动使用只有本段且可以确定全部被防止而无变化，
  则明确不能使用，不是未决。其他效果若已确认可执行，按完整卡文及 A 处理，
  不因存在其他效果就一概未决；只有来源适用未知、效果间依赖未明、
  付款后的动态变化缺依据等具体组合才保留 `needsRuling`。
- 获准使用的 `any` 指令可以提交显式零选；这不授予“本来无法使用的训练家也可
  先使出再选零”的权限。`optional` 是独立的整段执行／跳过选择，
  不把 `exact(5)` 改成任意 `0..5`，也不免除使用条件或费用。

### 2.3 全部候选受该来源保护：主动宣告资格独立复审

**结论：对只有本段放置效果、全部候选明确不受本次来源效果影响，
且宣告前就能确定执行说明文完全无变化的普通物品／主动特性，明文通则禁止使用；
不应把这个已确定情形继续列为 needsRuling。** 支援者也有同样通则。
这里“候选仍然存在”与“实际结果无变化”可同时成立，并不冲突。

本次重新核读同一固定哈希原件的 p8–9、p11、p19、p29–30、p37–39、
p43–44，另复读 p12 的支援者条款。确切定位如下，均为一基 PDF 页码：

| 定位 | 原文规则的实际范围 |
| --- | --- |
| **I.A-02 p8**，“宣告使用特性的步骤”之 **1 的末段**，在普隆隆姆文例之后、步骤 2 之前 | 独立于“无法满足使用条件”的限制，另禁止宣告前可判断执行步骤 2 后完全不会发生变化的特性；**没有把此限制缩成“无法选择对象”** |
| **I.B-01 p11**，“使用物品卡的步骤”之 **1 的最后一句** | 使用前可判断执行步骤 3 后不会有情况变化，就不能使用物品；不是只有没有合法目标才禁止。步骤 2 的使出展示、步骤 4 的用后弃置不能拿来代替步骤 3 的效果变化 |
| **I.B-03 p12**，“使用支援者卡的步骤”之 **1 的最后一句** | 同样以执行步骤 3 后的情况变化判断，不由“至少有一只可选对象”取代 |
| **II.D-04 p44**，D-05 标题前的最后一项 | 专门叙述因无法选择任何对象而可知无变化时不能使用训练家／特性；是较窄情形，**不是上述无变化禁令的唯一成因或反向许可** |
| **II.C-07 p30 FAQ 第一段** | 招式效果保护不禁止选择该宝可梦，但阻止实际放置；**没有授予主动特性／物品绕过其自身使用门槛的许可** |
| **II.C-17 p37 第一项、p38 放指示物的例子** | 明确招式效果保护阻止步骤 5 的相应效果；p39 讨论的是已有作用不会因后来取得保护而消失。该章节本身不证明某种招式保护也适用于训练家／特性来源 |
| **II.A p19 第三项** | 有部分无法执行时执行可执行部分；不是“整段预知完全无变化时，主动特性／物品仍可使用”的豁免 |

这是**把明文使用通则应用到题设已明确的保护事实**，不是声称另找到一条
逐字谈“全受保护目标＋主动放指示物”的专门 FAQ。需要分开验证两件事：

1. **来源适用事实**：全部候选确实对这一次真实 source 的效果受保护。
   C07／C17 的招式保护不能仅凭名称扩成 Ability／Trainer 保护。
   若适用本身缺少简中依据，未决的是这个前提，不能伪造为已明确全保护。
2. **完整效果结果**：本次只有放指示物，或其他部分也确定不能产生变化。
   仅本段被挡、但另有可执行抽牌等内容时，不能据此禁止整次使用；
   特定卡文改写、费用后的保护变化、自动特性和道具／竞技场放置均不由此一概判定。
   I.A-02 p9 明确自动生效特性与玩家宣告使用的特性不同。

**原始复审时的实现问题记录：** 对当时用户报告的
`canUse = count > 0 && targets.length > 0`：
**这个谓词本身只证明有正总数和可选对象，不足以证明主动使用资格。**
若它是仅放置效果的普通物品／主动特性的唯一门禁，那么题设全保护且无其他变化时
仍会通过，与上述无变化禁令不符；若上层另有完整门禁，则需另审该上层，
本次没有查验或追认现有实现。主要使用 attack 来源的 runtime 保护测试，
不能证明 Trainer／Ability 的主动宣告门槛正确。

**后续接线注：** 父线已亲读 p8／11／12 并确认上述结论，
反馈 Stage23 native 宿主已加入 source-aware 的无变化资格检查；
候选纯函数仍只处理可选范围。前段谓词不足的分析保留为历史，
不再当作修正后宿主的当前实现描述；完整验收仍由父线完成。

使用资格检查与正式选择池应保持分离：拒绝已经确定整次无变化的主动使用，
**不等于从获准效果的可选池剔除受保护者**。招式不套用上述主动物品／特性禁令；
能合法使用的招式仍可选择受保护者，并在实际放置时被挡。
本次只读原件并增补本节，没有运行测试、修改代码／schema 或更改卡牌审批。

## 3. 可选、实际移除与实际放置必须分别记录

| 情形 | 选择层 | 实际结算层 | 证据强度 |
| --- | --- | --- | --- |
| 普通放置 | 在卡文限定的场上对象中完整分配总数 | 未受对应来源效果保护者增加分配数 | C07 |
| 向受保护目的放置 | 仍可将份额分给它 | 增加 0；份额不转给其他目标 | C07P；不改派是固定完整选择协议的设计结果 |
| 正常来源转向受保护目的 | 目的仍可选 | 来源移除 `q`，目的增加 0，记录丢失 `q`；不返还、不重选 | C08P 明确 |
| 没有指定目的 | 不产生可提交的正数转放计划 | 来源不移除，目的不增加 | C08 |
| 来源本身受保护，或多来源只有部分可移除 | 不可借目的 FAQ 得出来源结论 | 暂不猜测扣除、跳过、重选或补足；返回 `needsRuling` | C17 有一般保护规则，但本次未读到 C08 对这些组合的直接处理 |

保护必须匹配**这次效果来源**：招式／特性／训练家、持有者及保护的适用范围。
C07/C08 的招式 FAQ 不能冒充已经证明所有特性或训练家种类的保护交互；
其他来源的保护需要自己的获审依据。防伤害与防效果是不同通道，
弱点、抗性、防伤害量与 `ignoreDefenderEffects` 这类伤害计算参数，
不能拿来扩大或抵消指示物效果。恢复保护不回滚已移除／已放置的事实。

在已解析的普通来源、互不重叠的来源／目的池中，可按每条分配应用上述目的保护
规则，先算出全部净变化再提交。这是通则的组合化设计，不声称指南为每一种
多源保护矩阵都给了 FAQ；涉及未明说依赖时见第 7 节。

## 4. 后续全量 API／schema 设计（不作为第一子集的前置条件）

第 0 节的 `distributeCounters` 保持固定数扁平结构。
后续动态／多量词设计暂称 `distributeCountersV2`，转放暂称
`redistributeCounters`；名字是设计占位，不是现有导出或生效的 schema。
不要静默扩大第一子集或现有 `counters / transferCounters` 的含义；
任何不在第一子集的 action 均不得由该模块降级执行。

### 4.1 静态指令

```json
{
  "op": "distributeCountersV2",
  "quantity": { "kind": "exact", "value": { "kind": "fixed", "count": 5 } },
  "recipients": {
    "side": "opponent", "position": "any",
    "selector": { "kind": "pokemon" }, "distribution": "arbitrary"
  }
}
```

```json
{
  "op": "redistributeCounters",
  "origins": {
    "side": "opponent", "position": "any",
    "selector": { "kind": "pokemon" }, "pick": "counterPool"
  },
  "quantity": { "kind": "any" },
  "recipients": {
    "side": "opponent", "position": "any",
    "selector": { "kind": "pokemon" }, "distribution": "arbitrary"
  }
}
```

需要明确的互斥字段和条件约束：

1. `quantity` 的 `exact / upTo` 必须有 `value`，`any / all` 禁止有它；
   每个数的单位都是 **10 点制指示物个数**，不是伤害点或实体标记物枚数。
   `all` 只适用于已有指示物转放；新放置不能凭空指定“全部”。
   没有来源库存或其他获审有界总量的新放置 `any` 也不在本提案可执行范围，
   不能把它解释为玩家凭空选择任意大整数。
2. `CounterCountValue` 首批可只支持 `fixed` 与明确的
   `{kind:"publicCardCount",side:"opponent",zone:"discard",selector:{kind:"pokemon"}}`。
   后者表达 C07 花岩怪文例的总量来源，由宿主在**该条效果实际开始选择时**
   从真实弃牌区读取一次，并冻结到窗口；不是运行任意 JS、相信玩家报数，
   也不是把尚不支持弃牌区计数的现有 BattleValue 假称已经支持。
3. `origins.pick:"onePokemon"` 先选择一只符合范围的来源；数量的库存只来自它。
   `pick:"counterPool"` 从明确限定池挑选指示物，可以来自多只。
   `all + onePokemon` 对应 C08 七夕青鸟形状；`any + counterPool`
   对应卡璞・蝶蝶形状。API 能拼出的其他组合不自动获批。
4. `origins.side` 与 `recipients.side` **独立且相对实际效果持有者**。
   不沿用旧 `from:"any"` 暗含“己方一只”的假设，也不把“任意来源”理解为
   可以超出卡文跨双方取物。首批只定义显式 own／opponent；更宽范围另审。
5. `distribution:"singleRecipient"` 需选择一个共同目的；
   `"arbitrary"` 允许将总量拆分给多个目的。`position` 与 CardSelector
   是候选范围，不是指示物数；受保护者不从候选范围剔除。
   若卡文另限定目的只数，应增加独立的宝可梦选择字段，不借用总量字段。
6. `optional` 继续用现有外层控制节点，不藏在数量下界中。只有审核后的
   binding 才能生成新操作；完整静态树，包括不执行分支，都要严格验证。

选择器复用现有 CardSelector 身份谓词及 `matchesInPlaySelector`：
卡名、阶段、卡面 HP 等保留原意；在场属性匹配读取宿主提供的有效属性。
不能把卡面 `printedHpAtMost` 偷换成当前剩余 HP。
`onePokemon` 的零指示物候选和后续零总量若涉及强制前置选择，须保留卡文层级；
没有专门依据时返回第 7 节的零选组合未决，而非擅自删去这个选择。

### 4.2 权威窗口、选择载荷和结果

```js
prepareCounterWindow(ctx, action);
// resolved: { status, window, sourceOfTruth }
// 未决: { status: 'needsRuling', window: null, reasons, sourceOfTruth }

assertCounterChoice(window, choice); // 严格结构、范围、总量、库存、归属
planCounterDistribution(window, choice, protectionFacts);
// resolved: { status, updates, selectedTotal, removedTotal, placedTotal,
//             lostTotal, performed, sourceOfTruth }
// needsRuling 不含可执行 updates，不能降级为 0 或 false。
```

窗口至少绑定：唯一 `choiceId`、规则集、原始 `source`、`programId`／效果步
标识、选择者、回合与起始 revision、静态 action、选定时的数量值／边界、
完整候选池及每只 `{pokemonId, owner, topCardId, counters}`。
使用实际 `pokemonId`，不是显示名称或 definitionId；所有对象都是普通、
密集、无 getter 的 JSON。原始 `sourceOfTruth` 追溯到第 1 节固定原件。
原始窗口一旦打开不能随每个回答的 revision 漂移；宿主另核对命令当前 revision，
确认期间只有本窗口的合法选择步骤。

建议新命令分支，不把数值塞入现有 `answer.selected: string[]`：

```js
{
  player: 0, expectedRevision: 42,
  action: {
    type: 'answerCounterDistribution', requestId: 'q-counter-7',
    choice: {
      choiceId: 'counter-7',
      originPokemonId: null, // onePokemon 模式必须是选中的实际 ID
      targetPokemonId: null, // singleRecipient 模式必须是共同目的 ID
      placements: [],        // 仅新放置使用 {targetId, count}
      transfers: [
        {originId: 'mA', targetId: 'mC', count: 2},
        {originId: 'mB', targetId: 'mC', count: 1}
      ]
    }
  }
}
```

以上只是“有向分配矩阵”的载荷示例，不是已获准的真实卡场景。
放置／转放载荷严格互斥；不用的数组必须为空，空值字段含义固定。
所有条目 count 为正整数，重复目的放置条目或重复 `(originId,targetId)` 条目
拒绝，不能靠重复项多取库存；省略的条目表示 0，显式零总量使用空数组。
`counterPool` 不另接受可伪造的来源扣除表：每只来源扣数由其出边之和导出。
`onePokemon / singleRecipient` 必须与相应 selector 字段一致。
普通单来源转放有 C08“其他宝可梦”的限定，不能靠零净变化冒充移动；
但任意多源重分配中的同一主体回流，不由此推断其全部合法性或禁止范围，
统一留作 `needsRuling`。来源／目的池交叠的其他组合另见第 7 节。

一次提交整张矩阵最简单；UI 也可以分多步收集数量、来源与目的，但这些步骤
只更新私有草稿。必须在所有份额齐备后进行**一次完整校验和提交**。
不为每个指示物制造虚假卡牌实例，也不枚举 `0..N` 作为字符串选项。

## 5. 状态不变量与原子结算

**先完整选择，再同时执行**是本方案的宿主提交约束：
本次核读没有发现一句可直接外推为“任意重分配复杂组合均已裁定”的同时性条文。
它用于防止 UI 选取顺序变成游戏效果顺序，不替代缺失的卡牌裁定。

设选择前每只的指示物为 `C_i`，转放矩阵为 `X_ij`，放置向量为 `P_j`；
以下公式只适用于规则已解析、来源可实际移除的窗口：

```text
R_i = sum_j X_ij                         // 本次实际来源移除
I_j = sum_i X_ij                         // 给目的分配的份额
B_j = 对该来源效果的目的保护布尔值
Q_j = B_j ? 0 : I_j                      // 实际转入
C'_k = C_k - R_k + Q_k                   // 整批净结果
lost = sum_i R_i - sum_j Q_j

新放置时：C'_j = C_j + (B_j ? 0 : P_j)
```

1. **选择前不改状态。** 所有份额尚未齐备、等待回答、撤销 UI 草稿或序列化恢复时，
   场上 counters、HP 派生值、历史与 KO 致因都不得出现半扣半加。
   窗口以独立可信记录锚定到获审 binding／执行帧；篡改窗口与日志一起不能自证。
2. **总量和库存。** `sum(P)` 或 `sum(X)` 符合 quantity；
   每个 `R_i <= C_i`，按同一选择前快照核验。不能把本批刚收到的指示物再次
   作为来源库存，也不能先扣完才用 `Math.max(0, ...)` 掩盖超取。
   新放置没有来源扣除；转放不足按 A／D04 的数量规则处理，不把请求 3 个
   的不足池 2 个输入当错误，也不接受有 5 个却只交 2 个。
3. **保护与部分执行。** 正式提交前取得整批适用的保护事实并预计算所有更新。
   已证实的目的受保护是游戏内部分不执行：来源照扣、目的不加、损失显式记录，
   不是整条事务回滚。来源保护等未决不能套这个公式。
4. **事务失败不同。** 非法选择、过期请求、超量、无法精确表示的数值、
   未决裁定或恢复锚定失败，在任何写入／日志／RNG 消耗前拒绝；
   不允许先完成前几条边再抛错。通过后一次写入所有 `C'_k`。
5. **没有 HP 容量上限。** 可以放置超过剩余 HP 的指定指示物；
   不按致死所需数裁剪。每只计数保持非负安全整数，当前软件还需保证
   `count * 10` 可精确表示（既有每只上限 `900719925474099`）。
   汇总／矩阵求和用精确整数，例如 BigInt；序列化仍符合已选的严格数值协议。
   表示溢出是软件边界错误，不是官方库存不足，不能缩小指定总数来迁就它。
6. **来源不是指示物的卡牌身份。** 效果 `source` 包括实际持有者、物理实例、
   category、effectId、来源证据及适用的复制／授予上下文；来源宝可梦则是
   `originId`。二者不得混同。指示物是运行时数值，没有卡面字段或逐枚归属 ID；
   转放不要求追溯每枚最初是哪次伤害留下的。
7. **HP 单一事实源。** `CardDefinition.mechanics.hp` 始终为卡面最大值；
   权威存档只保留运行时 `pokemon.counters`。当前有效最大 HP 由卡面与有效效果
   计算，剩余 HP 为 `max(0, effectiveMaxHp - counters * 10)` 的派生视图。
   不缓存“当前 HP”到卡面／事实包，不因转移或回复回写定义，不混用两张同定义实例。
8. **实际执行回执。** 放置 `performed = placedTotal > 0`；
   普通转放 `performed = removedTotal > 0`，即使 `placedTotal=0`。
   仅选择、零选、全部放置被保护均不能伪称执行成功。
   C08 的移除不是 C06 的“回复 HP”，不自动发出 healing 事件或触发伤害事件。
   净变化相消的重叠／循环不据此直接下结论，见第 7 节。
9. **整批后继续流程。** 更新 KO 致因时保持原效果 source；重新检查受影响的
   全局有效 HP／昏厥事实，不在每个选择或每条边之后拿奖赏、清除来源或触发新动作。
   后续按既有招式效果／特性／训练家结算及昏厥边界接线；`then` 使用实际
   performed，不把本原语选过目标当成成功。不在这里重写通用执行树或 healing。

## 6. 现有代码接点与不能冒称的能力

下表是**原始报告冻结时**读取到的函数／字段接点，不作为 Stage23 当前状态声明；
后续 C07 接线历史见第 0／2.3 节。并行工作中行号会漂移。

| 现有文件／接点 | 实际现状 | 后续建议，不代表本轮已做 |
| --- | --- | --- |
| [game.js]：`runEffect` 的 `counters` 分支 | 一次选一只，用固定 `a.count`；按 `effectBlocked` 跳过被保护者 | 新总量操作独立接入，不能循环调用旧操作模拟任意分配 |
| [game.js]：`runEffect(transferCounters)` | 来源限定效果持有者一方的一只；`from:any` 不等于跨多来源；`count` 固定 | 新操作需独立 origins.side、池化库存、完整分配回执 |
| [game.js]：`transfer-target` | **选来源后立即扣数，再询问目的**；现有测试还断言了这个中间态 | 与新协议完整选择前不改数的要求不同；旧恢复协议须显式迁移／版本处理，不能声称已经原子化 |
| [game.js]：`destinations`、`effectBlocked`、`addCounters` | 无目的时不列来源；目的保护不返还；来源保护当前直接结束；单次加数会记录致因 | 重用来源解析与保护依据，但来源保护的代码路径不能当缺失裁定的证据；批次需先完整规划 |
| [selection.js]：`selectionBounds / canSelectCount` | public exact 不足尽量；upTo 通常至少 1；any 含 0；all 取全部 | 复用量词，但 available 必须是对应单位，不是总用宝可梦只数 |
| [effects.js]：`assertEffectProgram / completeEffectStep` | 静态树验证；明确 performed 驱动 then | 新操作完成一次才向该控制机报告一次结果 |
| [handlers.js]：`cn.counters@1 / cn.transferCounters@1` | 固定数 handler，canUse 检查候选对象／现存计数；没有多源分配协议 | 新 handler 与完整使用资格证明分开审核，不静默扩展旧版本 |
| [S-fx]：`action / resolution` | 现有 fixed count；`selected` 是 ID 数组；`originId / removed / transfer-target` 仅支持旧单源中间态 | 新 typed action／choice／plan；互斥分支、来源范围与总量字段全严格化 |
| [S-command]、[S-state] | 普通 answer 只有 string ID 数组；pending／effect-choice 要满足各自 schema | 添加数字分配命令及可恢复窗口，不能仅绕过命令校验写内部 queue |
| [in-play-selection.js]、[S-card] | 卡面／有效属性／运行时事实已分离 | 保持 printed HP、有效属性及 counters 各自来源 |
| [effect-execution.js] | 并行工作正在接通程序身份／continuation 回放 | 后续父端将新 choice 锚到该机制；本文件不修改其代码或宣称整体验收 |

原始冻结时 [T-effects] 有 `counter transfer removes the source counters...` 和
`core transfer/attachment legality...` 两个固定单源相关回归，证明的不是多源、
all、任意数量、完整分配恢复或本提案的原子提交。[T-selection] 的数轴测试也
不能代替 `OfficialGame` 对完整分配命令的集成测试。

## 7. 扩展组合必须显式传播的 needsRuling

以下是本次固定原件不足以直接确定的**组合边界**，不是国际／日版默认值的入口。
未决结果携带具体 reason 和已核读证据，不能静默变成“不能用”“什么也没做”。
它们不撤销第 0 节 C07 固定总数、完整选择／冻结保护／整批提交的可实现范围；
尤其 C08 多源任意数量和同一主体回流可以整体留在后续阶段。
**静态来源适用已明确且完整主动效果确定无变化的全保护情形，是 USE 明确禁止，
不列入本表。** 其他效果已确定可执行时也不因本段被保护而自动进入未决。

| 建议 reason | 未明说的问题／暂不采取的默认 |
| --- | --- |
| `protected-origin-transfer` | 来源受适用保护时怎样处理来源移除；目的 FAQ 不等于来源 FAQ |
| `partially-blocked-origin-pool` | 多源部分不能移除时，是否重选、从其余来源补总量或只执行可移除份额 |
| `overlapping-counter-pools` | 来源／目的范围交叠、同一主体回流、交叉转放、循环、相同最终局面；不从串行扣加猜规则或使用资格 |
| `counter-dependent-protection-timing` | 同一批计数变化会改变保护、最大 HP 或另一只可适用性时的精确检查时点；原子设计本身不是官方优先序证据 |
| `unknown-protection-applicability` | 缺少对实际 source 类别／持有者／范围适用的依据，尚不能确定哪些目标真的受保护；不是“已确定全保护”的未决 |
| `unresolved-composite-activation` | 其他效果与本段的具体执行依赖尚无依据，导致完整主动使用是否有变化不明；其他效果存在本身不是未决理由 |
| `post-payment-protection-dependency` | 付款可能动态改变保护或候选可用性，且现有证据不足以解析该具体依赖；不影响静态可判断的 C07 第一子集 |
| `zero-with-mandatory-selectors` | onePokemon／singleRecipient 等强制前置选择与零库存／any 零选相遇；不擅自跳过卡文强制选择 |
| `zero-and-card-specific-continuation` | 特定卡文零选能否开始使用、费用／触发／后文是否成立；不是一般 D02 数轴或 THEN 回执可包办 |
| `unreviewed-counter-composition` | 尚无获审简中卡文支持的数量／来源／目的组合、其他来源保护或替代／特殊触发；不凭 schema 可表达就执行 |

来源本身保护的普通 C17 推论可以作为申请补裁定的方向，但在缺乏更具体依据前
不升级为 C08 已证实事实。其余清楚的通则（例如 exact 不足尽量、目的保护丢失、
没有目的不转放）不应反过来全部降成未决。

## 8. 独立 oracle 与集成验收清单（原始跨阶段计划）

以下为原始报告冻结时拟定的跨阶段清单。Stage23 已落地的子集及其完整验收，
以父线实际交付为准；本文不重新核验，也不将整份清单一概宣称为尚未编写。
不要令 oracle 调用待测的 `selectionBounds / planner / effectBlocked` 得出期望值。
数量用手写真值表；放置枚举整数分拆；转放枚举小矩阵并独立检验行库存／总和，
用不同表达式计算期望净变化。所有真实文例只用合成状态模拟相应语义，不冒充整卡审批。

1. **数量数轴**：`N=1..4, A=0..5` 的 exact／upTo／any／all 穷举；
   exact 足量拒绝少选、不足尽量；public upTo 足量拒绝 0；any 明确接受零；
   optional exact 只放行 0 或完整数，不放行中间数。
2. **总量不是逐只数**：固定 5、三只目的的全部非负整数分拆；
   单目标全收、多个目标拆分、无目的；不同 targetIds 顺序不改结果。
   剩余 HP 10 仍可放 5 个，不截到 1 个。
3. **来源库存**：库存 `[2,1]`、正数目标组合的所有合法小矩阵；
   exact(5) 只能取 3；有 3 却只交 2 拒绝；同一来源多边累计超取拒绝；
   新转入不得为本批补充可转库存。
4. **一只全部与池化任意**：选中来源 2 个、另一只 4 个，all-one 只转 2；
   pool-any 可按总选择数从多只取；己方／对手来源与目的分别核对，
   不把旧 from:any 当成多源实现。
5. **保护笛卡尔积**：目的保护／防伤害独立；来源类别／持有者匹配；
   普通来源转 3 至受保护目的，期望 removed=3、placed=0、lost=3；
   混合目的按预定份额损失，不补给其他目标；来源保护等必须返回未决。
6. **空池、零与资格**：无目的不扣数；没有指示物不制造库存；
   零选择无 performed；训练家／特性全卡确定无变化时不进入使用，
   招式仍执行可执行部分；全保护使用资格不能伪装成无对象断言，
   但 USE 的已知整次无变化禁止仍须执行；道具／竞技场普通放置另测不误禁。
7. **先选后改与部分执行**：在每个选择边界恢复存档，完成前所有 counters
   与选择前相同；未选全、重复回答、撤回草稿均不造成半扣。目的保护则
   正常完成来源扣除，不被误当成事务失败回滚。
8. **then／事件／KO**：纯放置全被挡则 false；转放目的被挡但实际扣来源则 true；
   部分执行继续 then；不产生 attackDamage／heal 事件；完成整批前无逐边 KO，
   完成后既有流程处理同批昏厥、有效 HP 变化和原始效果致因。
9. **来源／恢复抗篡改**：错 player、requestId、revision、source、programId、
   effectId、topCardId、池／数量快照、改名回执、重复消费、遗漏计划、换 binding
   都拒绝；只改日志和窗口不能绕过宿主目录／执行锚定。恢复不重新随机选择。
10. **schema／数值负例**：负数、小数、字符串、NaN／Infinity、重复矩阵边、
    显式零条目、混合两类数组、未知字段／操作、getter／稀疏数组、越界 ID、
    大整数求和溢出，均不能强制转换成合法零或产生任何半写入。
11. **属性与事实分离**：两张同定义卡不同 counters；卡面 HP 100、有效最大 150、
    counters=3 时剩余 120；移除增 HP 来源后剩余 70、counters 仍 3。
    总量读取在本条效果的窗口读取一次，不在每个分配条目后重算。
12. **未决稳定性**：第 7 节每个 reason 均有正例；结果不带 updates，
    不修改状态／RNG／公共历史；不能被调用方转成 0 或 false 并继续 then。

### 历史定向验证与本次复审边界

- 原件字节哈希、字节数、76 页及第 1 节页码已本地核对。
- 前轮运行只读定向基线：
  `node --test /home/zhn/pokemon-tcg/tests/official-rules/selection.test.mjs /home/zhn/pokemon-tcg/tests/official-rules/effects.test.mjs`。
  **当时父端更新 generated 后重跑 34/34 通过（selection 17、effects 17），
  0 失败／跳过／取消。** 这是前轮两份既有基线的历史结果，
  不代表修正后 Stage23 的完整验收。
- 历史注记：首次运行时 selection 的 17 项通过，effects 曾因并行工作树中
  `schema-validators.js` 尚未导出 `validateEffectExecutionEvent` 而无法加载。
  此临时加载问题已不再是上述最新定向基线的当前结果；本工作者没有修改
  共享文件或生成器。
- 本次只统一文档结论及接线历史，**未运行测试**，未修改代码／schema／审批。
  第 4 节多源／动态 API 仍为后续方案；不以文档、旧单源测试或拒绝未决输入
  宣称这些扩展已经实现或整体目标完成。

[game.js]: /home/zhn/pokemon-tcg/public/rules/game.js
[selection.js]: /home/zhn/pokemon-tcg/public/rules/selection.js
[effects.js]: /home/zhn/pokemon-tcg/public/rules/effects.js
[handlers.js]: /home/zhn/pokemon-tcg/public/rules/handlers.js
[in-play-selection.js]: /home/zhn/pokemon-tcg/public/rules/in-play-selection.js
[effect-execution.js]: /home/zhn/pokemon-tcg/public/rules/effect-execution.js
[S-fx]: /home/zhn/pokemon-tcg/schemas/effect-program.schema.json
[S-command]: /home/zhn/pokemon-tcg/schemas/game-command.schema.json
[S-state]: /home/zhn/pokemon-tcg/schemas/game-state.schema.json
[S-card]: /home/zhn/pokemon-tcg/schemas/card-definition.schema.json
[T-effects]: /home/zhn/pokemon-tcg/tests/official-rules/effects.test.mjs
[T-selection]: /home/zhn/pokemon-tcg/tests/official-rules/selection.test.mjs
