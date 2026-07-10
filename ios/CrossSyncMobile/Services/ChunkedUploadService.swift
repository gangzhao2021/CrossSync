import Foundation
import CryptoKit

private actor ChunkQueue {
    private var indices: ArraySlice<Int>

    init(_ indices: [Int]) {
        self.indices = ArraySlice(indices)
    }

    func next() -> Int? {
        guard let value = indices.first else { return nil }
        indices = indices.dropFirst()
        return value
    }
}

private actor UploadProgressLedger {
    private let alreadyUploaded: Int64
    private var inFlight: [Int: Int64] = [:]

    init(alreadyUploaded: Int64) {
        self.alreadyUploaded = alreadyUploaded
    }

    func update(index: Int, sent: Int64) -> Int64 {
        inFlight[index] = sent
        return alreadyUploaded + inFlight.values.reduce(0, +)
    }
}

final class ChunkedUploadService: @unchecked Sendable {
    static let preferredChunkSize = 16 * 1024 * 1024
    static let preferredConcurrency = 4

    private let api: CrossSyncAPI
    private let uploader: BackgroundUploadSession

    init(api: CrossSyncAPI, uploader: BackgroundUploadSession = .shared) {
        self.api = api
        self.uploader = uploader
    }

    func upload(
        asset: PreparedAsset,
        onProgress: @escaping @Sendable (_ sent: Int64, _ total: Int64) -> Void
    ) async throws -> UploadReceipt {
        let initialized = try await api.initializeUpload(for: asset, chunkSize: Self.preferredChunkSize)
        defer { Self.cleanupChunkDirectory(uploadID: initialized.uploadID) }
        let missing = initialized.missing.sorted()
        let missingSet = Set(missing)
        let chunkSize = Int64(initialized.chunkSize)
        let alreadyUploaded = UploadMath.bytesAlreadyUploaded(
            fileSize: asset.size,
            chunkSize: chunkSize,
            totalChunks: initialized.totalChunks,
            missing: missingSet
        )
        onProgress(alreadyUploaded, asset.size)

        let queue = ChunkQueue(missing)
        let ledger = UploadProgressLedger(alreadyUploaded: alreadyUploaded)
        let workers = min(Self.preferredConcurrency, max(1, missing.count))

        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<workers {
                group.addTask { [self] in
                    while let index = await queue.next() {
                        try Task.checkCancellation()
                        let offset = Int64(index) * chunkSize
                        let length = UploadMath.chunkLength(
                            fileSize: asset.size,
                            chunkSize: chunkSize,
                            index: index
                        )
                        let chunkURL = try Self.makeChunkFile(
                            sourceURL: asset.url,
                            offset: offset,
                            length: length,
                            uploadID: initialized.uploadID,
                            index: index
                        )
                        defer { try? FileManager.default.removeItem(at: chunkURL) }
                        let chunkSHA256 = try Self.sha256(fileURL: chunkURL)

                        try await uploadChunkWithRetry(
                            uploadID: initialized.uploadID,
                            index: index,
                            chunkURL: chunkURL,
                            sha256: chunkSHA256
                        ) { sent, _ in
                            Task {
                                let totalSent = await ledger.update(index: index, sent: sent)
                                onProgress(totalSent, asset.size)
                            }
                        }
                    }
                }
            }
            try await group.waitForAll()
        }

        let finished = try await api.finishUpload(uploadID: initialized.uploadID)
        onProgress(asset.size, asset.size)
        return UploadReceipt(savedPath: finished.saved, relativePath: finished.path)
    }

    func cancelAll() {
        uploader.cancelAll()
    }

    private func uploadChunkWithRetry(
        uploadID: String,
        index: Int,
        chunkURL: URL,
        sha256: String,
        progress: @escaping @Sendable (Int64, Int64) -> Void
    ) async throws {
        var lastError: Error?
        for attempt in 0..<3 {
            try Task.checkCancellation()
            do {
                var request = try api.makeChunkRequest(uploadID: uploadID, index: index)
                request.setValue(sha256, forHTTPHeaderField: "X-SHA256")
                let result = try await uploader.upload(request: request, fromFile: chunkURL, progress: progress)
                guard (200..<300).contains(result.response.statusCode) else {
                    throw CrossSyncAPIError.server(
                        status: result.response.statusCode,
                        message: CrossSyncAPI.message(from: result.data)
                    )
                }
                return
            } catch {
                lastError = error
                if attempt < 2 {
                    try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 1_000_000_000)
                }
            }
        }
        throw lastError ?? CrossSyncAPIError.invalidResponse
    }

    private static func makeChunkFile(
        sourceURL: URL,
        offset: Int64,
        length: Int64,
        uploadID: String,
        index: Int
    ) throws -> URL {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CrossSyncChunks", isDirectory: true)
            .appendingPathComponent(uploadID, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("\(index).chunk")
        try? FileManager.default.removeItem(at: destination)
        _ = FileManager.default.createFile(atPath: destination.path, contents: nil)

        let input = try FileHandle(forReadingFrom: sourceURL)
        let output = try FileHandle(forWritingTo: destination)
        defer {
            try? input.close()
            try? output.close()
        }
        try input.seek(toOffset: UInt64(offset))

        var remaining = length
        while remaining > 0 {
            let blockSize = Int(min(remaining, 1024 * 1024))
            guard let data = try input.read(upToCount: blockSize), !data.isEmpty else {
                throw CocoaError(.fileReadCorruptFile)
            }
            try output.write(contentsOf: data)
            remaining -= Int64(data.count)
        }
        return destination
    }

    private static func sha256(fileURL: URL) throws -> String {
        let input = try FileHandle(forReadingFrom: fileURL)
        defer { try? input.close() }
        var hasher = SHA256()
        while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func cleanupChunkDirectory(uploadID: String) {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CrossSyncChunks", isDirectory: true)
            .appendingPathComponent(uploadID, isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
    }
}
