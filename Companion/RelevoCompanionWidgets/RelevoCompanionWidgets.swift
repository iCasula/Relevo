import ActivityKit
import SwiftUI
import WidgetKit
import RelevoProtocol

@main
struct RelevoCompanionWidgets: WidgetBundle {
    var body: some Widget {
        RelevoLiveActivity()
    }
}

/// Lock Screen and Dynamic Island: what the agents are doing and whether one needs you.
struct RelevoLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RelevoActivityAttributes.self) { context in
            ActivityLockScreenView(state: context.state, macName: context.attributes.macName, isStale: context.isStale)
                .widgetURL(DeepLink.thread(context.state.threadId))
                .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActivityProviderBadge(state: state, size: 34)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PhaseBadge(phase: state.phase, isStale: context.isStale)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 1) {
                        Text(state.threadTitle.isEmpty ? "Relevo" : state.threadTitle)
                            .font(.headline)
                            .lineLimit(1)
                        if !state.subtitle.isEmpty {
                            Text(state.subtitle)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        if let approval = state.approval {
                            Text(approval.title)
                                .font(.system(.caption, design: .monospaced))
                                .lineLimit(2)
                            ApprovalButtons(state: state, approval: approval)
                        } else if context.isStale {
                            Text("Sin actualizar · abre Relevo para ver cómo va")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else if let status = state.statusLine {
                            Text(status)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                Image(systemName: state.symbol ?? "arrow.triangle.2.circlepath")
                    .foregroundStyle(state.tintColor)
            } compactTrailing: {
                Image(systemName: context.isStale ? "clock.badge.questionmark" : state.phase.symbol)
                    .foregroundStyle(context.isStale ? .gray : state.phase.color)
            } minimal: {
                Image(systemName: state.phase == .needsYou ? state.phase.symbol : (state.symbol ?? state.phase.symbol))
                    .foregroundStyle(state.phase == .needsYou ? state.phase.color : state.tintColor)
            }
            .widgetURL(DeepLink.thread(state.threadId))
            .keylineTint(state.phase == .needsYou ? .orange : state.tintColor)
        }
    }
}
