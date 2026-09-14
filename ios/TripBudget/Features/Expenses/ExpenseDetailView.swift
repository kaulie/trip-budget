import SwiftUI

/// Read-only detail: what it was, who paid, who bears what, and where it came from.
struct ExpenseDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var isEditing = false
    @State private var showingDelete = false

    let expense: Expense

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 12) {
                            CategoryBadge(
                                icon: model.category(forKey: expense.categoryKey)?.icon ?? "tag.fill",
                                size: 44,
                                tint: expense.type.isIncome ? Theme.income : Theme.accent
                            )
                            VStack(alignment: .leading, spacing: 3) {
                                Text(model.category(forKey: expense.categoryKey)?.name ?? "未分类")
                                    .font(.headline)
                                Text(Date.apiDate(expense.date)?.friendlyChineseDate ?? expense.date)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            AmountText(
                                cents: expense.amountCents,
                                type: expense.type,
                                font: .system(size: 26, weight: .bold, design: .rounded),
                                showSign: true
                            )
                        }

                        if !expense.note.isEmpty {
                            Text(expense.note).font(.subheadline)
                        }

                        Divider()

                        HStack {
                            Text("付款人").foregroundStyle(.secondary)
                            Spacer()
                            Text(model.name(of: expense.paidBy)).fontWeight(.medium)
                        }
                        .font(.subheadline)

                        Text("费用分摊（\(expense.shareMode.label)）")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        ForEach(expense.shares, id: \.userId) { share in
                            HStack {
                                Text(model.name(of: share.userId))
                                Spacer()
                                Text(Money.symbol(share.amountCents))
                                    .monospacedDigit()
                                    .fontWeight(.medium)
                            }
                            .font(.subheadline)
                        }

                        HStack {
                            Text("合计").foregroundStyle(.secondary)
                            Spacer()
                            Text(Money.symbol(expense.shareTotalCents))
                                .monospacedDigit()
                                .fontWeight(.medium)
                                .foregroundStyle(expense.isBalanced ? Theme.income : Theme.expense)
                        }
                        .font(.subheadline)
                    }
                }

                if let utterance = expense.rawUtterance, !utterance.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("原始语音/文字", systemImage: "waveform")
                                .font(.subheadline.weight(.semibold))
                            Text("“\(utterance)”")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Card {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("记录信息").font(.subheadline.weight(.semibold))
                        labelledRow("创建方式", expense.source.label)
                        labelledRow("记录人", model.name(of: expense.createdBy))
                        labelledRow("版本", "rev \(expense.revision)")
                    }
                }

                Button(role: .destructive) {
                    showingDelete = true
                } label: {
                    Text("删除这笔账").frame(maxWidth: .infinity).padding(.vertical, 14)
                }
                .background(Theme.expense.opacity(0.12))
                .foregroundStyle(Theme.expense)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .padding(16)
        }
        .background(Theme.groupBackground)
        .navigationTitle("账目详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { isEditing = true }
            }
        }
        .sheet(isPresented: $isEditing) {
            NavigationStack {
                ExpenseEditorView(expense: expense) { dismiss() }
            }
        }
        .alert("删除这笔账？", isPresented: $showingDelete) {
            Button("删除", role: .destructive) {
                Task {
                    if await model.delete(expense) { dismiss() }
                }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private func labelledRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
        .font(.subheadline)
    }
}

extension Expense.Source {
    var label: String {
        switch self {
        case .voice: return "语音记账"
        case .text: return "文字记账"
        case .manual: return "手动填写"
        case .agent: return "记账助手"
        }
    }
}
