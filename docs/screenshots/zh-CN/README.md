# 中文界面截图

2026-10-19，通过本地 Chromium 的真实界面采集：

- `board.webp`、`card-help.webp`、`attack.webp`、`prize.webp`：
  新建密勒顿 ex 对电龙 ex 对局，在界面点击合法操作和选择，直到游戏正常结束。
- `home.webp`：实际中文现代卡组选择界面。
- `real-game.json`：该局操作、日志、预览及错误检查结果。

不注入手牌、伤害、赢家或棋盘状态。可用下列命令重新采集原始 PNG，
再使用 Sharp 转换为 WebP：

```bash
CAPTURE_ZH_SCREENSHOTS=1 npm run test:game:zh
```

界面优先显示已关联的中文原图；其余明确标注为“中文练习卡面（非官方扫描）”。
截图不代表全部卡图已下载，也不代表全部规则经过验证。
卡图及宝可梦相关权利归原权利人，截图中的百科衍生文字资料许可见中文说明；
不因为代码使用 MIT 许可而改变卡图或资料许可。
