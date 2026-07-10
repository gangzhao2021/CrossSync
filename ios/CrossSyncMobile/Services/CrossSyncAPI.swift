import Foundation

enum CrossSyncAPIError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "电脑地址无效。请填写类似 https://192.168.2.14:8008 的地址。"
        case .invalidResponse:
            return "电脑返回了无法识别的响应。"
        case .server(let status, let message):
            return "电脑端错误（\(status)）：\(message)"
        }
    }
}

final class CrossSyncAPI: @unchecked Sendable {
    let baseURL: URL
    private let accessToken: String
    private let clientID: String
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL, accessToken: String, clientID: String, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.clientID = clientID
        self.session = session ?? CrossSyncSessionFactory.make()
    }

    func fetchConfig() async throws -> ServerConfig {
        try await send(path: "api/config", method: "GET", body: Optional<Data>.none)
    }

    func initializeUpload(for asset: PreparedAsset, chunkSize: Int) async throws -> InitUploadResponse {
        struct Payload: Encodable {
            let name: String
            let size: Int64
            let chunkSize: Int
            let lastModified: Int64
            let target: String
            let clientID: String
            let resumeKey: String

            enum CodingKeys: String, CodingKey {
                case name, size, target
                case chunkSize = "chunk_size"
                case lastModified = "last_modified"
                case clientID = "client_id"
                case resumeKey = "resume_key"
            }
        }

        let payload = Payload(
            name: asset.name,
            size: asset.size,
            chunkSize: chunkSize,
            lastModified: asset.lastModifiedMilliseconds,
            target: "downloads",
            clientID: clientID,
            resumeKey: asset.resumeKey
        )
        return try await send(path: "api/init-upload", method: "POST", body: encoder.encode(payload))
    }

    func finishUpload(uploadID: String) async throws -> FinishUploadResponse {
        try await send(
            path: "api/finish-upload/\(uploadID)",
            method: "POST",
            queryItems: [
                URLQueryItem(name: "open", value: "0"),
                URLQueryItem(name: "checksum", value: "0")
            ],
            body: Optional<Data>.none
        )
    }

    func makeChunkRequest(uploadID: String, index: Int) throws -> URLRequest {
        var request = URLRequest(url: try makeURL(path: "api/upload/\(uploadID)/\(index)"))
        request.httpMethod = "PUT"
        request.timeoutInterval = 60 * 30
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        applyAuthentication(to: &request)
        return request
    }

    private func send<Response: Decodable>(
        path: String,
        method: String,
        queryItems: [URLQueryItem] = [],
        body: Data?
    ) async throws -> Response {
        var request = URLRequest(url: try makeURL(path: path, queryItems: queryItems))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 60
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        applyAuthentication(to: &request)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CrossSyncAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw CrossSyncAPIError.server(status: http.statusCode, message: Self.message(from: data))
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw CrossSyncAPIError.invalidResponse
        }
    }

    private func applyAuthentication(to request: inout URLRequest) {
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    }

    private func makeURL(path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        let url = baseURL.appendingPathComponent(path)
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw CrossSyncAPIError.invalidServerURL
        }
        if !queryItems.isEmpty { components.queryItems = queryItems }
        guard let finalURL = components.url else { throw CrossSyncAPIError.invalidServerURL }
        return finalURL
    }

    static func message(from data: Data) -> String {
        if
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let detail = object["detail"] as? String
        {
            return detail
        }
        return String(data: data, encoding: .utf8) ?? "未知错误"
    }
}
