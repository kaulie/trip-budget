import SwiftUI

/// Where the shared-ledger story lives: create, join with a code, switch.
struct LedgerListView: View {
    @Environment(AppModel.self) private var model

    @State private var showingCreate = false
    @State private var showingJoin = false
    @State private var showingProfile = false

    var body: some View {
        List {
            Section {
                ForEach(model.ledgers) { ledger in
                    Button {
                        Task { await model.selectLedger(ledger.id) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(
                                systemName: ledger.id == model.currentLedgerId
                                    ? "checkmark.circle.fill" : "circle"
                            )
                            .foregroundStyle(
                                ledger.id == model.currentLedgerId ? Theme.accent : Color.secondary
                            )
                            VStack(alignment: .leading, spacing: 3) {
                                Text(ledger.name)
                                    .font(.body.weight(.medium))
                                    .foregroundStyle(.primary)
                                Text("邀请码 \(ledger.inviteCode)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        NavigationLink {
                            LedgerSettingsView(ledger: ledger)
                        } label: {
                            Label("管理", systemImage: "gear")
                        }
                    }
                }
            } header: {
                Text("我的账本")
            } footer: {
                Text("一个账本由多人共同查看和编辑。用邀请码让别人加入。")
            }

            Section {
                Button {
                    showingCreate = true
                } label: {
                    Label("创建新账本", systemImage: "plus.circle.fill")
                }
                Button {
                    showingJoin = true
                } label: {
                    Label("输入邀请码加入", systemImage: "rectangle.and.pencil.and.ellipsis")
                }
                Button {
                    showingProfile = true
                } label: {
                    Label("我的昵称", systemImage: "person.crop.circle")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("账本")
        .navigationDestination(for: Ledger.self) { ledger in
            LedgerSettingsView(ledger: ledger)
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack { CreateLedgerView() }
        }
        .sheet(isPresented: $showingJoin) {
            NavigationStack { JoinLedgerView() }
        }
        .sheet(isPresented: $showingProfile) {
            NavigationStack { ProfileView() }
        }
        .refreshable { await model.refreshAll() }
    }
}

/// Bottom sheet used by the home screen's ledger title.
struct LedgerPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var showingJoin = false

    var body: some View {
        NavigationStack {
            List {
                Section("切换账本") {
                    ForEach(model.ledgers) { ledger in
                        Button {
                            Task {
                                await model.selectLedger(ledger.id)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(ledger.name).foregroundStyle(.primary)
                                    Text("邀请码 \(ledger.inviteCode)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if ledger.id == model.currentLedgerId {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Theme.accent)
                                }
                            }
                        }
                    }
                }
                Section {
                    Button {
                        showingJoin = true
                    } label: {
                        Label("输入邀请码加入账本", systemImage: "rectangle.and.pencil.and.ellipsis")
                    }
                }
            }
            .navigationTitle("账本")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(isPresented: $showingJoin) {
                NavigationStack { JoinLedgerView() }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
