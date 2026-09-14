import SwiftUI

/// The home screen is built around one action: say something.
/// Everything else — totals, recent entries, members — supports that.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    let onCapture: () -> Void

    @State private var showingLedgerPicker = false
    @State private var showingSettings = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                subtitle
                totalCard
                captureCard
                if !model.pendingMutations.isEmpty { pendingCard }
                recentSection
            }
            .padding(16)
        }
        .background(Theme.groupBackground)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showingLedgerPicker = true
                } label: {
                    HStack(spacing: 4) {
                        Text(model.currentLedger?.name ?? "共享记账")
                            .font(.headline)
                        if model.ledgers.count > 1 {
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("账本与成员", systemImage: "person.2.fill")
                    }
                    Button {
                        Task { await model.sync() }
                    } label: {
                        Label("立即同步", systemImage: "arrow.triangle.2.circlepath")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .sheet(isPresented: $showingLedgerPicker) {
            LedgerPickerSheet()
        }
        .sheet(isPresented: $showingSettings) {
            if let ledger = model.currentLedger {
                NavigationStack { LedgerSettingsView(ledger: ledger) }
            }
        }
        .refreshable {
            await model.refreshAll()
        }
        .overlay(alignment: .top) { offlineStrip }
    }

    private var subtitle: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                if let ledger = model.currentLedger {
                    Text(model.members.map(\.nickname).joined(separator: "、"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("邀请码 \(ledger.inviteCode)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                } else {
                    Text("先创建一个账本，就可以开始记账了")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
    }

    private var offlineStrip: some View {
        Group {
            if model.isOffline {
                Button {
                    Task { await model.refreshAll() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.slash")
                        Text("离线状态，点一下重试")
                    }
                    .font(.caption)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.thinMaterial)
                    .clipShape(Capsule())
                    .padding(.top, 4)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
            }
        }
    }

    // MARK: - Totals

    private var totalCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("本月支出")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(Money.symbol(model.thisMonthExpenseCents))
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .monospacedDigit()
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("今天")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(Money.symbol(model.todayExpenseCents))
                            .font(.headline)
                            .monospacedDigit()
                    }
                }

                if let stats = model.stats, !stats.byCategory.isEmpty {
                    Divider()
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 18) {
                            ForEach(stats.byCategory.prefix(5)) { category in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 5) {
                                        Image(systemName: category.icon).font(.caption)
                                        Text(category.name).font(.caption)
                                    }
                                    .foregroundStyle(.secondary)
                                    Text(Money.compact(category.amountCents))
                                        .font(.subheadline.weight(.semibold))
                                        .monospacedDigit()
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Capture

    private var captureCard: some View {
        Card(padding: 20) {
            Button(action: onCapture) {
                HStack(spacing: 12) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 22, weight: .semibold))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("说一句话记账").font(.headline)
                        Text("“我付了 500，我们三个人吃饭，平摊”")
                            .font(.caption)
                            .opacity(0.92)
                            .lineLimit(1)
                    }
                    Spacer()
                }
                .padding(.vertical, 16)
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.accent)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .disabled(model.currentLedger == nil)
            .opacity(model.currentLedger == nil ? 0.5 : 1)
            .accessibilityIdentifier("home.capture")
        }
    }

    private var pendingCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Label("待上传 \(model.pendingMutations.count) 笔", systemImage: "arrow.up.circle")
                    .font(.subheadline.weight(.semibold))
                ForEach(model.pendingMutations) { mutation in
                    HStack {
                        Text(Money.symbol(mutation.displayAmountCents)).monospacedDigit()
                        Text(mutation.payload?.note ?? "")
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                    }
                    .font(.footnote)
                }
                Button("现在重试") {
                    Task { await model.flushPendingMutations() }
                }
                .font(.footnote.weight(.semibold))
            }
        }
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("最近账目").font(.headline)
                Spacer()
                if !model.expenses.isEmpty {
                    Text("共 \(model.expenses.count) 笔").font(.caption).foregroundStyle(.secondary)
                }
            }

            if model.recentExpenses.isEmpty {
                Card {
                    EmptyHint(
                        icon: "tray",
                        title: "还没有账目",
                        message: "点上面的按钮，说一句“昨天和朋友吃饭花了 280”试试。"
                    )
                }
            } else {
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(model.recentExpenses.enumerated()), id: \.element.id) { index, expense in
                            NavigationLink {
                                ExpenseDetailView(expense: expense)
                            } label: {
                                ExpenseRow(expense: expense)
                            }
                            .buttonStyle(.plain)
                            if index < model.recentExpenses.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
        }
    }
}
