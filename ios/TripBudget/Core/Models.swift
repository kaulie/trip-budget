import Foundation

// MARK: - Identity

/// Anonymous identity: a device-scoped account with a nickname.
/// No phone number, no email, no password — but `id` is a stable identity that a
/// real account system could later attach to.
struct User: Codable, Identifiable, Hashable {
    let id: String
    var nickname: String
    var deviceId: String?
    var createdAt: String?
    var updatedAt: String?
}

// MARK: - Ledger

struct Ledger: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var currency: String
    var ownerId: String
    var inviteCode: String
    var createdAt: String?
    var updatedAt: String?
    var deletedAt: String?
    var revision: Int
}

struct LedgerMember: Codable, Identifiable, Hashable {
    let id: String
    var ledgerId: String
    var userId: String
    var role: Role
    var joinedAt: String
    var removedAt: String?
    var nickname: String

    enum Role: String, Codable {
        case owner
        case member

        var label: String { self == .owner ? "创建者" : "成员" }
    }

    var isRemoved: Bool { removedAt != nil }
}

struct Category: Codable, Identifiable, Hashable {
    let id: String
    var ledgerId: String?
    var key: String
    var name: String
    /// SF Symbol name, supplied by the server so categories stay data, not UI.
    var icon: String
    var kind: Kind
    var sortOrder: Int
    var isArchived: Bool

    enum Kind: String, Codable {
        case expense
        case income
        case both

        var label: String {
            switch self {
            case .expense: return "支出"
            case .income: return "收入"
            case .both: return "收入/支出"
            }
        }
    }
}

// MARK: - Expense

/// One participant's share of a cost. Note this is *not* the same thing as who paid.
struct ExpenseShare: Codable, Hashable {
    var userId: String
    var amountCents: Int
}

/// Whether money left or entered the ledger. The amount itself is always
/// positive; the type carries the sign.
enum ExpenseType: String, Codable, Hashable {
    case expense
    case income

    var isIncome: Bool { self == .income }
    var chineseLabel: String { isIncome ? "收入" : "支出" }
}

struct Expense: Codable, Identifiable, Hashable {
    let id: String
    var ledgerId: String
    var type: ExpenseType
    var amountCents: Int
    var currency: String
    var categoryId: String
    var categoryKey: String
    var date: String
    var note: String
    /// Who actually handed over the money.
    var paidBy: String
    /// Who ultimately bears the cost. Always sums to `amountCents`.
    var shares: [ExpenseShare]
    var createdBy: String
    var createdAt: String
    var updatedAt: String
    var deletedAt: String?
    var revision: Int
    var source: Source
    var rawUtterance: String?
    var clientMutationId: String?
    var shareMode: ShareMode

    enum Source: String, Codable {
        case voice
        case text
        case manual
        case agent
    }

    enum ShareMode: String, Codable {
        case equal
        case weights
        case amounts

        var label: String {
            switch self {
            case .equal: return "平均分摊"
            case .weights: return "按比例分摊"
            case .amounts: return "指定金额"
            }
        }
    }

    var isDeleted: Bool { deletedAt != nil }

    var shareTotalCents: Int { shares.reduce(0) { $0 + $1.amountCents } }

    var isBalanced: Bool { shareTotalCents == amountCents }

    func share(for userId: String) -> ExpenseShare? {
        shares.first { $0.userId == userId }
    }
}

// MARK: - Statistics

struct MemberAggregate: Codable, Identifiable, Hashable {
    var userId: String
    var nickname: String
    /// What this member actually handed over.
    var paidCents: Int
    /// What this member ultimately bears.
    var shareCents: Int
    /// paid - share. Positive => the ledger owes them.
    var netCents: Int
    var expenseCents: Int?
    var incomeCents: Int?

    var id: String { userId }

    var netDescription: String {
        if netCents == 0 { return "已结清" }
        return netCents > 0 ? "应收 \(Money.symbol(netCents))" : "应付 \(Money.symbol(-netCents))"
    }
}

struct SettlementEdge: Codable, Hashable, Identifiable {
    var fromUserId: String
    var toUserId: String
    var amountCents: Int

    var id: String { "\(fromUserId)->\(toUserId)" }
}

struct LedgerBalances: Codable {
    var members: [MemberAggregate]
    var settlements: [SettlementEdge]
}

struct CategoryTotal: Codable, Identifiable, Hashable {
    var categoryId: String
    var categoryKey: String
    var name: String
    var icon: String
    var amountCents: Int
    var count: Int
    var ratio: Double

    var id: String { categoryKey }

    var percentText: String { String(format: "%.0f%%", ratio * 100) }
}

struct DailyTotal: Codable, Identifiable, Hashable {
    var date: String
    var expenseCents: Int
    var incomeCents: Int

    var id: String { date }
}

struct LedgerStats: Codable {
    var from: String
    var to: String
    var currency: String
    var totalExpenseCents: Int
    var totalIncomeCents: Int
    var netCents: Int
    var expenseCount: Int
    var incomeCount: Int
    var byCategory: [CategoryTotal]
    var byMember: [MemberAggregate]
    var daily: [DailyTotal]
}

// MARK: - Sync

struct SyncChanges: Codable {
    var cursor: Int
    var serverRevision: Int
    var hasMore: Bool
    var ledger: Ledger?
    var members: [LedgerMember]
    var categories: [Category]
    var expenses: [Expense]
}

extension Expense {
    /// Newest first: by expense date, then by when it was written down.
    /// `createdAt` is an ISO-8601 string, so lexicographic order is chronological.
    static func ordering(_ lhs: Expense, _ rhs: Expense) -> Bool {
        if lhs.date != rhs.date { return lhs.date > rhs.date }
        return lhs.createdAt > rhs.createdAt
    }
}
