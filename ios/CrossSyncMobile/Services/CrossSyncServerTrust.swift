import Foundation
import Security

enum CrossSyncServerTrust {
    private static let localCA: SecCertificate? = {
        guard
            let url = Bundle.main.url(forResource: "CrossSync-Local-CA", withExtension: "crt"),
            let data = try? Data(contentsOf: url)
        else { return nil }
        if let certificate = SecCertificateCreateWithData(nil, data as CFData) {
            return certificate
        }
        guard
            let pem = String(data: data, encoding: .utf8),
            let begin = pem.range(of: "-----BEGIN CERTIFICATE-----"),
            let end = pem.range(of: "-----END CERTIFICATE-----")
        else { return nil }
        let base64 = String(pem[begin.upperBound..<end.lowerBound])
        guard let der = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            return nil
        }
        return SecCertificateCreateWithData(nil, der as CFData)
    }()

    static func handle(
        challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard
            challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let serverTrust = challenge.protectionSpace.serverTrust,
            let localCA
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let hostPolicy = SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString)
        guard
            SecTrustSetPolicies(serverTrust, hostPolicy) == errSecSuccess,
            SecTrustSetAnchorCertificates(serverTrust, [localCA] as CFArray) == errSecSuccess,
            SecTrustSetAnchorCertificatesOnly(serverTrust, true) == errSecSuccess,
            SecTrustEvaluateWithError(serverTrust, nil)
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}

final class CrossSyncSessionDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        CrossSyncServerTrust.handle(challenge: challenge, completionHandler: completionHandler)
    }
}

enum CrossSyncSessionFactory {
    static func make() -> URLSession {
        URLSession(
            configuration: .default,
            delegate: CrossSyncSessionDelegate(),
            delegateQueue: nil
        )
    }
}
