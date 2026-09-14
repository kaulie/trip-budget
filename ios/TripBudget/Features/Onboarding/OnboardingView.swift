import SwiftUI

/// First launch: one field, one tap. No phone number, no email, no password.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var nickname = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: "mic.circle.fill")
                        .font(.system(size: 52))
                        .foregroundStyle(Theme.accent)
                    Text("说一句话，就把账记好")
                        .font(.largeTitle.bold())
                    Text("打开就说“昨天和朋友吃饭花了 280”，剩下的交给记账助手。\n支持多人共享账本和费用分摊。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 40)

                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("先取个昵称")
                            .font(.headline)
                        Text("这个昵称会显示在共享账本的成员列表里，别人靠它认出你。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        TextField("例如：小林", text: $nickname)
                            .textFieldStyle(.plain)
                            .font(.title3)
                            .padding(12)
                            .background(Theme.groupBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .focused($isFocused)
                            .submitLabel(.done)
                            .onSubmit { submit() }
                    }
                }

                Button(action: submit) {
                    HStack {
                        Spacer()
                        if model.isBusy {
                            ProgressView().tint(.white)
                        } else {
                            Text("开始使用").font(.headline)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 15)
                }
                .background(Theme.accent)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .disabled(nickname.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy)

                Text("不需要注册账号。数据存在你自己的账本里，之后可以随时用邀请码邀请其他人。")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(20)
        }
        .background(Theme.groupBackground)
        .onAppear { isFocused = true }
    }

    private func submit() {
        let value = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        Task { await model.completeOnboarding(nickname: value) }
    }
}
