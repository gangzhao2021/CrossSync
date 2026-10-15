import Foundation
import Photos

/// What to back up automatically. Kept on the phone.
struct AutoBackupSettings: Codable, Equatable {
    var enabled = false
    /// Local identifiers of the albums to back up; empty means the whole library.
    var albumIdentifiers: [String] = []
    /// When false, only photos taken after backup was turned on are sent.
    var includeExisting = false
    var startDate = Date()

    private static let key = "CrossSyncAutoBackup"

    static func load() -> AutoBackupSettings {
        guard
            let data = UserDefaults.standard.data(forKey: key),
            let settings = try? JSONDecoder().decode(AutoBackupSettings.self, from: data)
        else { return AutoBackupSettings() }
        return settings
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}

/// Which assets already reached the computer, by Photos local identifier.
/// Stored as a JSON file so a large library does not bloat UserDefaults.
final class BackupLedger: @unchecked Sendable {
    static let shared = BackupLedger()

    private let fileURL: URL
    private let lock = NSLock()
    private var identifiers: Set<String>

    init(fileURL: URL? = nil) {
        let url = fileURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CrossSync", isDirectory: true)
            .appendingPathComponent("backed-up-assets.json")
        self.fileURL = url
        if
            let data = try? Data(contentsOf: url),
            let saved = try? JSONDecoder().decode([String].self, from: data)
        {
            identifiers = Set(saved)
        } else {
            identifiers = []
        }
    }

    var snapshot: Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return identifiers
    }

    func markBackedUp(_ identifier: String) {
        lock.lock()
        identifiers.insert(identifier)
        let saved = Array(identifiers)
        lock.unlock()
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(saved) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}

/// The choice of what still needs backing up, kept free of Photos so it can be unit tested.
enum AutoBackupPlanner {
    struct Candidate: Equatable {
        let identifier: String
        let created: Date?
    }

    /// Candidates not yet backed up, oldest first, optionally only those taken since `since`.
    static func pending(_ candidates: [Candidate], backedUp: Set<String>, since: Date?) -> [String] {
        var seen = Set<String>()
        return candidates
            .filter { candidate in
                guard !backedUp.contains(candidate.identifier), seen.insert(candidate.identifier).inserted else { return false }
                guard let since else { return true }
                return (candidate.created ?? .distantPast) >= since
            }
            .sorted { ($0.created ?? .distantPast) < ($1.created ?? .distantPast) }
            .map(\.identifier)
    }
}

enum AutoBackupError: LocalizedError {
    case noOriginal(String)

    var errorDescription: String? {
        switch self {
        case .noOriginal(let name):
            return "\(name) 读不到原片。"
        }
    }
}

/// Finds new photos and videos in the library and exports their originals for upload.
struct AutoBackupService {
    struct Album: Identifiable, Equatable {
        let id: String
        let title: String
        let count: Int
    }

    static var isAuthorized: Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return status == .authorized || status == .limited
    }

    static func requestAccess() async -> Bool {
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        return status == .authorized || status == .limited
    }

    static func albums() -> [Album] {
        var found: [Album] = []
        let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        collections.enumerateObjects { collection, _, _ in
            let count = PHAsset.fetchAssets(in: collection, options: mediaOptions()).count
            if count > 0 {
                found.append(Album(id: collection.localIdentifier, title: collection.localizedTitle ?? "相册", count: count))
            }
        }
        return found.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    /// Assets that still need backing up, oldest first.
    static func pendingAssets(settings: AutoBackupSettings, backedUp: Set<String>) -> [PHAsset] {
        let since = settings.includeExisting ? nil : settings.startDate
        // Filtering by date in the query keeps a large library from being walked on every launch.
        let options = mediaOptions(since: since)
        var byIdentifier: [String: PHAsset] = [:]
        var candidates: [AutoBackupPlanner.Candidate] = []
        func collect(_ result: PHFetchResult<PHAsset>) {
            result.enumerateObjects { asset, _, _ in
                byIdentifier[asset.localIdentifier] = asset
                candidates.append(.init(identifier: asset.localIdentifier, created: asset.creationDate))
            }
        }
        if settings.albumIdentifiers.isEmpty {
            collect(PHAsset.fetchAssets(with: options))
        } else {
            let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: settings.albumIdentifiers, options: nil)
            collections.enumerateObjects { collection, _, _ in
                collect(PHAsset.fetchAssets(in: collection, options: options))
            }
        }
        return AutoBackupPlanner.pending(candidates, backedUp: backedUp, since: since).compactMap { byIdentifier[$0] }
    }

    /// The original file (and a Live Photo's video) written to a temporary folder.
    static func export(_ asset: PHAsset) async throws -> [PreparedAsset] {
        let resources = PHAssetResource.assetResources(for: asset)
        let isVideo = asset.mediaType == .video
        let primaryTypes: [PHAssetResourceType] = isVideo ? [.video, .fullSizeVideo] : [.photo, .fullSizePhoto]
        guard let primary = primaryTypes.lazy.compactMap({ type in resources.first { $0.type == type } }).first
            ?? resources.first
        else { throw AutoBackupError.noOriginal(asset.localIdentifier) }

        var exported: [PreparedAsset] = []
        do {
            exported.append(try await write(primary, of: asset, resumeKey: "photos:\(asset.localIdentifier)",
                                            kind: isVideo ? .video : .photo))
            if !isVideo, let paired = resources.first(where: { $0.type == .pairedVideo }) {
                exported.append(try await write(paired, of: asset, resumeKey: "photos:\(asset.localIdentifier):live",
                                                kind: .video))
            }
        } catch {
            PhotoPreparationService.cleanup(exported)
            throw error
        }
        return exported
    }

    private static func write(
        _ resource: PHAssetResource,
        of asset: PHAsset,
        resumeKey: String,
        kind: AssetKind
    ) async throws -> PreparedAsset {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CrossSyncPrepared", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = resource.originalFilename.isEmpty ? "\(UUID().uuidString).bin" : resource.originalFilename
        let destination = directory.appendingPathComponent("\(UUID().uuidString)-\(name)")

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true  // Originals kept only in iCloud are downloaded first.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: destination, options: options) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }

        let size = Int64((try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        let created = asset.creationDate.map { Int64($0.timeIntervalSince1970 * 1_000) } ?? 0
        return PreparedAsset(
            id: UUID(),
            url: destination,
            name: name,
            size: size,
            // The computer stamps saved files with this when the file itself has no capture time.
            lastModifiedMilliseconds: created,
            resumeKey: resumeKey,
            kind: kind
        )
    }

    private static func mediaOptions(since: Date? = nil) -> PHFetchOptions {
        let options = PHFetchOptions()
        let media = NSPredicate(
            format: "mediaType == %d OR mediaType == %d",
            PHAssetMediaType.image.rawValue,
            PHAssetMediaType.video.rawValue
        )
        if let since {
            options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                media, NSPredicate(format: "creationDate >= %@", since as NSDate),
            ])
        } else {
            options.predicate = media
        }
        return options
    }
}
