import XCTest
@testable import CrossSync

final class AutoBackupTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    func testOnlyPhotosTakenSinceBackupWasTurnedOnAreSent() {
        let candidates: [AutoBackupPlanner.Candidate] = [
            .init(identifier: "old", created: start.addingTimeInterval(-60)),
            .init(identifier: "new", created: start.addingTimeInterval(60)),
            .init(identifier: "undated", created: nil),
        ]
        XCTAssertEqual(AutoBackupPlanner.pending(candidates, backedUp: [], since: start), ["new"])
    }

    func testIncludingExistingPhotosSendsEverythingOldestFirst() {
        let candidates: [AutoBackupPlanner.Candidate] = [
            .init(identifier: "b", created: start.addingTimeInterval(20)),
            .init(identifier: "a", created: start.addingTimeInterval(10)),
            .init(identifier: "undated", created: nil),
        ]
        XCTAssertEqual(AutoBackupPlanner.pending(candidates, backedUp: [], since: nil), ["undated", "a", "b"])
    }

    func testAlreadyBackedUpAndRepeatedAssetsAreSkipped() {
        // The same photo can appear in two selected albums.
        let candidates: [AutoBackupPlanner.Candidate] = [
            .init(identifier: "a", created: start),
            .init(identifier: "a", created: start),
            .init(identifier: "done", created: start),
        ]
        XCTAssertEqual(AutoBackupPlanner.pending(candidates, backedUp: ["done"], since: nil), ["a"])
    }

    func testLedgerRemembersBackedUpAssetsAcrossLaunches() throws {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("ledger.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }

        BackupLedger(fileURL: file).markBackedUp("photo-1")
        XCTAssertEqual(BackupLedger(fileURL: file).snapshot, ["photo-1"])
    }
}
