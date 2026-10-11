"""Regenera sql/_politica_bloque.sql desde la lista de politicas (fuente unica).
Agregar una politica = agregar una fila aqui + usarla con _mig.pol('clave') en sql/30_migrar_sedes.sql.
"""
import pathlib

POLITICAS = [
    ("multisede", "duplicar", ["duplicar", "excluir", "solo_si_vigente_en_k"], "Alumno con inscripciones en sedes elegidas y fuera"),
    ("cuentas", "por_alumno", ["por_alumno", "por_inscripcion", "ninguno"], "Criterio del historial de cuentas/pagos/descuentos"),
    ("cuenta_mixta", "conservar", ["conservar", "descartar", "bloquear"], "Cuenta ligada a inscripciones de sedes elegidas Y de fuera"),
    ("cuenta_sin_link", "por_alumno", ["por_alumno", "solo_alumno_unisede", "descartar", "bloquear"], "Cuenta sin link a ninguna inscripcion (sede no deducible)"),
    ("recup_destino_fuera", "eliminar", ["eliminar", "destino_nulo", "bloquear"], "Recuperacion de alumno migrado con destino en sede no migrada"),
    ("recup_visitante", "eliminar", ["eliminar", "incluir_alumno", "bloquear"], "Recuperacion con destino en sede migrada de alumno no inscrito alli"),
    ("recup_ref_asistencia", "anular_nuevos", ["dejar", "anular_nuevos"], "registro_asistencia_id (sin FK) que apuntaria a asistencia no migrada"),
    ("alumnos_sin_inscripcion", "no_copiar", ["copiar", "no_copiar"], "Alumnos sin ninguna inscripcion (sede no deducible)"),
    ("mov_sin_sede", "no_copiar", ["copiar", "no_copiar"], "movimientos_financieros con sede_id NULL"),
    ("admin_foraneo", "conservar", ["conservar", "anular_referencia", "bloquear"], "Admin de sede no migrada referenciado por filas migradas"),
    ("coord_foraneo", "conservar", ["conservar", "anular_referencia", "bloquear"], "Coordinador que registro asistencia en sede migrada sin dictar alli"),
    ("publicaciones", "solo_admin_conservado", ["solo_admin_conservado", "no_copiar", "copiar_todas"], "Publicaciones (autor NOT NULL)"),
    ("grupo_transaccion_mixto", "permitir", ["permitir", "bloquear"], "Compra (id_grupo_transaccion) con inscripciones migradas y no migradas"),
    ("refresh_tokens", "no_copiar", ["copiar", "no_copiar"], "Sesiones activas"),
    ("credenciales", "copiar", ["copiar", "no_copiar"], "Hash de credenciales (no_copiar = obliga a restablecer contrasena)"),
]

lines = []
for k, *_ in POLITICAS:
    lines += [f"\\if :{{?p_{k}}}", "\\else", f"\\set p_{k} ''", "\\endif"]
lines.append("")
lines.append("insert into _mig.politica(clave, valor, permitidos, descripcion)")
lines.append("select k, coalesce(nullif(ov, ''), def), perm, descr from (values")
vals = []
for k, d, perm, desc in POLITICAS:
    arr = ",".join(f"'{x}'" for x in perm)
    vals.append(f"  ('{k}', :'p_{k}', '{d}', array[{arr}], '{desc}')")
lines.append(",\n".join(vals))
lines.append(") v(k, ov, def, perm, descr);")
pathlib.Path(__file__).parent.joinpath("sql", "_politica_bloque.sql").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
print(f"{len(POLITICAS)} politicas")
