# 52Poké 卡图下载便携包

此包是当前**尚未解决的简体卡图引用清单**，不是全库，也不包含已经下载的图片。
统计与校验值见 `bundle-summary.json`。

## 使用前请注意

**52Poké 已对原下载环境返回 403。其机器读取守则明确禁止更换 IP、伪装
User-Agent 或使用多个 IP 绕过封禁。把程序搬到另一台机器，并不自动获得访问许可。**
请先确认站方允许在目标环境下载；未得到允许时，只使用离线清单和检查命令。
`--site-authorized` 表示你确认具备这种许可，不是解除封禁的技术手段。
程序不会代理请求、仿冒浏览器、使用登录 Cookie、解验证码或自动重试 403。

源站条件保存在 `source-policy/`，请核对原站后使用。该副本不是授权书：

- 固定应用身份，单进程串行请求，不并行抓取。
- 已知 Wiki `Crawl-delay: 500` **按 500 秒而非毫秒**处理；新 robots 要求更长时继续加长。
- 本清单超过 500 条，因此所有网络请求限定在 **UTC+08 的 02:00–08:00**。
  不受目标机器时区影响。`--wait` 会等待窗口和请求间隔，看起来暂停是正常的。
- 下载限速 250,000 字节/秒，另有每小时 1,000,000,000 字节预算检查。
- 遇到 401、403、429 会保存访问阻塞并停止。不要改 IP、请求头或删除阻塞记录循环重试；
  需要站方确认后再复核恢复。
- 已完成文件复用，不重复请求；损坏或缺失的旧缓存报错，不静默重下。

## 环境

推荐 Python **3.11 或更新版本**，Windows、macOS、Linux 均可。
只依赖 Pillow 进行图片解码检查；不需要本地原项目、XML、数据库、Azure、OpenAI 或 API key。

在**解压后的目录**打开终端。以下 Windows 示例用 `py -3`；
macOS/Linux 把它换成 `python3`。

```sh
py -3 -m venv .venv
```

然后安装依赖：

Windows：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe portable_downloader.py status
```

macOS/Linux：

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python portable_downloader.py status
```

以下以 `python` 简写该虚拟环境的解释器；请替换为上面的实际路径。

## 下载

**仅在已经得到源站允许时运行：**

```sh
python portable_downloader.py download --site-authorized --wait
```

先下载少量用于验收：

```sh
python portable_downloader.py download --site-authorized --wait --limit 3
```

`--limit` 不改变站点窗口、间隔和权限要求。程序会先检查两个源站的 robots，
因此即使只下 3 张，也可能先等待较长时间。若 robots 不可访问或禁止读取，不请求图片。

再次执行同一命令会跳过已完整校验的文件；下载中断时，在有 ETag/Last-Modified 且服务器
支持 Range/If-Range 的情况下续传当前文件。无法安全续传时保留部分文件并停止，不自动从头重下。
不要开多个终端、复制多个输出目录或多机并行下载同一站点。

## 清单说明

- `manifests/remaining-images.json`：全部未解决引用、卡名、印刷编号、File 页 ID、
  已知原图 URL、SHA-1、大小和尺寸，以及来源链接。
- `manifests/download-urls.txt`：有可靠元数据的原图 URL，**仅供查阅**；
  不建议直接交给无限速的下载器。
- `manifests/remaining-images.csv`：便于表格查看的列表。
- `manifests/missing-image-urls.json`：缺少原图 URL 的条目。程序不会猜地址，也不会将
  来源文章页当作图片下载。这些仍需要补充来源，下载完已知 URL 也不等于全量完成。

校验值来自已缓存的最新 Wiki 文件元数据；原站之后更新文件会导致校验失败，程序不会悄悄
接受不同版本。部分恢复出的引用还需要语义核对：**字节下载成功不代表已完成简体语言、
印刷身份或 Academy 引擎版本确认**，相关标记保存在清单和回执中。

## 查看、验证与传回

```sh
python portable_downloader.py status
python portable_downloader.py verify
python portable_downloader.py pack-results
```

`status` 只读清单与记录，不重新计算图片哈希；`verify` 和 `pack-results` 会离线检查
文件大小、Wiki SHA-1、回执 SHA-256、图像尺寸及可解码性。

完成或下载一部分后，把生成的 **`52poke-downloaded-images.zip`** 传回来即可。
其中包含图片、清单和 `receipts.json`，便于在原机器复核导入。
图片按内容哈希保存在 `downloads/files/`，回执提供原始 Wiki 文件名映射。
请勿只传图片而漏掉回执。打包命令不联网、不包含本机环境变量或任何 API 密钥。

程序只下载图片，不做 OCR、翻译或对战规则处理。后处理继续在原机器进行。

## 离线自测

```sh
python -m unittest discover -s tests -v
```

这些测试不连接源站。包内文件 SHA-256 列在 `SHA256SUMS.txt`；
整个 ZIP 的校验文件与下载包放在一起。

## 出处与权利

卡牌引用及相关百科资料来自神奇宝贝百科，采用其声明的 CC BY-NC-SA 3.0，
保持非商业使用、出处及相同方式共享要求：

- https://wiki.52poke.com/
- https://wiki.52poke.com/wiki/神奇宝贝百科:机器读取守则
- https://wiki.52poke.com/wiki/神奇宝贝百科:版权声明

图片版权仍属于各自权利人；清单和程序不授予图片再分发、商用或对外部署许可，
也不代表神奇宝贝百科或宝可梦官方背书。此包不含限制再分发的研究数据集。
