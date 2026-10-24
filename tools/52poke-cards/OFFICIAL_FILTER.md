# 官网原始图片分类与人工复核

`official_filter` 只处理已经下载、哈希校验过的**官网图片**，不读取 MIK，
不请求官网、不重新启动旧下载器，不匹配卡号/印刷版，也不写正式 `library`。
原始图片和来源清单保持不变。运行数据、预览和模型响应均不提交 Git。

## 分类标准

- `card`：完整、单张、基本正视的宝可梦 TCG **正面**图。包含宝可梦、训练家、
  物品、支援者、场地、能量以及特殊全图卡；不要求必须有 HP 或招式框。
- `non_card`：**不是单张完整正面卡图**，包括包装、商品、海报、广告、图标、
  卡背、多卡拼图、卡片局部、实拍场景和其他内容。这不表示它不含宝可梦素材。
- `review`：模型结果有分歧、画幅异常、预览处理失败，或缺少充分证据。

长宽比只作辅助检查，不单独决定类别，不限定 `868×1212`。
两种不同部署分别视觉判别，改变拼图顺序、使用大字号图片 ID，并核验返回 ID
完整性；结构化 JSON 条件约束类别、卡面标志和子类别的一致性。
双方同类且模型自评分均至少 96 时自动分类。否则单图放大再判别，
需至少 98 分并获得此前一个至少 96 分的同类判断支持；仍不满足则留待用户复核。
异常画幅保留复核门槛。
自动确认卡图要求常规竖向画幅。横图即使含有完整卡牌，也要检查是否是
“左侧卡牌 + 右侧说明”的教学排版；旋转卡图不删除，仍可放大复判或人工确认。
抽检发现此类边界问题时可显式运行 `frame-audit`，用强化整图边界标准的两个
独立单图判断复判。旧模型判断保存在本机 `vote_history` 和原请求缓存，不覆盖人工结论。
为减少人工负担，放大后仍未形成共识的图片可再交给另一部署做独立单图判别；
两个不同部署的单图判断同类且均至少 98 分时归类，仍有歧义则保留用户复核。

**自评分不是测得的正确概率；模型共识不是人工核准，无法保证零误判。**
网页允许对任何分组修正结果，所有修改保存审计记录，并保留原 AI 证据。

## 存储

默认布局：

```text
/nas/share/Pokemon/images/official-bulk/             原始图片，只读
/nas/share/Pokemon/images/official-card-filter/thumbs/   派生 JPEG 预览
/nas/share/Pokemon/metadata/official-bulk/images.jsonl    来源回执，只读
/nas/share/Pokemon/metadata/official-card-filter/         分类结果与报告
tools/52poke-cards/exports/official-card-filter/          本机私有 SQLite / 模型缓存 / 日志
tools/52poke-cards/exports/official-card-filter/views/    本机三类原图软链接视图
```

同一哈希的多条回执取并集，保留全部来源页和图片地址。临时签名不进入分类目录或网页。
生成预览前核对原始 SHA-256 和大小，完整画面等比缩放，不裁切或改写原图。
SQLite 和锁不放在 NAS。默认只依赖现有 Pillow；少量 SVG 预览使用项目已安装的 Node `sharp`。
当前 CIFS NAS 不支持在共享盘上创建软链接（`EOPNOTSUPP`），因此三类原图软链接视图
留在本机；链接指向 NAS 原图，不复制图片字节。NAS 上的三类 JSON 清单保留
`original_filename`，结合 `summary.json` 的 `original_image_directory` 即可定位原图。

## 执行

从仓库根目录：

```sh
T="$PWD/tools/52poke-cards"
export PYTHONPATH="$T"
PY="$T/.venv/bin/python"

# 离线校验原图、合并来源、生成预览
"$PY" -m official_filter prepare --workers 4

# 用户明确允许后才会读取凭据并发送公开官网图片到指定 Azure 服务
"$PY" -m official_filter classify --run-azure --env "$PWD/.env.foundry" \
  --phases primary secondary adjudicator verifier --workers 6 --max-requests 900

"$PY" -m official_filter status
"$PY" -m official_filter export

# 对异常画幅候选做针对性整图边界复判，不发送有 provider_hold 的图片
"$PY" -m official_filter frame-audit --run-azure --env "$PWD/.env.foundry" \
  --workers 6 --max-requests 100

# 默认只开放本机；网页服务不读取 Foundry 配置、不调用模型
"$PY" -m official_filter serve --port 8832

# 需要局域网访问时，显式允许本机实际的私有 IP：
# "$PY" -m official_filter serve --host 0.0.0.0 --allow-host YOUR_PRIVATE_IP --port 8832

# SSH/Codex 把本机 57824 转发到远程 8832 时，显式允许浏览器实际使用的源：
# "$PY" -m official_filter serve --port 8832 --forwarded-origin http://localhost:57824

# 若客户端每次自动分配不同的本机转发端口，启用仅限本机 SSH 代理的模式：
# "$PY" -m official_filter serve --port 8832 --ssh-forwarded
```

`.env.foundry` 使用 `AOAI_ENDPOINT` 和 `FOUNDRY_KEY`（或 `AZURE_OPENAI_API_KEY`）。
只允许 HTTPS 的 Azure 服务域名、标准端口和干净的 `/openai/v1` 路径，
凭据不进入前端、模型请求缓存或日志，不跟随重定向。
默认部署为已有项目使用的 `gpt-4.1-mini-global-standard` 和
`gpt-4.1-global-standard`，需要实际账号验证，不能仅凭通用模型目录断言已部署。

每次运行最多 900 次新请求、每秒最多 2 次发起、最多 8 个线程；
临时传输/服务错误最多 3 次尝试，429 遵守 `Retry-After` 有界等待，
Azure 401/403 持久停止。已有官网 403 状态完全不读取、不更改、不绕过。
有效模型缓存和已保存判断可复用；漏 ID、重复 ID、逻辑冲突或截断输出不算成功。
失败项保留复核，不静默忽略。
Azure 内容过滤或模型拒绝会为对应图片保存持久 `provider_hold`，停止继续向其他模型
发送该图片，不裁图、改身份或改提示绕过过滤；原图仍可本地人工复核。
`provider_held_images` 与网页上的“模型服务拒绝自动判别”会明确列出这些情况。
退出码 2 表示还有模型漏项或有界预算内未完成的自动复判，不是全量成功；
查看 `pending_model_inputs`、`pending_enlarged_checks`、`pending_second_enlarged_checks`。
需要继续时保留全部状态并继续同一流程；遇到批量返回漏 ID 可显式改为
`--batch-size 1`，只处理尚无有效判断的图片，不重跑已完成图片。
所有自动阶段完成后仍确实有歧义的 `review` 项可以与 `pipeline_complete=true` 同时存在。

网页面向受信任本机/局域网，不要直接暴露到公网。校验 Host、同源 Origin，
使用 CSP，不提供任意文件读取；只能读取清单内原图、预览和经过筛选的分类证据。
转发前后端口不同时，`--forwarded-origin` 兼容代理保留或改写 Host 的两种方式；
仅接受明确配置的可信主机、协议和端口，不放行其他本机端口，不信任
`Forwarded` / `X-Forwarded-*` 请求头，也不关闭跨站拒绝或开启 CORS。
转发端口改变后需更新此参数。
对于随机分配端口的 SSH 客户端，可改用 `--ssh-forwarded`：仅当连接实际来自
远端服务器的回环地址，且 Host 是 `localhost` / `127.0.0.1` / `[::1]` 时，
接受不同的 HTTP 端口。Origin 仍须与 Host 相同；若代理将 Host 改写为后端地址，
只接受回环 Origin 且必须有浏览器 `Sec-Fetch-Site: same-origin` 证据。
其他端口的跨源请求（`same-site`）、公网来源、LAN 连接伪装转发均不享有此例外。
此模式不创建 SSH 隧道、不监听客户端的临时端口；应向客户端提供原始远端链接
`http://127.0.0.1:8832/`，不要将客户端分配的临时转发端口再次当作远端链接。

## 审核网页

- 三组图片分别浏览、类型筛选、ID/来源/理由搜索、排序与分页。
- 点图放大，查看双模型/放大复判理由、原始来源和 SHA-256。
- 单张或批量确认「卡图 / 非纯卡图 / 待复核」，可恢复 AI 判定。
- 详情快捷键 `1/2/3` 分类、左右方向键切图；复核队列确认后自动下一张。
- 人工备注、人工覆盖和操作审计持久保存；再次运行模型不会覆盖人工结论。
- 导出带全部原始来源、AI 判断和人工结果的 JSON。

分类报告为 `summary.json`、`catalog.json`、`card.json`、`non_card.json`、`review.json`。
它们是派生清单，不是正式卡牌身份库。服务器运行期间修改审核会同步更新这些报告。

## 离线测试

```sh
PYTHONPATH=tools/52poke-cards tools/52poke-cards/.venv/bin/python \
  -m unittest discover -s tools/52poke-cards/tests -p test_official_filter.py -v
node tools/52poke-cards/tests/official_filter_browser.cjs
TEST_SSH_FORWARD=1 node tools/52poke-cards/tests/official_filter_browser.cjs
TEST_SSH_FORWARD=dynamic node tools/52poke-cards/tests/official_filter_browser.cjs
TEST_SSH_FORWARD=dynamic TEST_PROXY_PRESERVE_HOST=1 node tools/52poke-cards/tests/official_filter_browser.cjs
```

测试仅用临时合成图片和假传输。覆盖来源并集、原图保护、模型格式/ID 校验、
共识门槛、人工覆盖持久化、并发版本检查、CSRF、目录穿越、三类筛选、
批量审核、移动布局和无外网请求；不把合成测试通过当成真实模型准确率。
转发模式额外经过真实本地反向代理，核验保留/改写 Host 均可读取，
以及浏览器 Origin 保持转发端口时仍可保存、恢复和持久化审核。
动态模式另测代理端口改变后无需重启服务，并用真实浏览器从其他 localhost
端口发送无需预检的跨源写请求，核验版本号与人工审核均未改变。
