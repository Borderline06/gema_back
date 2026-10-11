# Separación de sedes: informe de investigación (dump de prueba 2026-10-03)

Base analizada: `test-gema` (PG 18.1, 35 tablas, 47 FK) restaurada como `test-gema-migration` dentro del contenedor `bankhub-postgres`. `bankhub` no se tocó. Copias destructivas: `test-gema-exp-a` (poda confirmada, K={11,12}); la copia del escenario K={5} se hizo con rollback y ya se borró.

> El dump es PG18 (formato 1.16); el `pg_restore` del contenedor (16) no lo lee. Se usó `postgres:18-alpine` efímero solo como cliente (`docker run --rm`). El único error de restauración es `SET transaction_timeout` (inocuo).

## 1. Conclusión corta

**"Copiar y borrar las sedes que no corresponden" no funciona tal cual**, pero una **poda explícita y ordenada sobre una copia** sí. Hechos verificados:

1. `DELETE FROM sedes WHERE id NOT IN (...)` falla: `horarios_clases ← inscripciones` es `NO ACTION`.
2. Borrar bien según FK deja datos mal. Dos fallos que la base no avisa:
   * **`SET NULL` silencioso**: `notificaciones.alumno_id` es `SET NULL`. Sin borrado explícito quedaban 4.172 notificaciones de otros alumnos con dueño NULL en el sistema nuevo.
   * **`NOT IN` con NULL**: `congelamientos.inscripcion_id` es nullable (10 filas). No se borraban y bloqueaban el borrado de alumnos.
3. Hay **datos compartidos entre sedes mucho más allá de los alumnos** (sección 4).
4. **No hay sede explícita** para casi nada: solo `canchas`, `administrador` y `movimientos_financieros` tienen `sede_id`. Todo lo demás cuelga de `canchas → horarios_clases → inscripciones`. Quien no tenga inscripción **no tiene sede determinable**.

## 2. Mapa de dependencias respecto a `sede`

```
sedes ─┬─ canchas (sede_id, CASCADE) ── horarios_clases (cancha_id, CASCADE) ─┬─ inscripciones ─┬─ registros_asistencia
       │                                                                      │   (alumno_id)  ├─ congelamientos (inscripcion_id NULL)
       │                                                                      │                └─ inscripciones_deudas_link ── cuentas_por_cobrar ── pagos / descuentos_aplicados
       │                                                                      ├─ reprogramaciones_clases (CASCADE)
       │                                                                      ├─ recuperaciones.horario_destino_id (NULL)
       │                                                                      └─ coordinador_id → coordinadores
       ├─ administrador.sede_id (SET NULL)
       ├─ movimientos_financieros.sede_id (SET NULL, 18 de 20 con sede NULL)
       └─ direccion_id → direcciones
```

| Relación | Tablas |
|---|---|
| **Directa** | `canchas`, `administrador`, `movimientos_financieros`, `sedes` |
| **Indirecta (vía horario)** | `horarios_clases`, `reprogramaciones_clases`, `inscripciones`, `registros_asistencia`, `congelamientos`*, `inscripciones_deudas_link`, `recuperaciones` (por destino) |
| **Indirecta (vía alumno)** | `alumnos`, `alumnos_contactos`, `beneficios_pendientes`, `solicitudes_lesion`, `cuentas_por_cobrar`, `pagos`, `descuentos_aplicados`, `notificaciones`, `usuarios`, `credenciales_usuario`, `refresh_tokens`, `direcciones` |
| **Global** | `roles`, `tipos_documento`, `metodos_pago`, `niveles_entrenamiento`, `catalogo_conceptos`, `tipos_beneficio`, `feriados`, `parametros_sistema`, `_prisma_migrations` |

\* `congelamientos`: 10 de 37 no tienen inscripción; solo se ligan por lesión → alumno.

**No existen tablas de "políticas", "horarios de sede" ni "descripciones de sede".** Lo más cercano: `parametros_sistema` (4 claves globales, sin sede), `horarios_clases` (por cancha) y `sedes.nombre/tipo_instalacion`. Si hay políticas/descripciones, están en frontend/código o en la mente del cliente → ver decisiones.

## 3. Resultado de la prueba (K={11,12}, escenario hipotético)

Alumnos 985→129, usuarios 1004→134, inscripciones 3516→349, asistencia 16026→1242, cuentas 1616→244, pagos 1614→246, notificaciones 4967→795, recuperaciones 1413→152. Validación: FKs íntegras, sin huérfanos por FK, secuencias OK, sin duplicados. **Pero:** `recuperaciones.registro_asistencia_id` (sin FK) pasa de 43 a **53** huérfanos (origen ya tenía 43).

Escenario K={5}: sin errores; conserva 2 administradores ajenos porque pagos/publicaciones conservados los referencian.

## 4. Casos especiales encontrados (datos del dump)

| # | Caso | Magnitud |
|---|---|---|
| 1 | **Alumnos en varias sedes** (no solo dos: hay de 3 y 4) | 102 de 830 con inscripción; 16 con inscripciones vigentes en ≥2 sedes. Con K={11,12}: 44, de ellos 28 con vigente en la madre |
| 2 | **Cuentas por cobrar que cubren inscripciones de 2 sedes** (un pago, dos sistemas) | 44 en total (20 con K={11,12}) |
| 3 | **Cuentas sin link** a inscripción: sede no determinable | 286 (236 de alumnos de 1 sola sede, 50 de multi-sede) |
| 4 | **`id_grupo_transaccion` con inscripciones de sedes distintas** | 20 |
| 5 | **Recuperaciones que cruzan sede** (falta en A, recupera en B) y **alumno recupera en sede donde no está inscrito** | 114 de 296 con destino y asistencia; 89 sin inscripción en la sede destino |
| 6 | **Coordinadores**: no tienen sede; cada uno dicta en una sola sede, pero **registran asistencia de otras** (8.842 registros) y `registrado_por` es FK obligatoria | afecta qué coordinadores copiar |
| 7 | **Usuarios con doble perfil** (coordinador+alumno) | 7 coordinadores son también alumnos; 3 "Alumno" son coordinadores |
| 8 | **Alumnos sin inscripción alguna** (sede indeterminable) | 155 (4 con cuentas, 69 con notificaciones) |
| 9 | **Movimientos financieros sin sede** (gastos generales: polos, honorarios, torneo) | 18 de 20 |
| 10 | **Administradores**: solo 2 (sedes 11 y 12), referenciados por pagos/descuentos/lesiones/publicación | FK NO ACTION |
| 11 | **Horarios sin coordinador** (sede 4, inactiva) y coordinadores sin horarios | 4 / 5 |
| 12 | **Calidad**: 180 usuarios con DNI sin número | preexistente |
| 13 | `notificaciones.usuario_id` casi siempre NULL; el dueño real es `alumno_id` | 4966/4967 |

## 5. Clasificación de tablas

| Tabla | Clase | Justificación |
|---|---|---|
| sedes, canchas, horarios_clases, reprogramaciones_clases | **COPIAR** (solo K) | Directas |
| inscripciones, registros_asistencia, inscripciones_deudas_link | **COPIAR** (solo inscripciones K) | Derivan de horario K |
| alumnos + usuarios + credenciales_usuario + alumnos_contactos + direcciones | **DUPLICAR** si multi-sede; COPIAR si solo K | Alumno con inscripciones en K y fuera |
| refresh_tokens | **NO COPIAR** (propuesta) | Sesiones; forzar re-login en sistema nuevo. [REVISAR] |
| coordinadores | **COPIAR/DUPLICAR** | Los que dictan en K; + los que figuran en `registrado_por` de asistencia K |
| administrador | **REVISAR** | Quién administra el nuevo sistema; referencias cruzadas |
| cuentas_por_cobrar, pagos, descuentos_aplicados | **REVISAR** | Criterio por alumno vs por sede; 44 mixtas + 286 sin link |
| recuperaciones | **REVISAR** | Cruzan sede |
| congelamientos, solicitudes_lesion | **COPIAR** por alumno | Se ligan por alumno si no hay inscripción |
| beneficios_pendientes | **REVISAR** | Beneficio ¿de club o de sede? |
| notificaciones | **COPIAR** solo de alumnos K (borrado explícito) | Evita fuga SET NULL |
| movimientos_financieros | **REVISAR** | 18 sin sede (generales) |
| publicaciones, anuncios_beneficios | **REVISAR** | ¿Comunicaciones globales del club? |
| roles, tipos_documento, metodos_pago, niveles_entrenamiento, catalogo_conceptos, tipos_beneficio, feriados, parametros_sistema, _prisma_migrations | **GLOBAL** | Copia íntegra |

## 6. Problemas de integridad

* `SET NULL` silencioso en `notificaciones.alumno_id` (corregido en el script; hay detector genérico `_mig.nulls_fk`).
* `NOT IN` + NULL en `congelamientos.inscripcion_id` (corregido).
* Referencia blanda `recuperaciones.registro_asistencia_id` (sin FK): 43 huérfanos en origen, +10 por la poda.
* `beneficios_pendientes.asignado_por`, `inscripciones.id_grupo_transaccion` y `reprogramaciones_clases.grupo_uuid` sin FK (sin huérfanos hoy).
* Sin constraint única de negocio en `usuarios.email` (388 repetidos): riesgo de colisión si luego se unifican sistemas.

## 7. Entregables en `migracion-sedes/sql/`

| Archivo | Uso |
|---|---|
| `01_perfil.sql`, `02_multisede.sql`, `03_followup.sql`, `04_soft_refs.sql` | Análisis exploratorio (repetibles sobre el dump nuevo) |
| `05_exp_a_naive.sql` | Prueba del borrado ingenuo (falla) |
| `10_extraer_sedes.sql` | **Prototipo**: `-v keep='{ids}'`; por defecto hace ROLLBACK, `-v confirmar=1` persiste. Genera `_mig.hallazgos`, `_mig.alumnos_multisede`, conteos antes/después |
| `20_validar.sql` | Validaciones post-extracción |

Flujo repetible para el corte:

```
pg_restore (cliente PG18) -> base "corte-origen"
createdb corte-nuevo -T corte-origen
psql -d corte-nuevo -v ON_ERROR_STOP=1 -v keep='{...}' -v confirmar=1 -f 10_extraer_sedes.sql
psql -d corte-nuevo -f 20_validar.sql
pg_dump -Fc corte-nuevo  -> sistema nuevo
```

Limitaciones del prototipo: solo prueba un criterio por defecto (alumno-nivel para finanzas); no genera el `DELETE` en la base madre; no ajusta secuencias del nuevo sistema; los criterios marcados [REVISAR] son provisionales.

## 8. Decisiones a confirmar con el cliente

1. **¿Qué sedes van al sistema nuevo?** (el dump no lo dice; 11 y 12 son las únicas con administrador).
2. ¿La sede madre **conserva** esas sedes tras el corte, o se eliminan de allí?
3. **Alumno multi-sede**: ¿se duplica el perfil completo (incl. historial, lesiones, contactos) o solo los datos de la sede? ¿Qué pasa con sus inscripciones vigentes en la otra sede?
4. **Finanzas**: historial por alumno (todo) o solo cuentas/pagos de inscripciones K. ¿Cómo se parten las 44 cuentas mixtas? ¿Qué sede es dueña de las 286 sin link?
5. **Compras agrupadas** (`id_grupo_transaccion` mixto): ¿se divide el grupo?
6. **Recuperaciones** entre sedes: ¿se permiten en el sistema nuevo? ¿Se conservan las que tienen origen/destino en la madre?
7. **Alumnos sin inscripción** (155): ¿a qué sistema pertenecen? (Hoy no se copian.)
8. **Coordinadores** que dictan en una sede y registran en otra, y usuarios con doble rol: ¿se duplican?
9. **Administradores**: ¿quién administra el sistema nuevo? ¿Se duplican los de pagos/descuentos referenciados?
10. **Movimientos financieros** sin sede (gastos generales) y `publicaciones`: ¿van a ambos, a uno, o se parten?
11. **Políticas, horarios y descripciones de sede**: ¿dónde viven hoy? (no están en BD).
12. Catálogos globales (precios, conceptos, parámetros): ¿el nuevo sistema los hereda y puede cambiarlos de forma independiente?
13. **Sesiones y credenciales**: ¿se migran contraseñas hash y se invalidan tokens?
14. Fecha/hora de **congelamiento** de la base madre durante el corte y qué ocurre con altas posteriores al corte.
