import XCTest
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
}
