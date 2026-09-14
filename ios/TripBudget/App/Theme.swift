import SwiftUI

/// A small, shared visual language so the screens stay consistent:
/// one accent, one card shape, one amount style.
enum Theme {
    static let accent = Color(red: 0.20, green: 0.55, blue: 0.95)
    static let expense = Color(red: 0.92, green: 0.35, blue: 0.30)
    static let income = Color(red: 0.20, green: 0.68, blue: 0.45)
    static let cardBackground = Color(.secondarySystemGroupedBackground)
    static let groupBackground = Color(.systemGroupedBackground)

    static let cornerRadius: CGFloat = 18
}

/// The rounded container every screen is built from.
struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
    }
}

/// A money figure. Tabular digits so columns of amounts line up.
struct AmountText: View {
    let cents: Int
    var type: ExpenseType = .expense
    var font: Font = .system(size: 20, weight: .semibold, design: .rounded)
    var showSign: Bool = false

    var body: some View {
        Text(text)
            .font(font)
            .monospacedDigit()
            .foregroundStyle(color)
    }

    private var text: String {
        let prefix = showSign ? (type.isIncome ? "+" : "-") : ""
        return prefix + Money.symbol(abs(cents))
    }

    private var color: Color {
        showSign ? (type.isIncome ? Theme.income : Theme.expense) : .primary
    }
}

/// The category icon bubble used in lists and on the confirmation card.
struct CategoryBadge: View {
    let icon: String
    var size: CGFloat = 38
    var tint: Color = Theme.accent

    var body: some View {
        ZStack {
            Circle()
                .fill(tint.opacity(0.14))
            Image(systemName: icon.isEmpty ? "tag.fill" : icon)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(tint)
        }
        .frame(width: size, height: size)
    }
}

/// Empty-state placeholder that always tells the user what to do next.
struct EmptyHint: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}

/// Renders a member's name with a "我" marker when it is the current user.
struct MemberNameText: View {
    let name: String
    var isMe: Bool

    var body: some View {
        HStack(spacing: 4) {
            Text(isMe ? "我" : name)
            if isMe && name != "我" {
                Text("(\(name))")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
    }
}

/// A tappable pill, used for "who paid" and other small choices.
struct ChoiceChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(isSelected ? .semibold : .regular))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(isSelected ? Theme.accent.opacity(0.16) : Theme.groupBackground)
                .foregroundStyle(isSelected ? Theme.accent : .primary)
                .overlay(
                    Capsule().stroke(isSelected ? Theme.accent : Color.clear, lineWidth: 1.5)
                )
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// Minimal wrapping layout so member chips flow onto multiple lines.
struct FlowRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth + size.width > maxWidth, rowWidth > 0 {
                totalHeight += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        totalHeight += rowHeight
        return CGSize(width: proposal.width ?? rowWidth, height: totalHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
