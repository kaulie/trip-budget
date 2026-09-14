import SwiftUI

/// Statistics that keep the two questions apart:
/// "谁实际支付了多少钱" vs "谁最终承担了多少钱".
struct StatsView: View {
    @Environment(AppModel.self) private var model

    @State private var range: StatsRange = .month
    @State private var customFrom = Date()
    @State private var customTo = Date()
    @State private var showCustom = false

    enum StatsRange: String, CaseIterable, Identifiable {
        case today
        case week
        case month
        case year
        case all

        var id: String { rawValue }
        var label: String {
            switch self {
            case .today: return "今天"
            case .week: return "本周"
            case .month: return "本月"
            case .year: return "今年"
            case .all: return "全部"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                rangePicker
                totalsCard
                categoryCard
                memberCard
                settlementCard
                dailyCard
            }
            .padding(16)
        }
        .background(Theme.groupBackground)
        .navigationTitle("统计")
        .refreshable { await reload() }
        .task { await reload() }
        .onChange(of: range) { _, _ in Task { await reload() } }
    }

    private var rangePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(StatsRange.allCases) { value in
                    ChoiceChip(title: value.label, isSelected: range == value) {
                        range = value
                    }
                }
                ChoiceChip(title: "自定义", isSelected: showCustom) {
                    showCustom.toggle()
                }
            }
            .padding(.horizontal, 1)
        }
        .sheet(isPresented: $showCustom) {
            NavigationStack {
                Form {
                    DatePicker("开始", selection: $customFrom, displayedComponents: .date)
                    DatePicker("结束", selection: $customTo, displayedComponents: .date)
                }
                .navigationTitle("自定义时间范围")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("查看") {
                            showCustom = false
                            range = .all
                            Task { await reload(custom: true) }
                        }
                    }
                }
            }
            .presentationDetents([.height(280)])
        }
    }

    private var totalsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    statBlock("总支出", Money.symbol(model.stats?.totalExpenseCents ?? 0), Theme.expense)
                    Spacer()
                    statBlock("总收入", Money.symbol(model.stats?.totalIncomeCents ?? 0), Theme.income)
                    Spacer()
                    statBlock("笔数", "\(model.stats?.expenseCount ?? 0)", .primary)
                }
                if let stats = model.stats {
                    Text("\(stats.from) ~ \(stats.to)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func statBlock(_ title: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(color)
        }
    }

    private var categoryCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("按分类").font(.headline)
                if let categories = model.stats?.byCategory, !categories.isEmpty {
                    ForEach(categories) { category in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Image(systemName: category.icon)
                                    .foregroundStyle(Theme.accent)
                                    .frame(width: 20)
                                Text(category.name)
                                Spacer()
                                Text(Money.symbol(category.amountCents)).monospacedDigit()
                                Text(category.percentText)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 42, alignment: .trailing)
                            }
                            .font(.subheadline)
                            GeometryReader { geometry in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Theme.accent.opacity(0.12))
                                    Capsule()
                                        .fill(Theme.accent)
                                        .frame(width: max(4, geometry.size.width * category.ratio))
                                }
                            }
                            .frame(height: 6)
                        }
                    }
                } else {
                    Text("这段时间还没有支出。").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The heart of the split model, on screen: paid and borne are different columns.
    private var memberCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("按成员").font(.headline)
                Text("「实际支付」是掏了多少钱，「实际承担」是最终该由谁负担。两者不同。")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack {
                    Text("成员").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text("实际支付").font(.caption).foregroundStyle(.secondary).frame(width: 84, alignment: .trailing)
                    Text("实际承担").font(.caption).foregroundStyle(.secondary).frame(width: 84, alignment: .trailing)
                }

                ForEach(model.stats?.byMember ?? []) { member in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(model.name(of: member.userId))
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text(Money.symbol(member.paidCents))
                                .font(.subheadline)
                                .monospacedDigit()
                                .frame(width: 84, alignment: .trailing)
                            Text(Money.symbol(member.shareCents))
                                .font(.subheadline)
                                .monospacedDigit()
                                .frame(width: 84, alignment: .trailing)
                        }
                        HStack {
                            Text(member.netDescription)
                                .font(.caption)
                                .foregroundStyle(
                                    member.netCents > 0 ? Theme.income : (member.netCents < 0 ? Theme.expense : .secondary)
                                )
                            Spacer()
                        }
                    }
                    if member.id != (model.stats?.byMember.last?.id ?? member.id) {
                        Divider()
                    }
                }
            }
        }
    }

    private var settlementCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("结算建议").font(.headline)
                Text("第一阶段只做展示，方便你知道谁该给谁多少钱。")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let settlements = model.balances?.settlements, !settlements.isEmpty {
                    ForEach(settlements) { edge in
                        HStack(spacing: 8) {
                            Text(model.name(of: edge.fromUserId))
                            Image(systemName: "arrow.right")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(model.name(of: edge.toUserId))
                            Spacer()
                            Text(Money.symbol(edge.amountCents))
                                .monospacedDigit()
                                .fontWeight(.medium)
                        }
                        .font(.subheadline)
                    }
                } else {
                    Text("大家都已经结清。").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var dailyCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("按时间").font(.headline)
                let daily = (model.stats?.daily ?? []).filter { $0.expenseCents > 0 }
                if daily.isEmpty {
                    Text("这段时间还没有支出。").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    let maxValue = max(1, daily.map(\.expenseCents).max() ?? 1)
                    ForEach(daily.suffix(14)) { day in
                        HStack(spacing: 10) {
                            Text(Date.apiDate(day.date)?.friendlyChineseDate ?? day.date)
                                .font(.caption)
                                .frame(width: 68, alignment: .leading)
                            GeometryReader { geometry in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Theme.accent.opacity(0.12))
                                    Capsule()
                                        .fill(Theme.accent)
                                        .frame(
                                            width: max(
                                                4,
                                                geometry.size.width * Double(day.expenseCents) / Double(maxValue)
                                            )
                                        )
                                }
                            }
                            .frame(height: 8)
                            Text(Money.compact(day.expenseCents))
                                .font(.caption)
                                .monospacedDigit()
                                .frame(width: 66, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    private func reload(custom: Bool = false) async {
        if custom {
            await model.loadStats(range: "custom", from: customFrom.apiDateString, to: customTo.apiDateString)
        } else {
            await model.loadStats(range: range.rawValue)
        }
        await model.loadBalances()
    }
}
