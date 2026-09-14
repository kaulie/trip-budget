import Foundation
import Observation

/// Everything the UI needs, in one observable object.
///
/// It is deliberately the only place that knows about the network, the local
/// cache and the outbox, so the views stay declarative and testable.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case onboarding
        case ready
    }

    // MARK: Identity
    private(set) var phase: Phase = .launching
    private(set) var user: User?
    private(set) var deviceId: String = ""

    // MARK: Ledger data
    private(set) var ledgers: [Ledger] = []
    private(set) var currentLedgerId: String?
    private(set) var members: [LedgerMember] = []
    private(set) var categories: [Category] = []
    private(set) var expenses: [Expense] = []
    private(set) var stats: LedgerStats?
    private(set) var balances: LedgerBalances?
    private(set) var pendingMutations: [PendingMutation] = []

    // MARK: Status
    private(set) var isBusy = false
    private(set) var lastSyncedAt: Date?
    private(set) var isOffline = false
    var errorMessage: String?
    var infoMessage: String?

    private var api: APIClient
    private let store: LocalStore
    private var cursor = 0
    private var token: String?

    /// The address the app is talking to right now (see `defaultBaseURL`).
    private(set) var baseURL: URL

    init(api: APIClient? = nil, store: LocalStore = LocalStore()) {
        self.store = store
        let base = AppModel.resolvedBaseURL(store: store)
        self.baseURL = base
        self.api = api ?? APIClient(baseURL: base)
        // UI tests need a deterministic first-run experience.
        if ProcessInfo.processInfo.arguments.contains("-uitest-reset") {
            self.store.wipeAll()
        }
    }

    /// Where the API lives.
    ///
    /// Resolution order:
    ///   1. the address the user typed in the app (stored on the device) — this
    ///      is what makes a phone work on any Wi-Fi without a rebuild;
    ///   2. `TRIP_BUDGET_API` environment variable — set by the Xcode scheme, or
    ///      by `devicectl device process launch --environment`;
    ///   3. `TRIP_BUDGET_API` in Info.plist — baked at build time for a device
    ///      build, where "localhost" would mean the phone itself;
    ///   4. Loopback, which is what the Simulator needs.
    static var defaultBaseURL: URL {
        if let raw = ProcessInfo.processInfo.environment["TRIP_BUDGET_API"],
           let url = URL(string: raw) {
            return url
        }
        #if targetEnvironment(simulator)
        // The Simulator shares the Mac's network stack, so loopback is right and
        // a LAN address baked for a device would only add a way to break the
        // machine that does not need it.
        return URL(string: "http://127.0.0.1:4000")!
        #else
        if let raw = Bundle.main.object(forInfoDictionaryKey: "TRIP_BUDGET_API") as? String,
           !raw.trimmingCharacters(in: .whitespaces).isEmpty,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "http://127.0.0.1:4000")!
        #endif
    }

    /// The device's own choice wins over everything a build could bake in.
    static func resolvedBaseURL(store: LocalStore) -> URL {
        if let raw = store.serverURL,
           let url = normalizedBaseURL(raw) {
            return url
        }
        return defaultBaseURL
    }

    /// Accepts what a person actually types ("192.168.1.20:4000") as well as a
    /// full URL, and refuses anything that is not an http(s) address.
    static func normalizedBaseURL(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            text = "http://" + text
        }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else {
            return nil
        }
        while components.path.hasSuffix("/") { components.path = String(components.path.dropLast()) }
        return components.url
    }

    /// Point the app at a different server and reconnect. This is how a phone
    /// stops talking to itself and starts talking to the Mac on the same Wi-Fi.
    @discardableResult
    func updateServerURL(_ raw: String) async -> Bool {
        guard let url = AppModel.normalizedBaseURL(raw) else {
            errorMessage = "服务器地址要写成主机:端口，例如 192.168.1.20:4000"
            return false
        }
        store.serverURL = url.absoluteString
        baseURL = url
        await api.updateBaseURL(url)
        infoMessage = "已切换到 \(url.absoluteString)"
        await refreshAll()
        return true
    }

    // MARK: - Derived

    var currentLedger: Ledger? {
        ledgers.first { $0.id == currentLedgerId }
    }

    var myUserId: String? { user?.id }

    var memberNames: [String: String] {
        Dictionary(uniqueKeysWithValues: members.map { ($0.userId, $0.nickname) })
    }

    func name(of userId: String) -> String {
        if userId == user?.id { return "我" }
        return memberNames[userId] ?? "未知成员"
    }

    func category(forKey key: String) -> Category? {
        categories.first { $0.key == key }
    }

    func category(forId id: String) -> Category? {
        categories.first { $0.id == id } ?? categories.first { $0.key == id }
    }

    var recentExpenses: [Expense] {
        Array(expenses.filter { !$0.isDeleted }.prefix(8))
    }

    /// "本月总支出" — what the home screen shows in the headline card.
    var thisMonthExpenseCents: Int {
        let prefix = Date().apiDateString.prefix(7)
        return expenses
            .filter { !$0.isDeleted && $0.type == .expense && $0.date.hasPrefix(prefix) }
            .reduce(0) { $0 + $1.amountCents }
    }

    var todayExpenseCents: Int {
        let today = Date().apiDateString
        return expenses
            .filter { !$0.isDeleted && $0.type == .expense && $0.date == today }
            .reduce(0) { $0 + $1.amountCents }
    }

    var hasPendingWork: Bool { !pendingMutations.isEmpty }

    private func makeMutationId() -> String { UUID().uuidString }

    // MARK: - Bootstrap

    /// Restore identity and the last known ledger from disk, then refresh.
    func bootstrap() async {
        await observeReachability()
        deviceId = store.session?.deviceId ?? Self.persistedDeviceId()
        pendingMutations = store.pendingMutations()

        guard let session = store.session else {
            phase = .onboarding
            return
        }

        user = User(id: session.userId, nickname: session.nickname, deviceId: session.deviceId, createdAt: nil, updatedAt: nil)
        currentLedgerId = session.currentLedgerId
        token = session.token
        await api.setToken(session.token)

        if let ledgerId = session.currentLedgerId, let cached = store.ledger(ledgerId) {
            apply(cached)
        }

        phase = .ready
        await refreshAll()
    }

    /// Connectivity comes from the transport, not from whichever call site
    /// remembered to update it: a request that answers means online, a request
    /// that never leaves the device means offline.
    private func observeReachability() async {
        await api.setReachabilityHandler { [weak self] online in
            await MainActor.run { self?.isOffline = !online }
        }
    }

    private static func persistedDeviceId() -> String {
        let key = "trip-budget.device-id"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let created = UUID().uuidString
        UserDefaults.standard.set(created, forKey: key)
        return created
    }

    /// The only "sign up" this app has: pick a nickname on first launch.
    func completeOnboarding(nickname: String) async {
        let trimmed = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let auth = try await api.signIn(deviceId: deviceId, nickname: trimmed)
            await api.setToken(auth.token)
            token = auth.token
            user = auth.user
            ledgers = try await api.listLedgers()
            store.session = Session(
                userId: auth.user.id,
                nickname: auth.user.nickname,
                token: auth.token,
                deviceId: deviceId,
                currentLedgerId: currentLedgerId
            )
            phase = .ready
            if let first = ledgers.first { await selectLedger(first.id) }
        } catch {
            present(error)
        }
    }

    func updateNickname(_ nickname: String) async {
        let trimmed = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let updated = try await api.updateNickname(trimmed)
            user = updated
            persistSession()
        } catch {
            present(error)
        }
    }

    private func persistSession() {
        guard let user, let token else { return }
        store.session = Session(
            userId: user.id,
            nickname: user.nickname,
            token: token,
            deviceId: deviceId,
            currentLedgerId: currentLedgerId
        )
    }

    private func present(_ error: Error) {
        if let apiError = error as? APIError {
            errorMessage = apiError.errorDescription
            isOffline = apiError.isRetryableOffline
        } else {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Ledgers

    func refreshAll() async {
        isBusy = true
        defer { isBusy = false }

        await flushPendingMutations()

        do {
            ledgers = try await api.listLedgers()
            isOffline = false
            if let currentLedgerId, ledgers.contains(where: { $0.id == currentLedgerId }) {
                try await loadLedger(currentLedgerId)
            } else if let first = ledgers.first {
                try await loadLedger(first.id)
            } else {
                currentLedgerId = nil
                members = []
                categories = []
                expenses = []
                stats = nil
                balances = nil
            }
            lastSyncedAt = Date()
            persistSession()
        } catch {
            present(error)
        }
    }

    func selectLedger(_ ledgerId: String) async {
        do {
            try await loadLedger(ledgerId)
            persistSession()
        } catch {
            present(error)
        }
    }

    private func loadLedger(_ ledgerId: String) async throws {
        currentLedgerId = ledgerId
        let detail = try await api.ledgerDetail(ledgerId)
        members = detail.members ?? []
        categories = detail.categories ?? []
        cursor = detail.revision ?? 0
        expenses = try await api.listExpenses(ledgerId: ledgerId)
        cacheCurrentLedger()
        await loadStats(range: "month")
        await loadBalances()
    }

    @discardableResult
    func createLedger(name: String) async -> Ledger? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        isBusy = true
        defer { isBusy = false }
        do {
            let response = try await api.createLedger(name: trimmed)
            ledgers = try await api.listLedgers()
            try await loadLedger(response.ledger.id)
            persistSession()
            infoMessage = "账本已创建，把邀请码 \(response.ledger.inviteCode) 发给朋友吧。"
            return response.ledger
        } catch {
            present(error)
            return nil
        }
    }

    @discardableResult
    func joinLedger(inviteCode: String) async -> Ledger? {
        let code = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return nil }
        isBusy = true
        defer { isBusy = false }
        do {
            let response = try await api.joinLedger(inviteCode: code)
            ledgers = try await api.listLedgers()
            try await loadLedger(response.ledger.id)
            persistSession()
            infoMessage = "已加入「\(response.ledger.name)」"
            return response.ledger
        } catch {
            present(error)
            return nil
        }
    }

    func renameCurrentLedger(_ name: String) async {
        guard let ledgerId = currentLedgerId else { return }
        do {
            let updated = try await api.renameLedger(ledgerId, name: name)
            replaceLedger(updated)
        } catch {
            present(error)
        }
    }

    func rotateInviteCode() async {
        guard let ledgerId = currentLedgerId else { return }
        do {
            let response = try await api.rotateInviteCode(ledgerId)
            replaceLedger(response.ledger)
            infoMessage = "已生成新的邀请码，旧邀请码立即失效。"
        } catch {
            present(error)
        }
    }

    func removeMember(_ userId: String) async {
        guard let ledgerId = currentLedgerId else { return }
        do {
            members = try await api.removeMember(ledgerId, userId: userId)
            cacheCurrentLedger()
        } catch {
            present(error)
        }
    }

    private func replaceLedger(_ ledger: Ledger) {
        if let index = ledgers.firstIndex(where: { $0.id == ledger.id }) {
            ledgers[index] = ledger
        } else {
            ledgers.append(ledger)
        }
    }

    private func apply(_ cached: CachedLedger) {
        ledgers = [cached.ledger]
        members = cached.members
        categories = cached.categories
        expenses = cached.expenses
        cursor = cached.cursor
    }

    // MARK: - Statistics & sync

    func loadStats(range: String, from: String? = nil, to: String? = nil) async {
        guard let ledgerId = currentLedgerId else { return }
        stats = try? await api.stats(ledgerId: ledgerId, range: range, from: from, to: to)
    }

    func loadBalances() async {
        guard let ledgerId = currentLedgerId else { return }
        balances = try? await api.balances(ledgerId: ledgerId, range: "all")
    }

    /// Incremental pull. Cheap enough to run every time the app becomes active,
    /// and it is what makes a second device see the first one's expenses without
    /// anyone pressing refresh.
    func sync() async {
        guard let ledgerId = currentLedgerId else {
            // Nothing to pull yet — but "立即同步" is also the retry button, so
            // re-read the ledger list instead of silently doing nothing.
            await refreshAll()
            return
        }
        do {
            var changes = try await api.changes(ledgerId: ledgerId, since: cursor)
            merge(changes)
            var guardCounter = 0
            while changes.hasMore, guardCounter < 20 {
                changes = try await api.changes(ledgerId: ledgerId, since: cursor)
                merge(changes)
                guardCounter += 1
            }
            isOffline = false
            lastSyncedAt = Date()
            cacheCurrentLedger()
        } catch let error as APIError where error.isRetryableOffline {
            // Offline is a normal state here, not something to shout about.
            isOffline = true
        } catch {
            present(error)
        }
    }

    private func merge(_ changes: SyncChanges) {
        if let ledger = changes.ledger {
            replaceLedger(ledger)
        }
        for member in changes.members {
            if let index = members.firstIndex(where: { $0.id == member.id }) {
                members[index] = member
            } else {
                members.append(member)
            }
        }
        members.removeAll { $0.isRemoved }
        for category in changes.categories {
            if let index = categories.firstIndex(where: { $0.id == category.id }) {
                categories[index] = category
            } else {
                categories.append(category)
            }
        }
        for expense in changes.expenses {
            upsert(expense)
        }
        cursor = max(cursor, changes.cursor)
        expenses.sort(by: Expense.ordering)
    }

    /// Last write wins by revision; a tombstone drops the row from the visible list.
    private func upsert(_ expense: Expense) {
        guard let index = expenses.firstIndex(where: { $0.id == expense.id }) else {
            if !expense.isDeleted { expenses.append(expense) }
            return
        }
        guard expense.revision >= expenses[index].revision else { return }
        if expense.isDeleted {
            expenses.remove(at: index)
        } else {
            expenses[index] = expense
        }
    }

    // MARK: - Capture

    /// Send an utterance to the in-app accounting agent.
    func interpret(
        text: String,
        source: Expense.Source,
        pendingDraft: DraftState?
    ) async throws -> Interpretation {
        guard let ledgerId = currentLedgerId else { throw APIError.notAuthenticated }
        return try await api.interpret(
            ledgerId: ledgerId,
            text: text,
            source: source.rawValue,
            pendingDraft: pendingDraft
        )
    }

    private func cacheCurrentLedger() {
        guard let ledger = currentLedger else { return }
        store.saveLedger(
            CachedLedger(
                ledger: ledger,
                members: members,
                categories: categories,
                expenses: expenses,
                cursor: cursor,
                savedAt: Date()
            )
        )
    }

    // MARK: - Writes

    /// Save a confirmed expense. If the network is down the write goes to the
    /// outbox and is replayed later — the user is never blocked by connectivity.
    func save(_ payload: ExpensePayload, clientMutationId: String? = nil) async -> Expense? {
        guard let ledgerId = currentLedgerId else { return nil }
        let mutationId = clientMutationId ?? UUID().uuidString
        do {
            let expense = try await api.createExpense(
                ledgerId: ledgerId,
                payload: payload,
                clientMutationId: mutationId
            )
            upsert(expense)
            expenses.sort(by: Expense.ordering)
            cacheCurrentLedger()
            await loadStats(range: "month")
            await loadBalances()
            return expense
        } catch let error as APIError where error.isRetryableOffline {
            enqueue(
                PendingMutation(
                    id: mutationId,
                    kind: .create,
                    ledgerId: ledgerId,
                    expenseId: nil,
                    payload: payload,
                    expectedRevision: nil,
                    createdAt: Date()
                )
            )
            isOffline = true
            infoMessage = "离线已保存，联网后会自动上传。"
            return nil
        } catch {
            present(error)
            return nil
        }
    }

    func update(_ expense: Expense, payload: ExpensePayload) async -> Expense? {
        guard let ledgerId = currentLedgerId else { return nil }
        do {
            let updated = try await api.updateExpense(
                ledgerId: ledgerId,
                expenseId: expense.id,
                payload: payload,
                expectedRevision: expense.revision
            )
            upsert(updated)
            expenses.sort(by: Expense.ordering)
            cacheCurrentLedger()
            await loadStats(range: "month")
            await loadBalances()
            return updated
        } catch let error as APIError where error.isConflict {
            errorMessage = "这条账目刚刚被其他人改过，已经刷新到最新版本，请再试一次。"
            await sync()
            return nil
        } catch {
            present(error)
            return nil
        }
    }

    func delete(_ expense: Expense) async -> Bool {
        guard let ledgerId = currentLedgerId else { return false }
        do {
            try await api.deleteExpense(
                ledgerId: ledgerId,
                expenseId: expense.id,
                expectedRevision: expense.revision
            )
            expenses.removeAll { $0.id == expense.id }
            cacheCurrentLedger()
            await loadStats(range: "month")
            await loadBalances()
            return true
        } catch let error as APIError where error.isConflict {
            errorMessage = "这条账目刚刚被其他人改过，已经刷新到最新版本，请再试一次。"
            await sync()
            return false
        } catch {
            present(error)
            return false
        }
    }

    // MARK: - Outbox

    private func enqueue(_ mutation: PendingMutation) {
        guard !pendingMutations.contains(where: { $0.id == mutation.id }) else { return }
        pendingMutations.append(mutation)
        store.savePendingMutations(pendingMutations)
    }

    /// Replay queued writes. Safe to call often: the server deduplicates on
    /// `clientMutationId`, so a mutation that already landed is a no-op.
    func flushPendingMutations() async {
        guard !pendingMutations.isEmpty, let ledgerId = currentLedgerId else { return }
        var remaining: [PendingMutation] = []
        for mutation in pendingMutations {
            guard mutation.kind == .create, let payload = mutation.payload, mutation.ledgerId == ledgerId else {
                remaining.append(mutation)
                continue
            }
            do {
                let expense = try await api.createExpense(
                    ledgerId: mutation.ledgerId,
                    payload: payload,
                    clientMutationId: mutation.id
                )
                upsert(expense)
                expenses.sort(by: Expense.ordering)
            } catch let error as APIError where error.isRetryableOffline {
                remaining.append(mutation)
            } catch {
                // The server rejected it outright (e.g. a member left the ledger):
                // surface it instead of retrying forever.
                present(error)
            }
        }
        pendingMutations = remaining
        store.savePendingMutations(remaining)
        if remaining.isEmpty {
            cacheCurrentLedger()
            await loadStats(range: "month")
            await loadBalances()
        }
    }
}
