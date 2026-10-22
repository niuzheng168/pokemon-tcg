# 目录审批与发布入口（仍在开发）

本协议解决**数据准入和版本一致性**，不是官方认证，不证明实体卡真伪，
不替代赛制卡池和逐条规则验收。当前仓库包含真实简中卡的开发发布数据与开发安装钉，
但没有因此获得官方认证或部署到生产；当前数量和质量层以 [STATUS](STATUS.md) 为准。
规范测试的虚构卡、虚构印刷和自动生成的测试审批只能用于测试。

## 1. 两种内容分别审查

- `CardDefinition`：该地区／版本下的规则定义、属性、名称身份、说明文、
  handler 与严格参数、代码实现和语义测试。
- `CardPrinting`：实体 TCG 的语言、商品编号、完整卡号、标记，
  系列和发行日期，以及这张印刷与相应定义的确切绑定、逐赛制最新版审查和卡牌证据。

`implementation.status: verified` 与 `identityReview: verified` 都只是数据声明。
低层受信任构造器现在同时要求外部 `approvedDefinitions` 和 `approvedPrintings`，
分别匹配完整规范内容；任何身份、编号、映射或来源变更都会使旧审批失效。
一般规则说明能证明“如何玩”，不能单独证明“这张印刷是哪张卡”。
52Poké／MIK 资料继续保留为 metadata 来源，不成为印刷或语义审批权威（旧教学模式及其英文卡组已于 2026-10-21 删除）。

## 2. 审批工作流

1. 逐卡核对简中官方发行资料、卡面及适用勘误，不把英文翻译、繁体印刷、
   Pocket 或同名图片当作简中实体 TCG 的身份证明。
2. 确认打印编号、语言和定义绑定，并审核规则语义、回合边界、
   权限来源、费用、所有实现分支和对应测试。未实现／部分实现不允许装成完整支持。
3. 固定受信任的规则代码和 handler 注册表。代码不从目录中的 URL、字符串或脚本路径加载；
   handler 需要明确实现版本、参数 schema、来源和已安装的函数。
4. 运行 `npm run rules:build`，然后执行来源检查、完整测试及构建。
5. 用 `catalogCandidateFacts` 生成待审核的内容指纹：规则快照、内核、
   schema、定义、印刷与 handler。**这个函数不会签发审批或生成信任根。**
6. 审核最终 manifest 的完整条目集合、证据、审核记录和测试记录。
   manifest 的哈希只能在完成独立审核后进入受信任应用配置。
7. 应用通过 `loadReviewedCatalogRelease` 或 `createReviewedGame` 读取未信任 JSON，
   并使用独立安装的 `releaseId → manifest SHA-256` 名单。未批准时明确拒绝运行。
8. `createReviewedGame` 必须明确选择版本化的标准／开放卡池；恢复入口也核对该边界。
   不能省略赛制或用 `casual60`／`tiebreak60` 开发别名绕过。
   `matchMode` 只控制独立奖赏模式，不替代赛制检查。详见 `FORMATS.md`。

不要从正在下载的同一份 manifest 动态生成名单，也不要让目录携带
`approvedDefinitions`／`approvedPrintings` 来自证。发布包中的 `review` 是被名单覆盖的
审核记录，不是因为字段名称叫审核就自动具备权限。

## 3. 发布包和输入边界

`schemas/catalog-release.schema.json` 定义严格的 JSON 发布包：

```text
manifest
  schemaVersion / releaseId / ruleset
  kernelSha256 / schemaSha256 / rulesSha256
  definitions[] / printings[] / handlers[]  // 明确 ID 和规范内容 SHA-256
  review                                 // 独立审核记录、测试及来源
definitions[]
printings[]
```

定义、印刷和安装的 handler 均作集合及内容核对；增删、替换、重复 ID、
换绑定、改编号、改说明、改 provenance 或改变 handler 合约都不默默接受。
对象属性顺序及定义／印刷外层条目顺序不改变规范内容；
效果序列等内部数组仍保留顺序，不能重排后冒称等价。
manifest 自身仍须匹配独立批准的规范哈希。

入口仅接收 JSON 文本，不执行其中代码、不访问其中 URL、不加载 handler。
默认输入预算为 16 MiB，受信任宿主可明确配置；它是数据入口的资源约束，
不是卡组规则或对战规则上限。
输入、信任 Map 及 handler 配置在异步哈希前隔离，避免核对中途被调用者修改。
handler 合约拒绝非有限数、循环、非 JSON 对象、隐藏属性或被哈希丢弃的配置。

`catalogReleaseReceipt(catalog)` 只对成功通过此入口的对象给出只读回执。
复制对象属性、伪造同名字段或只知道 `catalog.id` 不能产生这个入口的对象品牌。
低层开发目录即使内容相同，也不会因此自行变成已批准发布目录。

## 4. 构建与存档

- `npm run rules:schema` 生成离线验证器；
  `npm run rules:kernel` 生成内核构建指纹；
  `npm run rules:build` 按顺序执行二者。
- `npm run rules:schema:check`／`npm run rules:kernel:check` 只检查，不更新文件。
  规则测试和网页构建都会先检查，过期指纹不能混入构建。
- 构建指纹覆盖规则目录代码／JSON、生成验证器及相关生成器，不覆盖自己，
  并拒绝机器特有的符号链接。路径按规范顺序记录。
- `catalog.id` 同时绑定安装的内核、schema、定义、印刷及 handler 合约，
  后者包含已知元数据和函数源码指纹；修改 schema、来源、参数合约或函数体不能静默共用旧身份。
- `createReviewedGame`／`restoreReviewedGame` 使用已批准发布包及回执，
  恢复仍须通过内核原有的版本、内容、卡牌守恒和 continuation 检查。

指纹和 CI 检查**不是对恶意应用宿主的自我认证**。
应用代码、WebCrypto、注册的函数及独立信任配置本身必须可信；
函数源码摘要也不能自动证明闭包、外部依赖或语义正确性。
自定义 handler 的代码依赖、版本与审查仍由受信任构建负责，
不能凭几个 SHA-256 字段就宣布任意第三方代码安全。

## 5. v2 分片入口（2026-10-22，预览，网站尚未切换）

已新增 `catalog-manifest`／`catalog-shard`／`catalog-index` 三份 2.0.0 schema，
与当前仍生效的 v1 入口并存；不是把 v2 预览钉从下载数据自动安装到网站。

```js
const release = await openReviewedRelease({
  manifestJson,
  trustedReleases,  // 宿主独立安装，绝不能从 manifest 临时推导
  readShard,       // 宿主 I/O：索引和分片都接收冻结的 descriptor，返回 Uint8Array
  tiers: ['reviewed', 'machine'],
});
const hints = await release.index();           // 只读的组卡事实，不是可执行目录
const catalog = await release.catalogFor(ids); // 去重、排序，并递归加入最新文本锚点
const { game, approval } = await createReviewedGame({ release, decks, seed, format, matchMode });
const resumed = await restoreReviewedGame({ release, snapshot });
```

- 清单用规范化 JSON 摘要匹配独立安装钉，同时核对内核／schema／规则与所有已安装 handler。
  索引和分片用**原始字节**摘要，先复制和验证，再严格 UTF-8 解码／JSON 解析。
  默认清单 1 MiB、单分片 4 MiB、索引 8 MiB；宿主 reader 还应在实际下载时按 descriptor 限制流量，
  不把不受限的响应先读入内存。
- 传输证据引用必须还原成完整来源，之后复用现有完整卡牌 schema／执行准入，
  官方专用位置与机器层的来源要求不变。内容冲突的来源 ID 不会被静默覆盖。
- 索引核对总数、唯一性、按包／层级数量和最新文本锚点；每次载入的分片核对自含绑定、
  全部卡牌形状、数量和重复定义一致性。最终子集再次核对索引身份、质量与组卡事实，
  不允许用索引把机器卡降格标成「人工审核」后运行。
- `catalogFor` 只纳入本局印刷及必要锚点，不纳入整包的其他卡牌。
  同一 reader 会话内共享已验证的索引／分片；并发请求复用读取，失败项可重试，不污染其他会话。
  仅允许审核层时，机器重印和机器定义都拒绝，包括作为必要锚点的机器印刷。
- `createReviewedGame`／`restoreReviewedGame` 接受带私有品牌的 `release`；不得再混传 v1 的 JSON／信任／handler 参数。
  恢复从全部实体卡的印刷 ID 重建同一子集，继续通过原有状态与卡牌守恒检查。
- v2 回执含 `manifestSha256`、`catalogId`、构建指纹、实际使用分片和层级；
  `sha256` 仍指清单摘要以便过渡。完整证据直接纳入目录 ID，无单独可漏传的 provenance。
  不相关分片或审查说明更新不改变本局目录 ID；内核／schema 或本局来源变更仍会改变。
- 构建必须全池检查名称身份和进化祖先，不能用浏览器的子集检查替代。
  `npm run cn:release:v2:preview` 只从已提交快照产生确定性预览，并核验完整往返与三副真实卡表。
  预览在 `.data/release-v2-preview/`；加 `-- --check` 逐字节检查，`-- --out DIR` 可选择输出目录。

**尚待完成**：网站／服务器／回放与记录的 v2 切换、正式分片与独立安装钉提交、HTTP 缓存／压缩、
以及移除 v1 入口。现有网站行为和 2,029 印刷池不因预览构建而改变。
完整方案见 [v2 提案](RELEASE-V2-PROPOSAL.md)。发布准入仍不等于全部规则或全卡池效果语义已验收。
