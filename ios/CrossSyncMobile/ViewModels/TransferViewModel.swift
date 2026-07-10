import Foundation
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
    @Published private(set) var totalItems = 0
    @Published private(set) var currentFileProgress = 0.0
    @Published private(set) var speedBytesPerSecond = 0.0
    @Published private(set) var summary: TransferSummary = .empty
    @Published private(set) var errorMessage = ""

    @Published var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Self.serverURLKey) }
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
    private var transferTask: Task<Void, Never>?
    private var uploadService: ChunkedUploadService?

    init() {
        baseURLString = UserDefaults.standard.string(forKey: Self.serverURLKey)
            ?? "https://192.168.2.14:8008"
        if UserDefaults.standard.object(forKey: Self.keepAwakeKey) == nil {
            keepScreenAwake = true
        } else {
            keepScreenAwake = UserDefaults.standard.bool(forKey: Self.keepAwakeKey)
        }
    }

    func refreshConnection() async {
        guard let url = normalizedBaseURL else {
            serverConfig = nil
            connectionError = CrossSyncAPIError.invalidServerURL.localizedDescription
            return
        }
        do {
            serverConfig = try await CrossSyncAPI(baseURL: url).fetchConfig()
            connectionError = nil
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
        summary = .empty
        errorMessage = ""
    }

    func applicationBecameActive() {
        updateIdleTimer()
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
            let api = CrossSyncAPI(baseURL: url)
            if serverConfig == nil {
                serverConfig = try await api.fetchConfig()
            }

            prepared = try await PhotoPreparationService().prepare(items: items) { [weak self] completed, total, name in
                self?.preparationCompleted = completed
                self?.preparationTotal = total
                self?.currentFileName = name
            }
            try Task.checkCancellation()

            phase = .uploading
            let service = ChunkedUploadService(api: api)
            uploadService = service
            var lastReceipt: UploadReceipt?

            for (index, asset) in prepared.enumerated() {
                try Task.checkCancellation()
                uploadedItems = index
                currentFileName = asset.name
                currentFileProgress = 0
                speedBytesPerSecond = 0
                let startedAt = Date()

                lastReceipt = try await service.upload(asset: asset) { [weak self] sent, total in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.currentFileProgress = total > 0 ? Double(sent) / Double(total) : 0
                        let elapsed = max(Date().timeIntervalSince(startedAt), 0.1)
                        self.speedBytesPerSecond = Double(sent) / elapsed
                    }
                }
                uploadedItems = index + 1
                currentFileProgress = 1
            }

            let photoCount = prepared.filter { $0.kind == .photo }.count
            let videoCount = prepared.filter { $0.kind == .video }.count
            summary = TransferSummary(
                total: prepared.count,
                photos: photoCount,
                videos: videoCount,
                failed: 0,
                destination: serverConfig?.downloadsDirectory ?? lastReceipt?.savedPath ?? "电脑接收区"
            )
            phase = .complete
        } catch is CancellationError {
            phase = .ready
        } catch let error as URLError where error.code == .cancelled {
            phase = .ready
        } catch {
            fail(error)
        }
    }

    private var normalizedBaseURL: URL? {
        var value = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard
            let url = URL(string: value),
            let scheme = url.scheme?.lowercased(),
            (scheme == "https" || scheme == "http"),
            url.host != nil
        else { return nil }
        return url
    }

    private func fail(_ error: Error) {
        errorMessage = error.localizedDescription
        phase = .failed
    }

    private func resetProgress() {
        preparationCompleted = 0
        preparationTotal = 0
        currentFileName = ""
        uploadedItems = 0
        totalItems = 0
        currentFileProgress = 0
        speedBytesPerSecond = 0
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = keepScreenAwake && phase.isBusy
    }
}

