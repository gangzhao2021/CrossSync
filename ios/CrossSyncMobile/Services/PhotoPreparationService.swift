import CoreTransferable
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct PhotoPreparationFailure: Sendable {
    let name: String
    let message: String
}

struct PhotoPreparationResult: Sendable {
    let assets: [PreparedAsset]
    let failures: [PhotoPreparationFailure]
}

private enum PhotoPreparationOutcome: Sendable {
    case success(index: Int, asset: PreparedAsset)
    case failure(index: Int, failure: PhotoPreparationFailure)
}

private struct ImportedPhotoFile: Transferable, Sendable {
    let url: URL
    let originalName: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            try Self.importFile(received)
        }
        FileRepresentation(importedContentType: .movie) { received in
            try Self.importFile(received)
        }
    }

    private static func importFile(_ received: ReceivedTransferredFile) throws -> ImportedPhotoFile {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CrossSyncPicker", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let ext = received.file.pathExtension
        let filename = ext.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(ext)"
        let destination = directory.appendingPathComponent(filename)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.copyItem(at: received.file, to: destination)
        return ImportedPhotoFile(url: destination, originalName: received.file.lastPathComponent)
    }
}

struct PhotoPreparationService {
    func prepare(
        items: [PhotosPickerItem],
        onProgress: @MainActor (_ completed: Int, _ total: Int, _ currentName: String) -> Void
    ) async throws -> PhotoPreparationResult {
        guard !items.isEmpty else { return PhotoPreparationResult(assets: [], failures: []) }
        Self.cleanupStaleWorkingFiles()
        await onProgress(0, items.count, "正在请求原片")

        var prepared = [PreparedAsset?](repeating: nil, count: items.count)
        var failures = [PhotoPreparationFailure?](repeating: nil, count: items.count)
        var nextIndex = 0
        var completed = 0
        let concurrency = min(4, items.count)

        do {
            try await withThrowingTaskGroup(of: PhotoPreparationOutcome.self) { group in
                func enqueue(_ index: Int) {
                    let item = items[index]
                    group.addTask {
                        do {
                            return .success(index: index, asset: try await Self.prepareOne(item: item, index: index))
                        } catch is CancellationError {
                            throw CancellationError()
                        } catch let error as URLError where error.code == .cancelled {
                            throw error
                        } catch {
                            return .failure(
                                index: index,
                                failure: PhotoPreparationFailure(
                                    name: Self.fallbackName(
                                        kind: Self.kind(for: item.supportedContentTypes),
                                        index: index,
                                        types: item.supportedContentTypes,
                                        itemIdentifier: item.itemIdentifier
                                    ),
                                    message: error.localizedDescription
                                )
                            )
                        }
                    }
                }

                while nextIndex < concurrency {
                    enqueue(nextIndex)
                    nextIndex += 1
                }

                while let outcome = try await group.next() {
                    let currentName: String
                    switch outcome {
                    case .success(let index, let asset):
                        prepared[index] = asset
                        currentName = asset.name
                    case .failure(let index, let failure):
                        failures[index] = failure
                        currentName = failure.name
                    }
                    completed += 1
                    await onProgress(completed, items.count, currentName)
                    if nextIndex < items.count {
                        enqueue(nextIndex)
                        nextIndex += 1
                    }
                }
            }
        } catch {
            Self.cleanup(prepared.compactMap { $0 })
            throw error
        }

        return PhotoPreparationResult(
            assets: prepared.compactMap { $0 },
            failures: failures.compactMap { $0 }
        )
    }

    static func cleanup(_ assets: [PreparedAsset]) {
        for asset in assets {
            try? FileManager.default.removeItem(at: asset.url)
        }
    }

    private static func prepareOne(item: PhotosPickerItem, index: Int) async throws -> PreparedAsset {
        try Task.checkCancellation()
        let kind = Self.kind(for: item.supportedContentTypes)
        let fallbackName = Self.fallbackName(
            kind: kind,
            index: index,
            types: item.supportedContentTypes,
            itemIdentifier: item.itemIdentifier
        )
        guard let imported = try await item.loadTransferable(type: ImportedPhotoFile.self) else {
            throw PhotoPreparationError.unavailable(index: index + 1)
        }
        try Task.checkCancellation()

        let uploadName = Self.uploadName(originalName: imported.originalName, fallbackName: fallbackName)
        let finalURL = try Self.moveToPreparedDirectory(
            imported.url,
            uploadName: uploadName,
            preferredType: item.supportedContentTypes.first
        )
        let values = try finalURL.resourceValues(forKeys: [.fileSizeKey])
        let fileSize = Int64(values.fileSize ?? 0)
        let resumeKey = item.itemIdentifier.map { "photos:\($0)" }
            ?? "file:\(uploadName):\(fileSize)"
        return PreparedAsset(
            id: UUID(),
            url: finalURL,
            name: uploadName,
            size: fileSize,
            // PhotosPicker may export a fresh temporary file each time. Zero keeps
            // the server fingerprint stable so selecting the same asset can resume.
            lastModifiedMilliseconds: 0,
            resumeKey: resumeKey,
            kind: kind
        )
    }

    private static func moveToPreparedDirectory(
        _ source: URL,
        uploadName: String,
        preferredType: UTType?
    ) throws -> URL {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CrossSyncPrepared", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let sourceExtension = source.pathExtension
        let fallbackExtension = preferredType?.preferredFilenameExtension ?? "bin"
        let filename: String
        if sourceExtension.isEmpty {
            filename = URL(fileURLWithPath: uploadName).deletingPathExtension().lastPathComponent + "." + fallbackExtension
        } else {
            filename = URL(fileURLWithPath: uploadName).deletingPathExtension().lastPathComponent + "." + sourceExtension
        }

        let destination = directory.appendingPathComponent("\(UUID().uuidString)-\(filename)")
        try FileManager.default.moveItem(at: source, to: destination)
        return destination
    }

    private static func kind(for types: [UTType]) -> AssetKind {
        if types.contains(where: { $0.conforms(to: .image) }) { return .photo }
        if types.contains(where: { $0.conforms(to: .movie) || $0.conforms(to: .video) }) { return .video }
        return .other
    }

    private static func fallbackName(
        kind: AssetKind,
        index: Int,
        types: [UTType],
        itemIdentifier: String?
    ) -> String {
        let prefix = kind == .video ? "VID" : "IMG"
        let ext = types.first?.preferredFilenameExtension ?? (kind == .video ? "mov" : "heic")
        if let itemIdentifier, !itemIdentifier.isEmpty {
            let stable = Data(itemIdentifier.utf8)
                .base64EncodedString()
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "=", with: "")
            return "\(prefix)_\(stable.prefix(24)).\(ext)"
        }
        let timestamp = Int64(Date().timeIntervalSince1970 * 1_000)
        return String(format: "%@_%lld_%03d.%@", prefix, timestamp, index + 1, ext)
    }

    private static func uploadName(originalName: String, fallbackName: String) -> String {
        let candidate = URL(fileURLWithPath: originalName).lastPathComponent
        let stem = URL(fileURLWithPath: candidate).deletingPathExtension().lastPathComponent
        let looksLikeTemporaryUUID = UUID(uuidString: stem) != nil
        guard
            !candidate.isEmpty,
            candidate != ".",
            candidate.lowercased() != "file",
            !looksLikeTemporaryUUID
        else { return fallbackName }
        return candidate
    }

    private static func cleanupStaleWorkingFiles() {
        let directories = [
            FileManager.default.temporaryDirectory.appendingPathComponent("CrossSyncPicker", isDirectory: true),
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("CrossSyncPrepared", isDirectory: true)
        ]
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        for directory in directories {
            guard let files = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for file in files {
                let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
                if modified.map({ $0 < cutoff }) ?? false {
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
    }
}

enum PhotoPreparationError: LocalizedError {
    case unavailable(index: Int)

    var errorDescription: String? {
        switch self {
        case .unavailable(let index):
            return "第 \(index) 项无法从照片库读取。请确认原片已从 iCloud 下载，或稍后重试。"
        }
    }
}
