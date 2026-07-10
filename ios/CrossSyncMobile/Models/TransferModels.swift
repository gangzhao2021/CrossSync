import Foundation
import UniformTypeIdentifiers

enum TransferPhase: Equatable {
    case ready
    case preparing
    case uploading
    case complete
    case failed

    var isBusy: Bool {
        self == .preparing || self == .uploading
    }
}

enum AssetKind: Sendable, Equatable {
    case photo
    case video
    case other
}

struct PreparedAsset: Identifiable, Sendable {
    let id: UUID
    let url: URL
    let name: String
    let size: Int64
    let lastModifiedMilliseconds: Int64
    let kind: AssetKind
}

struct TransferSummary: Equatable {
    let total: Int
    let photos: Int
    let videos: Int
    let failed: Int
    let destination: String

    static let empty = TransferSummary(total: 0, photos: 0, videos: 0, failed: 0, destination: "")
}

struct ServerConfig: Decodable, Equatable, Sendable {
    let downloadsDirectory: String
    let downloadsFreeBytes: Int64?
    let computerName: String
    let lanIP: String
    let defaultChunkSize: Int
    let maxConcurrency: Int

    enum CodingKeys: String, CodingKey {
        case downloadsDirectory = "downloads_dir"
        case downloadsFreeBytes = "downloads_free_bytes"
        case computerName = "computer_name"
        case lanIP = "lan_ip"
        case defaultChunkSize = "default_chunk_size"
        case maxConcurrency = "max_concurrency"
    }
}

struct InitUploadResponse: Decodable, Sendable {
    let resumed: Bool
    let uploadID: String
    let chunkSize: Int
    let totalChunks: Int
    let missing: [Int]

    enum CodingKeys: String, CodingKey {
        case resumed
        case uploadID = "upload_id"
        case chunkSize = "chunk_size"
        case totalChunks = "total_chunks"
        case missing
    }
}

struct FinishUploadResponse: Decodable, Sendable {
    let saved: String
    let path: String
    let area: String
    let sha256: String?
}

struct UploadReceipt: Sendable {
    let savedPath: String
    let relativePath: String
}

enum UploadMath {
    static func chunkLength(fileSize: Int64, chunkSize: Int64, index: Int) -> Int64 {
        let offset = Int64(index) * chunkSize
        return max(0, min(chunkSize, fileSize - offset))
    }

    static func bytesAlreadyUploaded(
        fileSize: Int64,
        chunkSize: Int64,
        totalChunks: Int,
        missing: Set<Int>
    ) -> Int64 {
        (0..<totalChunks).reduce(into: Int64(0)) { total, index in
            if !missing.contains(index) {
                total += chunkLength(fileSize: fileSize, chunkSize: chunkSize, index: index)
            }
        }
    }
}
