# MIK × 52Poké：候选合并与语义核验

入口：`merge_mik.py`，实现：`mik_merge/`。这是独立的**候选流程**：
以52Poké格式为骨架，采用对应MIK简体名称／描述和原始卡图，
补充有来源依据的弱点／抗性修正。不写入正式`library`，不启动下载队列，
不把规则页面ID当作跨来源印刷ID或引擎卡牌身份。

代码遵循仓库MIT许可；输入Wiki数据、MIK卡文和图像不因此变成MIT。
保留原始来源、固定修订、哈希与归属，另见[数据许可](DATA_LICENSE.md)。
本目录只提交代码、模板、合成测试与20张历史样本的**选择清单**；
不提交下载数据、卡图、模型响应、密钥、生成HTML或本机观察记录。

## 环境与输入

从仓库根目录运行，Python 3.11+，使用现有依赖：

```sh
python3 -m venv tools/52poke-cards/.venv
tools/52poke-cards/.venv/bin/python -m pip install -r tools/52poke-cards/requirements.txt
python3 tools/52poke-cards/merge_mik.py --help
```

MIK输入是已经取得并校验过的本地导出，不会联网补齐：

```text
SOURCE/cards/{setCode}/{cardIndex}/
  metadata.json
  source-response.json
  metadata-receipt.json
  image.png
  image-receipt.json
```

必须有源响应／图片SHA-256回执，且PNG可完整解码、尺寸与回执相符。
Wiki输入默认使用已提交的`snapshots/2026.10.18`：
`manifest.json`、`cards.jsonl.gz`、`display-zh-hans.jsonl.gz`。
读取前验证gzip哈希；这是固定快照，不宣称是当前网站全量。

选择清单由用户提供，不能通过替换失败样本隐藏问题：

```json
{
  "schema": "mik-52poke-selection-v1",
  "method": "用户指定的分层样本；不是准确率估计",
  "samples": [
    {"batch": "first", "mik_id": "CSMPaC/001"},
    {"batch": "first", "mik_id": "CSZC/020"}
  ]
}
```

`mik_merge/example-selection.json`保留此前两批各10张的MIK标识，
不包含预期Wiki ID，匹配器不会读取预先指定的正确答案。
重复MIK标识、路径穿越与不安全批次名均拒绝。

## 1. 离线生成候选

```sh
PY=tools/52poke-cards/.venv/bin/python
RUN=tools/52poke-cards/exports/my-mik-merge

$PY tools/52poke-cards/merge_mik.py stage \
  --source tools/52poke-cards/exports/mik-full-20261019 \
  --selection tools/52poke-cards/mik_merge/example-selection.json \
  --run-dir "$RUN"

$PY tools/52poke-cards/merge_mik.py html --run-dir "$RUN"
```

输出必须是`tools/52poke-cards/exports`的严格子目录，
不得与输入数据、快照、选择／观察文件或正式库重叠；写入时再次检查符号链接逃逸。

匹配先结合规范化的双语卡名与真实印刷行召回，必要时按描述二元字串补充召回，
再检查卡种、HP、属性、阶段、技能数量、能量费用（含`+`）、伤害运算符、
弱点、抗性、撤退费用等。候选不唯一时保留阻断，不能只按排名猜。
正文比对是关联之后的额外门槛，不由一个相似度分数决定。

派生规范化有日志，原始Wiki结构／展示副本不改写：
正确展开TCG链接显示标签、繁简及属性别名；保留未知模板；
从显式`damageP`重建伤害符号；只删除内容完全为空的VSTAR章节标题；
阶段／进化解释必须有明确模板依据。

卡面完整编号不从系列总数推测。可选`--observations local-observations.json`
引用此前实际检查过的卡面：

```json
{
  "observations": [{
    "mik_id": "CSMPaC/001",
    "printed_number": "001/023",
    "image_sha256": "这里必须填写实际图片的64位SHA256",
    "method": "agent_visual_inspection_of_cached_card_and_enlarged_footer",
    "human_reviewed": false
  }]
}
```

记录必须绑定图片SHA-256；这是Agent卡面观察，不是伪造的OCR置信度或最终人工核准。
没有独立卡面检查时仍保留暂缓；卡面与Wiki完整编号冲突时也不放行。
旧身份校验不支持`DAR`纯字母卡号：仍保留真实字母编号和独立暂缓项，不伪造数字。

## 2. 有界Foundry核验

先验证实际已部署的名称；默认名称不保证存在于其他Azure账号。
凭据从进程环境或显式`--env`文件读取：
`AOAI_ENDPOINT=https://your-resource.openai.azure.com/openai/v1`，
以及`AZURE_OPENAI_API_KEY`或`FOUNDRY_KEY`。不要把真实配置提交Git。

```sh
# 默认只读哈希匹配的已有响应，不联网、不读取密钥；缺少缓存会明确停止。
$PY tools/52poke-cards/merge_mik.py judge --run-dir "$RUN"

# 只有显式开启才会发送公开卡文到指定Azure部署：
$PY tools/52poke-cards/merge_mik.py judge --run-dir "$RUN" \
  --run-azure --env .env.foundry \
  --azure-host your-resource.openai.azure.com \
  --reviewer-a gpt-4.1-mini-global-standard \
  --reviewer-b gpt-4.1-global-standard \
  --max-requests 8
```

`--azure-host`须与endpoint的实际小写hostname一致。只允许Azure服务域名、
HTTPS、标准端口及干净的`/openai/v1`路径；拒绝跳转、查询参数、URL凭据或其他域名。
没有自动重试、模型fallback或资源创建；请求体与响应归档不包含认证头。

- 默认总预算8次：12组校准分3批，由两个部署分别检查，共6次；
  最多4段实际差异正文再调用2次。更多正文必须显式提高预算或缩小选择；
  超额在发送任何新请求前停止。缓存重放不收费、不读取凭据。
- 文本相同（仅安全图标／空白表示差异）及双方空白项不调用模型。
  若没有需要模型核验的正文，则连模型校准也不调用。
- 数量、正负号、未知模板、明确每事件／每回合次数冲突等有硬性否决，
  模型不能绕过。额外数字1必须由两个部署明确确认数量条件一致，不一概删掉。
- GX／VSTAR每场一次提示，必须有具体技能槽模板、MIK机制／阶段及官方规则共同支持。
  只在模型输入中等长遮罩已核验的提示，保留原字符偏移；候选MIK描述不删减。
- 两个不同部署分别核验10类条件：时机、触发、归属、对象、区域、数量、代价、
  操作顺序、次数／期间限制、例外。第二个部署交换输入顺序，不读取前者答案。
- 模型引用句子编号；程序按偏移从源文本取证据，拒绝未知编号、伪造引用、
  缺维度、截断／拒绝响应和结论矛盾。源槽位文字与metadata哈希变化会使核验停止。
- 10个负例／2个正例均须通过两部署校准，预期答案不发给模型。
  任一模型不确定、分歧、缺证据、校准失败，均保留暂缓。

同系列两个模型仍可能共同犯错；校准不是全量准确率或独立正确性证明。
机器通过不等于人工核准，也不解除卡号、印刷身份等非语义暂缓。

## 3. 渲染审阅与导出意见

```sh
$PY tools/52poke-cards/merge_mik.py html --run-dir "$RUN"
$PY tools/52poke-cards/merge_mik.py serve --run-dir "$RUN" --port 0
```

终端打印HTML预览URL，`#semantic`直接显示「语义核验」。也可离线打开生成HTML。
服务器只监听loopback，只提供HTML和favicon，不暴露目录、数据JSON、模型API或密钥。
需要固定浏览器存储origin时显式指定固定`--port`；建议导出意见JSON备份。

HTML包含原始／派生／实际合并候选、来源哈希、逐字段差异、模型原文证据与校准结果。
所有图片／数据内嵌，CSP禁止自动联网。原始文本只按文本渲染。
人工关联意见、字段取舍和备注与机器判定分开；导入必须通过整组数据指纹和身份检查，
失败不会部分改写已有意见。**导出的是意见，不会执行正式入库或启用对战规则。**

未找到唯一关联的样本始终留在JSON报告；HTML构建会明确列出阻断项并停止，
不会通过悄悄省略失败样本来生成一个“全成功”的审阅页。

## 本地验证

```sh
cd tools/52poke-cards
.venv/bin/python -m unittest discover -s tests -p 'test_mik_merge*.py' -v
# 可选：已有Node/Playwright浏览器时，检查实际生成的任意样本组
node tests/mik_merge_browser.cjs /absolute/run/semantic-v2/review.html /tmp/mik-merge-browser
```

浏览器可通过`PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE`选择现有安装，不要求本机固定路径。
Python测试使用临时合成metadata、纯色PNG与模拟传输，不依赖MIK私有缓存、Azure或NAS。
没有提交真实模型响应，干净clone的单元测试仍可离线运行。

历史20张实测：增加正文核验后，16张机器通过／4张暂缓变为19张通过／1张DAR暂缓；
12组校准全部通过。原文、图片、正式库和人工意见未改写。这只是分层样本结果。

机制依据是[官方SWSH12规则书](https://assets.pokemon.com/assets/cms2/pdf/trading-card-game/rulebook/swsh12_rulebook_en.pdf)
第24页Appendix C（VSTAR）、第30页Appendix M（GX）。
请求结构依据[Foundry Structured Outputs](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs)；
JSON Schema约束输出格式，不保证规则理解正确。
