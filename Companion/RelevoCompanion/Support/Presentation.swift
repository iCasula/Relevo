import SwiftUI
import RelevoProtocol

extension Color {
    /// "#RRGGBB" → Color (falls back to gray).
    init(hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else {
            self = .gray
            return
        }
        self.init(.sRGB,
                  red: Double((value >> 16) & 0xFF) / 255,
                  green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}

extension RemoteAccount {
    var tintColor: Color { Color(hex: tint) }

    func model(_ id: String?) -> RemoteModel? {
        guard let id else { return nil }
        return models.first { $0.id == id }
    }

    func modelName(_ id: String?) -> String {
        model(id)?.name ?? ((id?.isEmpty ?? true) ? "Predeterminado" : id!)
    }

    /// Short status shown next to the name in pickers ("agotada", "sin sesión"…).
    var availabilityNote: String? {
        guard let s = status else { return nil }
        if s.loggedIn == false { return "sin sesión" }
        if s.noPlan { return "plan sin acceso" }
        if s.exhausted { return "agotada" }
        if !s.windows.isEmpty { return "\(Int(s.maxPercent.rounded())) % usado" }
        return nil
    }
}

extension RemoteWindow {
    var tint: Color {
        if percent >= 90 { return .red }
        if percent >= 70 { return .orange }
        return .green
    }
}

extension RemoteMode {
    var label: String {
        switch self {
        case .ask: "Pedir permiso"
        case .autoEdit: "Auto-editar"
        case .full: "Acceso total"
        case .plan: "Solo planificar"
        }
    }

    var symbol: String {
        switch self {
        case .ask: "hand.raised"
        case .autoEdit: "pencil.line"
        case .full: "bolt.shield"
        case .plan: "list.bullet.clipboard"
        }
    }

    var help: String {
        switch self {
        case .ask: "El agente pide aprobación antes de ejecutar comandos o editar."
        case .autoEdit: "Edita ficheros sin preguntar; pide permiso para comandos."
        case .full: "Sin confirmaciones. Úsalo solo en proyectos de confianza."
        case .plan: "Solo lectura: analiza y propone un plan sin tocar nada."
        }
    }
}

enum EffortLabel {
    static func name(_ effort: String) -> String {
        switch effort.lowercased() {
        case "none": "Sin razonamiento"
        case "minimal": "Mínimo"
        case "low": "Bajo"
        case "medium": "Medio"
        case "high": "Alto"
        case "xhigh": "Muy alto"
        case "max": "Máximo"
        case "ultra": "Ultra"
        case "disabled": "Desactivado"
        case "enabled": "Activado"
        default: effort.capitalized
        }
    }
}

enum ResetFormatter {
    /// "a las 19:16", "mañana 0:59", "jue 1:00"…
    static func string(_ date: Date?) -> String? {
        guard let date else { return nil }
        let interval = date.timeIntervalSinceNow
        if interval <= 0 { return "ya disponible" }
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "a las \(time)" }
        if calendar.isDateInTomorrow(date) { return "mañana \(time)" }
        if interval < 7 * 86_400 { return date.formatted(.dateTime.weekday(.abbreviated)) + " " + time }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
