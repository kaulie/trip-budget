import Foundation

/// Splits an amount into integer cents.
///
/// This mirrors the server's largest-remainder rule *exactly*, and it exists for
/// one reason: the confirmation screen has to show the user real numbers as they
/// toggle participants. It is a *proposal* — the server recomputes and validates
/// everything before it is stored, so a drift here can never corrupt data.
enum ShareAllocator {
    /// Extra cents go to the earliest participants, which is why ¥500 three ways
    /// is 166.67 / 166.67 / 166.66 rather than an arbitrary rounding order.
    static func allocate(total: Int, weights: [Double]) -> [Int] {
        guard !weights.isEmpty else { return [] }
        let sign = total < 0 ? -1 : 1
        let absTotal = abs(total)

        var effective = weights
        if effective.reduce(0, +) <= 0 {
            effective = weights.map { _ in 1 }
        }
        let weightSum = effective.reduce(0, +)

        let raw = effective.map { Double(absTotal) * $0 / weightSum }
        var parts = raw.map { Int($0.rounded(.down)) }
        var remainder = absTotal - parts.reduce(0, +)

        let order = raw.enumerated()
            .map { (index: $0.offset, fraction: $0.element - $0.element.rounded(.down), weight: effective[$0.offset]) }
            .sorted { lhs, rhs in
                if lhs.fraction != rhs.fraction { return lhs.fraction > rhs.fraction }
                if lhs.weight != rhs.weight { return lhs.weight > rhs.weight }
                return lhs.index < rhs.index
            }

        var cursor = 0
        while remainder > 0 {
            parts[order[cursor % order.count].index] += 1
            remainder -= 1
            cursor += 1
        }
        return parts.map { $0 * sign }
    }

    static func splitEqually(total: Int, count: Int) -> [Int] {
        guard count > 0 else { return [] }
        return allocate(total: total, weights: Array(repeating: 1, count: count))
    }

    /// Scale per-person amounts so they sum to the total, keeping each as close
    /// as possible to what the user typed.
    static func normalize(amounts: [Int], total: Int) -> [Int] {
        guard !amounts.isEmpty else { return [] }
        let weights = amounts.map { Double(max(0, $0)) }
        let sum = weights.reduce(0, +)
        guard sum > 0 else { return splitEqually(total: total, count: amounts.count) }
        return allocate(total: total, weights: weights)
    }
}
