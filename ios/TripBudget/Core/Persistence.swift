import Foundation

/// The anonymous identity as stored on the device.
struct Session: Codable {
    var userId: String
    var nickname: String
    var token: String
    var deviceId: String
    var currentLedgerId: String?
}

/// Last known state of one ledger, so the app opens with content instead of a spinner.
struct CachedLedger: Codable {
    var ledger: Ledger
    var members: [LedgerMember]
    var categories: [Category]
    var expenses: [Expense]
    var cursor: Int
    var savedAt: Date
}

/// A write that has not reached the server yet.
///
/// `id` doubles as the `clientMutationId`, which is what makes replaying it safe:
/// the server deduplicates on that key, so a retry can never book the same
/// expense twice.
struct PendingMutation: Codable, Identifiable {
    enum Kind: String, Codable {
        case create
        case update
        case delete
    }

    var id: String
    var kind: Kind
    var ledgerId: String
    var expenseId: String?
    var payload: ExpensePayload?
    var expectedRevision: Int?
    var createdAt: Date

    var displayAmountCents: Int { payload?.amountCents ?? 0 }
}

/// File-backed local storage: one JSON file per concern, no database to migrate.
///
/// The app must be usable on a plane, so everything the user sees is read from
/// here first and refreshed from the network afterwards.
final class LocalStore {
    private let directory: URL
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TripBudget", isDirectory: true)
        self.directory = base
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    private func url(_ name: String) -> URL {
        directory.appendingPathComponent(name)
    }

    private func read<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        guard let data = try? Data(contentsOf: url(name)) else { return nil }
        return try? decoder.decode(type, from: data)
    }

    private func write<T: Encodable>(_ value: T?, to name: String) {
        guard let value else {
            try? FileManager.default.removeItem(at: url(name))
            return
        }
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: url(name), options: .atomic)
    }

    // MARK: - Session

    var session: Session? {
        get { read(Session.self, from: "session.json") }
        set { write(newValue, to: "session.json") }
    }

    // MARK: - Ledgers

    func ledger(_ id: String) -> CachedLedger? {
        read(CachedLedger.self, from: "ledger-\(id).json")
    }

    func saveLedger(_ cache: CachedLedger) {
        write(cache, to: "ledger-\(cache.ledger.id).json")
    }

    func ledgerIds() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return files.compactMap { file -> String? in
            guard file.hasPrefix("ledger-"), file.hasSuffix(".json") else { return nil }
            return String(file.dropFirst("ledger-".count).dropLast(".json".count))
        }
    }

    func removeLedger(_ id: String) {
        try? FileManager.default.removeItem(at: url("ledger-\(id).json"))
    }

    /// Used by UI tests to start from a clean slate.
    func wipeAll() {
        for id in ledgerIds() { removeLedger(id) }
        session = nil
        serverURL = nil
        savePendingMutations([])
    }

    // MARK: - Server

    /// A server address the user picked on this device.
    ///
    /// On a physical phone "localhost" means the phone itself, so the Mac that
    /// runs the dev server has to be named by its LAN address. Baking that into
    /// the build would be wrong the moment the Mac joins another Wi-Fi, so the
    /// choice made in the app wins over everything else and sticks.
    var serverURL: String? {
        get { read(String.self, from: "server.json") }
        set { write(newValue, to: "server.json") }
    }

    // MARK: - Outbox

    func pendingMutations() -> [PendingMutation] {
        read([PendingMutation].self, from: "pending.json") ?? []
    }

    func savePendingMutations(_ mutations: [PendingMutation]) {
        write(mutations, to: "pending.json")
    }
}
