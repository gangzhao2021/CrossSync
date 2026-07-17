import Photos
import PhotosUI
import SwiftUI
import UIKit

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
    @State private var isLibraryPresented = false
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

            Button {
                isLibraryPresented = true
            } label: {
                PrimaryActionLabel(title: selection.isEmpty ? pickerTitle : "继续选择", success: success && selection.isEmpty)
            }
            .buttonStyle(.plain)
            .fullScreenCover(isPresented: $isLibraryPresented) {
                PhotoLibrarySelectionView(selection: $selection, maxSelectionCount: 200)
            }
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.55)

            Text("打开后横向滑过照片，即可像系统相册一样连续选择")
                .font(.caption)
                .foregroundStyle(Color.crossSyncSecondaryText)
                .multilineTextAlignment(.center)

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

@MainActor
private final class PhotoLibraryViewModel: ObservableObject {
    @Published private(set) var authorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published private(set) var assets: [PHAsset] = []
    @Published private(set) var assetIndexByIdentifier: [String: Int] = [:]

    func load() async {
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        authorizationStatus = status
        reloadAssets()
    }

    func reloadAssets() {
        guard authorizationStatus == .authorized || authorizationStatus == .limited else {
            assets = []
            assetIndexByIdentifier = [:]
            return
        }

        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "mediaType == %d OR mediaType == %d",
            PHAssetMediaType.image.rawValue,
            PHAssetMediaType.video.rawValue
        )
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        let result = PHAsset.fetchAssets(with: options)
        var fetched: [PHAsset] = []
        fetched.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in fetched.append(asset) }
        assets = fetched
        assetIndexByIdentifier = Dictionary(
            uniqueKeysWithValues: fetched.enumerated().map { ($0.element.localIdentifier, $0.offset) }
        )
    }
}

private struct PhotoLibrarySelectionView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = PhotoLibraryViewModel()
    @State private var selectedIdentifiers: [String]
    @State private var cellFrames: [String: CGRect] = [:]
    @State private var dragIsSelecting: Bool?
    @State private var dragShouldAdd: Bool?
    @State private var dragStartIdentifier: String?
    @State private var selectionBeforeDrag: [String] = []
    @State private var lastDragLocation: CGPoint?
    @State private var suppressTap = false
    @State private var autoScrollDirection = 0
    @State private var autoScrollTask: Task<Void, Never>?

    @Binding private var selection: [PhotosPickerItem]
    private let maxSelectionCount: Int
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 4)
    private static let gridCoordinateSpace = "CrossSyncPhotoGrid"

    init(selection: Binding<[PhotosPickerItem]>, maxSelectionCount: Int) {
        _selection = selection
        self.maxSelectionCount = maxSelectionCount
        _selectedIdentifiers = State(
            initialValue: selection.wrappedValue.compactMap(\.itemIdentifier)
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.authorizationStatus {
                case .authorized, .limited:
                    photoGrid
                case .denied, .restricted:
                    permissionDeniedView
                case .notDetermined:
                    ProgressView("正在请求照片权限…")
                @unknown default:
                    permissionDeniedView
                }
            }
            .navigationTitle("选择照片与视频")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成（\(selectedIdentifiers.count)）") { confirmSelection() }
                        .fontWeight(.semibold)
                        .disabled(selectedIdentifiers.isEmpty)
                }
            }
        }
        .task { await model.load() }
    }

    private var photoGrid: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "hand.draw.fill")
                    .foregroundStyle(Color.crossSyncCyan)
                Text("轻点单选；像系统相册一样横向滑过照片可连续选择")
                    .font(.caption)
                    .foregroundStyle(Color.secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)

            if model.assets.isEmpty {
                ContentUnavailableView("没有可选择的照片", systemImage: "photo.on.rectangle.angled")
            } else {
                GeometryReader { viewport in
                    ScrollViewReader { scrollProxy in
                        ScrollView {
                            LazyVGrid(columns: columns, spacing: 2) {
                                ForEach(model.assets, id: \.localIdentifier) { asset in
                                    PhotoLibraryThumbnail(
                                        asset: asset,
                                        selectedNumber: selectedNumber(for: asset.localIdentifier)
                                    )
                                    .aspectRatio(1, contentMode: .fit)
                                    .contentShape(Rectangle())
                                    .background {
                                        GeometryReader { proxy in
                                            Color.clear.preference(
                                                key: PhotoCellFramePreferenceKey.self,
                                                value: [
                                                    asset.localIdentifier: proxy.frame(
                                                        in: .named(Self.gridCoordinateSpace)
                                                    )
                                                ]
                                            )
                                        }
                                    }
                                    .onTapGesture {
                                        guard !suppressTap else { return }
                                        toggle(asset.localIdentifier)
                                    }
                                }
                            }
                            .onPreferenceChange(PhotoCellFramePreferenceKey.self) { frames in
                                cellFrames = frames
                                if dragIsSelecting == true, let lastDragLocation {
                                    updateDragSelection(at: lastDragLocation)
                                }
                            }
                            .simultaneousGesture(
                                dragSelectionGesture(
                                    viewportHeight: viewport.size.height,
                                    scrollProxy: scrollProxy
                                )
                            )
                        }
                        .coordinateSpace(name: Self.gridCoordinateSpace)
                        .onDisappear { stopAutoScroll() }
                    }
                }
            }
        }
    }

    private var permissionDeniedView: some View {
        ContentUnavailableView {
            Label("需要照片权限", systemImage: "photo.badge.exclamationmark")
        } description: {
            Text("允许 CrossSync 读取照片后，才能使用拖动连续选择。")
        } actions: {
            Button("打开系统设置") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func dragSelectionGesture(
        viewportHeight: CGFloat,
        scrollProxy: ScrollViewProxy
    ) -> some Gesture {
        DragGesture(
            minimumDistance: 6,
            coordinateSpace: .named(Self.gridCoordinateSpace)
        )
            .onChanged { value in
                if dragIsSelecting == nil {
                    let horizontalDistance = abs(value.translation.width)
                    let verticalDistance = abs(value.translation.height)

                    // Match the Photos app: horizontal movement enters selection,
                    // while an ordinary vertical swipe keeps scrolling the library.
                    dragIsSelecting = horizontalDistance >= verticalDistance
                    guard dragIsSelecting == true else {
                        stopAutoScroll()
                        return
                    }

                    suppressTap = true
                    updateDragSelection(at: value.startLocation)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }

                guard dragIsSelecting == true else { return }
                lastDragLocation = value.location
                updateDragSelection(at: value.location)
                updateAutoScroll(
                    for: value.location,
                    viewportHeight: viewportHeight,
                    scrollProxy: scrollProxy
                )
            }
            .onEnded { _ in
                stopAutoScroll()
                dragIsSelecting = nil
                dragShouldAdd = nil
                dragStartIdentifier = nil
                selectionBeforeDrag = []
                lastDragLocation = nil
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(120))
                    suppressTap = false
                }
            }
    }

    private func updateAutoScroll(
        for location: CGPoint,
        viewportHeight: CGFloat,
        scrollProxy: ScrollViewProxy
    ) {
        let edgeZone = min(max(viewportHeight * 0.16, 56), 96)
        let newDirection: Int
        if location.y < edgeZone {
            newDirection = -1
        } else if location.y > viewportHeight - edgeZone {
            newDirection = 1
        } else {
            newDirection = 0
        }

        guard newDirection != autoScrollDirection else { return }
        autoScrollTask?.cancel()
        autoScrollTask = nil
        autoScrollDirection = newDirection
        guard newDirection != 0 else { return }

        autoScrollTask = Task { @MainActor in
            while !Task.isCancelled, dragIsSelecting == true {
                scrollOneRow(
                    direction: newDirection,
                    viewportHeight: viewportHeight,
                    scrollProxy: scrollProxy
                )
                try? await Task.sleep(for: .milliseconds(110))
            }
        }
    }

    private func scrollOneRow(
        direction: Int,
        viewportHeight: CGFloat,
        scrollProxy: ScrollViewProxy
    ) {
        let visibleIndices = cellFrames.compactMap { identifier, frame -> Int? in
            guard frame.maxY > 0, frame.minY < viewportHeight else { return nil }
            return model.assetIndexByIdentifier[identifier]
        }
        guard let firstVisible = visibleIndices.min(), let lastVisible = visibleIndices.max() else { return }

        let targetIndex: Int
        let anchor: UnitPoint
        if direction > 0 {
            targetIndex = min(lastVisible + columns.count, model.assets.count - 1)
            anchor = .bottom
        } else {
            targetIndex = max(firstVisible - columns.count, 0)
            anchor = .top
        }

        let currentEdge = direction > 0 ? lastVisible : firstVisible
        guard targetIndex != currentEdge else { return }
        withAnimation(.linear(duration: 0.1)) {
            scrollProxy.scrollTo(model.assets[targetIndex].localIdentifier, anchor: anchor)
        }
    }

    private func stopAutoScroll() {
        autoScrollTask?.cancel()
        autoScrollTask = nil
        autoScrollDirection = 0
    }

    private func selectedNumber(for identifier: String) -> Int? {
        selectedIdentifiers.firstIndex(of: identifier).map { $0 + 1 }
    }

    private func toggle(_ identifier: String) {
        if let index = selectedIdentifiers.firstIndex(of: identifier) {
            selectedIdentifiers.remove(at: index)
        } else if selectedIdentifiers.count < maxSelectionCount {
            selectedIdentifiers.append(identifier)
        }
    }

    private func updateDragSelection(at location: CGPoint) {
        guard let identifier = cellFrames.first(where: { $0.value.contains(location) })?.key else { return }
        if dragShouldAdd == nil {
            selectionBeforeDrag = selectedIdentifiers
            dragStartIdentifier = identifier
            dragShouldAdd = !selectedIdentifiers.contains(identifier)
        }

        guard
            let dragStartIdentifier,
            let startIndex = model.assetIndexByIdentifier[dragStartIdentifier],
            let currentIndex = model.assetIndexByIdentifier[identifier]
        else { return }

        let step = startIndex <= currentIndex ? 1 : -1
        let rangeIdentifiers = stride(
            from: startIndex,
            through: currentIndex,
            by: step
        ).map { model.assets[$0].localIdentifier }

        if dragShouldAdd == true {
            var updatedSelection = selectionBeforeDrag
            for candidate in rangeIdentifiers where !updatedSelection.contains(candidate) {
                guard updatedSelection.count < maxSelectionCount else { break }
                updatedSelection.append(candidate)
            }
            selectedIdentifiers = updatedSelection
        } else {
            let identifiersToRemove = Set(rangeIdentifiers)
            selectedIdentifiers = selectionBeforeDrag.filter { !identifiersToRemove.contains($0) }
        }
    }

    private func confirmSelection() {
        selection = selectedIdentifiers.map(PhotosPickerItem.init(itemIdentifier:))
        dismiss()
    }
}

private struct PhotoLibraryThumbnail: View {
    let asset: PHAsset
    let selectedNumber: Int?

    @State private var image: UIImage?
    @State private var requestID = PHInvalidImageRequestID

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Rectangle()
                            .fill(Color(uiColor: .secondarySystemBackground))
                            .overlay { ProgressView().controlSize(.small) }
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()

                if asset.mediaType == .video {
                    Label(Self.duration(asset.duration), systemImage: "video.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(5)
                        .shadow(radius: 2)
                }

                if let selectedNumber {
                    ZStack {
                        Circle()
                            .fill(Color.accentColor)
                        Circle()
                            .stroke(.white, lineWidth: 2)
                        Text("\(selectedNumber)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                    }
                    .frame(width: 26, height: 26)
                    .padding(6)
                }
            }
            .overlay {
                if selectedNumber != nil {
                    Rectangle().stroke(Color.accentColor, lineWidth: 3)
                }
            }
            .onAppear { requestThumbnail(size: proxy.size) }
            .onDisappear {
                if requestID != PHInvalidImageRequestID {
                    PHImageManager.default().cancelImageRequest(requestID)
                }
            }
        }
        .clipped()
    }

    private func requestThumbnail(size: CGSize) {
        guard image == nil, size.width > 0, size.height > 0 else { return }
        let scale = UIScreen.main.scale
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        requestID = PHImageManager.default().requestImage(
            for: asset,
            targetSize: CGSize(width: size.width * scale, height: size.height * scale),
            contentMode: .aspectFill,
            options: options
        ) { result, _ in
            guard let result else { return }
            DispatchQueue.main.async { image = result }
        }
    }

    private static func duration(_ seconds: TimeInterval) -> String {
        let total = max(Int(seconds.rounded()), 0)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

private struct PhotoCellFramePreferenceKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
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
