# CrossSync

CrossSync 是一个局域网文件传输工具，用于在 iPhone（Safari 或原生 App）和 Windows / macOS 电脑之间直接传文件，不经过云端。默认启用固定的访问令牌，局域网里的其他设备无法浏览、上传或删除文件。

原生 iPhone 客户端位于 [`ios/`](ios/README.md)。它会在系统照片选择器关闭后显示 iCloud 原片的准备进度、保持前台常亮，并复用同样的 16 MB / 4 路分片上传。

## 功能

- **iPhone → 电脑**：在 iPhone 上选择文件，直接写入电脑上选定的接收文件夹，不需要在电脑上再下载一遍。
- **电脑 → iPhone**：在电脑上打开同一个网页，把文件放进 `data/outbox`，再从 iPhone 下载。
- **断点续传**：iPhone 上的所有文件（包括小照片）都按分片上传。断网或浏览器被中断后，重新打开 CrossSync 并选择同样的文件，已完成的分片会自动跳过。
- **传输时保持常亮**：有 Screen Wake Lock 时优先使用；Safari 或 HTTP 环境下退回到可见的本地循环视频。
- **上传方式**：16 MB 分片，最多 4 路共享并发，服务器直接写入目标位置，每个分片超时后自动重试。
- **文件列表**：支持单个下载、打包下载选中文件、删除（移到回收站）和打开所在文件夹。
- **完整性校验**：完成的上传可以把 SHA-256 记录在隐藏的元数据里，不会在下载目录里多出 `.sha256` 文件。

## 快速开始

### Windows

```powershell
.\run.ps1
```

Windows 默认以 HTTPS 启动，这样 iPhone 的屏幕常亮和"添加到主屏幕"才能正常工作。启动后在电脑上打开 `https://localhost:8008`，用 iPhone 扫描二维码。

首次运行会在 `data/.crosssync/preferences.json` 生成一个固定的 12 位访问令牌。令牌会打印在终端里，也显示在只有电脑能看到的二维码页上。Safari 通过二维码链接自动获得令牌；原生 App 需要在连接设置里填写同一个令牌。

首次以 HTTPS 运行时，会在 `certs/` 下生成私有的 `CrossSync Local CA` 和服务器证书。在 iPhone 上打开 `/ca.crt` 安装描述文件，然后到 **设置 → 通用 → 关于本机 → 证书信任设置** 中为 `CrossSync Local CA` 开启完全信任，再重新打开 CrossSync。

启动脚本只会在 `requirements.txt` 变化后重新安装依赖，平时启动不再每次执行 `pip install`。

### macOS / Linux

```bash
./run.sh --https
```

如果脚本还没有执行权限：

```bash
chmod +x run.sh
```

### 手动启动

```bash
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8008
```

## 启动参数

| 作用 | Windows | macOS / Linux |
|---|---|---|
| 自定义访问令牌 | `.\run.ps1 -AccessToken 123456789012` | `./run.sh --access-token 123456789012` |
| HTTPS | 默认开启 | `./run.sh --https` |
| HTTP 兼容模式 | `.\run.ps1 -Http` | 不加 `--https` |
| 换网络后重新生成证书 | `.\run.ps1 -RegenerateCertificate` | `./run.sh --regenerate-certificate` |
| 自定义端口 | `.\run.ps1 -Port 8010` | `./run.sh --port 8010` |
| 手动指定局域网地址 | `.\run.ps1 -LanHost 192.168.1.20` | `./run.sh --lan-host 192.168.1.20` |

请求 HTTPS 时会自动生成 `certs/cert.pem`、`certs/key.pem` 和 `certs/ca.crt`。Windows 使用 Git for Windows 自带的 OpenSSL（或其他已安装的 OpenSSL），macOS / Linux 需要 `PATH` 中有 `openssl`。如果自动检测选错了网卡，用上表中的参数手动指定局域网地址。

只改局域网地址时会保留现有 CA，只重新签发服务器证书。完整重新生成会更换 CA，之后需要在 iPhone 上重新安装并完全信任新的 `/ca.crt`。原生 App 优先使用系统中已信任的 CA，因此更换 CA 不需要重新编译 App。

## 默认路径

- iPhone → 电脑：`data/downloads`
- 电脑 → iPhone：`data/outbox`
- 上传会话和正在接收的文件：`data/temp`（可以保存到 `preferences.json` 的 `temp_dir`，或用环境变量 `CROSSSYNC_TEMP_DIR` 临时指定）
- 校验记录和 CrossSync 传入的文件记录：`data/.crosssync/crosssync.db`（SQLite；旧版的 `checksums.json`、`transfers.json` 会在首次启动时自动导入，并改名为 `*.migrated`）
- 访问令牌和偏好设置：`data/.crosssync/preferences.json`

在电脑上打开工作台，点标题下方的 **起个好记的名字** 可以给电脑改名（例如“书房电脑”），手机网页和原生 App 都会显示这个名字；留空则恢复系统名称。名称保存在 `preferences.json`。

在电脑上打开工作台，在 **电脑接收区** 点 **更改保存位置…** 可以选择任意可写文件夹。选择会保存在 `preferences.json`，下次启动继续使用。如果设置了环境变量 `CROSSSYNC_DOWNLOADS_DIR`，它的优先级更高。

默认不会在文件旁边写 `文件名.sha256`。已有的 `.sha256` 文件会在列表和打包下载中隐藏，但仍可作为旧版校验来源。为了让大文件更快可用，只有在勾选 SHA-256 选项或设置 `CROSSSYNC_RECORD_UPLOAD_CHECKSUMS=1` 时才会计算整文件校验值。如果外部工具需要旁挂文件，启动前设置 `CROSSSYNC_WRITE_SHA256=1`。

## 性能建议

- **把接收文件夹和临时目录放在同一块固态硬盘上。** 正在接收的文件先写在临时目录里，传完后移动到接收文件夹；两者在同一块盘上时只是改个名字，跨盘则要整份复制一遍。在机械硬盘上，4 路并发写入大文件约 30 MB/s；换到固态硬盘可达 110 MB/s 以上。接收文件夹在网页上点 **更改保存位置…** 修改；临时目录用下面的命令保存一次即可（下次启动生效），环境变量 `CROSSSYNC_TEMP_DIR` 设置时优先：

  ```powershell
  .venv\Scripts\python.exe -c "from app.config import load_env_overrides, set_temp_dir; load_env_overrides(); print(set_temp_dir(r'E:\CrossSync\temp'))"
  ```
- 只有一个分片的小文件（大多数照片）在上传请求里直接完成，不再单独发"完成"请求。
- "最近传输"只显示最新的 200 个文件，iPhone 共享箱显示最新的 500 个；打开文件夹可查看全部，"下载全部"不受影响。

## 删除与清空

接收文件夹可能是"图片"或"桌面"这类个人文件夹，所以删除操作都比较保守：

- **删除选中**：把选中的文件移到电脑的回收站，不会永久删除。无法移动的文件（比如正被占用）会保留原位并提示。
- **清空已传入文件**：只在运行 CrossSync 的电脑上显示和执行。它只处理由 CrossSync 传入、之后没有被修改过的文件，同样是移到回收站。文件夹里原有的其他文件、你自己的空文件夹都不会被动。
- 这一规则之前传入的文件没有记录，"清空"不会处理它们，需要手动选中删除。

## iPhone 屏幕常亮

最可靠的方式是使用已信任的 HTTPS，并从 Safari 的分享菜单把 CrossSync 添加到主屏幕。工作台会显示当前的守护模式：**原生常亮**、**双重守护**、**视频守护** 或 **未启用**。

传输时请让 CrossSync 保持在前台。HTTPS 下优先使用原生 Screen Wake Lock；本地静音视频只作为 HTTP 或旧版 iOS 的兼容方案，界面会标明它可能被 iOS 覆盖。手动锁屏、切换 App 或低电量模式都可能让浏览器失去常亮保护。

常亮守护会在 iOS 把选中的文件交给网页之后才启动，避免和照片选择器冲突。如果守护被释放，回到 CrossSync 点屏幕上的重新开启按钮即可。

即使 iOS 阻止了两种常亮方式，传输也可以续传：解锁手机、重新打开页面、再次选择同一个文件，CrossSync 会从缺少的分片继续。

浏览器会在本地保留 48 小时内未完成的上传列表，和服务器临时文件的保留时间一致。页面重新加载后，工作台会显示 **重新选择并续传** 和待续传的文件名。Safari 不允许网页悄悄重新打开相册文件，所以 iOS 丢弃页面后需要重新选择一次，已上传的分片不会重复发送。

传大视频时，请保持页面在前台直到完成。单个分片卡住 180 秒后会自动中止并重试。

从相册选择时，iOS 可能要先导出或从 iCloud 下载原片，Safari 才能收到文件。这段时间 CrossSync 会暂停常亮，收到文件后立即开始上传，但无法控制 iOS 准备 iCloud 原片的时间。分小批选择可以缩短等待。

## 传输可靠性

- 分片上传完成后，回执会在最后一次活动后保留 48 小时。这期间重试完成请求，或再次选择同一个未改动的文件，都会复用已保存的文件；如果文件已被删除，则重新上传。
- 每个上传使用初始化时选定的目标文件夹。更改接收文件夹只影响之后的新上传。
- 合并中的临时文件不会出现在列表、下载、打包和清空中。已取消的上传不会再提交进行中的分片，临时文件会在相关请求结束后删除。
- 空间检查同时考虑临时目录和目标目录所在的磁盘，以及并发中的上传。对稀疏文件的预留比较保守，可能在磁盘真正写满之前就拒绝新上传。
- 打包下载是边打包边传输，不会先在磁盘上生成完整的压缩包。文件以不压缩方式存入 ZIP，照片和视频本身已经压缩过。
- 请保持默认的单进程运行：上传协调和空间预留都只在进程内生效。
- 文件列表的刷新会合并，列表没变化时保留勾选状态，页面在后台时停止轮询。大文件复制和上传写入在请求事件循环之外执行。
- 分片直接写入正在接收的文件对应位置，每个字节只写一次；只有同一个分片被重复并发上传时，后到的那份才先暂存，等前一份结束后再决定是否采用。

## 测试

安装 `requirements-dev.txt` 后运行：

```text
python -m unittest discover -s tests
node --test tests/file-list-refresh.test.cjs tests/ui-helpers.test.cjs
```

每次推送到 `main` 或提交合并请求时，GitHub Actions 会在 Ubuntu 和 Windows 上自动运行这两组测试。Dependabot 每月检查一次 Python 依赖和 GitHub Actions 的更新。iOS 测试目标包含分片范围和 SHA-256 的回归测试，需要在 macOS 的 Xcode 中运行。

## 目录结构

- `app/`：FastAPI 服务端。
  - `main.py`：应用入口、访问控制、页面和配置接口。
  - `transfers.py`：分片上传和流式上传。
  - `library.py`：文件列表、校验、下载、打包和删除。
  - `pairing.py`：扫码后通知电脑页面跳转。
  - `uploader.py`：上传会话的存储；`transfer_log.py`：CrossSync 传入文件的记录；`metadb.py`：保存校验和传入记录的 SQLite 数据库；`checksums.py`、`common.py`、`config.py`、`utils.py`：校验、共享工具和配置。
  - `templates/` 和 `static/`：网页界面。浏览器端代码在 `static/js/`，是按顺序加载、共享全局作用域的四个脚本：`core.js`（状态和工具）、`wake.js`（PWA 和常亮）、`upload.js`（上传队列）、`files.js`（文件列表和启动）。静态资源地址带有根据文件内容计算的版本号，缓存会自动更新。
- `ios/`：原生 SwiftUI 客户端，用 XcodeGen 根据 `project.yml` 生成 Xcode 工程。
- `scripts/`：Windows 和 macOS / Linux 的 HTTPS 证书脚本，以及图标生成脚本。
- `tests/`：Python `unittest` 测试和浏览器端列表控制器的 Node 测试。
- `.github/`：自动测试流程和 Dependabot 配置。
- `run.ps1` / `run.sh`：一键启动脚本，会创建 `.venv`、按需安装依赖并启动 uvicorn。
- `data/` 和 `certs/` 在运行时生成，不会提交到仓库。

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。`app/static/icons/tabler/` 中的图标来自 [Tabler Icons](https://tabler.io/icons)，按其自带的 [MIT 许可证](app/static/icons/tabler/LICENSE) 使用。
