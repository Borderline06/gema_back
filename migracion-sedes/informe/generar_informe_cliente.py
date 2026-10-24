"""Genera el PDF de decisiones para el cliente a partir de datos.json (ver datos.sql).

  docker exec -i gema_academy_db psql -U postgres -d <base_origen> -At -v keep='{1,2,3,6,11}' < datos.sql > datos.json
  python generar_informe_cliente.py datos.json salida.pdf

El PDF contiene datos personales de alumnos: no se versiona (ver .gitignore).
"""
import json
import sys
from collections import Counter
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

datos = json.load(open(sys.argv[1], encoding="utf-8"))
salida = sys.argv[2]

AZUL = colors.HexColor("#1f3a5f")
GRIS = colors.HexColor("#f0f2f5")
AMBAR = colors.HexColor("#fff4d6")

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
    return Paragraph(t, s)


def tabla(filas, anchos, cabecera=True, estilo_extra=None, repetir=1):
    t = Table(filas, colWidths=anchos, repeatRows=repetir if cabecera else 0)
    st = [("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c8ccd2")),
          ("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
          ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if cabecera:
        st += [("BACKGROUND", (0, 0), (-1, 0), AZUL), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]
    t.setStyle(TableStyle(st + (estilo_extra or [])))
    return t


def cab(textos, estilo=peq_b):
    return [Paragraph(f'<font color="white">{t}</font>', estilo) for t in textos]


def sede_corta(s):
    return (s or "").replace("San Miguel - ", "SM ").replace("Surquillo - ", "Surq. ")


def pie(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#777777"))
    canvas.drawString(18 * mm, 10 * mm, "Confidencial - contiene datos personales de alumnos. Migracion de sedes - decisiones para el cliente")
    canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Pagina {doc.page}")
    canvas.restoreState()


doc = SimpleDocTemplate(salida, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title="Migracion de sedes - decisiones para el cliente", author="Equipo de desarrollo GEMA")
W = A4[0] - 36 * mm
S = []

sedes = [s["nombre"] for s in datos["keep"]]
eddy = datos["eddy"]
vis = datos["visitantes"] or []
grupos = datos["grupos"] or []
sin_ins = datos["sin_ins"] or []
afectan = [g for g in grupos if g["afecta"]]

# ---------------------------------------------------------------- portada
S += [P("Separacion de sedes hacia el nuevo sistema", titulo), Spacer(1, 6),
      P("Decisiones pendientes y listas para validar con el cliente", sub), Spacer(1, 18),
      P(f"Generado el {date.today():%d/%m/%Y}. Datos de prueba: dump del 03/10/2026. "
        "Las cifras se recalcularan con los datos vigentes al momento de la migracion.", sub), Spacer(1, 26)]
S.append(tabla([cab(["Sedes que migran al nuevo sistema"], base), [P("<br/>".join(sedes))]], [W]))
S += [Spacer(1, 14), P("<b>Que necesitamos del cliente</b>", h2),
      tabla([cab(["#", "Tema", "Que se pide"]),
             [P("1"), P("Administrador Eddy (seccion 1)"), P("Elegir una de tres opciones.")],
             [P("2"), P("Recuperaciones de alumnos visitantes (seccion 2)"), P(f"Elegir una de dos opciones para {len(vis)} registros.")],
             [P("3"), P("Compras agrupadas en sedes distintas (seccion 3)"), P(f"Revisar {len(grupos)} compras ({len(afectan)} afectan la migracion) y marcar el destino de cada una.")],
             [P("4"), P("Alumnos sin inscripcion (seccion 4)"), P(f"Revisar {len(sin_ins)} alumnos y marcar cuales migran.")],
             [P("5"), P("Campo de notificaciones (seccion 5)"), P("Informativo. Confirmar si se acepta la propuesta.")]],
            [8 * mm, 62 * mm, W - 70 * mm]),
      PageBreak()]

# ---------------------------------------------------------------- 1. Eddy
pr = eddy["pagos_por_revisor"]
S += [P("1. Administrador Eddy (sede ATE)", h1),
      P(f"Eddy es administrador de la sede <b>{eddy['sede']}</b>, que <b>no migra</b>. Sin embargo, aprobo pagos de alumnos que si migran. "
        "En el nuevo sistema cada pago aprobado guarda quien lo reviso: si Eddy no existe alli, hay que decidir que hacer con esa referencia."),
      Spacer(1, 4),
      tabla([cab(["Dato (alumnos que migran)", "Cantidad"]),
             [P("Pagos aprobados por Eddy"), P(f"<b>{pr.get('97', 0)}</b>")],
             [P("Pagos aprobados por el administrador de Tottus 1 (migra)"), P(str(pr.get('143', 0)))],
             [P("Pagos sin revisor registrado"), P(str(pr.get('sin_revisor', 0)))],
             [P("Solicitudes de lesion revisadas por Eddy"), P(str(eddy["lesiones"]))],
             [P("Beneficios asignados por Eddy"), P(str(eddy["beneficios"]))],
             [P("Total de pagos aprobados por Eddy en todo el sistema"), P(str(eddy["eddy_pagos_global"]))]],
            [W - 30 * mm, 30 * mm]),
      Spacer(1, 6), P("Opciones", h2)]
S.append(tabla([
    cab(["Opcion", "Que ocurre", "Consecuencias"]),
    [P("<b>A. Conservar a Eddy</b> en el nuevo sistema"),
     P("Se copia su usuario (y su credencial) como administrador, sin sede asignada."),
     P("Se mantiene quien aprobo cada pago. Una persona de otra sede queda con acceso de administrador al sistema nuevo salvo que se desactive. "
       "Su unica notificacion historica tambien se conserva.")],
    [P("<b>B. Dejar el revisor vacio</b> (NULL)"),
     P(f"Los {pr.get('97', 0)} pagos y los otros registros quedan sin revisor. Eddy no se copia."),
     P("No entra ninguna cuenta de otra sede. Se pierde, en el sistema nuevo, el dato de quien aprobo esos pagos; el registro completo sigue en el sistema original. "
       "Es coherente con el criterio de usar NULL ya acordado.")],
    [P("<b>C. Reasignar</b> a un administrador del nuevo sistema"),
     P("Se sustituye a Eddy por otro administrador (por ejemplo el de Tottus 1)."),
     P("<b>No recomendada.</b> Altera la autoria: el sistema indicaria que un administrador aprobo pagos que no reviso.")],
], [34 * mm, 54 * mm, W - 88 * mm]))
S += [Spacer(1, 6),
      P("Sugerencia del equipo: opcion B si Eddy no va a operar el sistema nuevo; opcion A si va a seguir aprobando pagos alli. "
        "La decision es del cliente.", nota),
      PageBreak()]

# ---------------------------------------------------------------- 2. visitantes
est = Counter(v["estado"] for v in vis)
dst = Counter(sede_corta(v["destino"]) for v in vis)
S += [P("2. Recuperaciones de alumnos visitantes", h1),
      P(f"Son {len(vis)} recuperaciones de alumnos que <b>no estan inscritos en ninguna de las sedes que migran</b>, pero recuperaron una clase "
        "en una de ellas. El registro de recuperacion exige un alumno, por lo que no puede resolverse dejando un valor vacio. "
        "Para un alumno visitante existen dos caminos."),
      Spacer(1, 4),
      P("Estados: " + ", ".join(f"{k} ({v})" for k, v in est.most_common()) + ". Sedes destino: " + ", ".join(f"{k} ({v})" for k, v in dst.most_common()) + ".", nota),
      Spacer(1, 4), P("Opciones", h2)]
S.append(tabla([
    cab(["Opcion", "Que ocurre", "Consecuencias"]),
    [P("<b>A. Eliminarlas</b> del nuevo sistema"),
     P(f"Las {len(vis)} recuperaciones no pasan. Los alumnos tampoco."),
     P("El nuevo sistema no registra que esos alumnos asistieron a clases en sus sedes (asistencia e historial de esas clases). "
       "El sistema original las conserva. No se trae ningun alumno ajeno.")],
    [P("<b>B. Traer al alumno</b> solo con esas recuperaciones"),
     P("Se copia el perfil del alumno (usuario, datos personales, contactos) aunque no tenga inscripciones en las sedes que migran."),
     P("Se conserva el historial de la clase. Aparecen en el nuevo sistema alumnos sin inscripcion y con datos de personas que no pertenecen a esas sedes. "
       "Sus cuentas y pagos seguirian el criterio financiero que se defina.")],
], [34 * mm, 54 * mm, W - 88 * mm]))
S += [Spacer(1, 8), P("Detalle de los casos", h2)]
filas = [cab(["Recup.", "Alumno", "Inscrito en", "Recupero en", "Fecha prog.", "Estado"])]
for v in vis:
    filas.append([P(str(v["id"]), peq), P(f"{v['alumno']} ({v['alumno_id']})", peq), P(sede_corta(v["sedes_alumno"]), peq),
                  P(sede_corta(v["destino"]), peq), P(str(v["programada"]), peq), P(v["estado"], peq)])
S.append(tabla(filas, [12 * mm, 46 * mm, 32 * mm, 32 * mm, 20 * mm, W - 142 * mm]))
S.append(PageBreak())

# ---------------------------------------------------------------- 3. caso 4
S += [P("3. Compras agrupadas en sedes distintas (caso 4)", h1),
      P("Cuando un alumno se inscribe en varios horarios a la vez, el sistema agrupa esas inscripciones en una sola compra. "
        f"Hay <b>{len(grupos)}</b> compras cuyas inscripciones pertenecen a sedes distintas. De ellas, <b>{len(afectan)}</b> quedan partidas entre el sistema "
        "original y el nuevo con las sedes elegidas (marcadas en ambar). Para cada una, el cliente debe indicar el destino."),
      Spacer(1, 4),
      P("<b>Que significa cada destino.</b> Nuevo: las inscripciones de las sedes que migran pasan al nuevo sistema y las demas se quedan solo en el original (es lo que ocurre por defecto). "
        "Original: la compra completa se mantiene solo en el original. Revisar: requiere hablar con el alumno. Las compras sin fondo ambar van enteras a un solo sistema y no requieren decision.", nota),
      Spacer(1, 6)]
filas = [cab(["Compra", "Alumno", "Sedes", "Insc.", "Vig.", "Fecha", "Destino (marcar uno)"])]
extra = []
for i, g in enumerate(grupos, 1):
    dentro = [s in sedes for s in g["sedes"]]
    if g["afecta"]:
        dec = P("[ ] Nuevo<br/>[ ] Original<br/>[ ] Revisar", peq)
    else:
        dec = P("No requiere: " + ("ambas sedes migran" if all(dentro) else "ninguna migra"), peq)
    filas.append([P(g["g"], peq), P(f"{g['alumno']} ({g['alumno_id']})", peq), P(" + ".join(sede_corta(s) for s in g["sedes"]), peq),
                  P(str(g["n_ins"]), peq), P(str(g["vigentes"]), peq), P(str(g["fecha"]), peq), dec])
    if g["afecta"]:
        extra.append(("BACKGROUND", (0, i), (-1, i), AMBAR))
S.append(tabla(filas, [16 * mm, 38 * mm, 44 * mm, 9 * mm, 8 * mm, 17 * mm, W - 132 * mm], estilo_extra=extra))
S.append(PageBreak())

# ---------------------------------------------------------------- 4. caso 8
con_cta = [a for a in sin_ins if a["cuentas"]]
con_not = [a for a in sin_ins if a["notifs"]]
S += [P("4. Alumnos sin inscripcion (caso 8)", h1),
      P(f"Son <b>{len(sin_ins)}</b> alumnos registrados que no tienen ninguna inscripcion, por lo que el sistema no puede saber a que sede pertenecen. "
        f"{len(con_cta)} tienen cuentas por cobrar y {len(con_not)} tienen notificaciones. Por defecto <b>no migran</b>. "
        "El cliente debe marcar los que si deben migrar."),
      Spacer(1, 6)]
filas = [cab(["#", "ID", "Alumno", "DNI", "Alta", "Cuentas", "Notif.", "Migra (marcar)"])]
extra = []
for i, a in enumerate(sin_ins, 1):
    filas.append([P(str(i), peq), P(str(a["id"]), peq), P(a["nombre"] or "", peq), P(a["doc"] or "-", peq), P(str(a["alta"]), peq),
                  P(str(a["cuentas"]), peq_b if a["cuentas"] else peq), P(str(a["notifs"]), peq), P("[ ] Si   [ ] No", peq)])
    if a["cuentas"]:
        extra.append(("BACKGROUND", (0, i), (-1, i), AMBAR))
S.append(tabla(filas, [8 * mm, 11 * mm, 52 * mm, 21 * mm, 18 * mm, 16 * mm, 12 * mm, W - 138 * mm], estilo_extra=extra))
S.append(Spacer(1, 4))
S.append(P("Filas en ambar: alumnos con cuentas por cobrar. El registro 'Pase Invitado Gema' (DNI 00000000) no parece una persona real sino un usuario comodin para pases de visita; conviene confirmar su tratamiento aparte.", nota))
S.append(PageBreak())

# ---------------------------------------------------------------- 5. caso 13
S += [P("5. Campo usuario_id de notificaciones (caso 13)", h1),
      P("La tabla de notificaciones tiene dos campos para indicar a quien pertenece cada aviso: <b>alumno_id</b> (casi todos) y <b>usuario_id</b> (pensado "
        "para avisos a administradores). En los datos de prueba, usuario_id esta vacio en 4.966 de 4.967 filas. La pregunta es si se puede eliminar el campo."),
      P("Conclusion", h2),
      P("<b>El campo se puede eliminar sin perder datos y se realizara este cambio.</b> Hay codigo que lo usa y se ajustara junto con el campo (detalle abajo)."),
      P("Datos", h2),
      tabla([cab(["Dato", "Resultado"]),
             [P("Filas que usan usuario_id"), P("1 de 4.967: el aviso 'Pase Generado' del 27/05/2026, del administrador Eddy")]],
            [55 * mm, W - 55 * mm]),
      P("Que habria que cambiar", h2),
      tabla([cab(["Donde", "Cambio"]),
             [P("pagos.service.js (venta rapida de pase)"), P("Es la unica escritura real del campo: crea una notificacion de auditoria para el administrador. Habria que cambiarla o eliminarla.")],
             [P("notificaciones.service.js"), P("Tres funciones usan el campo (crear, listar por usuario y contar no leidas); las dos de lectura buscan en ambos campos y se simplificarian.")],
             [P("schema.prisma"), P("Quitar el campo y sus dos relaciones inversas, y crear la migracion que elimina la columna.")]],
            [55 * mm, W - 55 * mm]),
      P("Efecto funcional", h2),
      P("Un administrador no es alumno, por lo que sin ese campo no podria recibir notificaciones propias. Hoy solo recibe las de 'Pase Generado', asi que el efecto "
        "practico es pequeno, pero seria una funcionalidad que se retira."),
      Spacer(1, 10),
      P("Fin del documento", nota)]

doc.build(S, onFirstPage=pie, onLaterPages=pie)
print("OK", salida)
