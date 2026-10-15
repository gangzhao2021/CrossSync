import Foundation
import Photos
import PhotosUI
import SwiftUI
import UIKit

@MainActor
final class TransferViewModel: ObservableObject {
    @Published private(set) var phase: TransferPhase = .ready
    @Published private(set) var serverConfig: ServerConfig?
    @Published private(set) var connectionError: String?
    @Published private(set) var preparationCompleted = 0
    @Published private(set) var preparationTotal = 0
    @Published private(set) var currentFileName = ""
    @Published private(set) var uploadedItems = 0
    @Published private(set) var failedItems = 0
    @Published private(set) var totalItems = 0
    @Published private(set) var currentFileProgress = 0.0
    @Published private(set) var speedBytesPerSecond = 0.0
    @Published private(set) var summary: TransferSummary = .empty
    @Published private(set) var errorMessage = ""
    @Published private(set) var autoBackup = AutoBackupSettings.load()
    @Published private(set) var backupPendingCount: Int?
    @Published private(set) var isBackingUp = false

    @Published var baseURLString: String {
        didSet {
            UserDefaults.standard.set(baseURLString, forKey: Self.serverURLKey)
            if baseURLString != oldValue { invalidateConnection() }
        }
    }
    @Published var accessToken: String {
        didSet {
            UserDefaults.standard.set(accessToken, forKey: Self.accessTokenKey)
            if accessToken != oldValue { invalidateConnection() }
        }
    }
    @Published var keepScreenAwake: Bool {
        didSet {
            UserDefaults.standard.set(keepScreenAwake, forKey: Self.keepAwakeKey)
            updateIdleTimer()
        }
    }

    var isConnected: Bool { serverConfig != nil }
    var computerDisplayName: String { serverConfig?.computerName ?? "Home PC" }
    var destinationDisplay: String { serverConfig?.downloadsDirectory ?? "等待连接电脑" }

    private static let serverURLKey = "CrossSyncServerURL"
    private static let keepAwakeKey = "CrossSyncKeepAwake"
    private static let accessTokenKey = "CrossSyncAccessToken"
    private static let clientIDKey = "CrossSyncClientID"
    private var transferTask: Task<Void, Never>?
    private var uploadService: ChunkedUploadService?
    private let clientID: String

    init() {
        baseURLString = UserDefaults.standard.string(forKey: Self.serverURLKey)
            ?? "https://192.168.2.14:8008"
        accessToken = UserDefaults.standard.string(forKey: Self.accessTokenKey) ?? ""
        if let savedClientID = UserDefaults.standard.string(forKey: Self.clientIDKey) {
            clientID = savedClientID
        } else {
            let generated = UUID().uuidString.lowercased()
            UserDefaults.standard.set(generated, forKey: Self.clientIDKey)
            clientID = generated
        }
        if UserDefaults.standard.object(forKey: Self.keepAwakeKey) == nil {
            keepScreenAwake = true
        } else {
            keepScreenAwake = UserDefaults.standard.bool(forKey: Self.keepAwakeKey)
        }
    }

    // MARK: Automatic backup

    func setAutoBackupEnabled(_ enabled: Bool) {
        var settings = autoBackup
        if enabled && !settings.enabled {
            settings.startDate = Date()  // "New photos" means from now on.
        }
        settings.enabled = enabled
        updateAutoBackup(settings)
        if enabled {
            Task {
                _ = await AutoBackupService.requestAccess()
                refreshBackupStatus()
            }
        }
    }

    func setBackupIncludesExisting(_ include: Bool) {
        var settings = autoBackup
        settings.includeExisting = include
        updateAutoBackup(settings)
    }

    func setBackupAlbums(_ identifiers: [String]) {
        var settings = autoBackup
        settings.albumIdentifiers = identifiers
        updateAutoBackup(settings)
    }

    func refreshBackupStatus() {
        guard autoBackup.enabled, AutoBackupService.isAuthorized else {
            backupPendingCount = nil
            return
        }
        backupPendingCount = AutoBackupService.pendingAssets(settings: autoBackup, backedUp: BackupLedger.shared.snapshot).count
    }

    /// Back up new photos when the app opens; does nothing while another transfer runs.
    func startAutoBackupIfNeeded() {
        // Checked and set synchronously: opening the app can ask twice in a row.
        guard autoBackup.enabled, isConnected, !phase.isBusy, !isBackingUp, AutoBackupService.isAuthorized else { return }
        let assets = AutoBackupService.pendingAssets(settings: autoBackup, backedUp: BackupLedger.shared.snapshot)
        backupPendingCount = assets.count
        guard !assets.isEmpty else { return }
        isBackingUp = true
        // Picking photos by hand cancels this task (see start(items:)).
        transferTask = Task { [weak self] in
            await self?.runBackup(assets)
        }
    }

    private func updateAutoBackup(_ settings: AutoBackupSettings) {
        autoBackup = settings
        settings.save()
        refreshBackupStatus()
    }

    private func runBackup(_ assets: [PHAsset]) async {
        guard let url = normalizedBaseURL else {
            isBackingUp = false
            return
        }
        resetProgress()
        errorMessage = ""
        phase = .uploading
        totalItems = assets.count
        updateIdleTimer()
        let service = ChunkedUploadService(api: makeAPI(baseURL: url))
        uploadService = service
        var photos = 0
        var videos = 0
        var failedNames: [String] = []
        var failuresInARow = 0
        defer {
            uploadService = nil
            isBackingUp = false
            updateIdleTimer()
            refreshBackupStatus()
        }

        for asset in assets {
            if Task.isCancelled { break }
            var exported: [PreparedAsset] = []
            do {
                exported = try await AutoBackupService.export(asset)
                for file in exported {
                    try Task.checkCancellation()
                    currentFileName = file.name
                    currentFileProgress = 0
                    let startedAt = Date()
                    _ = try await service.upload(asset: file) { [weak self] sent, total in
                        Task { @MainActor [weak self] in
                            guard let self else { return }
                            self.currentFileProgress = total > 0 ? Double(sent) / Double(total) : 0
                            self.speedBytesPerSecond = Double(sent) / max(Date().timeIntervalSince(startedAt), 0.1)
                        }
                    }
                }
                BackupLedger.shared.markBackedUp(asset.localIdentifier)
                uploadedItems += 1
                if asset.mediaType == .video { videos += 1 } else { photos += 1 }
                failuresInARow = 0
            } catch is CancellationError {
                PhotoPreparationService.cleanup(exported)
                break
            } catch let error as URLError where error.code == .cancelled {
                PhotoPreparationService.cleanup(exported)
                break
            } catch {
                failedNames.append(exported.first?.name ?? "一项")
                failedItems += 1
                failuresInARow += 1
                if failuresInARow >= 3 {
                    // Probably the computer went away; try again next time the app opens.
                    PhotoPreparationService.cleanup(exported)
                    errorMessage = "自动备份暂停了：\(error.localizedDescription)"
                    break
                }
            }
            PhotoPreparationService.cleanup(exported)
        }

        summary = TransferSummary(
            total: uploadedItems + failedNames.count,
            photos: photos,
            videos: videos,
            failed: failedNames.count,
            destination: serverConfig?.downloadsDirectory ?? "电脑接收区"
        )
        if uploadedItems == 0 && !failedNames.isEmpty {
            if errorMessage.isEmpty { errorMessage = "自动备份没能完成，下次打开 App 时会再试。" }
            phase = .failed
        } else {
            phase = uploadedItems > 0 ? .complete : .ready
        }
    }

    func refreshConnection() async {
        guard let url = normalizedBaseURL else {
            serverConfig = nil
            connectionError = CrossSyncAPIError.invalidServerURL.localizedDescription
            return
        }
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            serverConfig = nil
            connectionError = "请输入电脑端显示的 12 位访问令牌。"
            return
        }
        do {
            serverConfig = try await makeAPI(baseURL: url).fetchConfig()
            connectionError = nil
            startAutoBackupIfNeeded()
        } catch {
            serverConfig = nil
            connectionError = error.localizedDescription
        }
    }

    func start(items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        cancel(resetToReady: false)
        transferTask = Task { [weak self] in
            await self?.run(items: items)
        }
    }

    func cancel(resetToReady: Bool = true) {
        transferTask?.cancel()
        transferTask = nil
        uploadService?.cancelAll()
        uploadService = nil
        if resetToReady {
            phase = .ready
            resetProgress()
        }
        updateIdleTimer()
    }

    func reset() {
        cancel(resetToReady: true)
        isBackingUp = false
        summary = .empty
        errorMessage = ""
    }

    func applicationBecameActive() {
        updateIdleTimer()
        refreshBackupStatus()
        Task { await refreshConnection() }
    }

    private func run(items: [PhotosPickerItem]) async {
        guard let url = normalizedBaseURL else {
            fail(CrossSyncAPIError.invalidServerURL)
            return
        }

        resetProgress()
        phase = .preparing
        preparationTotal = items.count
        totalItems = items.count
        updateIdleTimer()

        var prepared: [PreparedAsset] = []
        defer {
            PhotoPreparationService.cleanup(prepared)
            uploadService = nil
            updateIdleTimer()
        }

        do {
            let api = makeAPI(baseURL: url)
            if serverConfig == nil {
                serverConfig = try await api.fetchConfig()
            }

            let service = ChunkedUploadService(api: api)
            uploadService = service
            var lastReceipt: UploadReceipt?
            var photoCount = 0
            var videoCount = 0
            var failedNames: [String] = []
            let batchSize = 4

            for batchStart in stride(from: 0, to: items.count, by: batchSize) {
                try Task.checkCancellation()
                let batchEnd = min(batchStart + batchSize, items.count)
                let batch = Array(items[batchStart..<batchEnd])
                phase = .preparing
                let preparation = try await PhotoPreparationService().prepare(items: batch) { [weak self] completed, _, name in
                    self?.preparationCompleted = batchStart + completed
                    self?.preparationTotal = items.count
                    self?.currentFileName = name
                }
                prepared = preparation.assets
                failedNames.append(contentsOf: preparation.failures.map(\.name))
                failedItems += preparation.failures.count
                try Task.checkCancellation()
                phase = .uploading

                for asset in prepared {
                    try Task.checkCancellation()
                    currentFileName = asset.name
                    currentFileProgress = 0
                    speedBytesPerSecond = 0
                    let startedAt = Date()

                    do {
                        lastReceipt = try await service.upload(asset: asset) { [weak self] sent, total in
                            Task { @MainActor [weak self] in
                                guard let self else { return }
                                self.currentFileProgress = total > 0 ? Double(sent) / Double(total) : 0
                                let elapsed = max(Date().timeIntervalSince(startedAt), 0.1)
                                self.speedBytesPerSecond = Double(sent) / elapsed
                            }
                        }
                        uploadedItems += 1
                        currentFileProgress = 1
                        if asset.kind == .photo { photoCount += 1 }
                        if asset.kind == .video { videoCount += 1 }
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch let error as URLError where error.code == .cancelled {
                        throw error
                    } catch {
                        failedNames.append(asset.name)
                        failedItems += 1
                    }
                }
                PhotoPreparationService.cleanup(prepared)
                prepared = []
            }

            summary = TransferSummary(
                total: uploadedItems + failedNames.count,
                photos: photoCount,
                videos: videoCount,
                failed: failedNames.count,
                destination: serverConfig?.downloadsDirectory ?? lastReceipt?.savedPath ?? "电脑接收区"
            )
            if failedNames.isEmpty {
                phase = .complete
            } else {
                let names = failedNames.prefix(5).joined(separator: "、")
                let more = failedNames.count > 5 ? " 等 \(failedNames.count) 项" : ""
                errorMessage = "已成功传输 \(uploadedItems) / \(totalItems) 项。失败：\(names)\(more)。请只重新选择这些项目。"
                phase = .failed
            }
        } catch is CancellationError {
            phase = .ready
        } catch let error as URLError where error.code == .cancelled {
            phase = .ready
        } catch {
            if uploadedItems > 0 {
                errorMessage = "已成功传输 \(uploadedItems) / \(totalItems) 项。\(error.localizedDescription)"
                phase = .failed
            } else {
                fail(error)
            }
        }
    }

    private var normalizedBaseURL: URL? {
        var value = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard
            let url = URL(string: value),
            let scheme = url.scheme?.lowercased(),
            scheme == "https",
            url.host != nil
        else { return nil }
        return url
    }

    private func fail(_ error: Error) {
        errorMessage = error.localizedDescription
        phase = .failed
    }

    private func invalidateConnection() {
        serverConfig = nil
        connectionError = nil
    }

    private func makeAPI(baseURL: URL) -> CrossSyncAPI {
        CrossSyncAPI(
            baseURL: baseURL,
            accessToken: accessToken.trimmingCharacters(in: .whitespacesAndNewlines),
            clientID: clientID
        )
    }

    private func resetProgress() {
        preparationCompleted = 0
        preparationTotal = 0
        currentFileName = ""
        uploadedItems = 0
        failedItems = 0
        totalItems = 0
        currentFileProgress = 0
        speedBytesPerSecond = 0
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = keepScreenAwake && phase.isBusy
    }
}
