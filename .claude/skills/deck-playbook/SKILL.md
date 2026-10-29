---
name: deck-playbook
description: 给卡组写或复查「打法要点」（ai/deck-playbooks.json：大模型对手和教练读的打法，开始页也展示）。可以先从 OmniTCG 找简中强势卡组加入卡组池；再由子 agent 查攻略写稿、独立审稿、作者改稿、审稿人复核；最后合并、测试、提交推送。上线前要先问用户。用户提到打法要点、卡组策略、卡组打法、playbook、加新卡组、给卡组写打法或复查打法时使用。
argument-hint: "[卡组 id（可多个）；「复查 <id>…」复查已上线的要点；「找新卡组」先看简中赛事成绩]"
---

# 卡组打法要点

工作目录：`/home/zhn/pokemon-tcg`，分支 main。全程用中文回复用户。

要做的：$ARGUMENTS

## 0. 前提和用户定下的规矩

- 打法要点原样进大模型的系统提示（`ai/llm-player.mjs` 按卡组 id 取 `ai/deck-playbooks.json`，模板见 `ai/llm-instruction.md`）。网站开始页「打法要点」也展示它（`GET /api/playbooks`）。
- 用户的要求：**要点必须准确有效、和卡表与国服卡面一致，错了误导性很强。** 所以每份都要走完：写稿 → 独立审稿 → 改稿 → 复核。只写一遍不能合并。
- 卡组必须是**简中**的。来源是 OmniTCG 汇总的简中赛事卡表，卡要在发布包里并且已实现。
- 用户没用过大多数卡组的卡。卡面细节、先后攻、对位强弱这些不要问用户：
  - 能用卡面、规则或读到的攻略证明的，由审稿和改稿定；
  - 证据定不了的，写成条件和取舍，留给大模型对局时判断。
- 子 agent 的分工（`/home/zhn/CLAUDE.md`）：
  - 查资料、写稿、审稿交给子 agent，它们只读仓库、只写 `/tmp`；
  - 主会话只收结论，负责合并、测试、提交推送；
  - 子 agent 看不到主会话，提示要写完整（下面的模板已经写全）；
  - 互不依赖的子 agent 一次并行派出，都在后台跑。
- 写稿和审稿的中间文件（稿子、审稿意见、笔记）只放 `/tmp`，不提交。只提交合并后的 `ai/deck-playbooks.json`。
- 工作区里常有其他会话没提交的改动：
  - 只 `git add` 自己的文件；
  - 不要 `git stash`；
  - 别人的半成品会让测试失败时，在临时 worktree 里测（见第 6 步）。
- 长任务每 10 分钟汇报一次进度：用 CronCreate 建会话内定时，提示里写清楚用 node 统计 `/tmp/playbook/out/` 下的 JSON（节数、条数、来源数、审稿问题数），并用 ListAgents 看各子 agent 是否完成，不要凭记忆汇报。做完删掉定时。
- 模型网关偶尔 503，子 agent 会中途停下。用 SendMessage 让它接着做（它的上下文还在），并要求它先把已有内容存盘。

## 1. 找新卡组（「找新卡组」，或要写的卡组还不在卡组池里）

1. 看简中赛事里各卡组的实际成绩（54 场左右、几千人的完整排名）：
   ```sh
   node scripts/ai-meta-archetypes.mjs --out /tmp/playbook/meta.json
   ```
   - 「前 8」「冠军」后面的倍数是实际次数除以按使用人数应得的次数（×1 为平均）；名次分位 50 是中游。
   - 人数太少（几十人）的卡组样本不够，不算强势。
   - 输出里每个卡组的 `champions` 给出冠军卡表的 deck id 和 tournament id。
   - 卡组池（`ai/training-decks.json`）里已有的 archetype 不必重复加：同一 archetype 的新冠军卡表通常和池里那份有 50 多张印刷版本相同。
2. 取卡表并映射到发布包：
   ```sh
   node scripts/omni-deck.mjs <deck id> <英文 slug> <tournament id>
   ```
   - 输出两段：`ai/training-decks.json` 的条目，和 `catalog/zh-CN/V20261019/pool-decks.mjs` 的条目。
   - 有「发布包里没有」或「只映射到 N 张」的卡组不能加。
   - 两段都放在最后一副锦标赛卡表之后、入门卡组之前，两个文件位置一致。
3. 重新生成发布包的预设卡组并检查：
   ```sh
   npm run cn:release && npm run cn:release:check   # 只该改 public/data/cn/V20261019/decks.json，pin 不变
   node scripts/ai-training-decks.mjs                # 0 with problems
   ```
4. `tests/browser/cn-official.spec.mjs` 里开始页卡组数（`.deck` 的 toHaveCount）加 1。
5. 用规则 AI 试打，确认新卡组的卡没有引擎错误：
   ```sh
   node scripts/ai-arena.mjs level:3 level:3 48 8 0 --decks=<新 id>,<两三副池里的强势卡组>
   ```
   池里的 id 用 `ai/decks.mjs` 的 DECK_POOL：训练卡表和预设相同时，用预设的 id。
6. 测试：`test:cn-table`、`test:ai`、`test:accounts`、`test:engine-host`；Playwright `cn-official.spec.mjs machine.spec.mjs`。然后提交推送。
7. 把这次的成绩表写进 `docs/ai/STATUS.md` 的「卡组池」一节。

## 2. 准备材料

```sh
node scripts/ai-meta-archetypes.mjs --out /tmp/playbook/meta.json          # 第 1 步做过就不用再跑
node scripts/playbook-materials.mjs <id>… --out /tmp/playbook --meta /tmp/playbook/meta.json
mkdir -p /tmp/playbook/out
```

会写出这些文件：

| 文件 | 内容 |
| --- | --- |
| `<id>.md` | 卡表和每张卡的国服卡面，就是模型看到的文字 |
| `<id>-guides.json` | 以前整理的攻略要点（有的话） |
| `<id>-playbook.json` | 现在的要点（复查时用） |
| `opponents.md` | 卡组池里所有锦标赛卡表的卡面 |
| `meta.md` | 简中各卡组成绩 |
| `example-playbook.json` | 一份通过审核的要点，给写稿的子 agent 参照 |

## 3. 写稿（新卡组）

- 每副卡组派一个 general-purpose 子 agent，后台运行，几副一起派。
- 提示用 `.claude/skills/deck-playbook/writer.md`，替换其中的占位符：

| 占位符 | 填什么 |
| --- | --- |
| `{{DECK}}` | 卡组 id |
| `{{NAME}}` | 卡组名 |
| `{{EVENT}}` | 卡表出处，如「2026-10-25 惠州城市赛（64 人）冠军卡表」 |
| `{{WHY}}` | 这副为什么值得写，引用第 1 步的成绩，一句话 |
| `{{ENGLISH}}` | 英文或日文名对应，帮子 agent 搜索，如 Gholdengo ex + Dudunsparce |
| `{{WORK}}` | `/tmp/playbook` |
| `{{DATE}}` | 今天 |

- 子 agent 产出 `/tmp/playbook/out/<id>.json` 和 `<id>-notes.md`。
- 交稿后看它报的「最没把握的几处」，原样转给审稿人。

## 4. 独立审稿

- 每份稿子另派一个新的子 agent（不要用作者）。
- 提示用 `.claude/skills/deck-playbook/reviewer.md`：
  - `{{FILE}}` 填 `/tmp/playbook/out/<id>.json`；
  - `{{REVIEW}}` 填 `/tmp/playbook/out/<id>-review.json`；
  - 其余占位符同上。
- 把作者自述的疑点加在提示末尾，让审稿人重点核对。

## 5. 改稿和复核

1. **改稿。** 用 SendMessage 把审稿结果交回原作者，消息要点：
   - 审稿文件路径和问题数；
   - 每处都要改正或删除，只有卡面或规则能证明审稿人错时才保留，并写明证据；
   - 对位要把对手卡表里的加伤和加 HP 道具、特性都算进去，重核每个「能不能一击」；
   - 证据定不了的写成条件和取舍；
   - 不引入卡表外的卡，每回合只能用 1 张支援者；
   - 直接改原文件，加 `"review": {"issues","fixed","dropped","kept":[{"quote","why"}]}`，删掉已解决的 doubts。
2. **复核。** 用 SendMessage 请原审稿人复核：
   - 每处是否真改对了（新数字按卡面重算）；
   - 改动有没有引入新错误、卡表外的卡、一回合两张支援者或前后矛盾；
   - 结果写 `/tmp/playbook/out/<id>-recheck.json`（只列仍有问题的，加 `"verified": n`）。
3. **处理复核剩下的问题。**
   - 复核还有问题就再交作者改，在 review 里加 `"recheck": {"issues","fixed","dropped"}`。
   - 只剩一两处表述问题时，主会话可以直接改（用 node 精确替换那一条），并记进 recheck。
4. 作者部分保留的理由，以复核人认可为准。

## 6. 合并、测试、提交

```sh
node scripts/playbook-merge.mjs /tmp/playbook/out/<id>.json… --checked-on <今天>
```

1. **补说明。** 在 `ai/deck-playbooks.json` 的 `note` 末尾补一句这次的做法（日期、几副、来源语言、审稿和复核）。
2. **测试。** 工作区有别人的半成品时，在临时 worktree 里测：
   ```sh
   git worktree add --detach /tmp/pb-wt HEAD && cp ai/deck-playbooks.json /tmp/pb-wt/ai/ && ln -s $PWD/node_modules /tmp/pb-wt/node_modules
   (cd /tmp/pb-wt && node --test tests/ai/*.test.mjs tests/accounts/play-llm.test.mjs)
   rm /tmp/pb-wt/node_modules && git worktree remove --force /tmp/pb-wt
   ```
3. **确认模型读到了要点。** 可选：用假模型建一个 `llmPlayer`，看系统提示里有「已和这份卡表、卡面逐条核对」和这副的第一节标题。
4. **提交推送。**
   - 只 `git add ai/deck-playbooks.json`，加上新卡组和 STATUS 时一并加上它们的文件。
   - 提交信息写清：几副、来源数、审稿和复核各挑出几处、典型问题。
   - 推送用 gh 的凭据：
     ```sh
     GH_TOKEN="$(gh auth token --user niuzheng168)" GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
     ```
5. **更新状态文档。** 在 `docs/ai/STATUS.md` 的 M7 卡组套路里记一条：几副、规模、审出的典型问题。

## 7. 复查已上线的要点（「复查 <id>…」）

已上线的要点也会有漏网的卡面错误。例如多龙那份曾把卡面上不要能量的「痒痒花粉」写成要贴能量，又如有几份用了别的印刷版本的 HP。

复查流程：

1. `playbook-materials.mjs <id>…` 准备材料，会写出 `<id>-playbook.json`。
2. **审稿。** 每份派一个子 agent，用 `reviewer.md`：
   - `{{FILE}}` 填 `/tmp/playbook/<id>-playbook.json`；
   - `{{REVIEW}}` 填 `/tmp/playbook/out/<id>-review.json`；
   - 提示里加一句：这份已经审过一轮，仍要逐条对照国服卡面。
3. **核对替换。** 原作者已经不在，另派一个子 agent 用 `fixer.md` 逐条核对审稿意见再替换，产出 `/tmp/playbook/out/<id>.json` 和 `<id>.changes.json`。
4. **复核。** 原审稿人对照 `<id>.changes.json` 复核，同第 5 步第 2 点。
5. **合并。** 同第 6 步。`playbook-merge.mjs` 会把旧的审稿记录留在 `review.earlier`。

## 8. 上线

上线要先问用户，每次都问。用户同意后：

```sh
ssh pve-2604 'cd ~/g/pokemon/pokemon-tcg && git pull --ff-only -q && export PATH=$HOME/.local/bin:$PATH && npm run -s web:build'
ssh pve-2604 'systemctl --user restart pokemon-cn-site'   # 再看 ~/.local/share/pokemon-cn-site/server.log 的启动几行，和登录页是否 200
```

- 生产机上不跑测试，只拉代码、构建、重启、看启动日志。
- 部署时会一并带上 main 上其他会话已推送的提交，汇报时列出来。

## 9. 向用户汇报

- 每副卡组报规模：节数、条数、字数、来源按语言分。
- 报审稿和复核各挑出几处，列最典型的错误。
- 说明哪些策略选择留给了大模型判断。
- 报 commit 和测试结果；问用户要不要上线。
