import SwiftUI

/// The confirmation screen.
///
/// Two things matter here and nothing else:
///   1. the user can see exactly who paid and who bears what before saving;
///   2. they can fix it by talking ("小李不算，改成我和小王平摊") instead of
///      re-describing the whole expense.
struct ConfirmExpenseView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    /// Called after a successful save so the whole capture sheet can close.
    let onSaved: () -> Void

    @State private var interpretation: Interpretation
    @State private var type: ExpenseType
    @State private var amountText: String
    @State private var categoryKey: String
    @State private var date: Date
    @State private var note: String
    @State private var paidBy: String
    @State private var shareMode: Expense.ShareMode
    @State private var selectedParticipantIds: Set<String>
    @State private var manualAmounts: [String: String]
    @State private var refineText = ""
    @State private var isRefining = false
    @State private var isSaving = false
    @State private var serverViolations: [RuleViolation] = []
    @State private var localError: String?

    init(interpretation: Interpretation, onSaved: @escaping () -> Void = {}) {
        self.onSaved = onSaved
        _interpretation = State(initialValue: interpretation)
        let preview = interpretation.preview
        _type = State(initialValue: preview?.type ?? .expense)
        _amountText = State(initialValue: preview.map { Money.plain($0.amountCents) } ?? "")
        _categoryKey = State(initialValue: preview?.categoryKey ?? "")
        _date = State(initialValue: preview.flatMap { Date.apiDate($0.date) } ?? Date())
        _note = State(initialValue: preview?.note ?? "")
        _paidBy = State(initialValue: preview?.paidBy.userId ?? "")
        _shareMode = State(initialValue: preview?.shareMode ?? .equal)
        _selectedParticipantIds = State(
            initialValue: Set((preview?.shares ?? []).map(\.userId))
        )
        _manualAmounts = State(
            initialValue: Dictionary(
                uniqueKeysWithValues: (preview?.shares ?? []).map {
                    ($0.userId, Money.plain($0.amountCents))
                }
            )
        )
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                assistantBanner
                summaryCard
                detailsCard
                payerCard
                sharingCard
                refineCard
                saveButton
            }
            .padding(16)
        }
        .background(Theme.groupBackground)
        .navigationTitle("确认这笔账")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: shareMode) { _, newValue in
            // Switching to "指定金额" starts from what is currently shown, so the
            // user edits real numbers instead of blank fields.
            guard newValue == .amounts else { return }
            for share in previewShares where manualAmounts[share.userId]?.isEmpty ?? true {
                manualAmounts[share.userId] = Money.plain(share.amountCents)
            }
        }
        .onChange(of: amountText) { _, _ in
            // Keep the equal split in sync as the amount is typed.
            serverViolations = []
            localError = nil
        }
    }

    // MARK: - Banner

    private var assistantBanner: some View {
        Group {
            if !bannerText.isEmpty {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: bannerIcon)
                        .foregroundStyle(bannerTint)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(bannerText)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        if let utterance = interpretation.preview?.rawUtterance ?? interpretation.draft.rawUtterance {
                            Text("“\(utterance)”")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(bannerTint.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }

    private var bannerText: String {
        if let localError { return localError }
        if !serverViolations.isEmpty { return serverViolations[0].message }
        if !interpretation.questions.isEmpty { return interpretation.questions.joined(separator: "\n") }
        if interpretation.ready { return interpretation.assistantMessage.isEmpty ? "我已经听懂了，确认一下就记账。" : interpretation.assistantMessage }
        return interpretation.statusMessage
    }

    private var bannerIcon: String {
        interpretation.ready && localError == nil && serverViolations.isEmpty
            ? "checkmark.circle.fill"
            : "questionmark.circle.fill"
    }

    private var bannerTint: Color {
        interpretation.ready && localError == nil && serverViolations.isEmpty ? Theme.income : Theme.accent
    }

    // MARK: - Summary

    private var summaryCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 12) {
                    CategoryBadge(icon: currentCategory?.icon ?? "tag.fill", size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(currentCategory?.name ?? "未分类").font(.headline)
                        Text("\(date.friendlyChineseDate)\(note.isEmpty ? "" : " · \(note)")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    AmountText(cents: amountCents ?? 0, type: type, font: .system(size: 26, weight: .bold, design: .rounded))
                }

                Divider()

                HStack {
                    Text("付款人").foregroundStyle(.secondary)
                    Spacer()
                    Text(model.name(of: paidBy)).fontWeight(.medium)
                }
                .font(.subheadline)

                Text("费用分摊")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                VStack(spacing: 6) {
                    ForEach(previewShares, id: \.userId) { share in
                        HStack {
                            Text(model.name(of: share.userId))
                            Spacer()
                            Text(Money.symbol(share.amountCents))
                                .monospacedDigit()
                                .fontWeight(.medium)
                        }
                        .font(.subheadline)
                    }
                }
            }
        }
    }

    // MARK: - Details

    private var detailsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                Picker("类型", selection: $type) {
                    Text("支出").tag(ExpenseType.expense)
                    Text("收入").tag(ExpenseType.income)
                }
                .pickerStyle(.segmented)

                HStack {
                    Text("金额").foregroundStyle(.secondary)
                    Spacer()
                    TextField("0.00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                        .frame(maxWidth: 140)
                    Text("元").foregroundStyle(.secondary)
                }
                .font(.subheadline)

                Divider()

                HStack {
                    Text("分类").foregroundStyle(.secondary)
                    Spacer()
                    Picker("分类", selection: $categoryKey) {
                        ForEach(model.categories.filter { $0.kind != .income || type == .income }) { category in
                            Label(category.name, systemImage: category.icon).tag(category.key)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
                .font(.subheadline)

                Divider()

                HStack {
                    Text("日期").foregroundStyle(.secondary)
                    Spacer()
                    DatePicker("", selection: $date, displayedComponents: .date)
                        .labelsHidden()
                }
                .font(.subheadline)

                Divider()

                HStack {
                    Text("备注").foregroundStyle(.secondary)
                    Spacer()
                    TextField("可不填", text: $note)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 200)
                }
                .font(.subheadline)
            }
        }
    }

    private var payerCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("谁付的钱").font(.subheadline.weight(.semibold))
                Text("实际掏钱的人。可以和承担费用的人不同。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                FlowRow(spacing: 8) {
                    ForEach(model.members) { member in
                        ChoiceChip(
                            title: model.name(of: member.userId),
                            isSelected: paidBy == member.userId
                        ) {
                            paidBy = member.userId
                        }
                    }
                }
            }
        }
    }

    // MARK: - Sharing

    private var sharingCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("谁承担费用").font(.subheadline.weight(.semibold))
                    Spacer()
                    Picker("", selection: $shareMode) {
                        Text("平均").tag(Expense.ShareMode.equal)
                        Text("指定金额").tag(Expense.ShareMode.amounts)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 170)
                }

                Text("点一下成员即可加入或移出这笔分摊。")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ForEach(model.members) { member in
                    participantRow(member)
                }

                Divider()

                HStack {
                    Text("分摊合计").foregroundStyle(.secondary)
                    Spacer()
                    Text(Money.symbol(previewShares.reduce(0) { $0 + $1.amountCents }))
                        .monospacedDigit()
                        .fontWeight(.semibold)
                        .foregroundStyle(sharesBalanced ? Theme.income : Theme.expense)
                    Text("/ \(Money.symbol(amountCents ?? 0))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .font(.subheadline)

                if !sharesBalanced {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.expense)
                        Text("分摊合计必须等于总额，服务端会拒绝不一致的账目。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                    Button("自动调平（按比例）") {
                        let current = model.members.compactMap { member -> (String, Int)? in
                            guard selectedParticipantIds.contains(member.userId) else { return nil }
                            guard let cents = Money.cents(fromUserInput: manualAmounts[member.userId] ?? "") else { return nil }
                            return (member.userId, cents)
                        }
                        let total = amountCents ?? 0
                        let normalized = ShareAllocator.normalize(amounts: current.map(\.1), total: total)
                        for (index, entry) in current.enumerated() {
                            manualAmounts[entry.0] = Money.plain(normalized[index])
                        }
                        shareMode = .amounts
                    }
                    .font(.footnote.weight(.semibold))
                }
            }
        }
    }

    @ViewBuilder
    private func participantRow(_ member: LedgerMember) -> some View {
        let isSelected = selectedParticipantIds.contains(member.userId)
        HStack(spacing: 10) {
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
                    Text(model.name(of: member.userId))
                        .foregroundStyle(.primary)
                }
            }
            .buttonStyle(.plain)

            Spacer()

            if isSelected, shareMode == .amounts {
                TextField("0.00", text: binding(for: member.userId))
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(maxWidth: 90)
                    .textFieldStyle(.plain)
                Text("元").font(.caption).foregroundStyle(.secondary)
            } else if isSelected {
                Text(Money.symbol(equalShareCents(for: member.userId)))
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .font(.subheadline)
    }

    private func binding(for userId: String) -> Binding<String> {
        Binding(
            get: { manualAmounts[userId] ?? "" },
            set: { manualAmounts[userId] = $0 }
        )
    }

    // MARK: - Refine by talking

    private var refineCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Label("继续说，改这一笔", systemImage: "bubble.left.and.text.bubble.right")
                    .font(.subheadline.weight(.semibold))
                Text("例如：“小李不算，改成我和小王平摊”，不用重新描述整句话。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("用一句话修改", text: $refineText)
                        .textFieldStyle(.plain)
                        .padding(10)
                        .background(Theme.groupBackground)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        Task { await refine() }
                    } label: {
                        if isRefining {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 26))
                                .foregroundStyle(refineText.isEmpty ? Color.secondary : Theme.accent)
                        }
                    }
                    .disabled(refineText.trimmingCharacters(in: .whitespaces).isEmpty || isRefining)
                }
            }
        }
    }

    // MARK: - Save

    private var saveButton: some View {
        VStack(spacing: 8) {
            Button {
                Task { await save() }
            } label: {
                HStack {
                    Spacer()
                    if isSaving {
                        ProgressView().tint(.white)
                    } else {
                        Text("确认记账").font(.headline)
                    }
                    Spacer()
                }
                .padding(.vertical, 16)
            }
            .background(canSave ? Theme.accent : Color.gray.opacity(0.35))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .disabled(!canSave || isSaving)
            .accessibilityIdentifier("confirm.save")

            if !canSave, let reason = blockingReason {
                Text(reason).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var canSave: Bool {
        blockingReason == nil && !isSaving
    }

    private var blockingReason: String? {
        guard let amount = amountCents, amount > 0 else { return "请填写金额。" }
        guard !paidBy.isEmpty else { return "请选择谁付的钱。" }
        guard !selectedParticipantIds.isEmpty else { return "至少要有一位承担人。" }
        if shareMode == .amounts, !sharesBalanced {
            return "指定金额的分摊合计必须等于总额。"
        }
        return nil
    }

    private func refine() async {
        let utterance = refineText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !utterance.isEmpty else { return }
        isRefining = true
        defer { isRefining = false }
        localError = nil
        do {
            // The current, edited draft is the context — so "小李不算" applies to
            // what the user is looking at right now, edits included.
            let result = try await model.interpret(
                text: utterance,
                source: .text,
                pendingDraft: currentDraft
            )
            interpretation = result
            apply(result)
            refineText = ""
        } catch {
            localError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Sync the editable fields from a fresh interpretation.
    private func apply(_ result: Interpretation) {
        guard let preview = result.preview else { return }
        type = preview.type
        amountText = Money.plain(preview.amountCents)
        categoryKey = preview.categoryKey
        if let parsed = Date.apiDate(preview.date) { date = parsed }
        note = preview.note
        paidBy = preview.paidBy.userId
        shareMode = preview.shareMode
        selectedParticipantIds = Set(preview.shares.map(\.userId))
        manualAmounts = Dictionary(
            uniqueKeysWithValues: preview.shares.map { ($0.userId, Money.plain($0.amountCents)) }
        )
    }

    private func save() async {
        guard let amount = amountCents, let payload = payload(amountCents: amount) else { return }
        isSaving = true
        serverViolations = []
        defer { isSaving = false }

        if await model.save(payload) != nil {
            onSaved()
            return
        }
        // The server is the authority on money; show exactly what it objected to.
        if let message = model.errorMessage {
            serverViolations = [RuleViolation(rule: "server", message: message)]
            model.errorMessage = nil
        }
    }

    // MARK: - Derived state

    private var amountCents: Int? {
        Money.cents(fromUserInput: amountText)
    }

    private var currentCategory: Category? {
        model.category(forKey: categoryKey)
    }

    /// Roster order (owner first) so the allocation is deterministic and the extra
    /// cent lands where the server would put it.
    private var orderedParticipantIds: [String] {
        model.members.map(\.userId).filter { selectedParticipantIds.contains($0) }
    }

    /// What the user is about to save. In "指定金额" mode these are exactly the
    /// numbers they typed — including a mismatch, so they can see it.
    private var previewShares: [ExpenseShare] {
        guard let amount = amountCents, amount > 0, !orderedParticipantIds.isEmpty else { return [] }
        if shareMode == .amounts {
            return orderedParticipantIds.map { userId in
                ExpenseShare(
                    userId: userId,
                    amountCents: Money.cents(fromUserInput: manualAmounts[userId] ?? "") ?? 0
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

    private func equalShareCents(for userId: String) -> Int {
        guard let amount = amountCents, amount > 0, !orderedParticipantIds.isEmpty else { return 0 }
        let parts = ShareAllocator.splitEqually(total: amount, count: orderedParticipantIds.count)
        guard let index = orderedParticipantIds.firstIndex(of: userId), index < parts.count else { return 0 }
        return parts[index]
    }

    /// The draft sent back to the agent as context when the user refines.
    private var currentDraft: DraftState {
        DraftState(
            type: type,
            amountCents: amountCents,
            currency: model.currentLedger?.currency ?? "CNY",
            categoryKey: categoryKey.isEmpty ? nil : categoryKey,
            date: date.apiDateString,
            note: note,
            paidBy: paidBy.isEmpty ? nil : paidBy,
            shareMode: shareMode,
            participants: orderedParticipantIds.map { userId in
                DraftState.Participant(
                    userId: userId,
                    weight: nil,
                    amountCents: shareMode == .amounts
                        ? previewShares.first { $0.userId == userId }?.amountCents
                        : nil
                )
            },
            rawUtterance: interpretation.draft.rawUtterance
        )
    }

    private func payload(amountCents: Int) -> ExpensePayload? {
        let shares = previewShares
        guard !shares.isEmpty else { return nil }
        guard shares.reduce(0, { $0 + $1.amountCents }) == amountCents else { return nil }
        return ExpensePayload(
            type: type,
            amountCents: amountCents,
            currency: model.currentLedger?.currency ?? "CNY",
            categoryKey: categoryKey.isEmpty ? "other" : categoryKey,
            date: date.apiDateString,
            note: note,
            paidBy: paidBy,
            shareMode: shareMode,
            shares: shares,
            source: interpretation.preview?.source ?? .text,
            rawUtterance: interpretation.preview?.rawUtterance ?? interpretation.draft.rawUtterance
        )
    }
}
