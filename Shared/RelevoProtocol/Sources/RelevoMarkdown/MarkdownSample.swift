import Foundation

/// Representative agent reply used to check the renderer on both platforms.
public enum MarkdownSample {
    public static let text = """
    ## Auditoría de `proclubs-ios`

    He revisado el proyecto. **Resumen**: compila, pero hay *tres* cosas a corregir.

    ### Hallazgos

    | Área | Estado | Prioridad |
    |---|:---:|---:|
    | Seguridad: clave `.p8` en el repo | ❌ | Alta |
    | Logging con `print` | ⚠️ | Media |
    | Tests de UI | ✅ | — |

    1. **Mover la clave** fuera del repositorio
       (por ejemplo a `~/.appstoreconnect/private_keys`).
    2. Sustituir `print` por `os.Logger`:
       - en `NetworkClient.swift`
       - en `PaywallViewModel.swift`
    3. Revisar el [changelog](https://example.com/changelog).

    - [x] Compila en Release
    - [ ] Subir build a TestFlight

    > Nota: no he tocado nada sin tu permiso.
    > Puedes pedirme que lo aplique.

    ---

    ```swift
    let logger = Logger(subsystem: "app.proclubs", category: "network")
    logger.debug("GET \\(url, privacy: .public)")
    ```
    """
}
