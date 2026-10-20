# 简体中文网站

图片、大体积 metadata 与归档的本机 NAS 布局见 [存储说明](STORAGE.md)；
活跃 SQLite 数据库与受限研究资料不放入共享目录。

## 已接入

- 首次访问默认简体中文；明确保存过的语言选择优先。支持与英文、土耳其文、日文、西班牙文切换。
- 游戏界面、规则、新手引导、合法操作、教练、对战记录、卡牌效果说明、卡组简介。
- 首页、页面标题、无障碍标签和 404 页面；首页与游戏共享语言偏好。
- 109 套预设卡组使用的 1,270 个引擎卡牌身份均接入中文展示名、招式名及特性名；
  中文只在展示层使用，英文模式保留原名。
- 已接入 `tools/52poke-cards` 的中文资料和部分本地原卡图；缺失原图时使用明确标记为
  **非官方扫描**的中文练习卡面，不把生成的卡面计入下载数量。
- 中文首页使用实际中文对局采集的截图和本地练习卡面；其他语言仍保留原版截图及图片。
- 允许原图为繁体，但文字说明统一为简体；导入的效果说明按官网词表规范“抗性”
  “竞技场卡”“昏厥”“备战区”等基础术语，保留来源及修改记录，不改原卡图和名称字段。
- 中文字体回退及规则段落行距。
- 原有 2,122 个游戏文案键全部有中文，另增加 5 个界面键；首页 61 个键。
- 网页构建使用 Sharp 处理截图和图标，Linux 不再需要 macOS 的 `sips`。

## 官方术语依据

核对日期：2026-10-18。

- [宝可梦简体中文官网：玩法指引](https://www.pokemon.cn/tcg-about)
- [官方完整玩法规则入口](https://www.pokemon.cn/tcg/rules/howtoplay/)
- 可检查的术语及章节：[zh-CN-terminology.json](zh-CN-terminology.json)

已统一“抗性”“竞技场卡”“宝可梦检查”“先攻”等用语，不混用繁体版的“抵抗力”“场地卡”等名称。
“卡组”和“牌库”、“基础宝可梦”和“基本能量”、“造成伤害”和“放置伤害指示物”必须区分。
抗性减少的数值以卡面为准，不把固定减 30 写成官方通则。

术语有官方依据，不等于所有说明都是官方译文。说明和建议由本项目编写，
未进行逐卡官方勘误审计，也不代表 Academy 引擎经过官方认证。
经典 Pokémon Power 保持为“经典能力”，不与现代特性混为一谈。

## 本阶段边界

- **没有修改对战引擎、卡牌 ID、内部英文名称或存档结构。**
- 原卡图仅在资料与引擎卡牌的种类、HP、属性、招式／费用／伤害／特性或训练家效果等
  版本信息相符时关联，不按相同卡名随意替换。卡图的实际发行编号与英文引擎 ID 分开保存。
- 简体说明和图片语言独立；繁体原卡图明确标注为繁体。练习卡面也不冒充原图或官方译文。
- 图片完整度不等于卡牌数量：同一张原图可能服务于多个保留原 ID 的引擎卡牌。
  新增了只下载网站缺图且版本能对应的繁体官方源队列，不把它计入简体下载成功数。
- 资料导入审计见 `public/data/locales/zh-CN-audit.json`。其中“未缺少展示名”不等于
  所有卡图已下载、所有中文已逐卡人工审校或所有维基卡牌已实现对战。
- 现代系列的专有名称、历史卡牌译名仍需在接入具体卡牌时按官网逐项核对。
- 早期卡组中文标题及分类是便于练习的界面标签，不宣称是官方中文发行产品名称。
- 官方术语检查是静态回归检查，不证明全部翻译语义或全部规则场景正确。
- 原项目的 macOS 下载链接仍指向上游发行版，中文页明确提示其中不含本分支的改动。
- 运行网站或采集工具不会自动发布网站、推送 Git 或修改上游；部署时需配置自己的 `SITE_URL` 和托管目标，
  不要直接使用上游的发布配置。

## 本地运行

### 简中官方规则引擎（开发已暂停）

`CN/V20261019` 是独立于界面语言和旧 `classic/modern` 分类的规则快照。
当前已有带来源的独立状态机、伤害与效果结算、能量／费用、选择与存档恢复，
以及分离卡牌基础定义／印刷身份／战斗状态的严格 schema。2026-10-20按用户要求暂停；
**完整规则覆盖、真实卡池和网站接入尚未完成，
不能将当前教学网站当作已经按该版本结算。**

- [已实现功能、验证结果与暂停交接](rules/zh-CN/V20261019/STATUS.md)
- [设计](rules/zh-CN/V20261019/DESIGN.md)
- [实施及验收清单](rules/zh-CN/V20261019/IMPLEMENTATION.md)
- [目录审批与发布边界](rules/zh-CN/V20261019/RELEASE.md)
- [版本化赛制与旧印刷准入](rules/zh-CN/V20261019/FORMATS.md)
- [逐条规则覆盖与缺口](rules/zh-CN/V20261019/CLAUSE-COVERAGE.md)
- [真实卡牌迁移盘点](rules/zh-CN/V20261019/MIGRATION.md)
- [首副真实牌组的逐卡证据](rules/zh-CN/V20261019/cards/SV-MIRAIDON-REVIEW.md)
- `npm run rules:build`：重建离线验证器及内核构建指纹。
- `npm run test:rules:official`：规则与 schema 回归检查。
- `npm run test:rules:official:coverage`：新增模块覆盖率门禁（Node 24）。
- `npm run test:cn-migration`：只读迁移盘点测试，不生成审批。
- `npm run test:cn-card-review`：17 项首副牌组的证据／缺口审查测试，不签发准入。

### 启动现有教学网站

```bash
npm ci
npm start
```

游戏开发页默认在 `http://127.0.0.1:8787`。已有语言偏好时，点击右上角或起始界面的“简中”。
启动时会自动生成本地中文练习卡面。已下载的原卡图放在忽略版本控制的
`public/img/zh-scans`；新克隆缺少这些文件时会回退到有明确标签的练习卡面。
原开发服务可能沿用本地模型配置；如只需 CPU 练习、不希望下载模型，可用下方静态预览或本机研究预览。

完整静态站预览：

```bash
npm run web:build
npm run web:preview
```

首页为 `http://127.0.0.1:8790/`，游戏为 `/play/`。
中文模式的卡图优先使用本地中文原图或本地练习卡面；英文等模式保留原来的远程图片来源。
全量中文原图仍未下载完毕。

### 仅限本机的研究图像预览

另一个公开数据集 `duanxr/PTCG-CHS-Datasets` 明确限制未经授权再分发，
**不将其图片或完整 JSON 放入本仓库、公开构建、截图文档或模型服务**。
在确认适用条件后，本机研究可使用独立缓存：

```bash
# 先按 tools/52poke-cards/README.md 准备 Python 环境；从仓库根目录执行：
tools/52poke-cards/.venv/bin/python tools/52poke-cards/local_research_cards.py prepare
tools/52poke-cards/.venv/bin/python tools/52poke-cards/local_research_cards.py download
tools/52poke-cards/.venv/bin/python tools/52poke-cards/local_research_cards.py index
npm run research:preview
```

访问 `http://127.0.0.1:8795/play/`。该服务只监听回环地址，拒绝非本机 Host、跨源请求和路径越界，
保留 CPU-only 模式，不启动 Kev/Jev。图片在浏览器显示前再做完整性检查；
主目录、文件路径和完整数据集不会返回给页面。

普通静态构建不含研究模式标记，不请求其接口，也不读取或复制该缓存。
本机研究模式不是对外部署方案；若要向他人提供或分发这些资源，应先确认并取得所需授权。
数据集图片为较小尺寸，不放大后冒充高清，也不把“同一印刷标识匹配”说成 Wiki 原文件字节一致。
引擎 ID、英文内部名称、效果和存档保持不变。
新缓存默认使用 `tools/52poke-cards/data/local-research`；为兼容原工作目录，
仅在新目录不存在时回退至相邻的 `52poke-cards/data/local-research`。
也可以通过 `TCG_RESEARCH_MANIFEST` 显式指定已授权的本机研究清单。

## 更新中文资料及卡图

NAS 正式卡牌库使用 `library/发行语言/set/完整卡号目录/`，例如
`/nas/share/Pokemon/library/zh-Hans/151C/001_151/`。
没有 `tcg/` 层，metadata 的 `number` 仍为 `001/151`；
繁体发行版的目录为 `zh-Hant`，说明文字仍为简体。离线重建方式、待审记录和
下载器 `--library` 参数见[存储说明](STORAGE.md#建库与增量更新)。
网站仍按已确认的引擎版本关系导入，不会仅因图片归入新目录就改变对战卡牌身份。

在仓库内的 `tools/52poke-cards` 已导入官方 XML 归档并下载部分图片后：

```bash
tools/52poke-cards/.venv/bin/python tools/52poke-cards/export_academy.py
npm run cards:zh
```

导出只读源数据库、不修改引擎卡牌文件；将通过版本关联的缓存图复制至
`public/img/zh-scans`。Foundry 凭据仅由独立图片处理工具使用，网站不读取或打包这些凭据。
仓库内工具默认从仓库根目录的 `.env` 读取模型配置，该文件不提交 Git。
新增其他维基卡牌还需要实现并验证对应规则，不能只导入图片就直接对战。

百科衍生文字资料采用其声明的 CC BY-NC-SA 3.0 许可，与 MIT 代码分开；
卡图版权仍归原权利人。出处、修订及转换标记保存在资料目录中。

下载工具支持以 Wiki 最新文件的 SHA-1 和大小核对已经缓存的官方图片，并再次检查本地
SHA-256；不会借此请求受限的图片 CDN。恢复出的文件引用仍需语义核对，不能仅因文件名类似就关联。
文件级证据与图像字节缓存分开保存，避免多个别名共享图片时混淆来源。
已提交的压缩 metadata、待下载清单、重建与校验方式见
[`tools/52poke-cards/README.md`](../tools/52poke-cards/README.md)。这些快照不含图片、数据库或私有研究资料。

## 验证

```bash
npm run test:i18n
npm run test:presentation
npm run test:rules
npm test
npx playwright install chromium --only-shell
npm run test:ui
npm run test:game:zh
npm run test:research
# 已准备本地研究缓存时，可另外运行实际研究模式对局：
npm run test:game:research
```

词典检查覆盖键完整性、插值参数、禁止混用的术语、语言回退及卡牌内部身份不变。
浏览器检查覆盖首页与游戏切换、偏好持久化、规则页、现代卡组延迟加载、
新局准备、存储不可用、移动端首页和 404。
UI 测试阻止第三方网络请求，不将卡图 CDN 可用性混入本地汉化测试。
完整对局测试通过浏览器点击合法操作直到结束，不注入棋盘、手牌、伤害或赢家。
中文首页截图及对应对局记录见 `docs/screenshots/zh-CN`，这仅验证已运行的场景，
不代表每套卡组及每条规则都已通过中文浏览器对局验证。
研究模式对局截图只写入忽略版本控制的 `test-results/local-research-*`，
不得将其复制到公开首页的截图目录。隐私与访问控制测试使用自建测试图片，不依赖受限素材。
