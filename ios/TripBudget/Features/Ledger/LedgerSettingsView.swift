import SwiftUI

/// Ledger settings: the invite code, the member list, and the ledger name.
struct LedgerSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var ledger: Ledger
    @State private var name: String
    @State private var isEditingName = false

    init(ledger: Ledger) {
        _ledger = State(initialValue: ledger)
        _name = State(initialValue: ledger.name)
    }

    var body: some View {
        List {
            Section {
                HStack {
                    Text(ledger.inviteCode)
                        .font(.system(.title2, design: .monospaced).weight(.bold))
                        .textSelection(.enabled)
                    Spacer()
                    ShareLink(item: shareText) {
                        Label("分享", systemImage: "square.and.arrow.up")
                            .labelStyle(.titleAndIcon)
                    }
                }
                Button("重新生成邀请码（旧码立即失效）", role: .destructive) {
                    Task {
                        await model.rotateInviteCode()
                        if let updated = model.currentLedger { ledger = updated }
                    }
                }
                .font(.footnote)
            } header: {
                Text("邀请码")
            } footer: {
                Text("对方在「账本 → 输入邀请码加入」里输入这个码，就能看到并一起编辑。")
            }

            Section("成员（\(model.members.count)）") {
                ForEach(model.members) { member in
                    HStack(spacing: 12) {
                        Circle()
                            .fill(Theme.accent.opacity(0.15))
                            .frame(width: 34, height: 34)
                            .overlay(
                                Text(String(member.nickname.prefix(1)))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.accent)
                            )
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(member.userId == model.myUserId ? "我" : member.nickname)
                                if member.userId == model.myUserId {
                                    Text("(\(member.nickname))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text(member.role.label)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if member.userId != model.myUserId, ledger.ownerId == model.myUserId {
                            Button("移除", role: .destructive) {
                                Task { await model.removeMember(member.userId) }
                            }
                            .font(.footnote)
                        }
                    }
                }
            }

            Section("账本名称") {
                HStack {
                    TextField("账本名称", text: $name)
                    Button("保存") {
                        Task {
                            await model.renameCurrentLedger(name)
                            if let updated = model.currentLedger { ledger = updated }
                        }
                    }
                    .disabled(name == ledger.name)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(ledger.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
        .onChange(of: model.currentLedger) { _, updated in
            if let updated, updated.id == ledger.id { ledger = updated }
        }
    }

    private var shareText: String {
        "来一起记账吧！账本「\(ledger.name)」，邀请码 \(ledger.inviteCode)"
    }
}

/// Nickname management — the only "account" concept in this version.
struct ProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var serverURL = ""

    var body: some View {
        Form {
            Section {
                TextField("昵称", text: $nickname)
            } header: {
                Text("我的昵称")
            } footer: {
                Text("昵称用于在共享账本里区分成员。重名时记账助手不会猜，会先问你。")
            }

            Section {
                TextField("http://192.168.1.20:4000", text: $serverURL)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                HStack {
                    Button("保存并重连") {
                        Task {
                            await model.updateServerURL(serverURL)
                            serverURL = model.baseURL.absoluteString
                        }
                    }
                    .disabled(serverURL.trimmingCharacters(in: .whitespaces).isEmpty)
                    Spacer()
                    connectionBadge
                }
            } header: {
                Text("服务器地址")
            } footer: {
                Text("模拟器用 127.0.0.1:4000；真机上「本机」是手机自己，要填运行后端那台电脑的局域网地址（手机和电脑连同一个 Wi-Fi）。换 Wi-Fi 后地址变了，在这里改一次就行，不用重新装。")
            }

            Section("关于") {
                LabeledContent("版本", value: "0.1.0 MVP")
                LabeledContent("登录方式", value: "本机匿名身份")
                LabeledContent("当前连接", value: model.baseURL.absoluteString)
                if let last = model.lastSyncedAt {
                    LabeledContent("上次同步", value: last.formatted(date: .omitted, time: .standard))
                }
            }

            Section {
                Button("保存昵称") {
                    Task {
                        await model.updateNickname(nickname)
                        dismiss()
                    }
                }
                .disabled(nickname.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .navigationTitle("我")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭") { dismiss() }
            }
        }
        .onAppear {
            nickname = model.user?.nickname ?? ""
            serverURL = model.baseURL.absoluteString
        }
    }

    @ViewBuilder
    private var connectionBadge: some View {
        if model.isBusy {
            ProgressView()
        } else if model.isOffline {
            Label("连不上", systemImage: "wifi.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Label("正常", systemImage: "checkmark.circle")
                .font(.footnote)
                .foregroundStyle(Theme.accent)
        }
    }
}
