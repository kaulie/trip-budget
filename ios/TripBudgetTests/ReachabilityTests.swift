import XCTest
@testable import TripBudget

/// Answers with a canned response, or fails the way a dead address does, so the
/// reachability rule can be exercised without a running server.
final class StubURLProtocol: URLProtocol {
    static var failure: Error?
    static var statusCode = 200
    static var body = Data(#"{"ok":true}"#.utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let failure = StubURLProtocol.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: StubURLProtocol.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: StubURLProtocol.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private actor ReachabilityLog {
    private(set) var values: [Bool] = []
    func record(_ value: Bool) { values.append(value) }
}

/// "Offline" has to be decided by the transport. The bug these tests pin down:
/// one early failure (say, before the local-network permission was granted) used
/// to stick the banner on screen, because the calls that later succeeded never
/// cleared the flag.
final class ReachabilityTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.failure = nil
        StubURLProtocol.statusCode = 200
        StubURLProtocol.body = Data(#"{"ok":true}"#.utf8)
    }

    private func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            baseURL: URL(string: "https://trip-budget.test")!,
            session: URLSession(configuration: configuration)
        )
    }

    func testAnsweredRequestReportsOnline() async {
        let log = ReachabilityLog()
        let client = makeClient()
        await client.setReachabilityHandler { online in await log.record(online) }

        _ = try? await client.health()

        let values = await log.values
        XCTAssertEqual(values, [true])
    }

    func testRequestThatNeverLeavesTheDeviceReportsOffline() async {
        StubURLProtocol.failure = URLError(.cannotConnectToHost)
        let log = ReachabilityLog()
        let client = makeClient()
        await client.setReachabilityHandler { online in await log.record(online) }

        _ = try? await client.health()

        let values = await log.values
        XCTAssertFalse(values.isEmpty)
        XCTAssertFalse(values.contains(true), "a request that never arrived is offline")
    }

    /// A 4xx/5xx answer still means the server is there — only a request that
    /// never left the device counts as offline.
    func testServerErrorStillCountsAsOnline() async {
        StubURLProtocol.statusCode = 500
        StubURLProtocol.body = Data(#"{"error":{"code":"boom","message":"boom"}}"#.utf8)
        let log = ReachabilityLog()
        let client = makeClient()
        await client.setReachabilityHandler { online in await log.record(online) }

        _ = try? await client.health()

        let values = await log.values
        XCTAssertEqual(values, [true])
    }
}
