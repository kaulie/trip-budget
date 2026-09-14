import SwiftUI

struct CreateLedgerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var created: Ledger?

    private let suggestions = ["我的日常", "家庭账本", "日本旅行", "公司出差"]

    var body: some View {
        Form {
            Section("账本名称") {
                TextField("例如：日本旅行", text: $name)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(suggestions, id: \.self) { suggestion in
                            ChoiceChip(title: suggestion, isSelected: name == suggestion) {
                                name = suggestion
                            }
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }

            if let created {
                Section("邀请其他人") {
                    HStack {
                        Text(created.inviteCode)
                            .font(.system(.title3, design: .monospaced).weight(.semibold))
                        Spacer()
                        ShareLink(item: shareText(created)) {
                            Label("分享", systemImage: "square.and.arrow.up")
                        }
                    }
                    Text("朋友在 App 里输入这个邀请码就能加入，看到并一起编辑账本。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Button {
                    Task {
                        created = await model.createLedger(name: name)
                    }
                } label: {
                    HStack {
                        Spacer()
                        if model.isBusy {
                            ProgressView()
                        } else {
                            Text(created == nil ? "创建" : "再创建一个").fontWeight(.semibold)
                        }
                        Spacer()
                    }
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy)
            }
        }
        .navigationTitle("创建账本")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(created == nil ? "取消" : "完成") { dismiss() }
            }
        }
    }

    private func shareText(_ ledger: Ledger) -> String {
        "来一起记账吧！账本「\(ledger.name)」，邀请码 \(ledger.inviteCode)"
    }
}

struct JoinLedgerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var errorText: String?

    var body: some View {
        Form {
            Section {
                TextField("例如：TRIP-8F3K2", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(.system(.title3, design: .monospaced))
            } header: {
                Text("输入邀请码")
            } footer: {
                Text("邀请码由账本创建者生成，不区分大小写。")
            }

            if let errorText {
                Section {
                    Text(errorText).foregroundStyle(Theme.expense).font(.footnote)
                }
            }

            Section {
                Button {
                    Task { await join() }
                } label: {
                    HStack {
                        Spacer()
                        if model.isBusy {
                            ProgressView()
                        } else {
                            Text("加入账本").fontWeight(.semibold)
                        }
                        Spacer()
                    }
                }
                .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy)
            }
        }
        .navigationTitle("加入账本")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }
            }
        }
    }

    private func join() async {
        errorText = nil
        let joined = await model.joinLedger(inviteCode: code)
        if joined != nil {
            dismiss()
        } else {
            errorText = model.errorMessage ?? "加入失败，请检查邀请码。"
            model.errorMessage = nil
        }
    }
}
