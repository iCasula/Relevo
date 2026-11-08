#if DEBUG
import SwiftUI

/// `-previewComposer A|B|C` (and `-previewComposerRunning YES`): three designs for the bottom of the chat screen,
/// with sample data, to pick one before changing the real composer.
struct ComposerMockupScreen: View {
    let variant: String
    let running: Bool
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    MockBubble(text: "Revisa por qué falla el test de login en el simulador", mine: true)
                    MockReply()
                    if running {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Ejecutando xcodebuild test…").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(16)
            }
            .safeAreaInset(edge: .bottom) {
                Group {
                    switch variant {
                    case "B": MockComposerB(running: running, draft: $draft)
                    case "C": MockComposerC(running: running, draft: $draft)
                    default: MockComposerA(running: running, draft: $draft)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Proclubs-iOS").font(.headline)
                        Text("Propuesta \(variant)" + (running ? " · trabajando" : " · en reposo"))
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(.yellow.opacity(0.85), in: .capsule)
                    }
                }
            }
        }
    }
}

// MARK: - Sample content

private struct MockBubble: View {
    let text: String
    let mine: Bool

    var body: some View {
        HStack {
            Spacer(minLength: 50)
            Text(text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color.accentColor.opacity(0.18), in: .rect(cornerRadius: 18))
        }
    }
}

private struct MockReply: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                MockAvatar(size: 18)
                Text("Claude · Opus 5.5").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            Text("El test falla porque `LoginViewModel` espera la respuesta antes de que el mock de red la publique. Lo arreglo esperando al publisher y vuelvo a pasar los tests.")
            Text("38k tokens · 96 % caché · ≈ $0,04").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
        }
    }
}

private struct MockAvatar: View {
    var size: CGFloat = 22
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(Color.orange.gradient)
            Image(systemName: "asterisk").font(.system(size: size * 0.55, weight: .bold)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

/// The subscription's badge with its remaining quota as a ring around it (one control instead of two).
private struct AvatarRing: View {
    var size: CGFloat = 36
    var fraction: Double = 0.66

    var body: some View {
        ZStack {
            Circle().stroke(.quaternary, lineWidth: 3)
            Circle().trim(from: 0, to: fraction)
                .stroke(Color.green, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            MockAvatar(size: size - 14)
        }
        .frame(width: size, height: size)
    }
}

private struct SendButton: View {
    let running: Bool
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: running ? "text.append" : "arrow.up")
            .font(.system(size: size * 0.42, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color.accentColor, in: .circle)
            .accessibilityLabel(running ? "Añadir a la cola (mantén para enviar ya)" : "Enviar")
    }
}

// MARK: - A: one capsule

/// Everything in one line: the badge with its quota ring opens model, reasoning and permissions;
/// the field; send inside the capsule. While working, a small strip above says so and has "Detener".
private struct MockComposerA: View {
    let running: Bool
    @Binding var draft: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if running {
                HStack(spacing: 8) {
                    Circle().fill(.orange).frame(width: 7, height: 7)
                    Text("Trabajando · 1 min").font(.footnote.weight(.medium))
                    Text("· 1 en cola").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    Button("Detener", systemImage: "stop.fill") {}
                        .font(.footnote.weight(.semibold))
                        .tint(.red)
                        .buttonStyle(.glass)
                        .controlSize(.small)
                }
                .padding(.leading, 12)
                .padding(.vertical, 4)
                .padding(.trailing, 4)
                .glassEffect(.regular, in: .capsule)
            }
            HStack(alignment: .bottom, spacing: 8) {
                AvatarRing(size: 38)
                    .padding(.bottom, 3)
                TextField("Responde o pide algo más", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.vertical, 12)
                SendButton(running: running, size: 34)
                    .padding(.bottom, 5)
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
        }
    }
}

// MARK: - B: card with a toolbar

/// The field and its controls in one card: model with its quota ring on the left, reasoning and permissions
/// as icons, stop and send on the right — all 44-pt targets in one row.
private struct MockComposerB: View {
    let running: Bool
    @Binding var draft: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Responde o pide algo más", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 14)
                .padding(.top, 12)
            HStack(spacing: 4) {
                HStack(spacing: 6) {
                    AvatarRing(size: 30, fraction: 0.66)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Opus 5.5").font(.footnote.weight(.semibold))
                        Text("66 % semana").font(.caption2).foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 8)
                .frame(height: 44)
                .contentShape(.rect)
                Image(systemName: "brain").frame(width: 44, height: 44).foregroundStyle(.secondary)
                Image(systemName: "lock.shield").frame(width: 44, height: 44).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if running {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.red)
                        .frame(width: 36, height: 36)
                        .glassEffect(.regular.interactive(), in: .circle)
                        .accessibilityLabel("Detener")
                }
                SendButton(running: running, size: 36)
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 6)
        }
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 26))
    }
}

// MARK: - C: status on top, labelled chips

/// Explicit over compact: while working, a status bar with what the agent is doing and a clear "Detener";
/// labelled chips (model with a quota bar, reasoning, permissions) above a roomy field.
private struct MockComposerC: View {
    let running: Bool
    @Binding var draft: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if running {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Trabajando · 1 min").font(.footnote.weight(.semibold))
                        Text("xcodebuild test · 1 mensaje en cola").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Detener", role: .destructive) {}
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .controlSize(.small)
                }
                .padding(10)
                .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 18))
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        MockAvatar(size: 16)
                        Text("Opus 5.5").font(.footnote.weight(.semibold))
                        Capsule().fill(.quaternary).frame(width: 30, height: 5)
                            .overlay(alignment: .leading) { Capsule().fill(.green).frame(width: 20, height: 5) }
                        Text("66 %").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10).frame(height: 34)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    Label("Alto", systemImage: "brain").font(.footnote)
                        .padding(.horizontal, 10).frame(height: 34)
                        .glassEffect(.regular.interactive(), in: .capsule)
                    Label("Permisos", systemImage: "lock.shield").font(.footnote)
                        .padding(.horizontal, 10).frame(height: 34)
                        .glassEffect(.regular.interactive(), in: .capsule)
                    Spacer(minLength: 0)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(running ? "Siguiente mensaje (va a la cola)" : "Responde o pide algo más", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
                SendButton(running: running, size: 44)
            }
        }
    }
}
#endif
