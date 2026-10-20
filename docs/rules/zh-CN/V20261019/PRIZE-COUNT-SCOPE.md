# D-17：已经获得的奖赏卡张数

本旁路模块只实现 **CN / V20261019 的效果查询**，没有修改状态机、handler、
共享规则登记或生成器。测试使用合成值／状态；不签发真实卡牌审批。

## 实际读取的固定 primary 原字节

| 文档 | 版本／字节 SHA-256 | 本次读取范围 |
| --- | --- | --- |
| 进阶玩家向规则指南 | Ver.3.1.0；`27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419` | PDF p50–51 II.D-17；p16 I.E 抢分赛 |
| 赛场规则 | Ver.3.1.0，2026-04-02；`b5f0c8b87d928f5ca640f1f021863eb78aafcc8216067883e7b2075a25ab1ac6` | 全文定位抢分内容，重点 p5 5.1、p17 第12章 |

页码为从1开始的 PDF 页序，读取日期为2026-10-20。原 PDF 留在既存的忽略缓存，
不另分发原文。本轮不联网。赛场文件只有5.1对抢分赛适用对战／对局的说明；
详细的一奖赏重开步骤在进阶 I.E，不能虚构赛场文件存在另一套计数条款。

## 已确认与未决范围

- D-17 p50定义效果所指的“已经获得的奖赏卡张数”；p51明确将
  **60／40／30** 卡组的计算基数固定为 **6／4／3**。
- 正常模式且当前剩余数不超过基数：返回 `basis - remainingPrizes`。
  这是规则定义的当前值，不是累计KO数、累计拿牌／入手历史或胜负判定。
- 进阶 I.E p16规定抢分赛从头开始且只放1张奖赏，但没有进一步解释
  D-17的效果计数如何适用于该例外。固定赛场5.1／第12章也没有补足这个口径。
  **抢分赛查询全部保持 needsRuling**，既不擅自按 `1 - remaining`，
  也不直接把 D-17 的基数减法扩张为抢分赛结论。
- 剩余数大于6／4／3时，固定文本未解释负数结果或归零办法：
  返回 `needsRuling`，不截零、不输出负数，不宣告该局面“官方非法”。
- 负数、非整数、不安全整数、未知版本或缺字段属于本值协议的非法输入，
  不等于官方对游戏局面的裁定。
- 40／30的纯计数有D-17依据，**不代表现有 OfficialGame 已支持40／30卡组**。

## 稳定 API

```js
queryPrizesTaken({
  ruleset: { region: 'CN', version: 'V20261019' },
  deckSize: 60, matchMode: 'normal', remainingPrizes: 4,
});
// {status:'resolved', basis:6, count:2, reasons:[], sourceOfTruth:[D17]}

requirePrizesTaken(query); // 数字；未决时抛 PrizeCountError
prizesTakenForPlayer(ctx, { player: 0, deckSize: 60 }); // 父端公式／查询 hook
```

还导出 `assertPrizeCountQuery`、`PRIZE_COUNT_BASES`、`PRIZE_COUNT_RULE_IDS`
与冻结的 `PRIZE_COUNT_SOURCES`。schema 根为 query；`$defs/result`
和 `$defs/hookParameters` 是独立的严格值协议，无需改共享生成器即可验证。

未决返回 `{status:'needsRuling', basis, count:null, reasons, sourceOfTruth}`；
两个未决原因可同时存在，固定输出顺序仅为规范序列化，不是游戏优先级。
数字入口以 `PrizeCountError.code === 'needs-ruling'` 拒绝未决值，
`.details` 保存结果和证据。调用方不能把 `null`、异常或 unknown 默认为0。

hook 只读已准备完毕状态的 `ruleset`、`matchMode`、所选玩家的 Prize ID
数组长度。必须显式提供绝对玩家0／1和可信的原始卡组大小，不推断
`source.owner`、`current`、牌库余量、UI赛制名称或实际准备时放的奖赏数。
它不查看卡面、不修改RNG／状态，不允许在setup阶段把空奖赏数组当“已获得6张”。
来源／目录、完整状态、原始卡组大小的真实性仍由父端门禁负责。

## 父端接线边界

父端可在现有 `effectContext` 中封装固定正常60模式的权威查询，
再供审核后的伤害公式／handler使用。不得把 `deckSize` 作为玩家任意传入的
攻击参数；不得因此自动安装未经逐卡审核的公式。抢分赛应传播 needsRuling，
而不是退回本地的普通减法或国际规则默认。将来补足简中primary裁定后，
须另审适用范围并新增对应测试，不能静默改旧版本语义。

本交付不改变奖赏实际放置、拿取、胜负或裁判惩罚，也不注册生产 handler。

## 独立验证

```sh
node --experimental-test-coverage \
  --test-coverage-include='public/rules/prize-count.js' \
  --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 \
  --test tests/official-rules/prize-count.test.mjs
```

本次本地 **15/15 通过，行／函数／分支均100%**。覆盖正常60／40／30所有
基数内剩余数量、基数外／抢分双重未决、严格schema、数字hook、准备阶段、
两名实际持有者、输入不变、原始字段不可被getter执行，以及隐藏卡面不被读取。
这些是本纯查询协议的范围证明，不是整内核或真实卡牌的完备性声明。
