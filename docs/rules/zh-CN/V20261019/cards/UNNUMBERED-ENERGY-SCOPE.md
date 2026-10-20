# E0银色基本雷能量：未识别编号与卡面身份范围

目标 **CN / V20261019，截止2026-10-19**；本次离线复核 **2026-10-20**。
仅新增本说明，不改schema／代码／原17项review／Git，不签发admission或任何审批。
未联网、未重试E1金色雷能量归档；此前归档missing保持不变。

## 结论

**有可重复核验的官方完整卡面及商品关联，但尚不能确认“官方未编号”。**
E0可以成为独立审查的**基本雷能量卡面变体候选**，不必强绑 `csvL2C 135/052`。
`LIG` 的语义仍为 **unknown**，不能凭英文缩写或位置猜为类型码、卡牌编号或商品编号，
更不能把末尾G当成规制标记。当前模型无法诚实表达这些未知值并完成正式卡池检查；
未来可研究受限的 `identity.scope:faceVariant` 分支，**本轮没有可准入的真实60张卡组**。

## 1. 只读原件及可见事实

下列均为既有官方原字节，原回执采集日2026-10-20；本轮只重算／读取，没有新抓取。
缓存统一位于 `/home/zhn/pokemon-tcg/.cache/rules/card-review/V20261019/sv-miraidon/`，
文件名为各行完整SHA-256加 `.bin`。

| 证据／官方定位 | 字节数／SHA-256 | 本轮可证范围 |
| --- | --- | --- |
| **E0**：[银色雷能量图](https://image.pokemon.com.cn/wp-content/uploads/2025/11/81890d74a150905b97ce44899fd22485c5205db6-thumb-868x1212-28994.png) | 1662911；`415c6e8558a916af437b69bee58917d44ee84f70b06c1fc2b9a7fa3a4a82baac` | 868×1212原PNG，完整边框、卡头和页脚已目视；基本能量／雷图标、银色碎纹背景、页脚 `LIG`。不是135/052金色图 |
| **P1**：[游历礼盒公告](https://www.pokemon.cn/tcg/17590.html) | 89068；`6a2babaee3ef85fd116894391e27f338639101aa7b50dcc9176beb959b08eb68` | 正文2025-10-19；基本能量闪卡段实际包含E0签名图片链接；礼盒商品列2025-11-07发售。正文未解释 `LIG`，未出现 `135/052`／`csvL2C` |
| **R1**：[赛制说明](https://www.pokemon.cn/tcg-rules-regulation) | 38888；`b69f6182818a4b97f0d4b14740a99851018430356219fac03a6c7d08ea85d77a` | 说明商品编号表示收录商品，2026-09-16起标准范围另含8种基本能量；没有把 `LIG` 映射为编号／类型 |
| **R2**：[玩法指引](https://www.pokemon.cn/tcg-about) | 76924；`394a94c819b7f158192f91c30744ffce1739001641770abd009676b02b1f0d2e` | 60张构筑、宝可梦同名至多4张、基本能量不受一般数量限制；不证明E0的具体印刷身份 |

**完整正面观察不等于字段语义已知：**

- E0未见可辨识的数字／分数卡号、独立商品编号框或单字母规制标记，
  **尤其未见G**；但页脚确有 `LIG`，不能删除这个未解释token后宣告“绝对无编号”。
- 可记录 `visibleFooterTokens:["LIG"]`、数字卡号／独立商品编号／规制标记
  `notObservedOnFace`。正式的 `number`、`setCode` 身份解释仍unknown；
  “未见标记”的目视观察也不是本轮已签发的无标记印刷审核。
- E0的完整PNG不等于实物批次样本。P1支持官方所展示的基本能量闪卡与游历专题包关联，
  不自动证明样图的每个工艺细节均已核实为某一唯一实体印次。

## 2. 当前模型的精确阻塞

已读 `/home/zhn/pokemon-tcg/schemas/card-printing.schema.json`、
`/home/zhn/pokemon-tcg/public/rules/card-schema.js`、
`/home/zhn/pokemon-tcg/public/rules/formats.js` 及基本能量definition约束。

| 当前字段／门禁 | 实际约束 | 不应采用的“补齐” |
| --- | --- | --- |
| `number`、`setCode` | 必填非空string；没有“已确认未编号”和“号码未知”的区别 | `number:"LIG"`、`setCode:"LIG"`、`"unknown"`、占位符或借用 `csvL2C`；即使语法通过也没有身份依据 |
| `regulationMark` | 必填字母或null；单个null不能区别未知、未观察到及已审核无标记 | 默认G，或把未审核null当成身份审核完成 |
| `series`／`releasedOn` | shape中可缺；**正式卡池入口仍要求**已审系列、有效日期且不晚于快照；`releasedOn` 明确是本印次首次发行 | 把P1商品系列直接当E0唯一系列；把页面日期、下载日期、URL月份或某礼盒发售日冒充本印次最早日期 |
| 内容／印刷审批 | 独立canonical审批、确切版本绑定与release是另一层 | 用原图哈希、基本能量例外或自行填 `identityReview:verified` 替代审批 |

基本雷的definition本身可用基本能量／单个Lightning单位／无额外效果的既有结构表达；
当前阻塞不是必须找到135/052，而是**身份范围和日期证据不能被伪造为现有必填字段**。

## 3. 受来源约束的最小候选方案（未实现，不是官方规定）

| 建议表达 | 所解决的问题／必须保留的条件 |
| --- | --- |
| `numberStatus:known / confirmedUnnumbered / unknown`，`number` 为string或null；`setCode`同理分状态 | known须有已审来源；confirmedUnnumbered须有足以排除未解释编号的独立证据；unknown保留null和原始token。**E0目前只能列unknown**，不是confirmedUnnumbered；不能仅放宽nullable便让未知身份准入 |
| 卡面观察与规制身份分层 | 保存完整图、可见token及 `notObservedOnFace`；另审规制标记身份。`regulationMark:null` 不能单独承担这些不同含义 |
| 明示 `identity.scope:faceVariant`，与现有实体印次范围分开 | 可按已审正面图样／文字／可辨工艺识别逻辑卡面，保留来源图哈希和定义绑定；不声称知道唯一收录商品、制造批次或最早发行。优先单独faceVariant身份，而非悄悄改旧printingId含义 |
| `productAssociations[]`＋来源／locator／关联强度 | P1可记录“游历专题包基本能量闪卡展示”以及商品的朱&紫背景。多个商品／系列关联不能无证压成一个唯一 `setCode` 或单一系列结论 |
| `availableBy` 与最早发行分离 | 表示**同一受审身份不晚于某日已发行**的证据上界，不是精确首发日；须独立审查来源是否真正覆盖该faceVariant以及发行事实。普通已编号印次的 `releasedOn` 语义不改变，不全局放松日期门禁 |

**P1日期的可用程度：** 当前可实证的是官方公告列出商品2025-11-07发售，
并在基本能量闪卡段链接E0。可先保存为 `announcedProductRelease:2025-11-07`
和该图的关联证据；它是将来审查 `availableBy` 的候选依据，**本轮不直接填一个
已核准的 `availableBy` 或 `releasedOn`**。还须审查样图与实际发行卡面是否对应、
该日期是否足以支持所声明的身份范围；即使通过，也只证明首次发行不晚于该日。
2026-10-20取得的字节不能回填为2026-10-19历史存档，公告时间也不是卡面首次出现日。

新分支若实施，应仅在已审基本能量身份范围内考虑保留未知卡号／商品编号；
仍要求独立卡面同一性、实卡对应、定义绑定、快照适用性和发行上界审核。
旧product-printing流程不能借此降级，canonical／发布封签／恢复检查也必须明确涵盖新范围。

## 4. 同face跨商品与最小deck的边界

- **相同正面可成为共享逻辑faceVariant的候选，不等于同一制造批次。**
  不同商品若未来各有官方证据明确对应同一正面，可以分别关联；
  同PNG文件只证明媒体字节相同，不证明实卡工艺／发行身份相同。
  不同分辨率文件也不必然是不同face；工艺／编号／正文有差异或未知时不能自动合并。
- P1确实列出多个礼盒共享游历专题包；这只证明多包装关联，
  **不是已核实跨产品再版，也不是唯一或多个制造批次的证据**。
  本轮不把它们全部并为现有意义下的一个已批准printing。
- 后续可以只研究“已审皮卡丘＋一个已审基本雷身份”两种定义的60张方向，
  不必迁移原17定义或坚持135/052；皮卡丘自身印次／首发／勘误、基本雷的上述身份分支、
  真实逐卡测试及完整卡池／release门禁仍须分别完成。本轮不生成牌表或可玩结论。

## 5. 本轮验证

四份既有原件大小／完整SHA-256一致；E0 PNG magic、全部chunk CRC及IEND文件结尾
核验通过，并用图像查看工具读取完整正面。P1的E0链接及相邻正文已从原HTML核对。
另以真实 `validateCardPrinting` 运行 **10/10内存shape探针**：
null／空number或setCode被拒绝，新status／scope／availableBy字段被拒绝；
合成 `number:"LIG"` 仅语法可通过，**不是把LIG认定为真实卡号**。
没有创建真实printing、catalog、审批或缓存，没有重跑大测试或下载卡图。
原17项review及既有LIGHTNING说明保持原字节不变。
