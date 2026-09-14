import SwiftUI

/// The full list, with the filters people actually use.
struct ExpenseListView: View {
    @Environment(AppModel.self) private var model

    @State private var searchText = ""
    @State private var categoryFilter: String?
    @State private var onlyMine = false
    @State private var range: Range = .month
    @State private var pendingDeletion: Expense?

    enum Range: String, CaseIterable, Identifiable {
        case today
        case week
        case month
        case all

        var id: String { rawValue }
        var label: String {
            switch self {
            case .today: return "今天"
            case .week: return "本周"
            case .month: return "本月"
            case .all: return "全部"
            }
        }
    }

    var body: some View {
        List {
            ForEach(groupedDays, id: \.key) { day in
                Section {
                    ForEach(day.expenses) { expense in
                        NavigationLink {
                            ExpenseDetailView(expense: expense)
                        } label: {
                            ExpenseRow(expense: expense)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                pendingDeletion = expense
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(day.title)
                        Spacer()
                        Text(Money.symbol(day.totalCents)).monospacedDigit()
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("账目")
        .searchable(text: $searchText, prompt: "搜索备注、分类")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("时间范围", selection: $range) {
                        ForEach(Range.allCases) { value in
                            Text(value.label).tag(value)
                        }
                    }
                    Picker("分类", selection: $categoryFilter) {
                        Text("全部分类").tag(String?.none)
                        ForEach(model.categories) { category in
                            Text(category.name).tag(String?.some(category.key))
                        }
                    }
                    Toggle("只看和我有关", isOn: $onlyMine)
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
            }
        }
        .alert("删除这笔账？", isPresented: deletionAlertBinding) {
            Button("删除", role: .destructive) {
                if let expense = pendingDeletion {
                    Task { _ = await model.delete(expense) }
                }
                pendingDeletion = nil
            }
            Button("取消", role: .cancel) { pendingDeletion = nil }
        } message: {
            Text(
                pendingDeletion.map {
                    "\(Money.symbol($0.amountCents))，删除后其他成员也会同步消失。"
                } ?? ""
            )
        }
        .refreshable { await model.sync() }
        .overlay {
            if filtered.isEmpty {
                EmptyHint(
                    icon: "tray",
                    title: "没有符合条件的账目",
                    message: "换个筛选条件，或者回首页说一句试试。"
                )
            }
        }
    }

    private var deletionAlertBinding: Binding<Bool> {
        Binding(get: { pendingDeletion != nil }, set: { if !$0 { pendingDeletion = nil } })
    }

    private var filtered: [Expense] {
        let today = Date().apiDateString
        return model.expenses.filter { expense in
            guard !expense.isDeleted else { return false }
            switch range {
            case .today:
                guard expense.date == today else { return false }
            case .week:
                guard expense.date >= Self.startOfWeek(today) else { return false }
            case .month:
                guard expense.date.hasPrefix(String(today.prefix(7))) else { return false }
            case .all:
                break
            }
            if let categoryFilter, expense.categoryKey != categoryFilter { return false }
            if onlyMine {
                let isMine = expense.paidBy == model.myUserId
                    || expense.shares.contains { $0.userId == model.myUserId }
                if !isMine { return false }
            }
            if !searchText.isEmpty {
                let haystack = "\(expense.note) \(model.category(forKey: expense.categoryKey)?.name ?? "")"
                if !haystack.localizedCaseInsensitiveContains(searchText) { return false }
            }
            return true
        }
    }

    private var groupedDays: [(key: String, title: String, totalCents: Int, expenses: [Expense])] {
        let grouped = Dictionary(grouping: filtered, by: \.date)
        return grouped.keys.sorted(by: >).map { key in
            let items = (grouped[key] ?? []).sorted(by: Expense.ordering)
            let total = items.filter { $0.type == .expense }.reduce(0) { $0 + $1.amountCents }
            return (
                key: key,
                title: Date.apiDate(key)?.friendlyChineseDate ?? key,
                totalCents: total,
                expenses: items
            )
        }
    }

    private static func startOfWeek(_ dateString: String) -> String {
        guard let date = Date.apiDate(dateString) else { return dateString }
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let components = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        guard let start = calendar.date(from: components) else { return dateString }
        return start.apiDateString
    }
}
