import SwiftUI

/// One row in any expense list. Shows the two things that matter about a shared
/// expense: who paid, and how it was split.
struct ExpenseRow: View {
    @Environment(AppModel.self) private var model
    let expense: Expense

    var body: some View {
        HStack(spacing: 12) {
            CategoryBadge(
                icon: model.category(forKey: expense.categoryKey)?.icon ?? "tag.fill",
                tint: expense.type.isIncome ? Theme.income : Theme.accent
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 3) {
                AmountText(
                    cents: expense.amountCents,
                    type: expense.type,
                    font: .headline,
                    showSign: true
                )
                if let sharing = sharingSummary {
                    Text(sharing)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    private var title: String {
        let category = model.category(forKey: expense.categoryKey)?.name ?? "未分类"
        return expense.note.isEmpty ? category : "\(category) · \(expense.note)"
    }

    private var subtitle: String {
        let date = Date.apiDate(expense.date)?.friendlyChineseDate ?? expense.date
        return "\(date) · \(model.name(of: expense.paidBy))付款"
    }

    /// "我 166.67 / 小王 166.67 / 小李 166.66" — the whole point of the model.
    /// nil for a solo expense, where there is nothing interesting to say.
    private var sharingSummary: String? {
        guard expense.shares.count > 1 else { return nil }
        return expense.shares
            .map { "\(model.name(of: $0.userId)) \(Money.plain($0.amountCents))" }
            .joined(separator: " / ")
    }
}
