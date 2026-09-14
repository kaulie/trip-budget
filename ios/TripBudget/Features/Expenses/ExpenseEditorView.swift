import SwiftUI

/// Manual editing of an existing expense.
///
/// The client proposes shares (including a deliberately unbalanced set), and the
/// server validates before saving — the same invariant the agent path enforces.
struct ExpenseEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let expense: Expense
    let onSaved: () -> Void

    @State private var type: ExpenseType
    @State private var amountText: String
    @State private var categoryKey: String
    @State private var date: Date
    @State private var note: String
    @State private var paidBy: String
    @State private var shareMode: Expense.ShareMode
    @State private var selectedParticipantIds: Set<String>
    @State private var manualAmounts: [String: String]
    @State private var isSaving = false
    @State private var serverMessage: String?

    init(expense: Expense, onSaved: @escaping () -> Void) {
        self.expense = expense
        self.onSaved = onSaved
        _type = State(initialValue: expense.type)
        _amountText = State(initialValue: Money.plain(expense.amountCents))
        _categoryKey = State(initialValue: expense.categoryKey)
        _date = State(initialValue: Date.apiDate(expense.date) ?? Date())
        _note = State(initialValue: expense.note)
        _paidBy = State(initialValue: expense.paidBy)
        _shareMode = State(initialValue: expense.shareMode)
        _selectedParticipantIds = State(initialValue: Set(expense.shares.map(\.userId)))
        _manualAmounts = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: expense.shares.map { ($0.userId, Money.plain($0.amountCents)) }
            )
        )
    }

    var body: some View {
        Form {
            Section("基本信息") {
                Picker("类型", selection: $type) {
                    Text("支出").tag(ExpenseType.expense)
                    Text("收入").tag(ExpenseType.income)
                }
                .pickerStyle(.segmented)

                HStack {
                    Text("金额")
                    Spacer()
                    TextField("0.00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                    Text("元").foregroundStyle(.secondary)
                }

                Picker("分类", selection: $categoryKey) {
                    ForEach(model.categories) { category in
                        Label(category.name, systemImage: category.icon).tag(category.key)
                    }
                }

                DatePicker("日期", selection: $date, displayedComponents: .date)

                TextField("备注", text: $note)
            }

            Section("谁付的钱") {
                Picker("付款人", selection: $paidBy) {
                    ForEach(model.members) { member in
                        Text(model.name(of: member.userId)).tag(member.userId)
                    }
                }
            }

            sharingSection

            if let serverMessage {
                Section {
                    Text(serverMessage).foregroundStyle(Theme.expense).font(.footnote)
                }
            }
        }
        .navigationTitle("编辑账目")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }
                    .disabled(!canSave || isSaving)
            }
        }
    }

    private var sharingSection: some View {
        Section {
            Picker("方式", selection: $shareMode) {
                Text("平均").tag(Expense.ShareMode.equal)
                Text("指定金额").tag(Expense.ShareMode.amounts)
            }
            .pickerStyle(.segmented)

            ForEach(model.members) { member in
                let isSelected = selectedParticipantIds.contains(member.userId)
                HStack {
                    Button {
                        if isSelected {
                            selectedParticipantIds.remove(member.userId)
                        } else {
                            selectedParticipantIds.insert(member.userId)
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(isSelected ? Theme.accent : Color.secondary)
                            Text(model.name(of: member.userId)).foregroundStyle(.primary)
                        }
                    }
                    .buttonStyle(.plain)

                    Spacer()

                    if isSelected, shareMode == .amounts {
                        TextField(
                            "0.00",
                            text: Binding(
                                get: { manualAmounts[member.userId] ?? "" },
                                set: { manualAmounts[member.userId] = $0 }
                            )
                        )
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                        .frame(maxWidth: 100)
                    } else if isSelected {
                        Text(Money.symbol(equalShareCents(for: member.userId)))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
            }

            HStack {
                Text("分摊合计")
                Spacer()
                Text(Money.symbol(previewShares.reduce(0) { $0 + $1.amountCents }))
                    .monospacedDigit()
                    .foregroundStyle(sharesBalanced ? Theme.income : Theme.expense)
            }
        } header: {
            Text("谁承担费用")
        } footer: {
            if !sharesBalanced {
                Text("分摊合计必须等于总额，否则服务端会拒绝这笔修改。")
                    .foregroundStyle(Theme.expense)
            }
        }
    }

    // MARK: - Derived

    private var amountCents: Int? { Money.cents(fromUserInput: amountText) }

    private var orderedParticipantIds: [String] {
        model.members.map(\.userId).filter { selectedParticipantIds.contains($0) }
    }

    private var previewShares: [ExpenseShare] {
        guard let amount = amountCents, amount > 0, !orderedParticipantIds.isEmpty else { return [] }
        if shareMode == .amounts {
            return orderedParticipantIds.map {
                ExpenseShare(
                    userId: $0,
                    amountCents: Money.cents(fromUserInput: manualAmounts[$0] ?? "") ?? 0
                )
            }
        }
        let parts = ShareAllocator.splitEqually(total: amount, count: orderedParticipantIds.count)
        return zip(orderedParticipantIds, parts).map { ExpenseShare(userId: $0, amountCents: $1) }
    }

    private var sharesBalanced: Bool {
        guard let amount = amountCents, amount > 0, !previewShares.isEmpty else { return false }
        return previewShares.reduce(0) { $0 + $1.amountCents } == amount
    }

    private var canSave: Bool {
        guard amountCents != nil, !paidBy.isEmpty, !selectedParticipantIds.isEmpty else { return false }
        return sharesBalanced
    }

    private func equalShareCents(for userId: String) -> Int {
        guard let amount = amountCents, amount > 0, !orderedParticipantIds.isEmpty else { return 0 }
        let parts = ShareAllocator.splitEqually(total: amount, count: orderedParticipantIds.count)
        guard let index = orderedParticipantIds.firstIndex(of: userId), index < parts.count else { return 0 }
        return parts[index]
    }

    private func save() async {
        guard let amount = amountCents else { return }
        let shares = previewShares
        guard shares.reduce(0, { $0 + $1.amountCents }) == amount else { return }

        isSaving = true
        serverMessage = nil
        defer { isSaving = false }

        let payload = ExpensePayload(
            type: type,
            amountCents: amount,
            currency: expense.currency,
            categoryKey: categoryKey,
            date: date.apiDateString,
            note: note,
            paidBy: paidBy,
            shareMode: shareMode,
            shares: shares,
            source: expense.source,
            rawUtterance: expense.rawUtterance
        )

        if await model.update(expense, payload: payload) != nil {
            onSaved()
            dismiss()
            return
        }
        if let message = model.errorMessage {
            serverMessage = message
            model.errorMessage = nil
        }
    }
}
