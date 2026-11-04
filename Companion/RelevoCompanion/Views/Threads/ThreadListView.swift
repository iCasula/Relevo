import SwiftUI
import RelevoProtocol
import RelevoMarkdown

struct ThreadListView: View {
    @State private var viewModel: ThreadListViewModel
    @Environment(AppRouter.self) private var router

    init(client: CompanionClient) {
        _viewModel = State(initialValue: ThreadListViewModel(client: client))
    }

    var body: some View {
        NavigationStack(path: $viewModel.path) {
            content
                .navigationTitle("Hilos")
                .navigationDestination(for: UUID.self) { id in
                    ThreadDetailView(client: viewModel.client, threadId: id)
                }
                .toolbar { toolbar }
        }
        // Live Activity taps (and debug launch arguments) open a thread once the Mac's data is here.
        .onChange(of: router.threadToOpen, initial: true) { openPendingThread() }
        .onChange(of: viewModel.hasSnapshot) { openPendingThread() }
    }

    private func openPendingThread() {
        guard viewModel.hasSnapshot, let id = router.threadToOpen else { return }
        router.threadToOpen = nil
        viewModel.path = [id]
    }

    @ViewBuilder
    private var content: some View {
        if !viewModel.hasSnapshot {
            ContentUnavailableView {
                Label("Conectando con el Mac", systemImage: "macbook.and.iphone")
            } description: {
                ConnectionStatusRow(state: viewModel.client.state, macName: viewModel.client.pairing?.name ?? "el Mac",
                                    retry: viewModel.retry)
            }
        } else {
            List {
                if !viewModel.client.isConnected {
                    Section {
                        ConnectionStatusRow(state: viewModel.client.state, macName: viewModel.client.snapshot?.macName ?? "el Mac",
                                            retry: viewModel.retry)
                    }
                }
                ForEach(viewModel.sections) { section in
                    Section {
                        if section.threads.isEmpty {
                            Text("Sin hilos todavía")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(section.threads) { thread in
                            NavigationLink(value: thread.id) {
                                ThreadRow(thread: thread, account: viewModel.account(for: thread), isLive: viewModel.client.isConnected)
                            }
                        }
                    } header: {
                        ProjectHeader(project: section.project, isCreating: viewModel.creatingIn == section.project.id) {
                            Task { await viewModel.newThread(in: section.project) }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $viewModel.searchText, prompt: "Buscar hilos")
            .refreshable { await viewModel.refresh() }
            .overlay {
                if viewModel.sections.isEmpty {
                    if viewModel.searchText.isEmpty {
                        ContentUnavailableView("Sin proyectos", systemImage: "folder",
                                               description: Text("Añade un proyecto en Relevo para Mac y aparecerá aquí."))
                    } else {
                        ContentUnavailableView.search(text: viewModel.searchText)
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Section("Nuevo hilo en…") {
                    ForEach(viewModel.projects) { project in
                        Button(project.name, systemImage: "folder") {
                            Task { await viewModel.newThread(in: project) }
                        }
                    }
                }
            } label: {
                Label("Nuevo hilo", systemImage: "square.and.pencil")
            }
            .disabled(viewModel.projects.isEmpty || !viewModel.client.isConnected)
        }
        if viewModel.runningCount > 0 && viewModel.client.isConnected {
            ToolbarItem(placement: .topBarLeading) {
                Label("\(viewModel.runningCount) trabajando", systemImage: "circle.dotted")
                    .labelStyle(.titleAndIcon)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .symbolEffect(.rotate, options: .repeat(.continuous))
            }
        }
    }
}

private struct ProjectHeader: View {
    let project: RemoteProject
    let isCreating: Bool
    let newThread: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(project.name)
                Text(project.path)
                    .font(.caption2)
                    .textCase(nil)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if isCreating {
                ProgressView()
            } else {
                Button("Nuevo hilo en \(project.name)", systemImage: "plus", action: newThread)
                    .labelStyle(.iconOnly)
            }
        }
    }
}

struct ThreadRow: View {
    let thread: RemoteThreadSummary
    let account: RemoteAccount?
    /// Without a connection the agent state could be old, so it isn't shown.
    var isLive = true

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProviderBadge(account: account, size: 28)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(thread.title)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(thread.updatedAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let preview = thread.preview, !preview.isEmpty {
                    Text(MarkdownInline.plain(preview))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if !isLive {
                    EmptyView()
                } else if thread.needsApproval {
                    Label("Esperando tu aprobación", systemImage: "hand.raised.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                } else if thread.isRunning {
                    Label("Trabajando…", systemImage: "circle.dotted")
                        .font(.caption)
                        .foregroundStyle(.tint)
                        .symbolEffect(.rotate, options: .repeat(.continuous))
                } else if thread.isWaiting == true {
                    Label("Esperando a una tarea en segundo plano", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
