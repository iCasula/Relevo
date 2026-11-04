import Foundation
import AppKit
import SwiftUI
import RelevoProtocol

/// Maps the Mac's models to the transfer objects the iPhone companion receives.
@MainActor
enum CompanionMapper {
    /// Newest transcript entries sent to the phone (older ones stay on the Mac).
    static let transcriptLimit = 300

    static func snapshot(_ store: AppStore) -> RemoteSnapshot {
        RemoteSnapshot(
            macName: CompanionCredentials.macName,
            accounts: store.enabledAccounts.map { account($0, store: store) },
            projects: store.projects.map { RemoteProject(id: $0.id, name: $0.name, path: abbreviateHome($0.path)) },
            threads: store.threads.map { summary($0, store: store) },
            autoRelay: store.settings.autoRelay,
            pushReady: LiveActivityPusher.shared.isConfigured
        )
    }

    static func account(_ a: Account, store: AppStore) -> RemoteAccount {
        RemoteAccount(
            id: a.id, kind: a.kind.rawValue, name: a.name, agentName: a.kind.agentName, symbol: a.kind.symbol,
            tint: hex(a.kind.tint), usesAPIKey: a.kind.usesAPIKey, status: store.status[a.id].map(status),
            models: store.modelsFor(a).map(model), defaultModel: store.defaultModel(for: a),
            refreshing: store.refreshing.contains(a.id)
        )
    }

    static func status(_ s: AccountStatus) -> RemoteStatus {
        RemoteStatus(
            loggedIn: s.loggedIn, plan: s.plan, email: s.email,
            windows: s.windows.map { RemoteWindow(id: $0.id, label: $0.label, percent: $0.percent, resetsAt: $0.resetsAt, detail: $0.detail) },
            error: s.error, note: s.note, noPlan: s.noPlan == true, exhausted: s.isExhausted, updatedAt: s.updatedAt
        )
    }

    static func model(_ m: ModelOption) -> RemoteModel {
        RemoteModel(id: m.id, name: m.name, detail: m.detail, efforts: m.efforts, defaultEffort: m.defaultEffort)
    }

    static func summary(_ t: ThreadModel, store: AppStore) -> RemoteThreadSummary {
        let recent = t.items.suffix(60)
        let preview = recent.last { $0.kind == .assistant || $0.kind == .user }?.text
        return RemoteThreadSummary(
            id: t.id, projectId: t.projectId, title: t.title, updatedAt: t.updatedAt,
            isRunning: store.existingRuntime(t.id)?.isRunning ?? false,
            needsApproval: pendingApproval(t, store: store) != nil,
            accountId: t.segments.last?.accountId ?? t.selectedAccountId,
            preview: preview.map { String($0.replacingOccurrences(of: "\n", with: " ").prefix(140)) }
        )
    }

    /// Unanswered permission request of a live session (old ones left over from a previous launch don't count).
    static func pendingApproval(_ t: ThreadModel, store: AppStore) -> ChatItem? {
        guard store.existingRuntime(t.id) != nil else { return nil }
        return t.items.suffix(40).last { $0.kind == .approval && $0.resolution == nil }
    }

    /// The Live Activity: the thread that matters most (needs you > limit > working > just finished).
    static func activity(_ store: AppStore) -> RelevoActivityState {
        let now = Date()
        let threads = store.threads.sorted { $0.updatedAt > $1.updatedAt }
        let waiting = threads.filter { pendingApproval($0, store: store) != nil }
        let running = threads.filter { store.existingRuntime($0.id)?.isRunning == true }
        func state(_ t: ThreadModel, _ phase: RelevoActivityState.Phase, status: String?, approval: RelevoActivityState.Approval? = nil) -> RelevoActivityState {
            let segment = t.segments.last
            let account = store.account(segment?.accountId ?? t.selectedAccountId)
            return RelevoActivityState(
                phase: phase, threadId: t.id, threadTitle: t.title, accountName: account?.name, symbol: account?.kind.symbol,
                tint: account.map { hex($0.kind.tint) }, model: account.map { store.modelName($0, segment?.model ?? t.selectedModel ?? "") },
                statusLine: status.map { String($0.replacingOccurrences(of: "\n", with: " ").prefix(160)) }, approval: approval,
                running: running.count, waiting: waiting.count, updatedAt: now.timeIntervalSince1970)
        }
        if let t = waiting.first, let item = pendingApproval(t, store: store) {
            if let questions = item.questions, let first = questions.first {
                // Questions are answered in the app (options + free text don't fit on the Lock Screen).
                let approval = RelevoActivityState.Approval(
                    itemId: item.id, title: first.question,
                    detail: first.options.map(\.label).joined(separator: " · "), options: [])
                return state(t, .needsYou, status: "Te ha hecho una pregunta · toca para responder", approval: approval)
            }
            let approval = RelevoActivityState.Approval(
                itemId: item.id, title: item.title ?? "Permiso", detail: item.text.isEmpty ? nil : String(item.text.prefix(240)),
                options: (item.options ?? []).prefix(3).map { RemoteOption(id: $0.id, label: $0.label, isAllow: $0.isAllow) })
            return state(t, .needsYou, status: "Esperando tu aprobación", approval: approval)
        }
        if let t = threads.first(where: { store.existingRuntime($0.id)?.limit != nil }), let limit = store.existingRuntime(t.id)?.limit {
            let reset = Formatters.reset(limit.resetsAt).map { " · se reinicia \($0)" } ?? ""
            let what = limit.isNoPlan ? "El plan no incluye el servicio" : limit.isCapacity ? "Modelo saturado" : "Límite alcanzado"
            return state(t, .limit, status: what + reset + " · relévalo a otro agente")
        }
        if let t = running.first {
            let rt = store.existingRuntime(t.id)
            let lastTool = t.items.suffix(20).last { $0.kind == .tool }?.title
            return state(t, .working, status: rt?.statusLine ?? lastTool ?? "Trabajando…")
        }
        if let t = threads.first, now.timeIntervalSince(t.updatedAt) < 15 * 60, t.items.last?.kind == .assistant {
            return state(t, .finished, status: t.items.last?.text)
        }
        return .idle
    }

    static func thread(_ t: ThreadModel, store: AppStore) -> RemoteThread {
        RemoteThread(id: t.id, title: t.title, items: t.items.suffix(transcriptLimit).map(item),
                     totalItems: t.items.count, runtime: runtime(t, store: store))
    }

    static func runtime(_ t: ThreadModel, store: AppStore) -> RemoteRuntime {
        let rt = store.runtime(for: t)
        let account = store.account(t.selectedAccountId) ?? store.preferredAccount()
        let current = t.segments.last?.accountId ?? account?.id
        let model = account.map { t.selectedModel ?? store.defaultModel(for: $0) }
        let status = account.flatMap { store.status[$0.id] }
        var usage: [UsageWindow] = status?.windows ?? []
        if let account, let model, let option = store.modelOption(account, model) {
            usage = account.kind.provider.usageWindows(usage, model: option)
        }
        return RemoteRuntime(
            isRunning: rt.isRunning, statusLine: rt.statusLine,
            limit: rt.limit.map { RemoteLimit(accountId: $0.accountId, message: $0.message, resetsAt: $0.resetsAt, isCapacity: $0.isCapacity, isNoPlan: $0.isNoPlan) },
            suggestion: rt.suggester.suggestion.map {
                RemoteSuggestion(accountId: $0.accountId, model: $0.model, effort: $0.effort, reasons: $0.reasons,
                                 autoApplied: rt.suggester.autoApplied, byAI: $0.profile.byAI)
            },
            mode: RemoteMode(rawValue: t.mode.rawValue) ?? .ask,
            selectedAccountId: account?.id,
            selectedModel: account.map { t.selectedModel ?? store.defaultModel(for: $0) },
            selectedEffort: t.selectedEffort,
            relayCandidates: store.relayCandidates(excluding: current.map { [$0] } ?? []).map { RemoteCandidate(accountId: $0.account.id, model: $0.model) },
            queued: rt.queue.map { RemoteQueuedMessage(id: $0.id, text: $0.text) },
            queuePaused: rt.queuePaused,
            usage: usage.map { RemoteWindow(id: $0.id, label: $0.label, percent: $0.percent, resetsAt: $0.resetsAt, detail: $0.detail) },
            usageNote: usage.isEmpty ? status?.note : nil
        )
    }

    static func item(_ i: ChatItem) -> RemoteItem {
        RemoteItem(
            id: i.id, kind: RemoteItem.Kind(rawValue: i.kind.rawValue) ?? .notice, text: i.text, title: i.title,
            output: i.output, toolName: i.toolName, toolState: i.status.flatMap { RemoteItem.ToolState(rawValue: $0.rawValue) },
            accountId: i.accountId, model: i.model, date: i.date,
            options: i.options?.map { RemoteOption(id: $0.id, label: $0.label, isAllow: $0.isAllow) }, resolution: i.resolution,
            questions: i.questions?.map { q in
                RemoteQuestion(question: q.question, header: q.header,
                               options: q.options.map { RemoteQuestion.Option(label: $0.label, description: $0.description) },
                               multiSelect: q.multiSelect)
            },
            answers: i.answers,
            usage: i.usage.map { u in
                RemoteTurnUsage(tokens: u.tokens.total, cacheShare: u.tokens.cacheShare, cost: u.cost, costEstimated: u.costEstimated, paid: u.paid,
                                switchLabel: u.switchKind?.label, switchDetail: u.switchDetail, overhead: u.overhead, overheadCost: u.overheadCost,
                                context: u.context, contextWindow: u.contextWindow)
            }
        )
    }

    static func hex(_ color: Color) -> String {
        guard let c = NSColor(color).usingColorSpace(.sRGB) else { return "#808080" }
        return String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}
