import Foundation

/// Money is never a `Double` in this app.
///
/// Amounts travel and are stored as integer minor units (cents / 分) all the way
/// from the database to the screen, which is why a ¥500 three-way split renders
/// as 166.67 / 166.67 / 166.66 and still adds up to exactly 500.
enum Money {
    static let centsPerUnit = 100

    static func from(cents: Int) -> Decimal {
        Decimal(cents) / Decimal(centsPerUnit)
    }

    /// `16667` -> `"166.67"`
    static func plain(_ cents: Int, currency: String = "CNY") -> String {
        let sign = cents < 0 ? "-" : ""
        let abs = Swift.abs(cents)
        let whole = abs / centsPerUnit
        let frac = abs % centsPerUnit
        return "\(sign)\(whole).\(String(format: "%02d", frac))"
    }

    /// `16667` -> `"¥166.67"`
    static func symbol(_ cents: Int, currency: String = "CNY") -> String {
        "\(currencySymbol(currency))\(plain(cents, currency: currency))"
    }

    /// Compact form for list rows: `¥166` when there is nothing after the point.
    static func compact(_ cents: Int, currency: String = "CNY") -> String {
        cents % centsPerUnit == 0
            ? "\(currencySymbol(currency))\(cents / centsPerUnit)"
            : symbol(cents, currency: currency)
    }

    static func currencySymbol(_ currency: String) -> String {
        switch currency.uppercased() {
        case "CNY": return "¥"
        case "USD": return "$"
        case "EUR": return "€"
        case "JPY": return "¥"
        default: return ""
        }
    }

    /// Parse what a person typed into the amount field.
    static func cents(fromUserInput input: String) -> Int? {
        let cleaned = input
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "¥", with: "")
            .replacingOccurrences(of: "￥", with: "")
            .replacingOccurrences(of: " ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let value = Decimal(string: cleaned) else { return nil }
        let scaled = value * Decimal(centsPerUnit)
        var rounded = Decimal()
        var raw = scaled
        NSDecimalRound(&rounded, &raw, 0, .plain)
        let number = NSDecimalNumber(decimal: rounded)
        guard number != .notANumber else { return nil }
        let intValue = number.intValue
        return intValue > 0 ? intValue : nil
    }
}

extension Int {
    var moneyPlain: String { Money.plain(self) }
    var moneySymbol: String { Money.symbol(self) }
    var moneyCompact: String { Money.compact(self) }
}

extension Date {
    /// The API speaks in local calendar dates (`YYYY-MM-DD`), never timestamps —
    /// a dinner in Tokyo is dated in Tokyo even if you type it up in Beijing.
    static let apiDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    var apiDateString: String { Date.apiDateFormatter.string(from: self) }

    static func apiDate(_ value: String) -> Date? {
        apiDateFormatter.date(from: value)
    }

    /// "昨天" / "9月14日" — how a person would say the date out loud.
    var friendlyChineseDate: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) { return "今天" }
        if calendar.isDateInYesterday(self) { return "昨天" }
        if calendar.isDateInTomorrow(self) { return "明天" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = calendar
        formatter.dateFormat = calendar.component(.year, from: self) == calendar.component(.year, from: Date())
            ? "M月d日"
            : "yyyy年M月d日"
        formatter.timeZone = .current
        return formatter.string(from: self)
    }
}
