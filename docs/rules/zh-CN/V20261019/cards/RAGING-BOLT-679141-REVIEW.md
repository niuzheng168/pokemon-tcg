# 猛雷鼓ex 赛事卡组（OmniTCG 679141）：逐卡审核记录

规则快照 **CN / V20261019**，审核日期 **2026-10-21**。可执行数据在
[`catalog/zh-CN/V20261019/raging-bolt.mjs`](../../../../../catalog/zh-CN/V20261019/raging-bolt.mjs)
（与嗨皮卡组共用的「巢穴球」CSVH1C 043/059 在 `csvh1c.mjs`），卡组在
[`decks.mjs`](../../../../../catalog/zh-CN/V20261019/decks.mjs) 的 `raging-bolt-679141`。
真实卡机制测试在 [`tests/cn-cards/raging-bolt.test.mjs`](../../../../../tests/cn-cards/raging-bolt.test.mjs)，
合成规则测试在 `tests/official-rules/{ability-conditions,bench-limit,dependent-effects,effect-count}.test.mjs`。

## 1. 审核标准

与 [嗨皮卡组记录](CSVH1C-PIKACHU-REVIEW.md) 相同：卡文以**本机卡图**为准逐项核对，
与同目录 `metadata.json` 交叉核对，不一致时以卡图为准；每条定义／效果／印刷绑定的
`sourceOfTruth` 写明官方商品页、卡图路径、完整 SHA-256 与图源。不再逐卡联网取证。
卡图审核由子 agent 分 4 批完成（每批 5—8 张，转为小 JPEG 后阅读），主会话只取文本差异。

## 2. 卡表来源（完整 60 张）

| 项目 | 内容 |
| --- | --- |
| 来源 | OmniTCG 简中赛事卡表 API：<https://omnitcg.top/api/v1/jz/deck/679141>（2026-10-20 取得） |
| 赛事 | 2026城市赛第四赛季 – 赤饱潮玩卡牌（上海），2026-09-27，256 人，**第 1 名**（玩家 Even）；名次：<https://omnitcg.top/api/v1/jz/tournaments/3632/rankings> |
| 官方卡组码 | `1YWQN15qdGfUr0xLTT`（同码卡表共用记录，页面示例玩家为 Nuts.修王，青岛 2026-10-18） |
| 赛制 | 标准（G/H/I/J）；`validateFormatDeck` 通过 |
| 限制说明 | 第三方汇总，印刷版本可能经其规范化；宝可梦简中官网不公开卡表（仅小程序）。每个印刷都在本机卡库找到对应卡图并逐张核对 |

合计：宝可梦 17、训练家 31、能量 12。

## 3. 商品与发售日（官方商品页）

官方页面不印系列代码；代码与商品的对应由 52Poké 导出与 MIK 归档的系列元数据交叉确认（全部一致）。

| 代码 | 官方商品 | 发售日 | 页面 |
| --- | --- | --- | --- |
| CSV1C | 补充包「亘古开来」 | 2025-01-17 | tcg/product/15585 |
| CSV2C | 补充包 奇迹启程 | 2025-03-21 | tcg/product/15556 |
| CSV3C | 补充包 无畏太晶 | 2025-05-16 | tcg/product/15519 |
| CSV6C | 补充包 真实玄虚 | 2025-11-07 | tcg/17555 |
| CSV7C | 补充包 利刃猛醒 | 2026-01-16 | tcg/product/19812 |
| CSV8C | 补充包 璀璨诡幻 | 2026-03-13 | tcg/product/20627 |
| CSV9C | 补充包 星彩晶璃 | 2026-05-15 | tcg/product/21383 |
| 151C | 补充包「收集啦151 旅」 | 2025-01-17 | tcg/product/15688 |
| 30thC | 补充包 30周年庆典（系列 `anniversary-30`） | 2026-09-16 | tcg/product/22237 |
| 30thDC | 30周年庆典 豪华卡组套装（`anniversary-30`） | 2026-09-16 | tcg/product/21608 |
| CSVE1C | 对战派对 共梦 上（活动限定） | 2025-02-28 | tcg/event/15558 |

CSVE1C 基本能量：官方页面未展示能量卡上的 CSVE1C 标记；共梦 上 的官方卡组说明（tcg/product/15551）
列出基本能量，MIK 对所有 CSVE1C 卡统一记为 2025-04-18（共梦 下）。两个日期都早于快照日，不影响准入；
这里取官方商品页日期并记录这一限制。

## 4. 逐卡结果

所有弱点 ×2、抗性 −30。卡图上有而 metadata blocks 缺失的标记（古代／未来／太晶、ACE SPEC 规则框）以卡图为准。

| 印刷 | 卡名 | 标记 | 张数 | 已核对的卡面要点 | 实现 |
| --- | --- | --- | --- | --- | --- |
| CSV7C 154/204 | 猛雷鼓ex | H | 3 | 基础 HP240 龙 古代；飞溅咆哮[无] 弃全部手牌、抽6；极雷轰[雷斗]70× 弃场上任意张基本能量，张数×70；无弱抗；撤退3；ex | `cn.discardHand@1`＋`cn.draw@1`（无然后，分别执行）；`cn.countedEnergyDiscard@1`＋`cn.damageValue@1`（`effectCards`） |
| CSV8C 161/207 | 猛雷鼓 | H | 1 | 基础 HP130 龙 古代；落雷风暴[雷斗] 对手1只，自身能量数×30（备战不计弱抗）；龙之头击[雷斗无]130；撤退3 | `cn.damage@1` 数值式 `30 × self.energyUnits` |
| CSV8C 028/207 | 厄诡椪 碧草面具ex | H | 3 | 基础 HP210 草 **太晶**（在备战区不受招式伤害）；碧草之舞：每回合1次，手牌1张基本草能量附于自身，然后抽1；万叶阵雨[草草草]30+ 双方战斗宝可梦能量数×30；火×2；撤退1 | 卡面规则 `cn.protection@1`(`benchOnly`)；`cn.attachThenDraw@1`(`target:self`)；`cn.damageValue@1` |
| 151C 151/151 | 梦幻ex | G | 2 | 基础 HP180 超；再起动：每回合1次，抽到手牌3张；基因侵入[无无无] 使用对手战斗宝可梦的1个招式；恶×2；斗−30；撤退0 | `cn.drawUntil@1`；`cn.copyAttack@1`（`energy:ignore`，GX/VSTAR 需裁定） |
| CSV2C 105/128 | 怒鹦哥ex | G | 2 | 基础 HP160 无；英武重抽：仅最初的自己的回合1次，弃全部手牌抽6，同名本回合限1；鼓足干劲[无]20 弃牌区最多2张基本能量附于1只备战；雷×2；斗−30；撤退1 | 特性条件 `firstOwnTurn`＋玩家共享键；`cn.attachDiscard@1`(`type:null`, `singleRecipient`) |
| CSV7C 033/204 | 铁斑叶ex | H | 1 | 基础 HP220 草 未来；快速游标：从手牌放备战时可用1次，与战斗宝可梦互换，成功则任意数量能量转附于自身；棱镜利刃[草草无]180 下回合不能用招式；火×2；撤退1 | 触发特性＋`cn.then@1`（`switch affected:source` → `moveEnergy recipient:self`）；`cn.lasting@1` |
| CSV9C 053/208 | 古剑豹 | H | 1 | 基础 HP120 水；埋入雪中：从手牌放备战时可用1次，弃场上竞技场；冰柱环[水水无]120 自身1个能量回手牌；钢×2；撤退1 | 触发 `cn.discardStadium@1`；`cn.attachedEnergy@1`(`returnEnergy`, units 1) |
| CSV8C 135/207 | 吉雉鸡ex | H | 1 | 基础 HP210 恶；化危为吉：上一个对手回合己方宝可梦昏厥则可用1次，抽3，同名本回合限1；残忍箭矢[无无无] 对手1只100（备战不计弱抗）；斗×2；撤退1 | 特性条件 `previousOpponentKnockout`＋玩家共享键；`cn.damage@1` |
| CSV9C 078/208 | 拉帝亚斯ex | H | 1 | 基础 HP210 超；天际线：在场时己方所有基础宝可梦撤退能量全部消除；无限之刃[超超无]200 下回合不能用招式；恶×2；斗−30；撤退2 | `cn.energyRequirement@1`（retreat erase, `stages:[basic]`）；`cn.lasting@1` |
| CSV6C 082/128 | 爬地翅 | G | 1 | 基础 HP140 斗 古代；踏平[斗] 对手牌库上方1张弃牌；烫伤怒涛[斗斗]120 自伤90，对手战斗宝可梦灼伤；超×2；撤退3 | `cn.discardDeckTop@1`；`cn.recoilDamage@1`＋`cn.condition@1` |
| 151C 132/151 | 百变怪 | G | 1 | 基础 HP60 无；变身启动：在战斗场且最初的自己的回合1次，牌库1张基础（除百变怪）替换自身，弃置自身及附着卡，重洗；粘粑粑[无]10；斗×2；撤退1 | 条件 `firstOwnTurn`＋`sourceActive`；`cn.replacePokemon@1`（选择器 `excludeNameKeys`） |
| 30thC 101/103 | 高级球 | I | 4 | 只有弃2张手牌后才可使用；牌库1张宝可梦展示加入手牌，重洗 | 与 CSVH1C 044 同名同义，绑定同一定义 `cn:trainer:ultra-ball` |
| CSVH1C 043/059 | 巢穴球 | G | 4 | （见嗨皮卡组记录） | 原定义 |
| CSV6C 115/128 | 大地容器 | G | 4 | 物品 古代；弃1张手牌后才可使用；牌库最多2张基本能量展示加入手牌，重洗 | `playCosts` 弃1＋`cn.cards@1`；训练家 `tags:[Ancient]` |
| CSV8C 183/207 | 夜间担架 | H | 2 | 弃牌区1张宝可梦或1张基本能量展示加入手牌 | `cn.cards@1`（`anyOf` 选择器，恰好1张） |
| CSV2C 113/128 | 宝可装置3.0 | G | 1 | 查看牌库上方7张，1张支援者展示加入手牌，其余放回重洗 | `cn.cards@1`（`lookTop:7`, 重洗）。本机卡图位于 `CSV2C/113`（`113_128` 目录无图） |
| CSV1C 111/127 | 朋友手册 | G | 1 | 弃牌区最多2张支援者展示放回牌库，重洗 | `cn.cards@1`（discard → deck） |
| CSV3C 115/130 | 超级能量回收 | G | 1 | 弃2张手牌后才可使用；弃牌区最多4张基本能量加入手牌；不能选因本卡被弃的能量 | `playCosts` 弃2＋`cn.cards@1`(`excludePaid`) |
| CSV7C 180/204 | 顶尖捕捉器 | H | 1 | ACE SPEC；对手1只备战与战斗互换，然后己方战斗与备战互换 | `cn.then@1`；`deckLimits.groups` `cn-ace-spec` 上限1 |
| CSV6C 121/128 | 奥琳博士的气魄 | G | 4 | 支援者；最多2只「古代」宝可梦各附1张弃牌区基本能量，然后抽3 | `cn.attachThenDraw@1`（`recipient tagsAll:[Ancient]`, `separateRecipients`） |
| CSV9C 196/208 | 赤松 | H | 3 | 支援者；牌库属性各不相同的基本能量最多2张，展示后1张加入手牌，其余附于己方宝可梦，重洗 | `cn.attachDeckEnergy@1`（`distinctTypes`, `toHand:1`） |
| 30thDC 039/040 | 老大的指令（乌羽） | I | 2 | 支援者；对手1只备战与战斗互换 | `cn.switch@1`；副标题不属名称身份 |
| 30thDC 037/040 | 裁判 | J | 1 | 双方手牌全部放回牌库重洗，然后各抽4 | 与 CSVH1C 051 同名同义，绑定 `cn:trainer:judge` |
| CSV9C 207/208 | 零之大空洞 | H | 3 | 竞技场；场上有太晶宝可梦的玩家备战上限8；离场或无太晶时弃至5，双方都要时持有者先 | `cn.benchLimit@1` 与 `bench-trim` |
| CSVE1C GRA／LIG／FIG | 基本草／雷／斗能量 | — | 6／3／3 | 页脚仅印 GRA／LIG／FIG；LIG 与 CSVH1C LIG 卡图相同 | 基本能量；LIG 绑定既有雷能量定义 |

## 5. 新增机制与官方依据

| 机制 | 规则 ID | 依据 |
| --- | --- | --- |
| 特性使用条件（最初的自己的回合、在战斗场、上个对手回合己方昏厥） | `ability.condition` | I.A-02 p8、I.A-05 p10、II.E-11 p58—59、II.E-14 p60—61 |
| 「然后」／「如果成功执行…则」依赖前文实际执行 | `effects.partial` | II.A p19、II.E-19 p62—63（FAQ2：前文完全不能执行则不能使用） |
| 对手牌库上方弃牌 | `effects.deck-top-discard` | II.A p19、II.C-01 p25—26（无专门条款，按卡面） |
| 原位替换为新宝可梦 | `effects.replace` | I.D p14、I.H p18、II.C-02 p26、II.C-13 p35、II.E-12 p59（类比；不是昏厥） |
| 备战区上限变化与弃至上限 | `bench.limit` | I.A-04 p10、II.C-11 p34、I.D p14；扩容与恢复本身仅有卡面依据，在规则检查时点执行 |
| 太晶：在备战区不受招式伤害 | `effects.protection` | II.C-16 p36—37、II.B-08 p24；无畏太晶官方商品页的规则说明 |
| 属性各不相同的基本能量 | `effects.attach` | II.C-09 文例1 p31、I.C p14 |
| 计数弃能后按张数造成伤害 | `damage.effect-count` | II.B-02 p20、II.D-02 文例1 p42 |
| ACE SPEC 每副1张 | `deck.construction`＋卡面 | 卡面规则框；利刃猛醒官方商品页；II.D-18 FAQ2 p51 为同类组限额 |

## 6. 已知限制

- 卡表来自第三方汇总（见 §2）；没有简中官方赛事卡表公开渠道。
- 「零之大空洞」在战斗宝可梦昏厥后，弃至上限与派出新战斗宝可梦的先后没有简中条款；
  本实现按卡面「自己场上没有太晶宝可梦时」在规则检查时点立即执行（先于派出）。
- 本卡组没有水／超能量：「古剑豹·冰柱环」「拉帝亚斯ex·无限之刃」的真实卡测试经「梦幻ex·基因侵入」复制执行（II.C-18 不需被选招式的能量）。
- 「梦幻ex」复制 GX／VSTAR 招式仍需卡面专门裁定（`needsRuling`，当前卡池没有此类招式）。
