import XCTest
@testable import TripBudget

/// Decoding the agent's answer is the contract between the server's business
/// rules and this UI, so it is pinned down against a real response payload.
final class DecodingTests: XCTestCase {
    private let interpretationJSON = """
    {
      "action": "create_expense",
      "parser": "rule",
      "llmError": null,
      "ready": true,
      "patch": { "action": "create_expense", "amount": 500 },
      "draft": {
        "type": "expense",
        "amountCents": 50000,
        "currency": "CNY",
        "categoryKey": "food",
        "date": "2026-09-14",
        "note": "吃饭",
        "paidBy": "u0",
        "shareMode": "equal",
        "participants": [
          { "userId": "u0" },
          { "userId": "u1" },
          { "userId": "u2" }
        ],
        "source": "agent",
        "rawUtterance": "我付了 500，我们三个人吃饭"
      },
      "preview": {
        "type": "expense",
        "amountCents": 50000,
        "currency": "CNY",
        "categoryKey": "food",
        "categoryName": "吃饭",
        "categoryIcon": "fork.knife",
        "date": "2026-09-14",
        "note": "吃饭",
        "paidBy": { "userId": "u0", "nickname": "我" },
        "shareMode": "equal",
        "shares": [
          { "userId": "u0", "nickname": "我", "amountCents": 16667 },
          { "userId": "u1", "nickname": "小王", "amountCents": 16667 },
          { "userId": "u2", "nickname": "小李", "amountCents": 16666 }
        ],
        "source": "voice",
        "rawUtterance": "我付了 500，我们三个人吃饭"
      },
      "expense": {
        "type": "expense",
        "amountCents": 50000,
        "currency": "CNY",
        "categoryKey": "food",
        "date": "2026-09-14",
        "note": "吃饭",
        "paidBy": "u0",
        "shareMode": "equal",
        "shares": [
          { "userId": "u0", "amountCents": 16667 },
          { "userId": "u1", "amountCents": 16667 },
          { "userId": "u2", "amountCents": 16666 }
        ],
        "source": "voice",
        "rawUtterance": "我付了 500，我们三个人吃饭"
      },
      "issues": [],
      "warnings": [],
      "violations": [],
      "questions": [],
      "assistantMessage": "好的，支出 ¥500.00，请确认。",
      "notes": []
    }
    """

    func testDecodesAReadyInterpretation() throws {
        let result = try JSONDecoder().decode(Interpretation.self, from: Data(interpretationJSON.utf8))

        XCTAssertTrue(result.ready)
        XCTAssertEqual(result.action, .createExpense)
        XCTAssertEqual(result.parser, "rule")
        XCTAssertEqual(result.preview?.amountCents, 50000)
        XCTAssertEqual(result.preview?.paidBy.nickname, "我")
        XCTAssertEqual(result.preview?.categoryName, "吃饭")
        XCTAssertEqual(result.preview?.shares.map(\.amountCents), [16667, 16667, 16666])
        XCTAssertEqual(result.preview?.shareTotalCents, 50000)
        XCTAssertEqual(result.draft.rawUtterance, "我付了 500，我们三个人吃饭")
        XCTAssertEqual(result.expense?.shares.count, 3)
        XCTAssertFalse(result.needsUserInput)
    }

    func testDecodesAnUnreadyInterpretationWithQuestions() throws {
        let json = """
        {
          "action": "create_expense",
          "parser": "rule",
          "ready": false,
          "draft": {
            "type": "expense", "amountCents": 50000, "currency": "CNY",
            "categoryKey": "food", "date": "2026-09-14", "note": "",
            "paidBy": "u0", "shareMode": "equal",
            "participants": [{ "userId": "u0" }]
          },
          "preview": null,
          "expense": null,
          "issues": [{ "kind": "unknown_person", "message": "账本里找不到成员“小李”，请问分摊人具体是谁？" }],
          "warnings": [],
          "violations": [],
          "questions": ["账本里找不到成员“小李”，请问分摊人具体是谁？"],
          "assistantMessage": "我需要先确认几个信息。",
          "notes": []
        }
        """
        let result = try JSONDecoder().decode(Interpretation.self, from: Data(json.utf8))

        XCTAssertFalse(result.ready)
        XCTAssertTrue(result.needsUserInput)
        XCTAssertNil(result.preview)
        XCTAssertNil(result.expense)
        XCTAssertEqual(result.questions.count, 1)
        XCTAssertTrue(result.statusMessage.contains("小李"))
    }

    func testDecodesAGroupedStatsPayload() throws {
        let json = """
        {
          "from": "2026-09-01", "to": "2026-09-30", "currency": "CNY",
          "totalExpenseCents": 62800, "totalIncomeCents": 0, "netCents": -62800,
          "expenseCount": 2, "incomeCount": 0,
          "byCategory": [
            { "categoryId": "c1", "categoryKey": "food", "name": "吃饭", "icon": "fork.knife",
              "amountCents": 62800, "count": 2, "ratio": 1 }
          ],
          "byMember": [
            { "userId": "u0", "nickname": "我", "paidCents": 62800, "shareCents": 29467, "netCents": 33333 },
            { "userId": "u1", "nickname": "小王", "paidCents": 0, "shareCents": 16667, "netCents": -16667 }
          ],
          "daily": [{ "date": "2026-09-14", "expenseCents": 62800, "incomeCents": 0 }]
        }
        """
        let stats = try JSONDecoder().decode(LedgerStats.self, from: Data(json.utf8))

        XCTAssertEqual(stats.totalExpenseCents, 62800)
        XCTAssertEqual(stats.byCategory.first?.percentText, "100%")
        XCTAssertEqual(stats.byMember.count, 2)
        // paid and borne really are two different numbers for the same person.
        XCTAssertNotEqual(stats.byMember[0].paidCents, stats.byMember[0].shareCents)
        XCTAssertEqual(stats.byMember[1].netDescription, "应付 ¥166.67")
    }
}
