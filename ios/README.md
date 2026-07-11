# CrossSync iPhone App

这是与当前 CrossSync FastAPI 服务配套的原生 SwiftUI 客户端。界面实现 Figma 中的四个状态：选择照片、从 iCloud 准备、局域网上传和完成。

## 在 Mac 上生成并运行

1. 安装 Xcode 16 和 [XcodeGen](https://github.com/yonaskolb/XcodeGen)。
2. 在终端进入本目录并运行 `xcodegen generate`。
3. 打开 `CrossSyncMobile.xcodeproj`。
4. 在 Signing & Capabilities 中选择你自己的 Apple Developer Team。
5. 用数据线或无线调试把 App 安装到 iPhone（最低 iOS 17）。

## 首次连接

1. 在电脑上通过 HTTPS 启动 CrossSync：Windows 使用 `.\run.ps1`，macOS/Linux 使用 `./run.sh --https`。
2. 确保 iPhone 与电脑在同一 Wi‑Fi。
3. 如果电脑使用 HTTPS，请先通过 CrossSync 网页把本地 CA 证书安装到 iPhone，并在“设置 → 通用 → 关于本机 → 证书信任设置”中开启完全信任。
4. 在电脑端扫码首页找到 12 位“原生 App 访问令牌”。
5. 在 App 右上角点击连接状态，填写电脑地址和访问令牌，然后点“测试连接”。

## 传输行为

- 系统照片选择器使用“保持当前格式”，避免为兼容格式额外转码；关闭后，App 每批准备最多 4 个所选原片，上传并清理后再准备下一批，避免大量视频同时占满缓存。
- 如果某一项无法从 iCloud 或照片库读取，App 会记录该项失败并继续准备、上传同批其他项目，不会中止整个批次。
- 准备和上传期间默认调用 iOS 的常亮能力，避免前台运行时自动锁屏。
- 上传沿用桌面服务已验证的 16 MB 分片、最多 4 路并发和断点续传接口。
- 分片请求使用后台 URLSession；已经提交给系统的请求可在短暂锁屏或切到后台时继续。进程被系统终止或用户强制退出后，重新打开 App 并选择同一照片即可从服务器已保存的分片续传。
- 保存路径由电脑端 CrossSync 选择，手机端会显示当前路径但不会越权修改电脑文件系统。

## 当前平台限制

Windows 无法编译或签名 iOS App，因此本仓库提供 XcodeGen 工程描述、完整 Swift 源码和纯逻辑单元测试；最终的编译、签名和真机验证需要在 Mac/Xcode 上完成。

原生 App 会优先信任 iPhone 系统中当前安装的 CrossSync CA，并把构建时内置 CA 作为兼容回退。电脑执行完整证书重新生成后，需要在 iPhone 上安装并完全信任新的 `/ca.crt`，但不需要因此重新编译 App。
