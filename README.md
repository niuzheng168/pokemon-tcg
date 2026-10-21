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
| 网页对战（对电脑） | [`public/`](public)：原版对战界面 `ui.js` 经 `match.js` 驱动内核，构建后位于 `/play/` |
| 卡牌资料工具（52Poké／MIK／官网） | [`tools/52poke-cards/`](tools/52poke-cards/README.md) |

网页上的 3 副卡组：

- 嗨皮组合 皮卡丘卡组（CSVH1C，官方预组，开放赛制）
- 猛雷鼓ex（2026 城市赛上海站第 1 名卡表，标准赛制）
- 多龙巴鲁托ex／黑夜魔灵（2026 城市赛广州站第 1 名卡表，标准赛制）

## 运行

需要 Node 21.7 以上。本机 `NODE_ENV=production` 时要带上 `--include=dev`。

```sh
npm ci --include=dev
npm run cn:images     # 从本机卡牌库复制审核过的卡图（缺图时显示卡背）
npm start             # 构建 site/ 并在 http://127.0.0.1:8790/ 预览
```

## 测试

```sh
npm test                               # 官方规则、真实卡机制与电脑完整对局、审查记录、合并视图、对战界面驱动
npm run test:rules:official:coverage   # 规则内核覆盖率门槛（行／函数 100%，分支 95%）
npm run test:ui                        # 浏览器测试（Playwright）
```

## 文档

- [进度与已实现内容](docs/rules/zh-CN/V20261019/STATUS.md)
- [设计](docs/rules/zh-CN/V20261019/DESIGN.md)、[条款覆盖矩阵](docs/rules/zh-CN/V20261019/CLAUSE-COVERAGE.md)、
  [发布与信任](docs/rules/zh-CN/V20261019/RELEASE.md)、[赛制](docs/rules/zh-CN/V20261019/FORMATS.md)
- 逐卡审核记录：[`docs/rules/zh-CN/V20261019/cards/`](docs/rules/zh-CN/V20261019/cards)
- [卡牌合并视图 metadata.merged.json](docs/MERGED-METADATA.md)、[NAS 存储](docs/STORAGE.md)、[新机器建库](docs/MULTI_MACHINE.md)

## 许可

代码以 [MIT](LICENSE) 许可发布，第三方说明见 [NOTICE](NOTICE)。

Pokémon、宝可梦标志、卡名、卡文与卡图的权利属于 Nintendo／Creatures／GAME FREAK／The Pokémon Company。
这是非商业的爱好者项目，与上述公司无关，也未获其认可。仓库不包含卡图文件。
