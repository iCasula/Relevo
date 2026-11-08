import SwiftUI
import VisionKit

/// First run: pair with the Mac by scanning its QR code (Settings › iPhone on the Mac) or pasting the link.
struct PairingView: View {
    @State private var viewModel: PairingViewModel

    init(client: CompanionClient) {
        _viewModel = State(initialValue: PairingViewModel(client: client))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    VStack(spacing: 14) {
                        Image(systemName: "macbook.and.iphone")
                            .font(.system(size: 64, weight: .light))
                            .foregroundStyle(.tint)
                            .symbolRenderingMode(.hierarchical)
                        Text("Controla Relevo desde el iPhone")
                            .font(.title.bold())
                            .multilineTextAlignment(.center)
                        Text("Sigue tus agentes, aprueba permisos y continúa con otro proveedor sin perder el contexto.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 32)

                    VStack(alignment: .leading, spacing: 16) {
                        StepRow(number: 1, text: "En el Mac, abre Relevo › Ajustes › iPhone y activa el control desde el iPhone.")
                        StepRow(number: 2, text: "Escanea el código con la Cámara del iPhone o desde aquí.")
                        StepRow(number: 3, text: "El iPhone y el Mac deben estar en la misma red Wi‑Fi (o en tu VPN).")
                        Text("¿Un servidor sin pantalla con relevo-host? Ejecuta «relevo-host pair» en él y pega aquí el enlace.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))

                    VStack(spacing: 12) {
                        if viewModel.canScan {
                            Button {
                                viewModel.isScanning = true
                            } label: {
                                Label("Escanear código", systemImage: "qrcode.viewfinder")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.glassProminent)
                            .controlSize(.large)
                        }
                        PasteButton(payloadType: String.self) { strings in
                            viewModel.handle(strings.first)
                        }
                        .buttonBorderShape(.capsule)
                        .controlSize(.large)
                        if let error = viewModel.errorMessage {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                        }
                    }

                    Label("La conexión va cifrada con una clave que solo tienen tu Mac y este iPhone. No pasa por ningún servidor.", systemImage: "lock.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
            }
            .sheet(isPresented: $viewModel.isScanning) {
                ScannerSheet { code in viewModel.handle(code) }
            }
        }
    }
}

private struct StepRow: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.headline)
                .frame(width: 26, height: 26)
                .background(.tint.opacity(0.15), in: Circle())
                .foregroundStyle(.tint)
            Text(text)
                .font(.callout)
        }
    }
}

private struct ScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            QRScannerView(onCode: onCode)
                .ignoresSafeArea()
                .navigationTitle("Escanear código")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancelar", role: .cancel) { dismiss() }
                    }
                }
        }
    }
}

/// VisionKit live scanner limited to QR codes.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
                                                isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var handled = false

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !handled else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                    handled = true
                    onCode(payload)
                    return
                }
            }
        }
    }
}
