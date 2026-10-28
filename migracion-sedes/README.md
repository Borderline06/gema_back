# Migración de sedes gobernada por políticas

Ver `INFORME.md` para el análisis. Este directorio es el mecanismo repetible.

## Uso

```bash
# 1. restaurar el dump del corte (cliente PG18 efímero; el servidor puede ser PG15)
# 2. crear una COPIA desechable de esa restauración
docker exec gema_academy_db psql -U postgres -c "CREATE DATABASE corte_nuevo TEMPLATE corte_origen"

# 3. dry-run (por defecto hace ROLLBACK e imprime el reporte)
./migrar.sh corte_nuevo 5,8,12 por_sede
# 4. ajustar decisiones sueltas sobre un preset
./migrar.sh corte_nuevo 5,8,12 por_sede cuenta_mixta=descartar
# 5. persistir en la copia
./migrar.sh corte_nuevo 5,8,12 por_sede cuenta_mixta=descartar --confirmar
# 6. validar
docker exec -i gema_academy_db psql -U postgres -d corte_nuevo < sql/20_validar.sql
```

`migrar.sh <base> <ids sedes> [preset] [clave=valor ...] [--confirmar]`. Las sedes se pasan como ids
(resolver nombre → id con `select id, nombre from sedes`). Nunca usar sobre producción: borra datos.

## Políticas (`politicas/*.vars`, definidas en `gen_politica.py`)

| Clave | Opciones (default primero) |
|---|---|
| multisede | duplicar · excluir · solo_si_vigente_en_k |
| cuentas | por_alumno · por_inscripcion · ninguno |
| cuenta_mixta | conservar · descartar · bloquear |
| cuenta_sin_link | por_alumno · solo_alumno_unisede · descartar · bloquear |
| recup_destino_fuera | eliminar · destino_nulo · bloquear |
| recup_visitante | eliminar · incluir_alumno · bloquear |
| recup_ref_asistencia | anular_nuevos · dejar |
| alumnos_sin_inscripcion | no_copiar · copiar |
| mov_sin_sede | no_copiar · copiar |
| admin_foraneo | conservar · anular_referencia · reasignar · bloquear |
| admin_reasignar_a | (libre) id o nombre del admin de destino; obligatorio con `reasignar` |
| coord_foraneo | conservar · anular_referencia · bloquear |
| publicaciones | solo_admin_conservado · no_copiar · copiar_todas |
| grupo_transaccion_mixto | permitir · bloquear |
| refresh_tokens | no_copiar · copiar |
| notificaciones_usuario_id | conservar_columna · eliminar_columna |
| credenciales | copiar · no_copiar |

Presets: `nuevo_sistema` (decisiones vigentes del cliente), `default`, `por_sede` (solo lo ligado a las sedes), `completa` (máxima conservación),
`estricta` (excluye multi-sede y **bloquea** ante lo ambiguo).

Los defaults NO son decisiones del cliente: son un punto de partida. `bloquear` aborta con un mensaje
indicando política y cantidad de casos.

## Qué queda en la base resultante (esquema `_mig`, visible en TablePlus)

`politica` (qué se aplicó) · `hallazgos` (casos y qué política los gobierna) · `trazabilidad`
(por alumno/inscripción/cuenta/recuperación: NUEVO o NO_MIGRA, regla, si es compartido) ·
`alumnos_multisede` · `conteo_origen`/`conteo_final` · `nulls_origen`/`nulls_final`.

## Agregar una decisión nueva
1. Fila nueva en `POLITICAS` de `gen_politica.py`, luego `python gen_politica.py`.
2. Usar `_mig.pol('clave')` en `sql/30_migrar_sedes.sql` (y `_mig.bloqueo(...)` si admite `bloquear`).

## Límites conocidos
* No hay script de limpieza de la **madre**. Si el cliente pide eliminar lo migrado, es la misma poda con
  `keep` = sedes restantes sobre una copia de la madre (no probado; añade el caso de alumnos que quedan en ambas).
* `bloquear` aborta en el primer caso que detecta; hay que re-ejecutar tras resolverlo.
* Las secuencias se conservan tal cual (el nuevo sistema no reutiliza ids de la madre).
* Combinaciones de políticas no probadas: probadas en dry-run `ninguno`, `excluir`, `estricta`; confirmadas y
  validadas `default`, `por_sede`, `completa`.
* `sql/10_extraer_sedes.sql` es el prototipo v1 (línea base, criterio fijo). Usar `30_migrar_sedes.sql`.

## Decisiones vigentes del cliente (preset `nuevo_sistema`, 28/10/2026)
* Sedes: Aráoz (mar y jue) = 1, Aráoz (sáb y dom) = 2, Tottus 1 = 11, Tottus 2 = 3, Mirones = 6 (`keep=1,2,3,6,11`).
  Pendiente de confirmar: que Aráoz 1 sea mar y jue.
* Lo registrado/aprobado por Eddy (admin de ATE) pasa a Gerardo Melchor (`admin_foraneo=reasignar`, `admin_reasignar_a=Gerardo Melchor`):
  pagos, lesiones, descuentos, beneficios y reprogramaciones creadas.
* Recuperaciones de alumnos visitantes: se borran. Destino de recuperación fuera de las sedes y `registrado_por` de coordinadores ajenos: NULL.
* Alumnos sin inscripción (155): migran como cuentas sin inscripción.
* Movimientos financieros sin sede: no migran. `notificaciones.usuario_id`: la base nueva conserva la columna (vacía) y la elimina una migración Prisma (opción A).
* Compras agrupadas entre sedes (caso 4, 5 casos con estas sedes): sin acción por ahora (`permitir`); se pueden añadir al final.
* Finanzas (`cuentas*`): criterio provisional por alumno, aún sin decisión del cliente.

Para quitar `notificaciones.usuario_id` sin deriva: ajustar código y `schema.prisma`, `prisma migrate dev --name quitar_notificaciones_usuario_id` y `prisma migrate deploy` sobre la base nueva; comprobar con `prisma migrate diff --from-url <base> --to-schema-datamodel prisma/schema.prisma --script` (sin salida = sin deriva). El motor soporta también `eliminar_columna` (borrado manual), que obligaría a `prisma migrate resolve --applied`.
El detector de NULL (`_mig.nulls_*`) compara totales y puede enmascarar aumentos al borrar filas; los NULL deliberados se registran en `_mig.hallazgos`.

```
./migrar.sh gema_academy_nuevo_sistema 1,2,3,6,11 nuevo_sistema --confirmar
```
