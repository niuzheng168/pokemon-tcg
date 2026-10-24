# 密勒顿牌组审查：52Poké 库 metadata 快照

`sv-miraidon-review.json` 中每个 `libraryMetadata` 回执的原字节副本，文件名为其 SHA-256
（`<sha256>.json`），与回执的 `snapshot` 字段一一对应。共 18 份，均为审查时（2026-10-20）实际读取的字节。

- `readFrom` 只记录审查时读取的工作路径 `tools/52poke-cards/library/…`。该目录被 Git 忽略，
  由各机器自行构建或链接到本机库，不同构建的同一路径字节可以不同，所以测试不读它。
- `tests/cn-card-review.mjs` 在每个 clone 上都核对这里的全部快照：哈希或字节数不符即失败，
  缺失快照也失败。目录里只能有被回执引用的快照。改动证据必须换新的哈希和快照，并重新审核。
- MIK 导出文件（`files.*`、`mikMetadata`）不能提交，按哈希归档在忽略提交的
  `.cache/rules/card-review/V20261019/sv-miraidon/<sha256>.bin`（`localArchiveRef`），
  本机有归档时才核对。

## 来源与许可

这些快照是 `tools/52poke-cards` 从**神奇宝贝百科及其贡献者**（https://wiki.52poke.com/）
2026.10.18 归档提取、转为简体后的卡牌 metadata，以 **CC BY-NC-SA 3.0** 提供
（https://creativecommons.org/licenses/by-nc-sa/3.0/），不适用仓库根目录的 MIT 许可。
修改方式和权利边界见 `tools/52poke-cards/DATA_LICENSE.md`。各文件 `attribution` 字段保留出处，
回执的 `wikiSourcePages` 记录页面和修订。

`images` 字段只含图片的来源 URL、尺寸、字节数和哈希，不含图片本身。
`source_cache_file` 是构建机当时的本地路径，按原字节保留，不供读取。
