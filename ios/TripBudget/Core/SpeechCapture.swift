import AVFoundation
import Foundation
import Speech

/// Push-to-talk speech capture.
///
/// Voice is the primary way into this app, but recognition is not available
/// everywhere (notably the Simulator, and any device with dictation disabled).
/// When it is unavailable the capture sheet falls back to typing the same
/// sentence — the agent does not care where the text came from.
@MainActor
@Observable
final class SpeechCapture {
    enum Status: Equatable {
        case idle
        case requestingPermission
        case listening
        case unavailable(String)
        case finished(String)

        var isListening: Bool { self == .listening }

        var unavailableReason: String? {
            if case .unavailable(let reason) = self { return reason }
            return nil
        }
    }

    private(set) var status: Status = .idle
    private(set) var transcript: String = ""
    private(set) var audioLevel: Double = 0
    private(set) var isOnDevice = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    var isSupported: Bool { recognizer != nil }

    func requestPermission() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        guard speech == .authorized else {
            status = .unavailable("语音识别权限未开启。可以在系统设置里打开，或者直接输入文字。")
            return false
        }
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        guard granted else {
            status = .unavailable("麦克风权限未开启。可以在系统设置里打开，或者直接输入文字。")
            return false
        }
        return true
    }

    func start() async {
        guard status != .listening else { return }
        status = .requestingPermission

        guard await requestPermission() else { return }

        guard let recognizer, recognizer.isAvailable else {
            status = .unavailable("这台设备暂时无法使用语音识别，可以直接输入文字。")
            return
        }

        do {
            let engine = AVAudioEngine()
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            isOnDevice = recognizer.supportsOnDeviceRecognition
            // On-device recognition keeps the audio local and works offline.
            request.requiresOnDeviceRecognition = isOnDevice

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else {
                status = .unavailable("没有检测到可用的麦克风，可以直接输入文字。")
                return
            }

            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }

            engine.prepare()
            try engine.start()

            audioEngine = engine
            self.request = request
            transcript = ""
            status = .listening

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if let result {
                        self.transcript = result.bestTranscription.formattedString
                        if result.isFinal {
                            self.finish()
                        }
                    }
                    if error != nil, self.status == .listening {
                        // A recognition hiccup must not lose what we already heard.
                        self.finish()
                    }
                }
            }
        } catch {
            status = .unavailable("麦克风启动失败：\(error.localizedDescription)")
            teardown()
        }
    }

    /// Stop and keep whatever was recognized.
    func stop() {
        guard status == .listening else { return }
        request?.endAudio()
        task?.finish()
        let text = transcript
        teardown()
        status = .finished(text)
    }

    func cancel() {
        request?.endAudio()
        task?.cancel()
        teardown()
        transcript = ""
        status = .idle
    }

    func reset() {
        cancel()
        status = .idle
        audioLevel = 0
    }

    private func finish() {
        let text = transcript
        teardown()
        status = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? .unavailable("没有听清，再说一次，或者直接输入文字。")
            : .finished(text)
    }

    private func teardown() {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        request = nil
        task = nil
        audioLevel = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
