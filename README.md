# 宝可梦卡牌 · 简中官方规则对战（CN/V20261019）

按宝可梦集换式卡牌游戏**简体中文官方规则 V20261019** 实现的规则内核与网页对战。
每条规则标注简中官方文档出处；每张卡都对应确切的简中印刷（系列＋卡号），卡文按本机卡图逐张核对。

本仓库源自 [Pokémon TCG Academy](https://github.com/f/pokemon-tcg)。原项目的英文教学模式
（109 副英文预组、旧规则引擎、界面、桌面版和相关测试）已于 2026-10-21 删除，可在 Git 历史中找回。

## 现有内容

| 部分 | 位置 |
| --- | --- |
| 规则内核（状态机、伤害、效果、存档恢复） | [`public/rules/`](public/rules)，规则登记见 [`public/rules/zh-CN/V20261019.js`](public/rules/zh-CN/V20261019.js) |
| 严格 schema（卡牌定义、印刷、对局状态、效果参数） | [`schemas/`](schemas) |
| 审核卡池（定义 78、印刷 83）与卡组 | [`catalog/zh-CN/V20261019/`](catalog/zh-CN/V20261019) → `public/data/cn/V20261019/` |
| 全卡池机器层（进行中）：卡文机器核对、效果翻译、机器实现生成器 | [`scripts/card_review.py`](scripts/card_review.py)、[`scripts/effect_translate.py`](scripts/effect_translate.py)、[`scripts/build-machine-catalog.mjs`](scripts/build-machine-catalog.mjs)、[`catalog/zh-CN/V20261019/machine.mjs`](catalog/zh-CN/V20261019/machine.mjs)；进度见 [STATUS §14](docs/rules/zh-CN/V20261019/STATUS.md) |
| 当前 v2 发布包（2026-10-22） | **1,890 个定义、4,021 个印刷、128 个分片：83 张人工审核、3,938 张机器核对／实现**。机器重印即使绑定审核定义也标「机器实现」；标准赛可用 2,293 张、开放赛可用 3,822 张，赛制与最新版审查不放宽。见 [STATUS §14](docs/rules/zh-CN/V20261019/STATUS.md) |
| 分片发布与载入 | `npm run cn:release` / `npm run cn:release:check`：提交清单、分片、索引及独立安装钉；网站、服务器、组卡、恢复和回放已切换 v2。浏览不载入整池目录，对局按需取分片；私有缓存、Brotli/gzip、ETag。**未合并 main／未部署**。见 [发布与边界](docs/rules/zh-CN/V20261019/RELEASE.md#5-v2-分片入口2026-10-22网站代码已切换未部署) |
| 效果候选与缺口（2026-10-22） | 最终卡文语料 5,762 个单元，两模型均处理完；原始诊断为 2,686 个一致且过检查、2,945 个双方不支持、131 个待复核。当前 **924 个单元**另经完整卡文模式／已审核程序比对、规则框门禁与机制模拟后用于机器层；9,685 个未实现印刷逐一保留排除原因，不将候选直接发布。见 [缺口报告](docs/rules/zh-CN/V20261019/EFFECT-TRANSLATION-GAPS.md) |
| 网页对战（对电脑） | [`public/`](public)：原版对战界面 `ui.js` 经 `match.js` 驱动内核，构建后位于 `/play/` |
| 账户、卡牌库与自建卡组 | [`server/`](server)（登录、会话、卡组 API、卡牌库，SQLite）；页面 `public/{login,cards,decks,admin}.html`，卡池 [`public/card-pool.js`](public/card-pool.js)，卡组检查 [`public/deck-check.js`](public/deck-check.js) |
| 卡牌资料工具（52Poké／MIK／官网） | [`tools/52poke-cards/`](tools/52poke-cards/README.md) |

网站的所有页面都要登录后才能使用。用户用用户名和密码注册，分为普通用户和管理员：

- **卡牌库**（`/play/cards.html`）：本机卡牌库 library_v1 的全部简中卡牌（约 13,700 张，每张对应一个印刷），
  可按名称、招式／特性、卡牌种类、能否对战、属性、进化阶段、训练家／能量类别、特征（宝可梦ex／V／GX、TAG TEAM、
  光辉、棱镜之星、ACE SPEC、特性、古代、未来、太晶、一击／连击／融合、究极异兽）、HP、弱点、撤退、赛制、标记、
  系列和卡包筛选。已实现的印刷按「人工审核」／「机器实现」分开显示，是否能加入对局仍由赛制及构筑检查决定；
  其余的卡标为「未实现」，对战规则正在逐步实现。机器实现未经人工逐张审核。
- **我的卡组**（`/play/decks.html`）：从卡牌库挑卡组建、保存自己的卡组（也可复制预组再改）。
  卡组按所选赛制即时检查，凑满 60 张、符合构筑规则且每张卡都已实现后，就会出现在对战页面的「我的卡组」里；
  含未实现卡的卡组可以保存，暂时不能对战。
- **用户管理**（`/play/admin.html`，仅管理员）：修改角色、重置密码、删除账户。

网页上的 3 副预组：

- 嗨皮组合 皮卡丘卡组（CSVH1C，官方预组，开放赛制）
- 猛雷鼓ex（2026 城市赛上海站第 1 名卡表，标准赛制）
- 多龙巴鲁托ex／黑夜魔灵（2026 城市赛广州站第 1 名卡表，标准赛制）

## 运行

需要 Node 21.7 以上。本机 `NODE_ENV=production` 时要带上 `--include=dev`。

```sh
npm ci --include=dev
npm run cn:images                     # 从本机卡牌库复制审核过的卡图（缺图时显示卡背）
node scripts/build-card-library.mjs   # 卡牌库索引与缩略图 → .data/card-library/（需要 NAS 上的 library_v1 和 Pillow）
npm run user -- add <用户名> --admin   # 创建管理员（密码在终端输入，或用环境变量 USER_PASSWORD）
npm start                             # 构建 site/ 并在 http://127.0.0.1:8790/ 启动网站服务
```

网站需要 `server/main.mjs` 运行（登录、卡组、卡牌库都在服务端），纯静态托管已不能使用。账户数据库默认在
`.data/accounts.db`（`--db` 或 `DB_PATH` 可改）；卡牌库索引默认读 `.data/card-library/`（`--card-library` 可改，
没有索引时退回已发布印刷，含机器层；没有本地卡图时显示卡背）。在 localhost 以外访问时要用 HTTPS：
游戏用 WebCrypto 校验发布包，浏览器只在安全上下文提供它。

```sh
node server/main.mjs --host 0.0.0.0 --port 1028 --cert cert.pem --key key.pem --db /path/to/accounts.db
npm run user -- list | passwd <用户名> | role <用户名> user|admin | delete <用户名>   # 同样可加 --db
```

## 测试

```sh
npm test                               # 官方规则、真实卡机制与电脑完整对局、审查记录、合并视图、对战界面驱动、账户与卡组
npm run test:rules:official:coverage   # 规则内核覆盖率门槛（行／函数 100%，分支 95%）
npm run test:ui                        # 浏览器测试（Playwright，自带一个空的账户数据库和小型测试卡牌库）
```

当前机器层快照已提交在 `catalog/zh-CN/V20261019/library/machine/`，克隆即可构建／检查发布包，
不需要 Foundry 密钥或付费模型缓存。重新生成机器层需本地卡牌库、最终核对结果、两模型完整卡图读数和名称键；
重新认证效果还需已有的效果翻译缓存，两条命令本身都不会调用付费 API：

```sh
npm run cn:effect:certify              # 双模型原结果＋独立完整卡文模板 → 已提交效果候选快照
npm run cn:machine                     # 严格重印、整卡效果、双读规则框门禁 → 已提交机器快照
npm run cn:release                     # 合并两层、校验并重新钉住发布包（仍非部署）
npm run cn:merged                      # 更新人工审核绑定的 metadata.merged.json
```

## 文档

- [进度与已实现内容](docs/rules/zh-CN/V20261019/STATUS.md)
- [设计](docs/rules/zh-CN/V20261019/DESIGN.md)、[条款覆盖矩阵](docs/rules/zh-CN/V20261019/CLAUSE-COVERAGE.md)、
  [发布与信任](docs/rules/zh-CN/V20261019/RELEASE.md)（全卡池 [v2 提案](docs/rules/zh-CN/V20261019/RELEASE-V2-PROPOSAL.md)）、[赛制](docs/rules/zh-CN/V20261019/FORMATS.md)
- 逐卡审核记录：[`docs/rules/zh-CN/V20261019/cards/`](docs/rules/zh-CN/V20261019/cards)
- [卡牌合并视图 metadata.merged.json](docs/MERGED-METADATA.md)、[NAS 存储](docs/STORAGE.md)、[新机器建库](docs/MULTI_MACHINE.md)

## 许可

代码以 [MIT](LICENSE) 许可发布，第三方说明见 [NOTICE](NOTICE)。

Pokémon、宝可梦标志、卡名、卡文与卡图的权利属于 Nintendo／Creatures／GAME FREAK／The Pokémon Company。
这是非商业的爱好者项目，与上述公司无关，也未获其认可。仓库不包含卡图文件。
