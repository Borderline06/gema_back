# Asistencia - Documentación Técnica (Antigravity 🚀)

## 1. Estructura de Archivos
Este feature maneja el control de puntualidad, faltas, asistencias regulares y registro de clases de recuperación.
```text
src/features/asistencia/
├── asistencia.routes.js       # Rutas (GET, POST)
├── asistencia.controller.js   # Interacción HTTP y apiResponse
├── asistencia.service.js      # Lógica pesada, interacción con Prisma y recuperaciones
└── asistencia.schema.js       # Validaciones Zod (Parámetros, Queries y Body Masiva)
```

## 2. Modelo de Datos
```mermaid
erDiagram
  REGISTROS_ASISTENCIA {
    Int id PK
    Int inscripcion_id FK
    DateTime fecha
    String estado "PRESENTE, FALTA, JUSTIFICADO_LESION, PROGRAMADA"
    String comentario
  }
  INSCRIPCIONES ||--o{ REGISTROS_ASISTENCIA : tiene
  HORARIOS_CLASES ||--o{ INSCRIPCIONES : inscribe
  MODULOS_MESES ||--o{ INSCRIPCIONES : agrupa
  RECUPERACIONES |o--| REGISTROS_ASISTENCIA : "puede convertirse de falta"
```

## 3. Endpoints

Todas las rutas requieren token (`authenticate`).

| Método | Endpoint | Roles Permitidos | Zod Schema | Descripción |
|---|---|---|---|---|
| GET | `/` | Administrador, Coordinador | *Ninguno* | Lista historial general de todas las asistencias. |
| GET | `/alumno/:alumnoId` | Admin, Coordinador, Alumno | `alumnoIdParamSchema` | Lista las asistencias históricas de un alumno. |
| GET | `/agenda/hoy` | Coordinador | `agendaQuerySchema` | Lista las clases que tiene asignadas el coordinador en el día consultado. |
| GET | `/agenda` | Coordinador | `agendaQuerySchema` | Lista general de la agenda de clases para un coordinador (filtrable). |
| GET | `/choques-recuperacion` | Administrador, Coordinador | `choquesRecuperacionQuerySchema` | 🆕 BL-010: previsualiza (solo lectura) qué clases del ciclo chocarían con una recuperación ya agendada. |
| POST | `/masiva` | Coordinador | `masivaSchema` | Marca un lote de `asistencias` simultáneas. |

## 4. Cadena de Middlewares

Ejemplo del flujo de seguridad para `/masiva`:
1. `authenticate`: Verifica que el Token JWT sea válido y activo.
2. `authorize('Coordinador')`: Verifica el rol en DB del usuario.
3. `validate(asistenciaSchema.masivaSchema)`: Asegura que viene el arreglo de asistencias con estructura limpia (ID y Estado válido).
4. `asistenciaController.marcarAsistenciaMasiva`: Invoca el servicio.

## 5. Schemas Zod

| Schema | Propósito | Se usa en | Uso en Middleware |
|---|---|---|---|
| `alumnoIdParamSchema` | Valida que `req.params.alumnoId` sea un string parseable a número positivo. | `/alumno/:alumnoId` | `validateParams` |
| `agendaQuerySchema` | Asegura formato *datetime* (opcional) del query param para la agenda. | `/agenda`, `/agenda/hoy` | `validateQuery` |
| `masivaSchema` | Fuerza un array mínimo de 1 asistencia. Soporta IDs enteros y IDs sintéticos (ej. `reg-asis-recu-123`). | `/masiva` | `validate` |
| `choquesRecuperacionQuerySchema` | Exige `inscripcion_id` numérico positivo; `fecha_inicio` (`YYYY-MM-DD`) es opcional y la revalida `parsearFechaInicioCiclo` en el service, que además rechaza fechas imposibles como `2026-02-30`. | `/choques-recuperacion` | `validateQuery` |

## 6. Lógica Core del Service

El archivo `asistencia.service.js` delega procesamiento intenso y delegaciones a transacciones ACID:
* **`generarClasesPorConteo` / `depurarClasesParaCambioHorario` / `trasladarClasesDelCiclo`:** Cambio de horario REGULAR por **conteo de clases**, no por tope de fechas (el plan de 1 día/semana vende `CLASES_POR_CICLO = 5` clases). `updateInscripcion` conserva lo ya consumido (pasado o PRESENTE/FALTA) y lo traslada a la inscripción nueva, borra solo lo futuro del horario viejo y genera `5 − consumidas` desde hoy, saltando feriados sin gastar cupo. `fecha_fin_ciclo` del link **no se escribe** (invariante BL-006: vigente = NULL): si la última clase pasa del cierre del VERDUGO (`fecha_inscripcion + 30`), se corre `fecha_inscripcion` + `fecha_inicio_ciclo` lo justo. Lógica pura en `shared/utils/cambio-horario.util.js`.
* **`generarClasesFuturas:`** Algoritmo que genera los registros (`PROGRAMADA`) masivamente hacia un límite de 30 días, empalmando ciclos o aceptando una fecha manual. Se usa un `createMany` con `skipDuplicates: true` de forma optimizada.
  * 🤝 **BL-010 — choque con recuperaciones (bloqueo 409).** Antes de insertar, cruza las fechas del ciclo contra las recuperaciones del alumno en estado **estrictamente `PROGRAMADA`** (`shared/utils/recuperacion-slot.util.js`, mismo patrón `cargar*`/`buscar*` de `feriado.util.js`: **una** consulta, decisión pura en `detectarChoquesCiclo`). El choque se define como **mismo día + misma `hora_inicio`**, aunque sea en otra cancha. Las `COMPLETADA_*`, `VENCIDA` y `PENDIENTE` no bloquean.
  * ⛔ **Si hay choque, lanza `ApiError` 409 y no inserta nada.** Los llamadores corren dentro de una `$transaction` (`validarPago`, `updateInscripcion`), así que el throw la revierte completa. El backend bloquea por defecto; que el admin pueda "forzar" queda para un ticket futuro. Forma del JSON: `{ success: 'error', message, details: { codigo: 'CHOQUE_RECUPERACION', fecha, hora, inscripcion_id, choques: [{ fecha, hora, recuperacion_id, estado_recuperacion }] } }` (`fecha`/`hora` = primer choque; `choques` los lista todos). El endpoint de cambio de horario (`updateInscripcion`) lo devuelve tal cual; `validarPagoAdmin` (envelope `{ status, message }`) añade `details` y responde 409 **solo** para este error — el resto sigue siendo 400.
  * 🔍 **`validarChoquesCiclo(tx, params)`:** misma ruta que `generarClasesFuturas` con `dryRun: true` (calcula y valida, no inserta). `validarPago` lo ejecuta para todas las inscripciones `POR_VALIDAR` **antes** de mutar inscripción, ciclo o clases.
  * ⚠️ **Riesgo conocido:** al contar solo `PROGRAMADA`, un ciclo retroactivo que caiga sobre una recuperación ya `COMPLETADA_PRESENTE` puede perder la clase regular en silencio (la fila física `[RECUPERACION]` ocupa el `@@unique([inscripcion_id, fecha])` y `skipDuplicates` la descarta). Para cubrirlo basta añadir el estado a `ESTADOS_RECUPERACION_OCUPAN_SLOT`.
* **`previsualizarChoquesRecuperacion:`** 🆕 BL-010. Solo lectura. Reusa la MISMA aritmética que la generación real (`calcularProximasFechas` + `detectarChoquesCiclo`), así que lo que muestra es por construcción lo que va a pasar. Responde HTTP **200** (es una consulta previa; el 409 lo da la generación). Conserva las llaves `hay_choques`, `total_choques`, `choques` y `omitidas` (esta última siempre `[]`: ya no se reubica nada).
* **`procesarAsistenciaMasiva:`** Contiene un ciclo robusto empaquetado en una gran transacción `$transaction`:
  * Detecta si la asistencia viene de un registro de *Recuperación* (IDs como `reg-asis-recu-X`) e intercepta marcándolo en `recuperaciones`.
  * Filtra las justificaciones de lesión (`JUSTIFICADO_LESION`).
  * Al marcar una `FALTA`, contacta dinámicamente al **`recuperacionService`** para generar un ticket pendiente de recuperación.
  * Al revertir una falta a `PRESENTE`, interactúa nuevamente con el **`recuperacionService`** para **anular** el ticket de recuperación que ya se haya creado.
* **`obtenerAgendaCoordinador:`** Obtiene el formato especial (`horariosProcesados`) en el que inyecta programáticamente a los alumnos que asisten por recuperación ese día (camuflándolos para que aparezcan en la app del coordinador con estado de recuperar). Mínima latencia gracias a los bloqueos de mutación optimistas.
