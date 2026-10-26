---
name: fix-bug-report
description: 处理牌桌「报告问题」按钮提交的 bug 报告：从生产机 pve-2604 取回报告，回放复现，定位根因，修复并补测试，提交推送，再把复现步骤、根因、修复方案和 commit 写回报告；上线需先问用户。用户提到 bug 报告、问题报告、bug-reports、报告问题，或要求看/修某个 bug-<时间>-match-<id> 时使用。
argument-hint: "[报告 id，如 bug-20261026T123330Z-match-6；不填则列出未处理的报告]"
---

# 修复牌桌问题报告

工作目录：`/home/zhn/pokemon-tcg`，分支 main。全程用中文回复用户。

要处理的报告：$ARGUMENTS

## 0. 前提

- 报告在生产机上，用 `ssh pve-2604` 连接（别名在 `~/.ssh/config`），目录是 `/nas/share/Pokemon/bug-reports/`。
- 生产代码在 `~/g/pokemon/pokemon-tcg`，服务是 `pokemon-cn-site`，见 `deploy/README.md`。
- 本机没有 `/nas`。报告先拷到 `.data/bug-reports/` 再处理。
- 工作区里常有其他会话没提交的改动：
  - 只提交自己改的文件；
  - 不要 `git stash`（refs/stash 是共享的）；
  - 不要碰别人的文件。

## 1. 取回报告

```sh
D=/nas/share/Pokemon/bug-reports
ssh pve-2604 "ls -la $D; cd $D && grep -L '\"resolution\":' bug-*.json"   # 第二部分列出还没有 resolution 的（未处理）
```

- 没给 id 时：只有一个未处理的报告，就直接处理它；有多个，就列出来（时间、对局、描述首行），问用户先处理哪个。
- 取回报告并备份，记下 sha256。写回生产机前要用它确认文件没被改过：

```sh
F=<id>.json
scp pve-2604:$D/$F .data/bug-reports/ && cp .data/bug-reports/$F /tmp/$F.orig && sha256sum .data/bug-reports/$F
```

## 2. 复现

```sh
npm run match -- show --file .data/bug-reports/$F            # 停在报告的那一步
npm run match -- show --file .data/bug-reports/$F --at <n>   # 停在任意一步；--raw 会加印内核事件
```

输出依次包括：

- 报告描述和接管链接；
- 每一步的命令和当时显示的日志；
- 「every recorded state matches」，或者 ⚠ 标出的分歧；
- 棋盘、待选请求、双方合法动作；
- `牌桌选择框`：玩家实际看到的标题、显示的卡和选项。

按下面的规则判断问题出在哪一层：

| 现象 | 层 |
|---|---|
| 回放与记录不一致，或某一步被拒 | 引擎行为在记录之后变了（回归），或记录本身有问题 |
| 状态一致，但结算违反规则或卡面（伤害、效果、条件） | 引擎或卡牌定义：`public/rules/game.js`、handlers、`catalog/zh-CN/…` |
| 状态和结算都对，只是显示、标题、选项、动画不对 | 牌桌界面：`public/match.js`（把内核视图翻译成界面模型）、`public/ui.js`（渲染） |
| 只在联网对局出现 | `server/play.mjs`、`public/remote-game.js` |

- 卡牌文本以仓库里审核过的 TEXTS 为准，不要编造。
- 规则问题要找到官方规则文档的原文和章节号。
- 需要大范围读代码时交给子 agent（见 CLAUDE.md），只带回函数、行号和结论。
- 边查边记下复现步骤，第 6 步写回报告时要用。

## 3. 修复

- 在出问题的那一层做最小的修改。
- 只是展示问题，就在界面层修，不要改引擎提问的次数或顺序。否则旧的对局记录和回放（每一步都校验 state hash）就对不上了。
- 跟随周围代码的风格：注释密度、命名、中文界面文字。
- 修完再用报告回放一遍（`show --file … --at <n>`），确认问题消失，而且记录仍然全部一致。

## 4. 测试

- **界面**：写在 `tests/cn-table.test.mjs`。
  - 用 `cardBoard` 搭局面，`new Match({...})` 之后检查 `m.prompt(view)`。
  - 要走完整的对局循环，就调用 `m.run({ resume: true })`，并在 controller 的 `chooseAction` 里设置 `m.stopped = true` 结束。
- **浏览器**：写在 `tests/browser/cn-official.spec.mjs`。
  - 在 node 子进程里搭出局面 snapshot，再用 `gameAt(page, baseURL, { deck, snapshot })` 开局。
  - 运行：`npx playwright test cn-official.spec.mjs -g '<测试名>'`。
  - 截图只用来自己检查。先用 Pillow 缩成约 100 KB 的 JPEG 再看（见 CLAUDE.md 的图片规则），截图语句不要留在测试里。
- **引擎和卡牌**：写在 `tests/official-rules/`、`tests/cn-cards/`。
- 按改动范围跑受影响的套件，例如 `npm run test:cn-table`、`test:match-records`、`test:engine-host`、`test:accounts`、`test:rules:official`、`test:cn-cards`。
- 其他会话未提交的内核改动可能让 `web:build` 或 Playwright 失败。遇到这种情况，在临时 worktree 里测试：`git worktree add --detach /var/tmp/<name> HEAD`，只拷入自己的文件，`node_modules` 用软链接，用完删除。

## 5. 提交和推送

- `git add <自己的文件>`。
- 提交信息的格式：
  - 首行：`<领域>: <一句话>`；
  - **首行后空一行**；
  - 正文：报告 id、现象、原因和改法；
  - `Tests: …` 一行；
  - 最后一行：`Co-Authored-By: Claude <noreply@anthropic.com>`。
- 推送（直接 `git push` 会卡在凭据管理器上）：

```sh
GH_TOKEN="$(gh auth token --user niuzheng168)" GIT_TERMINAL_PROMPT=0 timeout 90 \
  git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
```

- 如果推送被拒（远端有新提交）：
  1. 用同样的凭据参数 `fetch origin`；
  2. 确认新提交不碰自己的文件，也不碰工作区里别人未提交的文件；
  3. `git branch tmp HEAD && git reset --keep origin/main && git cherry-pick tmp && git branch -D tmp`；
  4. 重跑新测试，再推送。

  不要 stash，也不要在脏工作区上 rebase。

## 6. 把处理记录写回报告

1. 写一份 notes JSON（中文）：

   ```json
   {
     "repro": ["取回报告……", "show --file 回放……", "第 n 步……"],
     "rootCause": "……",
     "fix": ["文件/函数：改了什么", "……"],
     "tests": ["新增的测试", "跑过的套件和结果", "用报告回放验证的结果"],
     "verify": "生产机更新到包含该提交的版本后：/play/?replay=<matchId>&at=<出问题的动作之前那一步>，从这里接管后再做一次同样的操作"
   }
   ```

2. 写入本地副本。它会在 description 后加上 `resolution`（status、resolvedAt、commit、title 和 notes），再写一次会替换之前的：

   ```sh
   npm run match -- resolve --file .data/bug-reports/$F --notes notes.json --commit <修复提交>
   ```

3. 核对：除了 `resolution`，其余内容和 `/tmp/$F.orig` 完全一致（用 node 解析两边 JSON 比较）。
4. 确认生产机上的文件仍是取回时的 sha256，然后原子替换：

   ```sh
   ssh pve-2604 "test \"\$(sha256sum $D/$F | cut -d' ' -f1)\" = <取回时的 sha256> && cat > $D/.$F.tmp && chmod 664 $D/.$F.tmp && mv $D/.$F.tmp $D/$F" < .data/bug-reports/$F
   ```

   最后比对两边的 sha256。如果生产机上的文件变了，就停下来告诉用户，不要覆盖。

## 7. 上线（先问用户）

上线是生产操作。用户在这次对话里明确同意后才能做：

```sh
ssh pve-2604 'cd ~/g/pokemon/pokemon-tcg && git pull --ff-only && npm run web:build && systemctl --user restart pokemon-cn-site && systemctl --user is-active pokemon-cn-site && git log --oneline -1'
```

- 上线后，可以在 notes 里加一条 `"deployed": "<时间> <commit>"`，再 resolve 一次并按第 6 步写回。
- 拉取或构建失败时，如实告诉用户，不要自己绕过。

## 8. 回复用户

用中文简要说明：

- 复现结果；
- 根因；
- 改了什么；
- 测试结果；
- commit；
- 处理记录写回到了哪里；
- 验证链接；
- 是否已上线。如果还没上线，问用户要不要上线。
