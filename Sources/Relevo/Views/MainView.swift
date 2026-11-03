import SwiftUI
import AppKit

struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 380)
        } detail: {
            Group {
                if let thread = store.selectedThread {
                    ThreadView(thread: thread, runtime: store.runtime(for: thread))
                        .id(thread.id)
                } else if store.projects.isEmpty {
                    WelcomeView()
                } else {
                    NoThreadView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.canvas)
        }
        .sheet(isPresented: $store.showNewProject) {
            NewProjectSheet()
                .environment(store)
        }
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                Text(toast)
                    .font(.callout)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(Theme.hairline))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onTapGesture { store.toast = nil }
            }
        }
        .animation(.spring(duration: 0.3), value: store.toast)
        .task { await store.bootstrap() }
        .onChange(of: store.debugRequest) {
            if store.debugRequest == "settings" {
                openSettings()
                store.debugRequest = nil
            }
        }
    }
}

enum Theme {
    static let canvas = Color(nsColor: .textBackgroundColor)
    static let hairline = Color.primary.opacity(0.09)
    static let subtleFill = Color.primary.opacity(0.045)
    static let bubble = Color.primary.opacity(0.07)
    static let contentWidth: CGFloat = 780

    static func usageColor(_ percent: Double) -> Color {
        if percent >= 90 { return .red }
        if percent >= 70 { return .orange }
        return Color.green.opacity(0.85)
    }
}

struct ProviderBadge: View {
    let kind: ProviderKind
    var size: CGFloat = 16

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(kind.tint.gradient)
            Image(systemName: kind.symbol)
                .font(.system(size: size * 0.55, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

struct WelcomeView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 10) {
                HStack(spacing: -6) {
                    ForEach(ProviderKind.allCases) { ProviderBadge(kind: $0, size: 40) }
                }
                Text("Relevo")
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                Text("Todas tus suscripciones de IA en un mismo sitio.\nCambia de agente cuando llegues a un límite sin perder el contexto.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button {
                    store.showNewProject = true
                } label: {
                    Label("Añadir proyecto", systemImage: "folder.badge.plus")
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                SettingsLink {
                    Label("Suscripciones", systemImage: "person.crop.circle.badge.checkmark")
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .controlSize(.large)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(store.accounts) { account in
                    HStack(spacing: 10) {
                        ProviderBadge(kind: account.kind, size: 18)
                        Text(account.name).frame(width: 90, alignment: .leading)
                        AccountStatusLabel(account: account)
                    }
                }
            }
            .padding(16)
            .background(Theme.subtleFill, in: RoundedRectangle(cornerRadius: 14))
        }
        .padding(40)
    }
}

struct NoThreadView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("Elige un hilo o empieza uno nuevo")
                .foregroundStyle(.secondary)
            Button("Nuevo hilo") { store.newThread() }
                .keyboardShortcut("n")
        }
    }
}

struct AccountStatusLabel: View {
    @Environment(AppStore.self) private var store
    let account: Account

    var body: some View {
        let s = store.status[account.id]
        HStack(spacing: 6) {
            if store.refreshing.contains(account.id) {
                ProgressView().controlSize(.mini)
            }
            if !account.enabled {
                Text("Desactivada").foregroundStyle(.tertiary)
            } else if Binaries.launch(for: account) == nil {
                Label("CLI no instalada", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            } else if s?.loggedIn == false {
                Label("Sin sesión", systemImage: "person.crop.circle.badge.xmark").foregroundStyle(.orange)
            } else if let s, s.loggedIn == true {
                Label([s.plan, s.email].compactMap { $0 }.joined(separator: " · ").ifEmpty("Conectada"), systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else if let err = s?.error {
                Text(err).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Text("Comprobando…").foregroundStyle(.tertiary)
            }
        }
        .font(.caption)
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

enum Formatters {
    static func reset(_ date: Date?) -> String? {
        guard let date else { return nil }
        let interval = date.timeIntervalSinceNow
        if interval <= 0 { return "ya disponible" }
        let cal = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if cal.isDateInToday(date) { return "a las \(time)" }
        if cal.isDateInTomorrow(date) { return "mañana \(time)" }
        if interval < 7 * 86_400 {
            return date.formatted(.dateTime.weekday(.abbreviated)) + " " + time
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }
}
