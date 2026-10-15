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
- 第一次连接时，电脑上的 CrossSync 页面会弹出“iPhone 上的 CrossSync App 想连接这台电脑”，点“允许”后 App 才能传输。App 会在每个请求里带上自己的设备标识（`X-CrossSync-Device`）。

## 自动备份

- 在“连接电脑”设置里打开 **打开 App 时自动备份新照片**。默认只备份打开开关之后拍的照片；打开 **也备份以前的照片** 会把整个范围都传一遍。
- **备份范围** 可以选“所有照片”或指定的几个相册。
- 每次打开 App 并连上电脑时，App 会找出还没备份的照片和视频，按拍摄时间从早到晚导出原片（iCloud 里的原片会先下载）并上传；实况照片的视频部分也会一起传。
- 已经传到电脑的照片记在手机上，不会重复传；就算重装 App 丢了这份记录，电脑端的内容比对也会认出重复的文件。
- 连续 3 项失败（通常是电脑离线）会暂停，下次打开 App 再试。目前只在 App 打开时备份；切到后台后，已经提交给系统的分片会继续传完。

## 当前平台限制

Windows 无法编译或签名 iOS App，因此本仓库提供 XcodeGen 工程描述、完整 Swift 源码和纯逻辑单元测试；最终的编译、签名和真机验证需要在 Mac/Xcode 上完成。

原生 App 会优先信任 iPhone 系统中当前安装的 CrossSync CA。电脑执行完整证书重新生成后，需要在 iPhone 上安装并完全信任新的 `/ca.crt`，但不需要因此重新编译 App。

### 可选：内置本机 CA

仓库不再提交 CA 证书，因为它属于生成它的那台电脑。如果希望 App 在 iPhone 尚未信任 CA 时也能连接，可以在运行 `xcodegen generate` 之前把电脑上的 CA 复制进来：

```bash
cp ../certs/ca.crt CrossSyncMobile/Resources/CrossSync-Local-CA.crt
```

该文件已被 `.gitignore` 忽略；不放这个文件时，App 只使用系统信任的证书。
