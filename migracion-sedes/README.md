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

## Flujo completo: del dump de la madre al sistema nuevo

Receta usada para el sistema nuevo (preset `nuevo_sistema`, sedes 1,2,3,6,11). Repetir con un dump
más reciente cambia las cifras, no el procedimiento. Contenedor y usuario de ejemplo: `gema_academy_db`
/ `postgres`. En Git Bash anteponer `MSYS_NO_PATHCONV=1` a los `docker run` con rutas.

```bash
# 1. Restaurar el dump de la madre en una base de origen (intacta, solo lectura).
#    El dump suele ser formato custom 1.16 (PG17/18): usar cliente pg_restore 18.
docker exec gema_academy_db psql -U postgres -c "CREATE DATABASE corte_origen"
docker run --rm -v "D:\Gema:/d:ro" postgres:18-alpine pg_restore --no-owner --no-privileges \
  -h host.docker.internal -U postgres -d corte_origen /d/<dump-madre>.dump
#    (error benigno esperado en servidor 15/16: SET transaction_timeout)

# 2. Copia desechable: el ETL borra datos, nunca correrlo sobre corte_origen.
docker exec gema_academy_db psql -U postgres -c "CREATE DATABASE nuevo_sistema TEMPLATE corte_origen"

# 3. Sedes a migrar (ids), según lo acordado con el cliente.
docker exec gema_academy_db psql -U postgres -d corte_origen -c "select id, nombre from sedes order by id"

# 4. Dry-run (ROLLBACK, solo reporte) y luego persistir.
./migrar.sh nuevo_sistema 1,2,3,6,11 nuevo_sistema
./migrar.sh nuevo_sistema 1,2,3,6,11 nuevo_sistema --confirmar

# 5. Validar (FKs, huérfanos, duplicados, conteos, política de admin).
docker exec -i gema_academy_db psql -U postgres -d nuevo_sistema < sql/20_validar.sql

# 6. Dump final, sin el esquema de trazabilidad _mig.
docker exec gema_academy_db pg_dump -U postgres -Fc -N _mig --no-owner --no-privileges nuevo_sistema > dump-nuevo-sistema.dump

# 7. Restaurar en el destino (Render/Railway). Debe estar vacío; si no, DROP SCHEMA public CASCADE; CREATE SCHEMA public.
docker run --rm -v "D:\Gema:/d:ro" -e PGSSLMODE=require postgres:16-alpine pg_restore \
  --no-owner --no-privileges --exit-on-error -d "<URL_PUBLICA_DESTINO>" /d/dump-nuevo-sistema.dump
```

Después de restaurar:

- Arrancar el backend: `npm start` corre `prisma migrate deploy` y aplica las migraciones posteriores al dump.
- Verificar en el destino: 35 tablas antes de migrar (más las que añadan migraciones nuevas), 47 FKs y conteos
  iguales a los de `nuevo_sistema`.
- El dump contiene datos personales y hashes de contraseña: no versionarlo y borrarlo al terminar.
- No cargar `TWILIO_*` ni `BREVO_*` en el destino mientras la madre siga activa (los crons envían mensajes reales).
- Las contraseñas migradas son las de la madre (el hash se copia tal cual). Para cuentas de prueba, generar el hash
  con `bcryptjs` (10 rondas), igual que `src/features/auth`.

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
* Finanzas (`cuentas`, `cuenta_mixta`, `cuenta_sin_link`): se mantiene el criterio por alumno (todo el historial de cada alumno que migra).
  Decisión del equipo, **no consultada con el cliente**: se estima irrelevante porque la migración es solo para separar sistemas.
  Anotado por si se revisa: con las sedes 1,2,3,6,11 (dump del 03/10/2026) unas 51 cuentas de 851 son ambiguas y quedan en ambos sistemas:
  20 cuentas de sedes que no migran (S/ 3.305), 11 mixtas (S/ 2.510) y 20 sin vínculo de alumnos multi-sede.
  Si hiciera falta: `cuentas=por_inscripcion` y `cuenta_mixta=descartar|conservar`.

Para quitar `notificaciones.usuario_id` sin deriva: ajustar código y `schema.prisma`, `prisma migrate dev --name quitar_notificaciones_usuario_id` y `prisma migrate deploy` sobre la base nueva; comprobar con `prisma migrate diff --from-url <base> --to-schema-datamodel prisma/schema.prisma --script` (sin salida = sin deriva). El motor soporta también `eliminar_columna` (borrado manual), que obligaría a `prisma migrate resolve --applied`.
El detector de NULL (`_mig.nulls_*`) compara totales y puede enmascarar aumentos al borrar filas; los NULL deliberados se registran en `_mig.hallazgos`.

```
./migrar.sh gema_academy_nuevo_sistema 1,2,3,6,11 nuevo_sistema --confirmar
```
