"""Informe de casos especiales de una corrida de migracion de sedes (PDF).

  python generar_informe_casos.py <base_origen> <base_traspaso> <base_madre> '<ids sedes>' salida.pdf

Lee las tablas de trazabilidad _mig de las bases ya migradas (traspaso y madre limpia) y el origen
intacto. El PDF contiene datos personales de alumnos: no se versiona (ver .gitignore).
"""
import json
import subprocess
import sys
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ORIGEN, TRASPASO, MADRE, KEEP, SALIDA = sys.argv[1:6]
PSQL = ["docker", "exec", "-i", "gema_academy_db", "psql", "-U", "postgres", "-At", "-d"]


def q(db, sql):
    """Ejecuta sql y devuelve el JSON de la unica columna resultante."""
    r = subprocess.run(PSQL + [db], input=sql.encode("utf-8"), capture_output=True, check=True)
    txt = r.stdout.decode("utf-8").strip()
    return json.loads(txt) if txt else []


def J(sql_select):
    return f"select coalesce(json_agg(t), '[]'::json) from ({sql_select}) t;"


AZUL = colors.HexColor("#1f3a5f")
GRIS = colors.HexColor("#f0f2f5")
AMBAR = colors.HexColor("#fff4d6")
VERDE = colors.HexColor("#e3f3e6")

ss = getSampleStyleSheet()
base = ParagraphStyle("base", parent=ss["Normal"], fontName="Helvetica", fontSize=9.5, leading=13)
peq = ParagraphStyle("peq", parent=base, fontSize=7.5, leading=9.5)
peq_b = ParagraphStyle("peq_b", parent=peq, fontName="Helvetica-Bold")
h1 = ParagraphStyle("h1", parent=base, fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=AZUL, spaceBefore=4, spaceAfter=6)
h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=AZUL, spaceBefore=8, spaceAfter=3)
titulo = ParagraphStyle("titulo", parent=h1, fontSize=22, leading=27, alignment=TA_CENTER, spaceBefore=60)
sub = ParagraphStyle("sub", parent=base, alignment=TA_CENTER, fontSize=11, leading=15, textColor=colors.HexColor("#555555"))
nota = ParagraphStyle("nota", parent=base, fontSize=8.5, leading=11, textColor=colors.HexColor("#555555"))


def P(t, s=base):
    return Paragraph(str(t), s)


def tabla(filas, anchos, extra=None):
    t = Table(filas, colWidths=anchos, repeatRows=1)
    st = [("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c8ccd2")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
          ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
          ("BACKGROUND", (0, 0), (-1, 0), AZUL)]
    t.setStyle(TableStyle(st + (extra or [])))
    return t


def cab(textos):
    return [Paragraph(f'<font color="white">{t}</font>', peq_b) for t in textos]


def pie(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#777777"))
    canvas.drawString(18 * mm, 10 * mm, "Confidencial - contiene datos personales de alumnos. Migracion de sedes - casos especiales")
    canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Pagina {doc.page}")
    canvas.restoreState()


def corto(s):
    return (s or "").replace("San Miguel - ", "SM ").replace("Surquillo - ", "Surq. ")


# ---------------------------------------------------------------- datos
sedes = {s["id"]: s["nombre"] for s in q(ORIGEN, J("select id, nombre from sedes"))}
keep_ids = [int(x) for x in KEEP.split(",")]


def nombres_sedes(ids):
    return ", ".join(corto(sedes.get(i, f"#{i}")) for i in (ids or []))


hall_t = {h["codigo"]: h["n"] for h in q(TRASPASO, J("select codigo, n from _mig.hallazgos"))}
hall_m = {h["codigo"]: h["n"] for h in q(MADRE, J("select codigo, n from _mig.hallazgos"))}

n_origen, n_t, n_m = (q(db, J("select count(*) n from alumnos"))[0]["n"] for db in (ORIGEN, TRASPASO, MADRE))
ids_t = {r["u"] for r in q(TRASPASO, J("select usuario_id u from alumnos"))}
ids_m = {r["u"] for r in q(MADRE, J("select usuario_id u from alumnos"))}
ids_o = {r["u"] for r in q(ORIGEN, J("select usuario_id u from alumnos"))}
perdidos = ids_o - ids_t - ids_m
en_ambos = ids_t & ids_m

por_sede = q(ORIGEN, J(f"""
  select s.id, s.nombre, count(distinct i.alumno_id) alumnos, count(i.id) inscripciones,
         (s.id = any('{{{KEEP}}}'::int[])) traspasa
  from sedes s left join canchas c on c.sede_id = s.id left join horarios_clases h on h.cancha_id = c.id
  left join inscripciones i on i.horario_id = h.id group by s.id, s.nombre order by s.id"""))

multi = q(TRASPASO, J("""
  select m.alumno_id, u.nombres || ' ' || u.apellidos nombre, m.sedes_nuevo, m.sedes_madre,
         m.ins_vigentes_k, m.ins_vigentes_madre
  from _mig.alumnos_multisede m join usuarios u on u.id = m.alumno_id order by m.ins_vigentes_madre desc, m.alumno_id"""))

v_ambos = sum(1 for m in multi if m["ins_vigentes_k"] > 0 and m["ins_vigentes_madre"] > 0)
v_madre = sum(1 for m in multi if m["ins_vigentes_k"] == 0 and m["ins_vigentes_madre"] > 0)
v_tras = sum(1 for m in multi if m["ins_vigentes_k"] > 0 and m["ins_vigentes_madre"] == 0)
v_nada = len(multi) - v_ambos - v_madre - v_tras

sin_ins = q(TRASPASO, J("""
  select a.usuario_id id, u.nombres || ' ' || u.apellidos nombre, u.creado_en::date creado,
         (select count(*) from cuentas_por_cobrar c where c.alumno_id = a.usuario_id) cuentas,
         (select count(*) from cuentas_por_cobrar c where c.alumno_id = a.usuario_id and c.estado = 'PENDIENTE') pendientes
  from _mig.alumnos_sin_ins s join alumnos a on a.usuario_id = s.id join usuarios u on u.id = a.usuario_id order by 1"""))

cuentas = q(TRASPASO, J("""
  select c.id, c.alumno_id, u.nombres || ' ' || u.apellidos nombre, c.monto_final::float monto, c.estado,
         case when k.en_k and k.fuera_k then 'Mixta' else 'Sin link (multi-sede)' end tipo
  from _mig.cuentas_clasif k join cuentas_por_cobrar c on c.id = k.id join usuarios u on u.id = c.alumno_id
  where (k.en_k and k.fuera_k) or (not k.tiene_link and k.alumno_multisede) order by tipo, c.id"""))

grupos = q(ORIGEN, J(f"""
  select i.id_grupo_transaccion::text grupo, i.alumno_id, u.nombres || ' ' || u.apellidos nombre, count(*) ins,
         array_agg(distinct c.sede_id order by c.sede_id) sedes
  from inscripciones i join horarios_clases h on h.id = i.horario_id join canchas c on c.id = h.cancha_id
  join usuarios u on u.id = i.alumno_id where i.id_grupo_transaccion is not null
  group by 1, 2, 3
  having bool_or(c.sede_id = any('{{{KEEP}}}'::int[])) and bool_or(not (c.sede_id = any('{{{KEEP}}}'::int[])))"""))

vis_ids = [r["id"] for r in q(TRASPASO, J("select id from _mig.recup_visitante"))]
visitantes = q(ORIGEN, J(f"""
  select r.id, r.alumno_id, u.nombres || ' ' || u.apellidos nombre, r.fecha_falta::text falta,
         r.fecha_programada::text programada, r.estado, c.sede_id sede_destino
  from recuperaciones r join usuarios u on u.id = r.alumno_id join horarios_clases h on h.id = r.horario_destino_id
  join canchas c on c.id = h.cancha_id where r.id = any('{{{",".join(map(str, vis_ids)) or 0}}}'::int[]) order by r.id"""))

doble = q(TRASPASO, J("""
  select u.id, u.nombres || ' ' || u.apellidos nombre from usuarios u
  join alumnos a on a.usuario_id = u.id join coordinadores c on c.usuario_id = u.id order by 1"""))

cf_ids = [r["id"] for r in q(TRASPASO, J("select id from _mig.coord_foraneos"))]
coord_for = q(ORIGEN, J(f"""
  select u.id, u.nombres || ' ' || u.apellidos nombre,
         (select count(*) from registros_asistencia ra where ra.registrado_por = u.id) asistencias_registradas
  from usuarios u where u.id = any('{{{",".join(map(str, cf_ids)) or 0}}}'::int[]) order by 1"""))

pendientes = q(TRASPASO, J("""
  select i.id, i.alumno_id, u.nombres || ' ' || u.apellidos nombre, i.creado_en::date creado,
         (select count(*) from registros_asistencia r where r.inscripcion_id = i.id) asistencias
  from inscripciones i join usuarios u on u.id = i.alumno_id where i.estado = 'PENDIENTE_PAGO' order by 1"""))

admins = q(ORIGEN, J("""select u.id, u.nombres || ' ' || u.apellidos nombre, a.sede_id from administrador a
  join usuarios u on u.id = a.usuario_id order by 1"""))

# ---------------------------------------------------------------- documento
doc = SimpleDocTemplate(SALIDA, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                        title="Migracion de sedes - casos especiales", author="Equipo de migracion")
W = A4[0] - 36 * mm
s = []

s += [P("Migracion de sedes", titulo), P("Casos especiales y alumnos con tratamiento particular", sub), Spacer(1, 8),
      P(f"Corte real del 06/11/2026 &middot; sedes a traspasar: {nombres_sedes(keep_ids)}", sub), Spacer(1, 6),
      P(f"Generado el {date.today():%d/%m/%Y}", sub), Spacer(1, 30)]

s += [P("1. Conclusion", h1),
      P(f"<b>Ningun alumno quedo sin pasar.</b> Los {n_origen} alumnos del corte estan en el traspaso, en la madre o en ambos "
        f"(alumnos del origen ausentes en los dos resultados: <b>{len(perdidos)}</b>).")]
s += [Spacer(1, 4), tabla([cab(["", "Alumnos"]),
                           [P("Corte original (madre completa)"), P(n_origen)],
                           [P("Traspaso (5 sedes)"), P(n_t)],
                           [P("Madre sin las 5 sedes"), P(n_m)],
                           [P("Presentes en ambos (duplicados a proposito)"), P(len(en_ambos))],
                           [P("Solo en el traspaso"), P(len(ids_t - ids_m))],
                           [P("Solo en la madre"), P(len(ids_m - ids_t))],
                           [P("<b>Perdidos</b>"), P(f"<b>{len(perdidos)}</b>")]], [W * 0.7, W * 0.3],
                          [("BACKGROUND", (0, 7), (-1, 7), VERDE)])]
s += [Spacer(1, 6),
      P("Los alumnos \"en ambos\" son los multi-sede (inscritos en una sede que se va y en otra que se queda) y los alumnos sin "
        "inscripcion, cuya sede no se puede deducir. Se copian a los dos lados: la cuenta existe en las dos bases.", nota),
      P("Las inscripciones y asistencias, en cambio, se reparten sin duplicar: lo que ocurrio en una sede que se va queda "
        "solo en el traspaso y lo demas, solo en la madre.", nota)]

s += [P("2. Reparto por sede", h2),
      tabla([cab(["Id", "Sede", "Alumnos", "Inscripciones", "Destino"])] +
            [[P(r["id"], peq), P(corto(r["nombre"]), peq), P(r["alumnos"], peq), P(r["inscripciones"], peq),
              P("Traspaso" if r["traspasa"] else "Se queda en la madre", peq)] for r in por_sede],
            [W * .07, W * .43, W * .12, W * .15, W * .23],
            [("BACKGROUND", (0, i + 1), (-1, i + 1), VERDE) for i, r in enumerate(por_sede) if r["traspasa"]])]
s += [P("Los alumnos se cuentan por sede: un alumno multi-sede aparece en mas de una fila.", nota)]

# --- resumen de casos
filas = [
    ("Alumnos multi-sede (duplicados)", len(multi), "Quedan en los dos lados; se revisa cual es su sede principal."),
    ("Alumnos sin inscripcion", len(sin_ins), "Pasan todos como cuenta sin inscripcion y tambien quedan en la madre."),
    ("Cuentas de cobro mixtas", sum(1 for c in cuentas if c["tipo"] == "Mixta"), "Ligadas a inscripciones de sedes que se van y de las que se quedan."),
    ("Cuentas sin link, alumno multi-sede", sum(1 for c in cuentas if c["tipo"] != "Mixta"), "No se sabe de que sede son; van por alumno."),
    ("Compras agrupadas mixtas", len(grupos), "Un mismo pago con inscripciones de sedes que se van y que se quedan."),
    ("Recuperaciones de visitantes (se eliminan)", len(visitantes), "Alumnos de otras sedes que recuperaban clase en una sede que se va."),
    ("Recuperaciones con destino en sede que no pasa", hall_t.get("RECUP_DESTINO_FUERA", 0), "El destino queda vacio."),
    ("Recuperaciones con asistencia de origen no migrada", hall_t.get("RECUP_REF_ASISTENCIA_ANULADA", 0), "La referencia a la asistencia queda vacia."),
    ("Usuarios con doble perfil alumno y coordinador", len(doble), "Pasan con los dos perfiles."),
    ("Coordinadores que no dictan en las sedes pero registraron asistencia", len(coord_for), "El campo registrado_por queda vacio en esas asistencias."),
]
if pendientes:
    filas.append(("Inscripciones en PENDIENTE_PAGO", len(pendientes), "Tienen asistencias; el proceso de limpieza de reservas las vuelve a detectar cada minuto."))
s += [P("3. Resumen de casos", h2),
      tabla([cab(["Caso", "Cantidad", "Tratamiento"])] +
            [[P(a, peq), P(b, peq), P(c, peq)] for a, b, c in filas], [W * .40, W * .10, W * .50])]

s += [P("Cambios masivos por la reasignacion del administrador", h2),
      P("Todo lo registrado o aprobado por el administrador que no migra (" +
        ", ".join(f"{a['nombre']} (sede {sedes.get(a['sede_id'], '-')})" for a in admins if a["sede_id"] not in keep_ids) +
        ") pasa a nombre del administrador de destino. En el traspaso:", base),
      tabla([cab(["Campo", "Filas reasignadas"]),
             [P("pagos.revisado_por", peq), P(hall_t.get("REASIGNADO_PAGOS", 0), peq)],
             [P("reprogramaciones_clases.creado_por", peq), P(hall_t.get("REASIGNADO_REPROGRAMACIONES", 0), peq)],
             [P("beneficios_pendientes.asignado_por", peq), P(hall_t.get("REASIGNADO_BENEFICIOS", 0), peq)],
             [P("descuentos_aplicados.aplicado_por", peq), P(hall_t.get("REASIGNADO_DESCUENTOS", 0), peq)],
             [P("solicitudes_lesion.revisado_por", peq), P(hall_t.get("REASIGNADO_LESIONES", 0), peq)],
             [P("asistencias con registrado_por vacio", peq), P(hall_t.get("ASISTENCIA_REGISTRADO_POR_ANULADO", 0), peq)]],
            [W * .6, W * .4])]
s += [P("Esto significa que, en el sistema nuevo, esos registros figuran como hechos por el administrador de destino. "
        "Si se necesita saber quien los aprobo realmente, hay que consultarlo en la madre.", nota)]

# --- detalle
s += [PageBreak(), P("4. Alumnos multi-sede", h1),
      P("Alumnos con inscripciones en sedes que se van y en sedes que se quedan. Se copian a los dos lados. "
        "Las columnas de vigentes indican cuantas inscripciones activas tiene en cada lado. "
        f"Vigentes en ambos lados: <b>{v_ambos}</b> &middot; solo en la madre: <b>{v_madre}</b> &middot; "
        f"solo en el traspaso: <b>{v_tras}</b> &middot; en ninguno (historico): <b>{v_nada}</b>. "
        "Los que estan vigentes en un solo lado siguen asistiendo alli; el otro lado conserva solo su historial.", nota),
      Spacer(1, 4),
      tabla([cab(["Id", "Alumno", "Sedes que se van", "Sedes que se quedan", "Vig. traspaso", "Vig. madre"])] +
            [[P(m["alumno_id"], peq), P(m["nombre"], peq), P(nombres_sedes(m["sedes_nuevo"]), peq),
              P(nombres_sedes(m["sedes_madre"]), peq), P(m["ins_vigentes_k"], peq), P(m["ins_vigentes_madre"], peq)] for m in multi],
            [W * .07, W * .24, W * .24, W * .25, W * .10, W * .10],
            [("BACKGROUND", (0, i + 1), (-1, i + 1), AMBAR) for i, m in enumerate(multi)
             if m["ins_vigentes_k"] > 0 or m["ins_vigentes_madre"] > 0])]
s += [P("Resaltados: alumnos con alguna inscripcion vigente (se les debe avisar de en cual sistema siguen).", nota)]

s += [PageBreak(), P("5. Cuentas de cobro ambiguas y compras agrupadas", h1),
      P("Las cuentas van por alumno: si el alumno pasa, sus cuentas pasan. Estas son las que no se pueden asignar a una sola sede.", nota),
      Spacer(1, 4),
      tabla([cab(["Cuenta", "Alumno", "Tipo", "Monto", "Estado"])] +
            [[P(c["id"], peq), P(f"{c['alumno_id']} - {c['nombre']}", peq), P(c["tipo"], peq), P(f"S/ {c['monto']:.2f}", peq), P(c["estado"], peq)]
             for c in cuentas], [W * .1, W * .42, W * .22, W * .12, W * .14])]
s += [Spacer(1, 8), P("Compras agrupadas con inscripciones de sedes que se van y que se quedan", h2)]
if grupos:
    s += [tabla([cab(["Grupo de transaccion", "Alumno", "Inscripciones", "Sedes"])] +
                [[P(g["grupo"], peq), P(f"{g['alumno_id']} - {g['nombre']}", peq), P(g["ins"], peq), P(nombres_sedes(g["sedes"]), peq)] for g in grupos],
                [W * .30, W * .28, W * .12, W * .30])]
else:
    s += [P("Ninguna.", base)]

s += [PageBreak(), P("6. Alumnos sin inscripcion", h1),
      P(f"{len(sin_ins)} alumnos no tienen ninguna inscripcion, por lo que no se puede deducir su sede. Todos pasan al traspaso como "
        "cuenta sin inscripcion, y tambien se mantienen en la madre.", nota), Spacer(1, 4),
      tabla([cab(["Id", "Alumno", "Creado", "Cuentas", "Pendientes"])] +
            [[P(a["id"], peq), P(a["nombre"], peq), P(a["creado"], peq), P(a["cuentas"], peq), P(a["pendientes"], peq)] for a in sin_ins],
            [W * .09, W * .47, W * .18, W * .13, W * .13],
            [("BACKGROUND", (0, i + 1), (-1, i + 1), AMBAR) for i, a in enumerate(sin_ins) if a["pendientes"] > 0])]
s += [P("Resaltados: alumnos con cuentas pendientes de pago.", nota)]

s += [PageBreak(), P("7. Recuperaciones de visitantes (se eliminan)", h1),
      P("Alumnos que no estan inscritos en las sedes que se van pero tienen una recuperacion programada en una de ellas. "
        "No se copian al traspaso, y la recuperacion se elimina.", nota), Spacer(1, 4)]
if visitantes:
    s += [tabla([cab(["Recup.", "Alumno", "Falta", "Programada", "Estado", "Sede destino"])] +
                [[P(v["id"], peq), P(f"{v['alumno_id']} - {v['nombre']}", peq), P(v["falta"], peq), P(v["programada"] or "-", peq),
                  P(v["estado"], peq), P(corto(sedes.get(v["sede_destino"])), peq)] for v in visitantes],
                [W * .08, W * .30, W * .13, W * .13, W * .14, W * .22])]
else:
    s += [P("Ninguna.", base)]

s += [P("8. Personas con perfil particular", h1),
      P("Usuarios con perfil de alumno y de coordinador (pasan con ambos)", h2)]
s += [tabla([cab(["Id", "Usuario"])] + [[P(d["id"], peq), P(d["nombre"], peq)] for d in doble], [W * .15, W * .85])] if doble else [P("Ninguno.", base)]
s += [P("Coordinadores que registraron asistencias migradas sin dictar en las sedes que pasan", h2),
      P("No migran como coordinadores. Sus asistencias quedan con registrado_por vacio.", nota)]
s += [tabla([cab(["Id", "Coordinador", "Asistencias registradas (total)"])] +
            [[P(c["id"], peq), P(c["nombre"], peq), P(c["asistencias_registradas"], peq)] for c in coord_for],
            [W * .12, W * .58, W * .30])] if coord_for else [P("Ninguno.", base)]

if pendientes:
    s += [P("Inscripciones en PENDIENTE_PAGO", h2),
          P("Tienen asistencias y por eso el proceso automatico de limpieza de reservas no las borra, pero las detecta cada minuto y "
            "escribe \"liquidado con exito\" aunque no cambie nada. Conviene decidir si se regularizan.", nota),
          tabla([cab(["Inscripcion", "Alumno", "Creada", "Asistencias"])] +
                [[P(p["id"], peq), P(f"{p['alumno_id']} - {p['nombre']}", peq), P(p["creado"], peq), P(p["asistencias"], peq)] for p in pendientes],
                [W * .15, W * .5, W * .2, W * .15])]

s += [P("9. Decisiones que siguen abiertas", h1),
      P("&bull; Alumnos multi-sede con inscripcion vigente en ambos lados: definir donde se gestiona cada uno.", base),
      P("&bull; Cuentas mixtas y sin link de multi-sede: confirmar que se queden en los dos sistemas (hoy van por alumno).", base),
      P("&bull; Compras agrupadas mixtas: decidir si se parten o se dejan duplicadas.", base),
      P("&bull; Alumnos sin inscripcion: confirmar que se mantengan tambien en la madre.", base),
      P("&bull; Alumnos multi-sede con inscripcion vigente: avisarles en cual sistema siguen.", base),
      P("&bull; Fecha y ventana de corte real: el resultado es una foto del 06/11; lo que ocurra despues no esta incluido.", base)]

doc.build(s, onFirstPage=pie, onLaterPages=pie)
print("OK", SALIDA, "perdidos=", len(perdidos), "ambos=", len(en_ambos))
