import SwiftUI
import RelevoProtocol
import RelevoMarkdown

struct RootView: View {
    @Environment(CompanionClient.self) private var client
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content
        .animation(.default, value: client.pairing == nil)
        .onChange(of: scenePhase, initial: true) {
            client.setActive(scenePhase == .active)
        }
        .overlay(alignment: .top) { ToastView() }
    }

    @ViewBuilder
    private var content: some View {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "previewActivity") {
            ActivityPreviewGallery()
        } else if UserDefaults.standard.bool(forKey: "previewMarkdown") {
            ScrollView { MarkdownView(MarkdownSample.text).padding() }
        } else if let variant = UserDefaults.standard.string(forKey: "previewComposer") {
            ComposerMockupScreen(variant: variant, running: UserDefaults.standard.bool(forKey: "previewComposerRunning"))
        } else {
            main
        }
        #else
        main
        #endif
    }

    @ViewBuilder
    private var main: some View {
        if client.pairing == nil {
            PairingView(client: client)
        } else {
            MainTabView(client: client)
        }
    }
}

struct MainTabView: View {
    let client: CompanionClient
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("Hilos", systemImage: "bubble.left.and.text.bubble.right", value: AppTab.threads) {
                ThreadListView(client: client)
            }
            .badge(client.pendingApprovals)

            Tab("Límites", systemImage: "gauge.with.dots.needle.50percent", value: AppTab.limits) {
                LimitsView(client: client)
            }

            Tab("Ajustes", systemImage: "gearshape", value: AppTab.settings) {
                SettingsView(client: client)
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
    }
}

/// Short messages from the Mac or the connection ("Sin conexión con el Mac"…).
struct ToastView: View {
    @Environment(CompanionClient.self) private var client

    var body: some View {
        if let text = client.toast {
            Text(text)
                .font(.callout)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassEffect()
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: text) {
                    try? await Task.sleep(for: .seconds(3))
                    withAnimation { client.toast = nil }
                }
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

#if DEBUG
/// `-previewActivity YES`: the Live Activity Lock Screen design for every phase (the simulator can't be locked from scripts).
struct ActivityPreviewGallery: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                ForEach([RelevoActivityState.Phase.needsYou, .working, .limit, .finished], id: \.self) { phase in
                    ActivityLockScreenView(state: DemoActivity.sample(phase), macName: "MacBook Pro")
                        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .environment(\.colorScheme, .dark)
                }
            }
            .padding(12)
        }
        .background(LinearGradient(colors: [.indigo, .purple, .orange], startPoint: .top, endPoint: .bottom))
    }
}
#endif
