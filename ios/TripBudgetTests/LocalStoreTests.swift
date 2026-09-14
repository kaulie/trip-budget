import XCTest
@testable import TripBudget

/// The offline half of the app: local cache and the outbox that makes a save
/// survive a dead network without ever double-booking it.
final class LocalStoreTests: XCTestCase {
    private var directory: URL!
    private var store: LocalStore!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TripBudgetTests-\(UUID().uuidString)")
        store = LocalStore(directory: directory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeLedger() -> Ledger {
        Ledger(
            id: "ledger-1",
            name: "日本旅行",
            currency: "CNY",
            ownerId: "u0",
            inviteCode: "TRIP-8F3K2",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            deletedAt: nil,
            revision: 3
        )
    }

    func testSessionRoundTrip() {
        XCTAssertNil(store.session)
        let session = Session(
            userId: "u0",
            nickname: "小林",
            token: "token-1",
            deviceId: "device-1",
            currentLedgerId: "ledger-1"
        )
        store.session = session
        XCTAssertEqual(store.session?.nickname, "小林")
        XCTAssertEqual(store.session?.currentLedgerId, "ledger-1")

        store.session = nil
        XCTAssertNil(store.session)
    }

    func testLedgerSnapshotRoundTrip() {
        let expense = Expense(
            id: "e1",
            ledgerId: "ledger-1",
            type: .expense,
            amountCents: 50000,
            currency: "CNY",
            categoryId: "c1",
            categoryKey: "food",
            date: "2026-09-14",
            note: "吃饭",
            paidBy: "u0",
            shares: [
                ExpenseShare(userId: "u0", amountCents: 16667),
                ExpenseShare(userId: "u1", amountCents: 16667),
                ExpenseShare(userId: "u2", amountCents: 16666),
            ],
            createdBy: "u0",
            createdAt: "2026-09-14T10:00:00.000Z",
            updatedAt: "2026-09-14T10:00:00.000Z",
            deletedAt: nil,
            revision: 4,
            source: .voice,
            rawUtterance: "我付了 500，我们三个人吃饭",
            clientMutationId: "m1",
            shareMode: .equal
        )

        store.saveLedger(
            CachedLedger(
                ledger: makeLedger(),
                members: [],
                categories: [],
                expenses: [expense],
                cursor: 9,
                savedAt: Date()
            )
        )

        let loaded = store.ledger("ledger-1")
        XCTAssertEqual(loaded?.cursor, 9)
        XCTAssertEqual(loaded?.expenses.first?.amountCents, 50000)
        XCTAssertEqual(loaded?.expenses.first?.shares.count, 3)
        XCTAssertEqual(loaded?.expenses.first?.shareTotalCents, 50000)
        XCTAssertEqual(store.ledgerIds(), ["ledger-1"])

        store.removeLedger("ledger-1")
        XCTAssertNil(store.ledger("ledger-1"))
    }

    func testOutboxRoundTripKeepsTheIdempotencyKey() {
        let payload = ExpensePayload(
            type: .expense,
            amountCents: 12800,
            currency: "CNY",
            categoryKey: "food",
            date: "2026-09-14",
            note: "晚饭",
            paidBy: "u0",
            shareMode: .equal,
            shares: [ExpenseShare(userId: "u0", amountCents: 12800)],
            source: .voice,
            rawUtterance: nil
        )
        let mutation = PendingMutation(
            id: "mutation-1",
            kind: .create,
            ledgerId: "ledger-1",
            expenseId: nil,
            payload: payload,
            expectedRevision: nil,
            createdAt: Date()
        )
        store.savePendingMutations([mutation])

        let loaded = store.pendingMutations()
        XCTAssertEqual(loaded.count, 1)
        // The id doubles as clientMutationId, which is what makes replay safe.
        XCTAssertEqual(loaded.first?.id, "mutation-1")
        XCTAssertEqual(loaded.first?.displayAmountCents, 12800)
        XCTAssertEqual(loaded.first?.kind, .create)
    }

    func testExpenseOrderingIsNewestFirst() {
        func expense(_ id: String, date: String, createdAt: String) -> Expense {
            Expense(
                id: id, ledgerId: "l", type: .expense, amountCents: 100, currency: "CNY",
                categoryId: "c", categoryKey: "food", date: date, note: "", paidBy: "u0",
                shares: [ExpenseShare(userId: "u0", amountCents: 100)], createdBy: "u0",
                createdAt: createdAt, updatedAt: createdAt, deletedAt: nil, revision: 1,
                source: .text, rawUtterance: nil, clientMutationId: nil, shareMode: .equal
            )
        }
        let items = [
            expense("a", date: "2026-09-12", createdAt: "2026-09-12T10:00:00.000Z"),
            expense("b", date: "2026-09-14", createdAt: "2026-09-14T09:00:00.000Z"),
            expense("c", date: "2026-09-14", createdAt: "2026-09-14T20:00:00.000Z"),
        ].sorted(by: Expense.ordering)

        XCTAssertEqual(items.map(\.id), ["c", "b", "a"])
    }
}
