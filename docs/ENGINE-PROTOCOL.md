# 引擎协议 engine/1

规则引擎放在服务器的 worker 里运行，服务器、AI 和牌桌都只通过这套消息和它打交道。现在的实现是 JS（`server/engine-host.mjs`），以后如果换成别的语言，只要遵守同一套消息格式，并通过同一组测试（`tests/engine-host.test.mjs`），服务器和其他功能都不用改。

## 角色

| 角色 | 做什么 |
| --- | --- |
| 引擎宿主（host） | 保存每局的完整状态，只执行规则；给某个座位的输出只含这个座位能看到的信息。用模拟模式执行，检查方式见下文"检查" |
| worker 池（`server/engine-pool.mjs`） | 把对局分到各个 worker 线程上，一局固定在开局时所在的线程；`workers: 0` 时宿主直接在本线程运行（测试、小规模部署） |
| 服务器 | 唯一调用方：把座位绑定到登录用户，生成种子，记录对局，安排电脑走子，决定谁可以悔棋 |
| 牌桌（浏览器） | 只发指令，只收自己座位的视图和事件 |
| AI 服务（`ai/service.mjs`） | 由服务器把完整快照交给它，牌桌拿不到快照 |

## 传输

所有消息都是纯 JSON。请求是 `{id, op, ...参数}`，回复是 `{id, ok: true, result}` 或 `{id, ok: false, error: {code, message, ruleId?}}`。现在的传输是 worker 线程的 postMessage；换成别的语言时，可以每行一条 JSON 走标准输入输出，也可以走 napi。同一局的请求按到达顺序处理。

`pool.call(op, 参数)` 成功时返回 `result`，失败时抛出 `EngineCallError`（带 `code`、`message`，以及可能有的 `ruleId`）。单次调用超过 1 秒会记一条 `[slow engine]` 日志。`pool.load()` 返回每个 worker 上开着的对局数。`pool.restart(i)` 停掉第 i 个 worker 并重开一个：和 worker 意外退出时一样，它上面的对局都会丢失，之后对这些对局的调用会返回 `unknown-match`。

## 操作

**牌桌可见**：这一列为"是"的输出，服务器可以原样转给牌桌。为"否"的含有隐藏信息，只给服务器、AI 和管理员用。

| op | 参数 | 结果 | 牌桌可见 |
| --- | --- | --- | --- |
| `hello` | — | `{protocol, releaseId, manifestSha256, kernelSha256, matches}` | 是 |
| `open` | `match`, `setup`, `expectedApproval?`, `moves?` | `{status, hash, approval, compatibility}` | 否（`approval` 列出了双方卡组的全部卡牌） |
| `status` | `match` | `{status, hash, broken?}` | 是 |
| `play` | `match`, `seat`, `revision`, `action` | `{status, hash}` | 是 |
| `view` | `match`, `seat`, `cursor?` | `{status, view, events, cursor, reset?}` | 只给这个座位的玩家 |
| `watch` | `match`, `cursor?` | `{status, view, events, cursor, reset?}` | 是（观众视图：双方都能看到的内容） |
| `preview` | `match`, `seat`, `revision`, `action` | `{pending: {kind, options, minimum, maximum} \| null}` | 只给这个座位的玩家 |
| `rewind` | `match`, `revision` | `{status, hash}` | 是 |
| `snapshot` | `match` | `{snapshot}`（完整状态，含双方牌库顺序和随机数状态） | 否 |
| `restore` | `match`, `snapshot` | `{status, hash}` | 否（只给管理员的调试台） |
| `close` | `match` | `{closed}` | 是 |

**各参数说明：**

- **`match`**：对局编号，不超过 100 个字符，由服务器自己定。
- **`setup`**：`{releaseId, seed, format, matchMode, decks: [[printingId…], [printingId…]]}`。`releaseId` 必须是宿主加载的那个发布，否则返回 `release-mismatch`。
- **`seed`**：由服务器用 `crypto.getRandomValues` 生成。对局结束前不发给牌桌，否则牌桌能算出整副牌库的顺序。
- **`moves`**：`[{seat, action}…]`，`open` 时按顺序重放到当前局面，用于服务器重启或 worker 退出后从记录恢复对局。重放用模拟模式跑，最后对局面做一次完整检查；有一步被拒绝就返回 `replay-refused`。
- **`seat`**：由服务器按登录用户填写。牌桌发来的指令里不带 `player`，宿主用 `seat` 组装 `{player, expectedRevision, action}` 交给引擎。
- **`revision`**：牌桌看到的局面版本，必须等于当前版本，否则返回 `stale-command`。同一条指令重复提交时，第二次也会因此被拒绝。
- **`action`**：引擎指令，也就是视图 `legalActions` 里的一项，或者对 `pending` 的回答 `{type: 'answer', requestId, selected}`。
- **`hash`**：与 `public/replay.js` 的 `stateHash` 算法相同，可以直接写进记录的 `action` 步骤。

## 状态

`status` 是 `{revision, turn, phase, actor, result}`，双方都能看到。

`actor` 表示现在该谁行动：如果有选择请求在等某位玩家，就是那位玩家；否则是本回合的玩家；对局结束后为 `null`。引擎给非行动方的 `pending` 是 `null`，所以牌桌要靠 `actor` 来显示"对方正在选择"。服务器也靠 `actor` 判断是否该让电脑走子。

## 检查

宿主用引擎的模拟模式（`Simulation`）执行对局：规则相同，只是关掉了每一步对整局状态的自检。检查分三层：

- **每条指令**：在入口检查指令格式、局面版本号和座位，再由引擎核对合法动作或选择请求。被拒绝的指令会回滚，局面保持原样。
- **每回合开始**：对整局状态做一次完整检查，后期一次约 100 ms，平摊到每条指令约十几毫秒。没通过就停住这局：`status` 带 `broken` 说明原因，`play`、`view`、`preview` 返回 `state-invalid`，`snapshot` 仍然可用，方便附进问题报告。悔棋或 `restore` 到一个通过检查的局面后，这局可以继续。
- **测试**：同一种子分别用完整检查和模拟模式打，每一步的状态、视图、合法动作都必须相同（`tests/official-rules/simulation.test.mjs`、`tests/cn-cards/simulation.test.mjs`、本协议的测试）。规则测试运行时，引擎缓存的中间结果每次都会和重新计算的结果比对（`tests/verify-reads.mjs`）。

## 视图和事件

- **`watch`**：观众视图，引擎的 `playerView(state, catalog, null)`：双方手牌都只给数量，准备阶段的宝可梦都背面朝上，没有选择请求和合法动作，事件只有公开的。游标和 `view` 一样用。
- **`view`**：引擎的 `playerView(state, catalog, seat)`，去掉了事件列表。对手的手牌和双方牌库只给数量；奖赏卡只给数量，以及正面朝上的那几张；`pending` 只给被询问的一方。里面没有随机数状态、种子和工作队列。
- **`events`**：这个座位可见的事件中，排在 `cursor` 之后的那些。
- **`cursor`**：一个不透明的字符串，下次请求时原样带回。
- **`reset: true`**：悔棋或调试台改局面之后，旧游标会失效，宿主会把这个座位的事件从头重发一遍，并带上这个标记，牌桌收到后应清空已有的事件历史。

实测一局约 400 条事件、每条约 300 字节；去掉事件后的视图约 20–25 KB。所以每一步只发视图和新增事件，不重发整个事件列表。

## 试走（preview）

预览只针对从自己手牌打出的宝可梦道具，回答"装给哪只宝可梦"，候选都是自己场上的宝可梦。其他指令一律返回 `null`：如果放开，预览检索类卡就能看到牌库，预览带硬币的效果就能提前知道下一个随机结果。试走时如果用到了随机数（例如对手的「振动拳」让打出每张训练家前都要抛硬币，或者先洗了牌库），不管结果如何也返回 `null`：否则正面会问"装给谁"、反面不会，预览就等于提前告诉了下一次硬币（`previewTool`，测试见 `tests/engine-host.test.mjs`）。

这一项取代了牌桌在完整快照副本上试走的做法（`public/match.js` 的 `probe`）。以后让引擎在 `legalActions` 里直接列出道具的目标，就可以不再需要这个操作。

## 悔棋和调试台

- **`rewind`**：回到当前这条对局线上更早的某个版本。宿主保存最近两个回合开始时的局面，更早的版本从开局重放。悔棋规则（只能撤自己本回合、不影响隐藏信息的动作，只在人机对战里允许）由服务器判断，宿主不管。
- **`restore`**：用一个新的完整局面替换当前局面，用于管理员在调试台改局面。新局面会像读档一样接受完整检查，然后成为新的起点：之后不能悔棋到它之前。

## 错误码

| code | 含义 |
| --- | --- |
| `bad-request` | 参数格式不对，或者是未知的 op |
| `unknown-match` | 这个宿主上没有这局，可能从没开过、已经关闭，或者所在的 worker 退出了 |
| `match-exists` | `open` 了一局已经开着的对局 |
| `release-mismatch` | `setup.releaseId` 不是宿主加载的发布 |
| `replay-refused` | `open` 时 `moves` 里有一步被规则拒绝 |
| `engine-crashed` | 请求处理中 worker 退出了 |
| `state-invalid` | 这局在某个回合开始时没通过完整检查，已停住；悔棋或 `restore` 后才能继续 |
| `stale-command`、`invalid-command`、`game-over` 等 | 引擎的 `EngineError` 原样传出 |
| `rule-violation`（带 `ruleId`） | 规则拒绝了这条指令 |
| 发布相关的 code（如 `incompatible-recorded-release`） | 开局或恢复时卡牌发布校验没通过 |
| `internal` | 宿主内部出错，服务器记日志，不把详情转给牌桌 |

被拒绝的指令不会改变局面。

## 服务器负责、协议不管的事

- 座位和用户的绑定、生成种子、超时判负和断线重连、观战。
- 电脑走子：在 `actor` 是电脑座位时，把 `snapshot` 交给 AI 服务的 `decide`，再 `play`。难度 0 的旧 CPU（`public/cn/ai.js`）只需要电脑座位的 `view`。
- 记录：每次 `play` 记一条 `action` 步骤（seat、revision、action、hash），被拒绝的记 `rejected`，悔棋记 `rewind`，调试台记 `edit`。格式和现在的 `public/replay.js` 相同。
- 恢复：收到 `unknown-match` 时，用记录里的 setup 和有效走法（`effectiveMoves`）重新 `open`。
- 卡牌数据：牌桌加载完整卡库来显示卡名和卡图，不使用这局的 catalog。这局的 catalog 只含双方卡组里的卡，交出去就等于泄露对手卡组。

## 服务器上的对局（`server/play.mjs`，`/api/play`）

上面这些职责由 `server/play.mjs` 实现，牌桌通过 `/api/play` 使用：

| 接口 | 作用 |
| --- | --- |
| `POST /api/play {deck, opponent?, level?, seed?}` | 开新局：服务器生成种子，按卡组 ID 读取双方卡组（玩家自己的卡组先检查是否合法），玩家其他进行中的对局记为放弃。`seed` 只有管理员能指定；测试服务器用 `--test-seeds` 启动时任何玩家都能指定，供浏览器测试固定发牌 |
| `GET /api/play/current` | 玩家进行中的对局和完整视图，用于刷新页面后继续 |
| `GET /api/play/:id?cursor=` | 玩家视图和新增事件 |
| `POST /api/play/:id/move {revision, action, cursor}` | 玩家走一步；返回之后的视图、这一步是否"安静"、还能撤销几步 |
| `POST /api/play/:id/cpu {revision, cursor}` | 小茂走一步：有难度时用 AI 服务（输入服务器自己的快照），AI 出错或给出被拒绝的走法时改用 CPU 引擎 |
| `POST /api/play/:id/preview` | 道具的目标 |
| `POST /api/play/:id/undo` | 撤销本回合自己的安静走法（上场、进化、附能量），视图重新开始 |
| `POST /api/play/:id/abandon` | 放弃这局 |
| `POST /api/play/takeover {match, move, seat?, level?}` | 把一局已结束的对局重放到第 n 步，作为玩家对小茂的新对局（进行中的人机对局只有管理员可以接管，进行中的在线对战谁都不能接管）。`seat`：玩家坐哪一边（默认是他在原对局里的座位，否则 0），小茂坐另一边，记在 `setup.seat`；`level`：小茂的难度，同新对局（默认沿用原对局） |
| `GET/POST /api/play/:id/state` | 管理员：读取完整状态；提交调试台修改（记为 `edit` 步骤，局面版本必须是当前版本加 1；`revert` 回到更早的版本，记为 `rewind`）。在线对战进行中不能用 |

### 两位玩家对战（在线对战）

两位玩家在大厅约战：一人开房（卡组、赛制、每方用时），另一人带自己的卡组加入，对局随即开始。房主坐座位 0，加入者坐座位 1（`setup.pvp`，数据库里加入者是 `opponent_id`）。

| 接口 | 作用 |
| --- | --- |
| `GET /api/rooms` | 等人加入的房间：房主、赛制、每方分钟数；不显示房主的卡组 |
| `POST /api/rooms {deck, format?, minutes?, seed?}` | 开房（每人一间，新的替换旧的）：卡组须符合赛制（默认用卡组自己的赛制），每方 10、20 或 30 分钟（默认 20），`seed` 的规则同 `POST /api/play` |
| `DELETE /api/rooms/:id` | 取消自己的房间 |
| `POST /api/rooms/:id/join {deck}` | 加入：卡组须符合房间的赛制；回复和 `POST /api/play` 相同 |
| `GET /api/events` | 推送通道（Server-Sent Events）：`rooms`（大厅变了）、`match {id}`（你的房间有人加入）、`move {id, revision}`（对局走了一步，双方都收到）、`presence {id, seat, online}`（对手打开或关掉了网站） |
| `POST /api/play/:id/concede` | 认输：引擎的 `concede`，对手获胜；人机对战也可以用 |

- **座位**：服务器按登录用户确定座位，`move`、`preview`、`view`、`concede` 都用这个座位；`cpu`、`undo`、`coach` 回答 409 `pvp`。对局进行中谁都不能用调试台（读取完整局面和修改都回答 403），管理员也不行。`abandon` 等于认输。一位玩家有在线对战没下完时，不能开房、加入或开新的人机对战（409 `in-game`）；开始在线对战会放弃双方进行中的人机对战。
- **计时（棋钟）**：每方在整局里共有 `setup.clock.minutes` 分钟，引擎等谁（`status.actor`）就扣谁的时间。时间记在对局的 `clock` 列（`{left: [ms, ms], actor, since}`），每步都结算并写回；服务器重启后从启动时重新开始计（停机期间谁都不能走）。一步棋的用时算到它到达服务器的时刻，在队列里等候的时间不算任何一方的；时间用完后服务器再等 1 秒才判负，到达时还有时间、只是在队列里等着的那一步照常执行。时间用完时，服务器替这位玩家对引擎认输，记录里这一步带 `reason: 'timeout'`，对局结果是 `{winner, reason: 'timeout'}`，回复里的 `status.result` 和 `view.result` 也是这个结果。时间已经用完的玩家再走一步，服务器先判负，再回答 409 `game-over`。
- **每次回复**：摘要 `match` 多了 `pvp`、`players`（双方用户名）、`minutes`；回复多了 `clock {left, running}`（回复时双方剩余的毫秒数、正在走的一方）和 `online`（对手是否开着网站）。对局结束后双方仍可取最后的视图（输的一方要看到最后一步）；这种对局结束后不马上关掉，随闲置对局一起关。
- **隐藏信息**：对局进行中，每位玩家在 `GET /api/matches/:id` 和对局列表里只看到自己的卡组，对手的卡组是 `{id: null, name: null, cards: []}`；种子、`approval`、`implementation` 和全部步骤都不给（步骤里有对方秘密选的卡，比如检索牌库选了哪张）。结束后全部公开：任何登录用户都能读取它的记录、回放，也能从任一步接管（观众看过全程）。对局进行中，管理员读取对局记录也同样看不到种子、卡组和步骤（看得到的人就能转告给一方）。玩家的浏览器信息（`userAgent`）只给管理员看。观众提交「报告问题」时可以带上正在观看的对局编号，这局的记录只写进报告文件，不发回浏览器，也不附完整局面。
- **观战**：任何登录用户都可以观看进行中的在线对战。`GET /api/games` 列出进行中的在线对战（双方用户名、每方分钟数、回合、观战人数），对局开始或结束时推送通道向所有页面发 `games`。`GET /api/play/:id/watch?cursor=` 给观众视图（引擎的 `watch`）和公开事件，加上 `clock`、`online: [座位 0, 座位 1]`、`watchers`；摘要 `match` 的 `seat` 是 `null`，带 `watching: true`，对局结束前双方的卡组都不显示。对局结束后仍可取。观众的页面用 `GET /api/events?watch=<id>` 订阅：收到这局的 `move`、`presence {id, seat, online}` 和 `watchers {id, count}`。玩家的回复也带 `watchers`，观众人数变化时双方都会收到 `watchers`。观众只看到双方都看得到的内容，所以无法把隐藏信息转告给任何一方。人机对局不能观战。
- **防刷**：每个账户同时在途的 API 请求最多 8 个（推送通道和卡牌库除外），同时打开的推送连接最多 8 个，每分钟最多开 10 次房，超出回答 429。观众视图每个局面只向引擎要一次，同一局的所有观众共用，观众的请求不进这局的队列，所以无论多少人观看都不会拖慢玩家走子、消耗玩家的时间。只有在 `--test-seeds` 的测试服务器上开房才能指定种子（指定了种子的房主就知道双方牌库的顺序），管理员也不行。
- **引擎停住的对局**：如果引擎在某回合开始时发现局面不合法而停住这局（`state-invalid`），认输或时间用完时服务器直接在记录里写 `end`（带 `stopped: true`）结束这局，双方都不会被卡在这局里。
- **实例 ID**：引擎给卡的编号是“第几位玩家的卡表第几张”（`p1c17`）。服务器开局时把双方卡表按加密随机数打乱后再交给引擎，所以编号只说明一个随机位置，看不出卡表的结构。记录里存的就是打乱后的卡表，回放不受影响。

对局记录由服务器写，格式和 `public/replay.js` 相同：每步 `action`（带哈希）、被拒绝的 `rejected`、悔棋 `rewind`、调试台 `edit`、终局 `snapshot` 和 `end`。对局进行中，`GET /api/matches/:id` 不给非管理员看 `setup.seed`，结束后才公开，回放用它重放。引擎池里没有这局时（重启、worker 退出、闲置超过 2 小时被关掉），服务器先按记录重新打开，再处理请求。报告问题时，进行中对局的局面由服务器附上，不用浏览器发来的。管理员改过的局面可能带进别的卡组的卡，之后小茂的 CPU 引擎按改过的局面里的卡建卡表。

### 牌桌（`public/remote-game.js`）

牌桌通过 `RemoteGame` 使用上面的接口，`public/match.js` 驱动它的方式和以前驱动内核对局一样（`view`、`dispatch`）：

- 牌桌只有自己座位的视图和收到的事件。轮到小茂时只发 `cpu` 请求，等服务器走完再播放动画。
- 牌桌的卡表只含自己卡组的卡和已经亮出来的卡，每见到新卡就向审核发布重新取一次（`catalogFor`），所以浏览器拿不到对手的牌表。
- 刷新页面时向服务器取进行中的对局（`GET /api/play/current`）。浏览器的 localStorage 只存这局的编号和日志，不存局面。
- 请求失败（例如网络断开）时，牌桌重新取一次视图；服务器已经走了那一步的话，牌桌补播这一步。对局循环出错时，对局留在服务器上，刷新页面就能接着下。
- 悔棋、管理员改局面之后，视图从头重发（`reset`），牌桌按服务器的局面重新开始这局。
- 调试台读服务器的完整状态，在浏览器里还原一份只用来显示。每次修改先在这份副本上生效，再按顺序提交给服务器；服务器因为局面已经变了而拒绝时，副本作废、重新读取。
- 回放只用于已经结束的对局：结束前种子不公开，「对局记录」里进行中的对局显示「继续」。

### 记录和 AI 接口的权限

- `POST /api/matches`（用浏览器给出的 setup 建一条记录）只给管理员，用于导入记录。
- `POST /api/matches/:id/steps`：玩家只能给自己的对局追加 `error` 步骤（浏览器的报错），不能改对局状态、结果和回合数；对局的其余步骤都由服务器写。服务器只保留报错的 `message`（最多 1000 字）和 `stack`（最多 4000 字），时间用服务器的；每局最多 200 条，每次请求最多 1 MB。在线对战进行中，参与对局的管理员也只能追加报错。
- `POST /api/decide`、`POST /api/rate` 接受浏览器上传的局面，只给管理员当工具用。玩家对局里小茂的走子走 `/api/play`，由服务器用自己的局面去问 AI。（博士已于 2026-10-29 去掉，`/api/play/:id/rate` 随之删除；该走哪一步由大模型教练建议。）

## 牌桌换到服务器前后的对应

| 以前（浏览器跑引擎） | 现在 |
| --- | --- |
| 浏览器生成种子，自己建局 | 服务器生成种子，调用 `open` |
| `game.view(ME)` 渲染和自动代打 | `view`（自己的座位） |
| `game.dispatch` | `play`（服务器补上座位） |
| `probe`：在快照副本上试走，取道具目标 | `preview` |
| 同时读 `view(OPP)` 判断该谁行动 | `status.actor` |
| 按事件数组长度切出增量 | `cursor` |
| 悔棋：浏览器里的完整快照栈 | `rewind`（服务器先检查是否允许） |
| 读档：localStorage 里的完整快照 | 服务器保留对局；丢失后 `open` 加 `moves` 恢复 |
| 回放、接管：用种子和步骤在浏览器里重放 | 服务器 `open` 加前 n 步，再给出视图 |
| 调试台直接改快照 | 管理员：`snapshot` → 修改 → `restore` |
| `/api/decide`、`/api/rate` 收浏览器上传的快照 | 服务器从 `snapshot` 取局面，交给 AI 服务 |
| 报告问题时浏览器附上完整状态 | 服务器自己附上 `snapshot` |

## 实测（本机，三套审核卡组两两对战三局，235 条指令）

| op | 每步都完整检查（engine/1 初版） | 现在：边界检查＋每回合完整检查 |
| --- | --- | --- |
| `play` | 平均 169 ms，p50 148 ms，p95 441 ms，最大 632 ms | 平均 14 ms，p50 2.7 ms，p95 114 ms，最大 175 ms |
| `view` | 平均 16 ms，p95 49 ms | 平均 1.5 ms，p95 3.3 ms |
| `snapshot` | 平均 1.7 ms | 平均 1.9 ms |
| `open` | 45 ms | 50 ms |

`play` 的 p95 和最大值来自回合开始的那次完整检查。

## 以后要做的

- 实例 ID 的残余信息：一张卡的 ID 整局不变，宝可梦和选择请求的编号（`m…`、`q…`）连续递增，从编号的间隔能看出对方中间有过几次不公开的操作。对局里的影响很小，暂不处理。
