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
| admin_foraneo | conservar · anular_referencia · bloquear |
| coord_foraneo | conservar · anular_referencia · bloquear |
| publicaciones | solo_admin_conservado · no_copiar · copiar_todas |
| grupo_transaccion_mixto | permitir · bloquear |
| refresh_tokens | no_copiar · copiar |
| credenciales | copiar · no_copiar |

Presets: `default`, `por_sede` (solo lo ligado a las sedes), `completa` (máxima conservación),
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
