import Foundation

/// Gives each conversation a short topic as its title, using the cheapest available model with no
/// reasoning. If the first message has no real context ("hola"), it waits for the next one.
@MainActor
enum TopicNamer {
    static let maxAttempts = 3

    static let system = """
    Eres un titulador de conversaciones de programación. Devuelve SOLO un título de 2 a 6 palabras, en el idioma del usuario, \
    que diga de qué trata la conversación (la tarea o el tema, no el saludo). Sin comillas, sin emojis y sin punto final. \
    Si los mensajes no dan contexto suficiente para saberlo (saludos, pruebas, «hola», «¿estás ahí?»), responde exactamente: ESPERAR
    """

    static func maybeName(_ thread: ThreadModel, store: AppStore) {
        guard store.settings.autoTopics, thread.titleSource != .manual, thread.titleSource != .ai else { return }
        let userMessages = thread.items.filter { $0.kind == .user }.map(\.text)
        guard !userMessages.isEmpty, userMessages.count > thread.topicAttempts, thread.topicAttempts < maxAttempts else { return }
        guard let (account, provider) = store.topicProvider() else { return }
        thread.topicAttempts = userMessages.count
        let prompt = "Mensajes del usuario, en orden:\n" + userMessages.prefix(maxAttempts)
            .map { "- " + String($0.replacingOccurrences(of: "\n", with: " ").prefix(600)) }.joined(separator: "\n")
        Task { @MainActor in
            guard let raw = await provider.quickCompletion(account: account, system: system, prompt: prompt) else { return }
            guard let topic = clean(raw), thread.titleSource == .provisional else { return }
            thread.title = topic
            thread.titleSource = .ai
            store.save(thread)
        }
    }

    /// Lets the user ask for a fresh AI title.
    static func regenerate(_ thread: ThreadModel, store: AppStore) {
        thread.titleSource = .provisional
        thread.topicAttempts = 0
        maybeName(thread, store: store)
    }

    static func clean(_ raw: String) -> String? {
        var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = t.split(separator: "\n").first { t = String(first) }
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: "\"'«»“”`*#.:- ").union(.whitespaces))
        if t.isEmpty || t.uppercased().contains("ESPERAR") || t.count > 80 { return nil }
        return String(t.prefix(60))
    }
}
