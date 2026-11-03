import Foundation
import Observation
import RelevoProtocol

@Observable
final class ThreadListViewModel {
    struct ProjectSection: Identifiable {
        let project: RemoteProject
        let threads: [RemoteThreadSummary]
        var id: UUID { project.id }
    }

    let client: CompanionClient
    var searchText = ""
    var path: [UUID] = []
    private(set) var creatingIn: UUID?

    init(client: CompanionClient) {
        self.client = client
    }

    var projects: [RemoteProject] { client.snapshot?.projects ?? [] }
    var hasSnapshot: Bool { client.snapshot != nil }

    /// Projects with their threads, newest first; when searching, only matching threads.
    var sections: [ProjectSection] {
        guard let snapshot = client.snapshot else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespaces)
        return snapshot.projects.compactMap { project in
            var threads = snapshot.threads.filter { $0.projectId == project.id }
            if !query.isEmpty {
                threads = threads.filter {
                    $0.title.localizedStandardContains(query) || ($0.preview?.localizedStandardContains(query) ?? false)
                }
                if threads.isEmpty { return nil }
            }
            return ProjectSection(project: project, threads: threads.sorted { $0.updatedAt > $1.updatedAt })
        }
    }

    var runningCount: Int { client.snapshot?.threads.filter(\.isRunning).count ?? 0 }

    func account(for thread: RemoteThreadSummary) -> RemoteAccount? { client.account(thread.accountId) }

    func newThread(in project: RemoteProject) async {
        creatingIn = project.id
        defer { creatingIn = nil }
        if let id = await client.createThread(in: project.id) { path.append(id) }
    }

    func refresh() async {
        client.send(.refreshUsage)
        try? await Task.sleep(for: .seconds(1))
    }

    func retry() { client.reconnect() }
}
