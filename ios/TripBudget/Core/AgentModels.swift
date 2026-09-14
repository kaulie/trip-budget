import Foundation

// MARK: - Responses

struct AuthResponse: Decodable {
    var token: String
    var user: User
    var created: Bool?
}

struct MeResponse: Decodable {
    var user: User
    var ledgers: [Ledger]
}

struct LedgerDetailResponse: Decodable {
    var ledger: Ledger
    var member: LedgerMember?
    var members: [LedgerMember]?
    var categories: [Category]?
    var revision: Int?
    var expenseCount: Int?
    var shareText: String?
}

struct InviteCodeResponse: Decodable {
    var ledger: Ledger
    var shareText: String
}

// MARK: - Requests

struct CreateExpenseBody: Encodable {
    var expense: ExpensePayload
    var clientMutationId: String
    var today: String
}

struct UpdateExpenseBody: Encodable {
    var expense: ExpensePayload
    var expectedRevision: Int?
    var today: String
}

struct InterpretBody: Encodable {
    var text: String
    var source: String
    var pendingDraft: DraftState?
    var today: String
}

/// Exactly what the confirmation screen approved, posted back for the server to
/// validate again before it is stored.
struct ExpensePayload: Codable, Hashable {
    var type: ExpenseType
    var amountCents: Int
    var currency: String
    var categoryKey: String
    var date: String
    var note: String
    var paidBy: String
    var shareMode: Expense.ShareMode
    var shares: [ExpenseShare]
    var source: Expense.Source
    var rawUtterance: String?
}

// MARK: - Agent

/// The pending draft the user is looking at. It is echoed back verbatim when the
/// user refines it ("小李不算，改成我和小王平摊"), so the agent never has to
/// re-interpret the whole sentence.
struct DraftState: Codable, Hashable {
    struct Participant: Codable, Hashable, Identifiable {
        var userId: String
        var weight: Double?
        var amountCents: Int?

        var id: String { userId }
    }

    var type: ExpenseType
    var amountCents: Int?
    var currency: String
    var categoryKey: String?
    var date: String?
    var note: String
    var paidBy: String?
    var shareMode: Expense.ShareMode
    var participants: [Participant]
    /// Echoed back for display; the server returns it alongside the draft.
    var rawUtterance: String?
}

struct PreviewShare: Codable, Hashable, Identifiable {
    var userId: String
    var nickname: String
    var amountCents: Int

    var id: String { userId }
}

struct PreviewPerson: Codable, Hashable {
    var userId: String
    var nickname: String
}

/// What the confirmation screen renders: the parsed expense *after* the server
/// validated it, with names resolved and shares already rounded.
struct AgentPreview: Codable, Hashable {
    var type: ExpenseType
    var amountCents: Int
    var currency: String
    var categoryKey: String
    var categoryName: String
    var categoryIcon: String
    var date: String
    var note: String
    var paidBy: PreviewPerson
    var shareMode: Expense.ShareMode
    var shares: [PreviewShare]
    var source: Expense.Source
    var rawUtterance: String?

    var shareTotalCents: Int { shares.reduce(0) { $0 + $1.amountCents } }
}

struct Interpretation: Decodable, Hashable {
    enum Action: String, Decodable, Hashable {
        case createExpense = "create_expense"
        case updateDraft = "update_draft"
        case ask
        case unknown
    }

    var action: Action
    var parser: String
    var llmError: String?
    var ready: Bool
    var draft: DraftState
    var preview: AgentPreview?
    var expense: ExpensePayload?
    var warnings: [RuleViolation]
    var violations: [RuleViolation]
    var questions: [String]
    var assistantMessage: String
    var notes: [String]
    var members: [LedgerMember]?

    /// The banner text above the draft card, in priority order.
    var statusMessage: String {
        if !questions.isEmpty { return questions[0] }
        if !violations.isEmpty { return violations[0].message }
        if !assistantMessage.isEmpty { return assistantMessage }
        return ""
    }

    var needsUserInput: Bool { !ready }
}
