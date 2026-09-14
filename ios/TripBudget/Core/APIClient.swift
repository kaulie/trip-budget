import Foundation

/// A rule the business layer refused.
///
/// These come straight from the server's deterministic validator — the client
/// never decides whether a split is legal, it only shows what the server said.
struct RuleViolation: Codable, Hashable, Identifiable {
    var rule: String
    var message: String

    var id: String { rule + message }
}

enum APIError: LocalizedError {
    case notAuthenticated
    case transport(String)
    case server(status: Int, code: String, message: String, violations: [RuleViolation])
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "还没有进入账本，请先设置昵称。"
        case .transport(let message):
            return "网络不可用：\(message)"
        case .server(_, _, let message, let violations):
            return violations.first?.message ?? message
        case .decoding(let message):
            return "数据解析失败：\(message)"
        }
    }

    var violations: [RuleViolation] {
        if case .server(_, _, _, let violations) = self { return violations }
        return []
    }

    /// Conflicts (409) are recoverable by re-syncing; everything else is not.
    var isConflict: Bool {
        if case .server(let status, _, _, _) = self { return status == 409 }
        return false
    }

    /// True when nothing was written, so a retry is safe.
    var isRetryableOffline: Bool {
        if case .transport = self { return true }
        return false
    }
}

struct ServerErrorBody: Decodable {
    struct Payload: Decodable {
        var code: String
        var message: String
        var details: Details?
    }
    struct Details: Decodable {
        var violations: [RuleViolation]?
    }
    var error: Payload
}

struct EmptyResponse: Decodable {}

/// The whole HTTP surface of the app, in one place.
///
/// Nothing else in the app talks to the network, which is what keeps the views
/// and the sync engine testable and offline-aware.
actor APIClient {
    enum Method: String {
        case get = "GET"
        case post = "POST"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    private var baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var token: String?

    /// Told `true` whenever the server answers at all (even with 4xx/5xx) and
    /// `false` when the request never left the device. Reporting it here means
    /// "online" is decided in one place instead of by every call site.
    private var reachability: (@Sendable (Bool) async -> Void)?

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func setReachabilityHandler(_ handler: (@Sendable (Bool) async -> Void)?) {
        reachability = handler
    }

    func setToken(_ token: String?) {
        self.token = token
    }

    var currentToken: String? { token }

    var currentBaseURL: URL { baseURL }

    /// Point the client at another server (e.g. the Mac's LAN address when the
    /// app runs on a phone). The token is kept: the same identity is valid on
    /// whichever server the user points at.
    func updateBaseURL(_ url: URL) {
        guard url != baseURL else { return }
        baseURL = url
    }

    // MARK: - Transport

    /// Request without a body.
    func send<T: Decodable>(
        _ method: Method,
        _ path: String,
        query: [String: String] = [:],
        authenticated: Bool = true
    ) async throws -> T {
        try await perform(method, path, query: query, bodyData: nil, authenticated: authenticated)
    }

    /// Request with a JSON body.
    func send<T: Decodable, Body: Encodable>(
        _ method: Method,
        _ path: String,
        query: [String: String] = [:],
        body: Body,
        authenticated: Bool = true
    ) async throws -> T {
        let data: Data
        do {
            data = try encoder.encode(body)
        } catch {
            throw APIError.decoding("could not encode request: \(error)")
        }
        return try await perform(method, path, query: query, bodyData: data, authenticated: authenticated)
    }

    private func perform<T: Decodable>(
        _ method: Method,
        _ path: String,
        query: [String: String],
        bodyData: Data?,
        authenticated: Bool
    ) async throws -> T {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.transport("invalid URL for \(path)")
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else {
            throw APIError.transport("invalid URL for \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // The client owns "today": a dinner in Tokyo is dated in Tokyo.
        request.setValue(Date().apiDateString, forHTTPHeaderField: "x-client-date")
        if authenticated {
            guard let token else { throw APIError.notAuthenticated }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        request.httpBody = bodyData

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // Nothing came back at all: wrong address, no Wi-Fi, or the local
            // network permission was refused. The status code below cannot be
            // reached in that case, so it is the only real "offline" signal.
            await reachability?(false)
            throw APIError.transport(error.localizedDescription)
        }
        await reachability?(true)

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("no HTTP response")
        }

        guard (200..<300).contains(http.statusCode) else {
            if let decoded = try? decoder.decode(ServerErrorBody.self, from: data) {
                throw APIError.server(
                    status: http.statusCode,
                    code: decoded.error.code,
                    message: decoded.error.message,
                    violations: decoded.error.details?.violations ?? []
                )
            }
            throw APIError.server(
                status: http.statusCode,
                code: "unknown",
                message: "HTTP \(http.statusCode)",
                violations: []
            )
        }

        if T.self == EmptyResponse.self || data.isEmpty {
            guard let empty = EmptyResponse() as? T else {
                throw APIError.decoding("unexpected empty response for \(path)")
            }
            return empty
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    // MARK: - Identity

    func signIn(deviceId: String, nickname: String?) async throws -> AuthResponse {
        try await send(
            .post,
            "/auth/anonymous",
            body: ["deviceId": deviceId, "nickname": nickname ?? ""],
            authenticated: false
        )
    }

    func me() async throws -> MeResponse {
        try await send(.get, "/me")
    }

    func updateNickname(_ nickname: String) async throws -> User {
        struct Response: Decodable { var user: User }
        let response: Response = try await send(.patch, "/me", body: ["nickname": nickname])
        return response.user
    }

    // MARK: - Ledgers

    func listLedgers() async throws -> [Ledger] {
        struct Response: Decodable { var ledgers: [Ledger] }
        let response: Response = try await send(.get, "/ledgers")
        return response.ledgers
    }

    func createLedger(name: String, currency: String = "CNY") async throws -> LedgerDetailResponse {
        try await send(.post, "/ledgers", body: ["name": name, "currency": currency])
    }

    func joinLedger(inviteCode: String) async throws -> LedgerDetailResponse {
        try await send(.post, "/ledgers/join", body: ["inviteCode": inviteCode])
    }

    func ledgerDetail(_ ledgerId: String) async throws -> LedgerDetailResponse {
        try await send(.get, "/ledgers/\(ledgerId)")
    }

    func renameLedger(_ ledgerId: String, name: String) async throws -> Ledger {
        struct Response: Decodable { var ledger: Ledger }
        let response: Response = try await send(.patch, "/ledgers/\(ledgerId)", body: ["name": name])
        return response.ledger
    }

    func rotateInviteCode(_ ledgerId: String) async throws -> InviteCodeResponse {
        try await send(.post, "/ledgers/\(ledgerId)/invite-code/rotate")
    }

    func removeMember(_ ledgerId: String, userId: String) async throws -> [LedgerMember] {
        struct Response: Decodable { var members: [LedgerMember] }
        let response: Response = try await send(.delete, "/ledgers/\(ledgerId)/members/\(userId)")
        return response.members
    }

    // MARK: - Expenses

    func listExpenses(
        ledgerId: String,
        from: String? = nil,
        to: String? = nil,
        limit: Int = 200
    ) async throws -> [Expense] {
        struct Response: Decodable { var expenses: [Expense] }
        var query: [String: String] = ["limit": String(limit)]
        if let from { query["from"] = from }
        if let to { query["to"] = to }
        let response: Response = try await send(.get, "/ledgers/\(ledgerId)/expenses", query: query)
        return response.expenses
    }

    func createExpense(
        ledgerId: String,
        payload: ExpensePayload,
        clientMutationId: String
    ) async throws -> Expense {
        struct Response: Decodable { var expense: Expense }
        let response: Response = try await send(
            .post,
            "/ledgers/\(ledgerId)/expenses",
            body: CreateExpenseBody(
                expense: payload,
                clientMutationId: clientMutationId,
                today: Date().apiDateString
            )
        )
        return response.expense
    }

    func updateExpense(
        ledgerId: String,
        expenseId: String,
        payload: ExpensePayload,
        expectedRevision: Int?
    ) async throws -> Expense {
        struct Response: Decodable { var expense: Expense }
        let response: Response = try await send(
            .patch,
            "/ledgers/\(ledgerId)/expenses/\(expenseId)",
            body: UpdateExpenseBody(
                expense: payload,
                expectedRevision: expectedRevision,
                today: Date().apiDateString
            )
        )
        return response.expense
    }

    func deleteExpense(ledgerId: String, expenseId: String, expectedRevision: Int?) async throws {
        var query: [String: String] = [:]
        if let expectedRevision { query["expectedRevision"] = String(expectedRevision) }
        let _: EmptyResponse = try await send(
            .delete,
            "/ledgers/\(ledgerId)/expenses/\(expenseId)",
            query: query
        )
    }

    // MARK: - Agent

    func interpret(
        ledgerId: String,
        text: String,
        source: String,
        pendingDraft: DraftState?
    ) async throws -> Interpretation {
        try await send(
            .post,
            "/ledgers/\(ledgerId)/agent/interpret",
            body: InterpretBody(
                text: text,
                source: source,
                pendingDraft: pendingDraft,
                today: Date().apiDateString
            )
        )
    }

    // MARK: - Statistics & sync

    func stats(
        ledgerId: String,
        range: String,
        from: String? = nil,
        to: String? = nil
    ) async throws -> LedgerStats {
        struct Response: Decodable { var stats: LedgerStats }
        var query: [String: String] = ["range": range]
        if let from { query["from"] = from }
        if let to { query["to"] = to }
        let response: Response = try await send(.get, "/ledgers/\(ledgerId)/stats", query: query)
        return response.stats
    }

    func balances(ledgerId: String, range: String = "all") async throws -> LedgerBalances {
        struct Response: Decodable { var balances: LedgerBalances }
        let response: Response = try await send(
            .get,
            "/ledgers/\(ledgerId)/balances",
            query: ["range": range]
        )
        return response.balances
    }

    func changes(ledgerId: String, since: Int, limit: Int = 500) async throws -> SyncChanges {
        try await send(
            .get,
            "/ledgers/\(ledgerId)/sync",
            query: ["since": String(since), "limit": String(limit)]
        )
    }

    func health() async throws -> Bool {
        struct Response: Decodable { var ok: Bool }
        let response: Response = try await send(.get, "/health", authenticated: false)
        return response.ok
    }
}
