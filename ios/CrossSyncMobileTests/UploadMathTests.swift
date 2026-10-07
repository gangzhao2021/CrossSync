import XCTest
import CryptoKit
@testable import CrossSync

final class UploadMathTests: XCTestCase {
    func testLastChunkUsesRemainingBytes() {
        let chunk = Int64(16 * 1024 * 1024)
        XCTAssertEqual(UploadMath.chunkLength(fileSize: chunk * 2 + 99, chunkSize: chunk, index: 2), 99)
    }

    func testResumeCountsCompletedChunks() {
        let chunk = Int64(16 * 1024 * 1024)
        let total = chunk * 2 + 99
        let uploaded = UploadMath.bytesAlreadyUploaded(
            fileSize: total,
            chunkSize: chunk,
            totalChunks: 3,
            missing: [1]
        )
        XCTAssertEqual(uploaded, chunk + 99)
    }
    func testChunkFileContainsOnlyRequestedRangeAndMatchingChecksum() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let input = Data((0..<(1024 * 1024 + 17)).map { UInt8($0 % 251) })
        try input.write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let expected = input.subdata(in: 7..<input.count)
        let chunk = try ChunkedUploadService.makeChunkFile(
            sourceURL: source, offset: 7, length: Int64(expected.count),
            uploadID: UUID().uuidString, index: 0
        )
        defer { try? FileManager.default.removeItem(at: chunk.url.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: chunk.url), expected)
        let expectedHash = SHA256.hash(data: expected).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(chunk.sha256, expectedHash)
    }
}
