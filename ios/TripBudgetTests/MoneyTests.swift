import XCTest
@testable import TripBudget

/// The money rules are the ones that must never be wrong — a split that does not
/// add up is the fastest way to lose a user's trust in a shared ledger.
final class MoneyTests: XCTestCase {
    func testParsesWhatPeopleType() {
        XCTAssertEqual(Money.cents(fromUserInput: "128"), 12800)
        XCTAssertEqual(Money.cents(fromUserInput: "128.5"), 12850)
        XCTAssertEqual(Money.cents(fromUserInput: "1,200"), 120000)
        XCTAssertEqual(Money.cents(fromUserInput: "¥300"), 30000)
        XCTAssertEqual(Money.cents(fromUserInput: "0"), nil)
        XCTAssertEqual(Money.cents(fromUserInput: "-5"), nil)
        XCTAssertEqual(Money.cents(fromUserInput: "abc"), nil)
    }

    func testFormatsWithoutFloatingPointDrift() {
        XCTAssertEqual(Money.plain(0), "0.00")
        XCTAssertEqual(Money.plain(5), "0.05")
        XCTAssertEqual(Money.plain(16667), "166.67")
        XCTAssertEqual(Money.plain(16666), "166.66")
        XCTAssertEqual(Money.plain(-250), "-2.50")
        XCTAssertEqual(Money.symbol(50000), "¥500.00")
        XCTAssertEqual(Money.compact(50000), "¥500")
    }

    func testDatesAreLocalCalendarDates() {
        XCTAssertEqual(Date.apiDate("2026-09-14")?.apiDateString, "2026-09-14")
        XCTAssertNil(Date.apiDate("昨天"))
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date())!
        XCTAssertEqual(yesterday.friendlyChineseDate, "昨天")
    }
}

/// The client's allocator is a *proposal* generator, but it must mirror the
/// server's largest-remainder rule or the confirmation screen would show numbers
/// that get rejected on save.
final class ShareAllocatorTests: XCTestCase {
    func testSplitsFiveHundredThreeWaysExactly() {
        let parts = ShareAllocator.splitEqually(total: 50000, count: 3)
        XCTAssertEqual(parts, [16667, 16667, 16666])
        XCTAssertEqual(parts.reduce(0, +), 50000)
    }

    func testNeverLosesACent() {
        for total in stride(from: 1, through: 1000, by: 7) {
            for count in 1...9 {
                let parts = ShareAllocator.splitEqually(total: total, count: count)
                XCTAssertEqual(parts.count, count)
                XCTAssertEqual(parts.reduce(0, +), total, "total \(total) count \(count)")
                XCTAssertTrue(parts.allSatisfy { $0 >= 0 })
                XCTAssertLessThanOrEqual((parts.max() ?? 0) - (parts.min() ?? 0), 1)
            }
        }
    }

    func testHonoursWeights() {
        XCTAssertEqual(ShareAllocator.allocate(total: 90000, weights: [2, 1]), [60000, 30000])
        XCTAssertEqual(ShareAllocator.allocate(total: 100, weights: [1, 1, 1]), [34, 33, 33])
    }

    func testNormaliseMakesAmountsSumToTheTotal() {
        let fixed = ShareAllocator.normalize(amounts: [10000, 10000], total: 30000)
        XCTAssertEqual(fixed.reduce(0, +), 30000)
        XCTAssertEqual(fixed, [15000, 15000])

        let awkward = ShareAllocator.normalize(amounts: [3333, 3333, 3333], total: 10000)
        XCTAssertEqual(awkward.reduce(0, +), 10000)
    }
}
