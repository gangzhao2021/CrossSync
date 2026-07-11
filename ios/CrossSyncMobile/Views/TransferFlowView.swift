import Photos
import PhotosUI
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: TransferViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: [PhotosPickerItem] = []
    @State private var showingSettings = false

    var body: some View {
        ZStack {
            CrossSyncBackground()
            ScrollView {
                VStack(spacing: 24) {
                    AppHeader(
                        connected: model.isConnected,
                        computerName: model.computerDisplayName,
                        action: { showingSettings = true }
                    )
                    .padding(.top, 8)

                    switch model.phase {
                    case .ready:
                        ReadyView(selection: $selection, onStart: startSelection)
                    case .preparing:
                        PreparingView()
                    case .uploading:
                        UploadingView()
                    case .complete:
                        CompleteView(selection: $selection, onStart: startSelection)
                    case .failed:
                        FailedView()
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 36)
            }
        }
        .task { await model.refreshConnection() }
        .onChange(of: scenePhase) { _, value in
            if value == .active { model.applicationBecameActive() }
        }
        .sheet(isPresented: $showingSettings) {
            ServerSettingsView()
                .environmentObject(model)
        }
    }

    private func startSelection() {
        guard !selection.isEmpty else { return }
        let selectedItems = selection
        selection = []
        model.start(items: selectedItems)
    }
}

private struct ReadyView: View {
    @EnvironmentObject private var model: TransferViewModel
    @Binding var selection: [PhotosPickerItem]
    let onStart: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            ScreenTitle(title: "发送到 \(model.computerDisplayName)", subtitle: "选好照片后立即回到 CrossSync")

            CrossSyncCard(accent: .crossSyncCyan) {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 18) {
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: 42, weight: .medium))
                            .foregroundStyle(Color.crossSyncCyan)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(model.computerDisplayName)
                                .font(.title3)
                                .fontWeight(.bold)
                            Text(model.serverConfig.map { "\($0.lanIP) · 本地网络" } ?? "点击右上角设置电脑地址")
                                .font(.footnote)
                                .foregroundStyle(Color.crossSyncSecondaryText)
                        }
                    }
                    Label(model.isConnected ? "已准备接收" : "尚未连接", systemImage: model.isConnected ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.footnote)
                        .fontWeight(.medium)
                        .foregroundStyle(model.isConnected ? Color.crossSyncGreen : Color.crossSyncMagenta)
                }
            }

            PhotoSelectionControls(
                selection: $selection,
                enabled: model.isConnected,
                pickerTitle: "选择照片",
                onStart: onStart
            )

            CrossSyncCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("电脑保存到")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.crossSyncSecondaryText)
                    Text(model.destinationDisplay)
                        .font(.body)
                        .fontWeight(.bold)
                        .lineLimit(2)
                    Text("保存位置只能在运行 CrossSync 的电脑端更改")
                        .font(.caption)
                        .foregroundStyle(Color.crossSyncSecondaryText)
                }
            }

            CrossSyncCard {
                Toggle(isOn: $model.keepScreenAwake) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("传输期间保持屏幕常亮")
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Text("避免 iPhone 自动锁屏导致传输中断")
                            .font(.caption)
                            .foregroundStyle(Color.crossSyncSecondaryText)
                    }
                }
            }
        }
    }
}

private struct PreparingView: View {
    @EnvironmentObject private var model: TransferViewModel

    private var progress: Double {
        guard model.preparationTotal > 0 else { return 0 }
        return Double(model.preparationCompleted) / Double(model.preparationTotal)
    }

    var body: some View {
        VStack(spacing: 24) {
            ScreenTitle(title: "照片正在准备", subtitle: "你已返回 CrossSync，不必停留在相册")

            CrossSyncCard(accent: .crossSyncCyan) {
                VStack(spacing: 18) {
                    ZStack {
                        Circle()
                            .stroke(Color.crossSyncCardBorder, lineWidth: 5)
                        Circle()
                            .trim(from: 0, to: max(progress, 0.02))
                            .stroke(Color.crossSyncCyan, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Image(systemName: "icloud.and.arrow.down.fill")
                            .font(.system(size: 38, weight: .semibold))
                            .foregroundStyle(Color.crossSyncCyan)
                    }
                    .frame(width: 104, height: 104)

                    Text("\(model.preparationCompleted) / \(model.preparationTotal)")
                        .font(.title)
                        .fontWeight(.bold)
                    Text("正在从 iCloud 读取原片")
                        .font(.subheadline)
                        .fontWeight(.medium)
                    ProgressView(value: progress)
                        .tint(.crossSyncCyan)
                    Text("剩余 \(max(model.preparationTotal - model.preparationCompleted, 0)) 项")
                        .font(.caption)
                        .foregroundStyle(Color.crossSyncSecondaryText)
                }
                .frame(maxWidth: .infinity)
            }

            CrossSyncCard {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(Color.crossSyncCyan)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("这是 iOS 从照片库取回文件的时间")
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Text("准备完成后 CrossSync 会自动开始局域网传输；在前台运行期间，屏幕会保持常亮。")
                            .font(.caption)
                            .foregroundStyle(Color.crossSyncSecondaryText)
                    }
                }
            }

            Button("取消本次任务") { model.cancel() }
                .font(.subheadline)
                .foregroundStyle(Color.crossSyncSecondaryText)
        }
    }
}

private struct UploadingView: View {
    @EnvironmentObject private var model: TransferViewModel

    var body: some View {
        VStack(spacing: 24) {
            ScreenTitle(title: "正在发送到电脑", subtitle: "局域网直传，不经过云端")

            CrossSyncCard(accent: .crossSyncMagenta) {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(model.uploadedItems)")
                            .font(.system(size: 68, weight: .bold, design: .rounded))
                        Text("/ \(model.totalItems) 项")
                            .font(.body)
                            .foregroundStyle(Color.crossSyncSecondaryText)
                        Spacer()
                        Text(Self.speed(model.speedBytesPerSecond))
                            .font(.title3)
                            .fontWeight(.bold)
                            .foregroundStyle(Color.crossSyncMagenta)
                    }
                    ProgressView(value: model.currentFileProgress)
                        .tint(.crossSyncMagenta)
                    Text(model.currentFileName)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Text("16 MB 分片 · 最多 4 路并发")
                        .font(.caption)
                        .foregroundStyle(Color.crossSyncSecondaryText)
                }
            }

            CrossSyncCard {
                VStack(spacing: 16) {
                    StatusRow(symbol: "checkmark.circle.fill", tint: .crossSyncGreen, title: "照片处理完成", value: "\(model.preparationCompleted) / \(model.totalItems) 项")
                    Divider().overlay(Color.crossSyncCardBorder)
                    StatusRow(symbol: "record.circle", tint: .crossSyncMagenta, title: "已经传输", value: "\(model.uploadedItems) 项")
                    Divider().overlay(Color.crossSyncCardBorder)
                    StatusRow(symbol: "circle", tint: .crossSyncSecondaryText, title: "等待传输", value: "\(max(model.totalItems - model.uploadedItems - model.failedItems, 0)) 项")
                }
            }

            Label("屏幕保持常亮 · 请勿切换网络", systemImage: "sun.max.fill")
                .font(.footnote)
                .foregroundStyle(Color.crossSyncGreen)

            Button("取消传输") { model.cancel() }
                .font(.subheadline)
                .foregroundStyle(Color.crossSyncSecondaryText)
        }
    }

    private static func speed(_ bytesPerSecond: Double) -> String {
        guard bytesPerSecond > 0 else { return "— MB/s" }
        return String(format: "%.1f MB/s", bytesPerSecond / 1_048_576)
    }
}

private struct CompleteView: View {
    @EnvironmentObject private var model: TransferViewModel
    @Binding var selection: [PhotosPickerItem]
    let onStart: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            ScreenTitle(title: "传输完成", subtitle: "所有照片已经安全保存到电脑")

            CrossSyncCard(accent: .crossSyncGreen) {
                VStack(spacing: 18) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 96, weight: .medium))
                        .foregroundStyle(Color.crossSyncGreen)
                    Text("\(model.summary.total) 项已传输")
                        .font(.title2)
                        .fontWeight(.bold)
                    Text("\(model.summary.photos) 张照片 · \(model.summary.videos) 个视频 · \(model.summary.failed) 个失败")
                        .font(.footnote)
                        .foregroundStyle(Color.crossSyncSecondaryText)
                    Divider().overlay(Color.crossSyncGreen.opacity(0.35))
                    Label("已保存到  \(model.summary.destination)", systemImage: "folder.fill")
                        .font(.caption)
                        .foregroundStyle(Color.crossSyncGreen)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity)
            }

            PhotoSelectionControls(
                selection: $selection,
                enabled: true,
                pickerTitle: "再选一批",
                success: true,
                onStart: onStart
            )

            CrossSyncCard {
                HStack(spacing: 14) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.title2)
                        .foregroundStyle(Color.crossSyncGreen)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("文件接收完成")
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Text("原始文件 · 局域网直传 · 无云端副本")
                            .font(.caption)
                            .foregroundStyle(Color.crossSyncSecondaryText)
                    }
                }
            }
        }
    }
}

private struct PhotoSelectionControls: View {
    @Binding var selection: [PhotosPickerItem]
    let enabled: Bool
    let pickerTitle: String
    var success = false
    let onStart: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            if !selection.isEmpty {
                CrossSyncCard(accent: .crossSyncCyan) {
                    HStack(spacing: 14) {
                        Image(systemName: "photo.stack.fill")
                            .font(.title2)
                            .foregroundStyle(Color.crossSyncCyan)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("已选择 \(selection.count) 项")
                                .font(.headline)
                            Text("确认后才会开始上传")
                                .font(.caption)
                                .foregroundStyle(Color.crossSyncSecondaryText)
                        }
                        Spacer()
                        Button {
                            selection = []
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.title2)
                                .foregroundStyle(Color.crossSyncSecondaryText)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("清除选择")
                    }
                }
            }

            PhotosPicker(
                selection: $selection,
                maxSelectionCount: 200,
                selectionBehavior: .continuousAndOrdered,
                matching: .any(of: [.images, .videos]),
                preferredItemEncoding: .current,
                photoLibrary: PHPhotoLibrary.shared()
            ) {
                PrimaryActionLabel(title: selection.isEmpty ? pickerTitle : "继续选择", success: success && selection.isEmpty)
            }
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.55)

            if !selection.isEmpty {
                Button(action: onStart) {
                    PrimaryActionLabel(title: "开始上传 \(selection.count) 项", success: true)
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .opacity(enabled ? 1 : 0.55)
            }
        }
    }
}

private struct FailedView: View {
    @EnvironmentObject private var model: TransferViewModel

    var body: some View {
        VStack(spacing: 24) {
            ScreenTitle(title: "传输未完成", subtitle: "已保留电脑端可续传的分片")
            CrossSyncCard(accent: .crossSyncMagenta) {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(Color.crossSyncMagenta)
                    Text(model.errorMessage)
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.crossSyncSecondaryText)
                }
                .frame(maxWidth: .infinity)
            }
            Button(action: model.reset) {
                PrimaryActionLabel(title: "返回重新选择")
            }
            .buttonStyle(.plain)
        }
    }
}

private struct ServerSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: TransferViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("电脑地址") {
                    TextField("https://192.168.2.14:8008", text: $model.baseURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("测试连接") {
                        Task { await model.refreshConnection() }
                    }
                }
                Section("访问令牌") {
                    SecureField("电脑端显示的 12 位令牌", text: $model.accessToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                    Text("令牌显示在电脑端 CrossSync 的扫码首页。")
                        .font(.footnote)
                }
                Section("状态") {
                    LabeledContent("连接", value: model.isConnected ? "已连接" : "未连接")
                    if let config = model.serverConfig {
                        LabeledContent("电脑", value: config.computerName)
                        LabeledContent("保存到", value: config.downloadsDirectory)
                    }
                    if let error = model.connectionError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Text("iPhone 与电脑需在同一 Wi‑Fi。使用 HTTPS 时，需先在 iPhone 安装并信任 CrossSync 的本地 CA 证书。")
                        .font(.footnote)
                }
            }
            .navigationTitle("连接电脑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
