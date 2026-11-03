import SwiftUI
import RelevoProtocol

/// Current and weekly limits of every subscription, like the Mac sidebar.
struct LimitsView: View {
    @State private var viewModel: LimitsViewModel

    init(client: CompanionClient) {
        _viewModel = State(initialValue: LimitsViewModel(client: client))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.hasSnapshot {
                    List {
                        ForEach(viewModel.accounts) { account in
                            Section {
                                AccountLimitsView(account: account)
                            }
                        }
                    }
                    .refreshable { await viewModel.refresh() }
                } else {
                    ContentUnavailableView("Sin datos del Mac", systemImage: "gauge.with.dots.needle.0percent",
                                           description: Text("Los límites aparecen al conectar con Relevo en el Mac."))
                }
            }
            .navigationTitle("Límites")
        }
    }
}

private struct AccountLimitsView: View {
    let account: RemoteAccount

    var body: some View {
        HStack(spacing: 12) {
            ProviderBadge(account: account, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
                    .font(.headline)
                Text(account.status?.email ?? account.agentName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if account.refreshing {
                ProgressView()
            } else if let plan = account.status?.plan {
                Text(plan)
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.fill.tertiary, in: Capsule())
            }
        }

        if let status = account.status {
            if status.loggedIn == false {
                Label("Sin sesión: inicia sesión desde el Mac", systemImage: "person.crop.circle.badge.exclamationmark")
                    .foregroundStyle(.orange)
            } else if status.noPlan {
                Label(status.error ?? "El plan no incluye este servicio", systemImage: "creditcard.trianglebadge.exclamationmark")
                    .foregroundStyle(.orange)
            } else if status.windows.isEmpty {
                Text(status.error ?? status.note ?? "Sin datos de uso todavía")
                    .foregroundStyle(.secondary)
            }
            ForEach(status.windows) { window in
                UsageWindowView(window: window)
            }
            if let updated = status.updatedAt {
                Text("Actualizado \(updated, format: .relative(presentation: .named))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else {
            Text("Sin datos de uso todavía").foregroundStyle(.secondary)
        }
    }
}
