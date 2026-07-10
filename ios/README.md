# CrossSync iPhone App

这是与当前 CrossSync FastAPI 服务配套的原生 SwiftUI 客户端。界面实现 Figma 中的四个状态：选择照片、从 iCloud 准备、局域网上传和完成。

## 在 Mac 上生成并运行

1. 安装 Xcode 16 和 [XcodeGen](https://github.com/yonaskolb/XcodeGen)。
2. 在终端进入本目录并运行 `xcodegen generate`。
3. 打开 `CrossSyncMobile.xcodeproj`。
4. 在 Signing & Capabilities 中选择你自己的 Apple Developer Team。
5. 用数据线或无线调试把 App 安装到 iPhone（最低 iOS 17）。

## 首次连接

1. 在电脑上启动 CrossSync：`D:\projects\CrossSync\run.ps1`。
2. 确保 iPhone 与电脑在同一 Wi‑Fi。
3. 如果电脑使用 HTTPS，请先通过 CrossSync 网页把本地 CA 证书安装到 iPhone，并在“设置 → 通用 → 关于本机 → 证书信任设置”中开启完全信任。
4. 在 App 右上角点击连接状态，填写电脑地址，例如 `https://192.168.2.14:8008`，然后点“测试连接”。

## 传输行为

- 系统照片选择器使用“保持当前格式”，避免为兼容格式额外转码；关闭后，App 会同时准备最多 4 个所选原片。若原片只在 iCloud，这段时间会显示在“照片正在准备”，不再让用户盯着看不出进度的网页。
- 准备和上传期间默认调用 iOS 的常亮能力，避免前台运行时自动锁屏。
- 上传沿用桌面服务已验证的 16 MB 分片、最多 4 路并发和断点续传接口。
- 分片请求使用后台 URLSession；已经提交给系统的请求可在短暂锁屏或切到后台时继续。iOS 仍可能暂停尚未排队的后续工作，用户手动强制退出 App 也会停止本次任务。
- 保存路径由电脑端 CrossSync 选择，手机端会显示当前路径但不会越权修改电脑文件系统。

## 当前平台限制

Windows 无法编译或签名 iOS App，因此本仓库提供 XcodeGen 工程描述、完整 Swift 源码和纯逻辑单元测试；最终的编译、签名和真机验证需要在 Mac/Xcode 上完成。
