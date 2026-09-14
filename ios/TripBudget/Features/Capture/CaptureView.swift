import SwiftUI

/// The "say one sentence" screen.
///
/// Voice is the headline interaction, but recognition is unavailable in the
/// Simulator and on devices with dictation off, so typing the same sentence sits
/// right next to the microphone — no capability is lost either way.
struct CaptureView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var speech = SpeechCapture()
    @State private var text = ""
    @State private var isInterpreting = false
    @State private var interpretation: Interpretation?
    @State private var failureMessage: String?
    @FocusState private var isTyping: Bool

    private let examples = [
        "昨天晚上和朋友吃饭花了 280",
        "我付了 500，我们三个人吃饭，其中小王和小李也要分摊",
        "这顿饭我付的，一共 300，我们三个人平摊",
        "我付了 500，小王承担 200，剩下我自己承担",
        "东京酒店住了三晚，一共 1200",
        "这 600 块我付的，我和小王一人一半，小李不算",
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                header
                microphone
                transcriptField
                if let failureMessage { hint(failureMessage) }
                examplesSection
                analyseButton
            }
            .padding(20)
        }
        .background(Theme.groupBackground)
        .navigationTitle("记一笔")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") {
                    speech.cancel()
                    dismiss()
                }
            }
        }
        .navigationDestination(item: $interpretation) { result in
            ConfirmExpenseView(interpretation: result, onSaved: { dismiss() })
        }
        .onChange(of: speech.status) { _, status in
            switch status {
            case .finished(let recognized):
                if !recognized.isEmpty { text = recognized }
            case .unavailable(let reason):
                failureMessage = reason
                isTyping = true
            default:
                break
            }
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            Text("直接说一句话")
                .font(.title2.bold())
            Text("记账助手会听懂金额、分类、日期、谁付的钱，以及谁承担多少")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 6)
    }

    private var microphone: some View {
        VStack(spacing: 12) {
            Button {
                failureMessage = nil
                Task {
                    if speech.status.isListening {
                        speech.stop()
                    } else {
                        await speech.start()
                    }
                }
            } label: {
                ZStack {
                    Circle()
                        .fill(
                            (speech.status.isListening ? Theme.expense : Theme.accent).opacity(0.14)
                        )
                        .frame(width: 148, height: 148)
                        .scaleEffect(speech.status.isListening ? 1 + speech.audioLevel * 0.18 : 1)
                        .animation(.easeOut(duration: 0.12), value: speech.audioLevel)
                    Circle()
                        .fill(speech.status.isListening ? Theme.expense : Theme.accent)
                        .frame(width: 104, height: 104)
                    Image(systemName: speech.status.isListening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 40, weight: .semibold))
                        .foregroundStyle(.white)
                }
            }
            .buttonStyle(.plain)

            Text(speech.status.isListening ? "正在听…说完点一下停止" : "点一下开始说话")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var transcriptField: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("识别到的内容").font(.subheadline.weight(.semibold))
                    Spacer()
                    if speech.status.isListening, !speech.transcript.isEmpty {
                        Text("实时")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.expense.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }
                TextField(
                    "也可以在这里直接输入，例如：昨天打车花了 45",
                    text: $text,
                    axis: .vertical
                )
                .lineLimit(2...5)
                .focused($isTyping)
                .textFieldStyle(.plain)
                .padding(10)
                .background(Theme.groupBackground)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityIdentifier("capture.input")
                .onChange(of: speech.transcript) { _, newValue in
                    if speech.status.isListening, !newValue.isEmpty { text = newValue }
                }
            }
        }
    }

    private func hint(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill").foregroundStyle(Theme.accent)
            Text(message).font(.footnote).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Theme.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var examplesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("试试这些说法").font(.footnote).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(examples, id: \.self) { example in
                        Button {
                            text = example
                            failureMessage = nil
                        } label: {
                            Text(example)
                                .font(.caption)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(Theme.cardBackground)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 1)
            }
        }
    }

    private var analyseButton: some View {
        Button {
            Task { await analyse() }
        } label: {
            HStack {
                Spacer()
                if isInterpreting {
                    ProgressView().tint(.white)
                } else {
                    Label("让记账助手理解这句话", systemImage: "sparkles")
                        .font(.headline)
                }
                Spacer()
            }
            .padding(.vertical, 15)
        }
        .background(canAnalyse ? Theme.accent : Color.gray.opacity(0.35))
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .disabled(!canAnalyse || isInterpreting)
        .accessibilityIdentifier("capture.analyse")
    }

    private var canAnalyse: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func analyse() async {
        let utterance = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !utterance.isEmpty else { return }
        if speech.status.isListening { speech.stop() }
        isInterpreting = true
        defer { isInterpreting = false }
        do {
            let result = try await model.interpret(
                text: utterance,
                source: speech.transcript.isEmpty ? .text : .voice,
                pendingDraft: nil
            )
            interpretation = result
        } catch {
            failureMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
