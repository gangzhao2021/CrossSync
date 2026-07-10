import Foundation

struct HTTPUploadResult: Sendable {
    let response: HTTPURLResponse
    let data: Data
}

final class BackgroundUploadSession: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    static let identifier = "com.crosssync.mobile.background-upload"
    static let shared = BackgroundUploadSession()

    private final class PendingUpload {
        let continuation: CheckedContinuation<HTTPUploadResult, Error>
        let progress: @Sendable (Int64, Int64) -> Void
        var data = Data()

        init(
            continuation: CheckedContinuation<HTTPUploadResult, Error>,
            progress: @escaping @Sendable (Int64, Int64) -> Void
        ) {
            self.continuation = continuation
            self.progress = progress
        }
    }

    private let lock = NSLock()
    private var pending: [Int: PendingUpload] = [:]
    private var backgroundCompletionHandler: (() -> Void)?

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.timeoutIntervalForRequest = 60 * 30
        configuration.timeoutIntervalForResource = 60 * 60 * 6
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func upload(
        request: URLRequest,
        fromFile fileURL: URL,
        progress: @escaping @Sendable (Int64, Int64) -> Void
    ) async throws -> HTTPUploadResult {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.uploadTask(with: request, fromFile: fileURL)
            task.taskDescription = fileURL.path
            let item = PendingUpload(continuation: continuation, progress: progress)
            lock.lock()
            pending[task.taskIdentifier] = item
            lock.unlock()
            task.resume()
        }
    }

    func cancelAll() {
        session.getAllTasks { tasks in
            tasks.forEach { $0.cancel() }
        }
    }

    func cancelOrphanedTasks() {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            self.lock.lock()
            let activeTaskIDs = Set(self.pending.keys)
            self.lock.unlock()
            tasks.filter { !activeTaskIDs.contains($0.taskIdentifier) }.forEach { $0.cancel() }
        }
    }

    func setBackgroundCompletionHandler(_ completionHandler: @escaping () -> Void) {
        lock.lock()
        backgroundCompletionHandler = completionHandler
        lock.unlock()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        lock.lock()
        let callback = pending[task.taskIdentifier]?.progress
        lock.unlock()
        callback?(totalBytesSent, totalBytesExpectedToSend)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        CrossSyncServerTrust.handle(challenge: challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        pending[dataTask.taskIdentifier]?.data.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let item = pending.removeValue(forKey: task.taskIdentifier)
        lock.unlock()

        guard let item else {
            removeChunkFileIfOwned(task.taskDescription)
            return
        }
        if let error {
            item.continuation.resume(throwing: error)
            return
        }
        guard let response = task.response as? HTTPURLResponse else {
            item.continuation.resume(throwing: CrossSyncAPIError.invalidResponse)
            return
        }
        item.continuation.resume(returning: HTTPUploadResult(response: response, data: item.data))
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        lock.unlock()
        DispatchQueue.main.async { completion?() }
    }

    private func removeChunkFileIfOwned(_ path: String?) {
        guard let path else { return }
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CrossSyncChunks", isDirectory: true)
            .standardizedFileURL.path
        let candidate = URL(fileURLWithPath: path).standardizedFileURL.path
        guard candidate.hasPrefix(root + "/") else { return }
        try? FileManager.default.removeItem(atPath: candidate)
    }
}
