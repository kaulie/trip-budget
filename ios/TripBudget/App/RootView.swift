import SwiftUI

/// Top-level routing: onboarding → the app, plus the global error/info banners.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model

        Group {
            switch model.phase {
            case .launching:
                LaunchView()
            case .onboarding:
                OnboardingView()
            case .ready:
                MainTabView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.phase)
        .overlay(alignment: .bottom) {
            if let message = model.errorMessage {
                ToastBanner(text: message, style: .error) { model.errorMessage = nil }
            } else if let message = model.infoMessage {
                ToastBanner(text: message, style: .info) { model.infoMessage = nil }
            }
        }
    }
}

private struct LaunchView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "mic.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Theme.accent)
            Text("共享记账")
                .font(.title2.weight(.semibold))
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.groupBackground)
    }
}

/// The four places a user actually goes.
struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: Tab = .home
    @State private var isCapturing = false

    enum Tab: Hashable {
        case home
        case expenses
        case stats
        case ledgers
    }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                HomeView(onCapture: { isCapturing = true })
            }
            .tabItem { Label("首页", systemImage: "house.fill") }
            .tag(Tab.home)

            NavigationStack {
                ExpenseListView()
            }
            .tabItem { Label("账目", systemImage: "list.bullet.rectangle") }
            .tag(Tab.expenses)

            NavigationStack {
                StatsView()
            }
            .tabItem { Label("统计", systemImage: "chart.pie.fill") }
            .tag(Tab.stats)

            NavigationStack {
                LedgerListView()
            }
            .tabItem { Label("账本", systemImage: "book.closed.fill") }
            .tag(Tab.ledgers)
        }
        .task { await model.loadStats(range: "month") }
        .fullScreenCover(isPresented: $isCapturing) {
            NavigationStack {
                CaptureView()
            }
        }
    }
}

/// Transient banner for errors and confirmations.
struct ToastBanner: View {
    enum Style {
        case error
        case info
    }

    let text: String
    let style: Style
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: style == .error ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .foregroundStyle(style == .error ? Theme.expense : Theme.accent)
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .onTapGesture(perform: onDismiss)
    }
}
