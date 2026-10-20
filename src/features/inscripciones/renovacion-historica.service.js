import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
import * as Validators from './validators/inscripcion.validator.js';
import { inscripcionService } from './inscripcion.service.js';
import { whereTipoInscripcion, TIPO_INSCRIPCION } from '../../shared/utils/tipo-inscripcion.util.js';
import { formatearHorario, HORARIO_SELECT } from '../horarios/horario.service.js';
import { diaLimaAFechaUTC } from '../../shared/utils/ciclo.util.js';
import {
  ESTADOS_EN_CURSO,
  esPaqueteFinalizado,
  existeInscripcionEquivalente,
  elegirConceptoVigente,
  ordenarAlternativas,
} from './utils/renovacion.util.js';

// BL-004: renovar un paquete FINALIZADO desde el expediente histórico.
// El paquete se agrupa por inscripciones_deudas_link.cuenta_id (el cron
// VERDUGO anula id_grupo_transaccion al finalizar, por eso no se usa).

const LIMITE_PLANES = 10;

const fechaLimiteZombie = async () => {
  const p = await prisma.parametros_sistema.findUnique({ where: { clave: 'TIEMPO_LIMITE_RESERVA_MIN' } });
  return new Date(Date.now() - (p ? Number.parseInt(p.valor) : 20) * 60 * 1000);
};

const tieneCupo = async (horarioId, limite) => {
  try {
    await Validators.validarAforoHorario(prisma, horarioId, limite);
    return true;
  } catch {
    return false;
  }
};

/** Horarios activos con cupo del mismo nivel que los no disponibles (mismo día primero). */
const buscarAlternativas = async (detalle, idsExcluidos, limite) => {
  const caidos = detalle.horarios.filter((h) => !h.disponible);
  if (caidos.length === 0) return [];
  const niveles = [...new Set(caidos.map((h) => h.nivel.id))];
  const dias = new Set(caidos.map((h) => h.dia_semana));
  const candidatos = await prisma.horarios_clases.findMany({
    where: {
      activo: true,
      nivel_id: { in: niveles },
      id: { notIn: idsExcluidos },
      canchas: { sedes: { activo: true } },
    },
    select: HORARIO_SELECT,
  });
  const conCupo = [];
  for (const c of candidatos) {
    if (await tieneCupo(c.id, limite)) {
      const f = formatearHorario(c);
      conCupo.push({ ...f, mismo_dia: dias.has(f.dia_semana) });
    }
  }
  return ordenarAlternativas(conCupo, [...dias][0]);
};

const evaluarPaquete = async (idAlumno, cuentaId, enCurso, limite) => {
  const detalle = await inscripcionService.obtenerUltimoPlanAlumno(idAlumno, cuentaId);
  const horarioIds = detalle.horarios.map((h) => h.id);

  const candidatos = await prisma.catalogo_conceptos.findMany({
    where: { activo: true, es_vigente: true, cantidad_clases_semanal: horarioIds.length },
  });
  const historico = await prisma.cuentas_por_cobrar.findUnique({
    where: { id: cuentaId },
    select: { catalogo_conceptos: true },
  });
  const vigente = elegirConceptoVigente(candidatos, historico?.catalogo_conceptos, horarioIds.length);

  let motivo = null;
  if (!detalle.tiene_plan_previo || horarioIds.length === 0) motivo = 'El paquete histórico no tiene horarios.';
  else if (existeInscripcionEquivalente(horarioIds, enCurso))
    motivo = 'Ya tienes una inscripción activa o pendiente con los mismos horarios.';
  else if (!vigente) motivo = 'No existe un plan vigente equivalente en el catálogo.';

  const alternativas = motivo ? [] : await buscarAlternativas(detalle, horarioIds, limite);

  return {
    cuenta_id: cuentaId,
    concepto: historico?.catalogo_conceptos
      ? { id: historico.catalogo_conceptos.id, nombre: historico.catalogo_conceptos.nombre }
      : null,
    concepto_vigente: vigente
      ? { id: vigente.id, nombre: vigente.nombre, precio_base: Number(vigente.precio_base) }
      : null,
    fecha_inicio_ciclo: detalle.ultimo_ciclo?.fecha_inicio_ciclo ?? null,
    fecha_fin_ciclo: detalle.ultimo_ciclo?.fecha_fin_ciclo ?? null,
    horarios: detalle.horarios,
    horarios_alternativos: alternativas,
    puede_renovar: motivo === null,
    motivo_no_renovable: motivo,
    _vigente: vigente,
  };
};

const cargarEnCurso = (idAlumno) =>
  prisma.inscripciones.findMany({
    where: { alumno_id: idAlumno, estado: { in: ESTADOS_EN_CURSO }, ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR) },
    select: { horario_id: true, estado: true },
  });

/** Cuentas con paquete REGULAR 100% FINALIZADO, la más nueva primero, sin duplicar paquetes. */
const cuentasFinalizadas = async (idAlumno) => {
  const links = await prisma.inscripciones_deudas_link.findMany({
    where: { inscripciones: { alumno_id: idAlumno, ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR) } },
    select: { cuenta_id: true, creado_en: true, inscripciones: { select: { estado: true, horario_id: true } } },
    orderBy: { creado_en: 'desc' },
  });
  const porCuenta = new Map();
  for (const l of links) {
    if (!porCuenta.has(l.cuenta_id)) porCuenta.set(l.cuenta_id, []);
    porCuenta.get(l.cuenta_id).push(l.inscripciones);
  }
  const vistas = new Set();
  const out = [];
  for (const [cuentaId, inscs] of porCuenta) {
    if (!esPaqueteFinalizado(inscs.map((i) => i.estado))) continue;
    const firma = inscs.map((i) => i.horario_id).sort((a, b) => a - b).join(',');
    if (vistas.has(firma)) continue; // renovaciones comparten inscripciones
    vistas.add(firma);
    out.push(cuentaId);
  }
  return out;
};

const publico = ({ _vigente, ...resto }) => resto;

export const renovacionHistoricaService = {
  listarPlanesHistoricos: async (alumnoId) => {
    const idAlumno = Number.parseInt(alumnoId);
    const [cuentas, enCurso, limite] = await Promise.all([
      cuentasFinalizadas(idAlumno),
      cargarEnCurso(idAlumno),
      fechaLimiteZombie(),
    ]);
    const out = [];
    for (const cuentaId of cuentas.slice(0, LIMITE_PLANES)) {
      out.push(publico(await evaluarPaquete(idAlumno, cuentaId, enCurso, limite)));
    }
    return out;
  },

  renovar: async (alumnoId, cuentaId, { horario_ids, fecha_inicio } = {}) => {
    const idAlumno = Number.parseInt(alumnoId);
    const idCuenta = Number.parseInt(cuentaId);

    const cuenta = await prisma.cuentas_por_cobrar.findUnique({ where: { id: idCuenta }, select: { alumno_id: true } });
    if (!cuenta) throw new ApiError('La cuenta indicada no existe.', 404);
    if (cuenta.alumno_id !== idAlumno) throw new ApiError('La cuenta no pertenece al alumno.', 403);

    const links = await prisma.inscripciones_deudas_link.findMany({
      where: { cuenta_id: idCuenta },
      select: { inscripciones: { select: { estado: true } } },
    });
    if (links.length === 0) throw new ApiError('La cuenta no tiene un paquete de inscripciones asociado.', 404);
    if (!esPaqueteFinalizado(links.map((l) => l.inscripciones.estado)))
      throw new ApiError('El paquete aún no está finalizado.', 409);

    const [enCurso, limite] = await Promise.all([cargarEnCurso(idAlumno), fechaLimiteZombie()]);
    const evaluacion = await evaluarPaquete(idAlumno, idCuenta, enCurso, limite);
    if (!evaluacion.puede_renovar) throw new ApiError(evaluacion.motivo_no_renovable, 409);

    const ids = horario_ids?.length ? [...new Set(horario_ids)] : evaluacion.horarios.map((h) => h.id);
    if (horario_ids?.length && ids.length !== horario_ids.length)
      throw new ApiError('No se pueden repetir horarios.', 400);

    const concepto = horario_ids?.length
      ? elegirConceptoVigente(
          await prisma.catalogo_conceptos.findMany({
            where: { activo: true, es_vigente: true, cantidad_clases_semanal: ids.length },
          }),
          null,
          ids.length
        )
      : evaluacion._vigente;
    if (!concepto) throw new ApiError(`No existe un plan vigente para ${ids.length} clases por semana.`, 400);

    for (const id of ids) {
      const h = await prisma.horarios_clases.findUnique({ where: { id }, select: { activo: true } });
      if (!h) throw new ApiError(`El horario ${id} no existe.`, 404);
      if (!h.activo) throw new ApiError(`El horario ${id} está desactivado.`, 409);
      if (!(await tieneCupo(id, limite))) throw new ApiError(`El horario ${id} no tiene cupos disponibles.`, 409);
    }

    const fechaInicio = fecha_inicio ?? diaLimaAFechaUTC().toISOString().slice(0, 10);

    let r;
    try {
      // El merch es de pago único: la renovación NUNCA reenvía merch_ids ni sede_recojo_id,
      // aunque el ciclo anterior los haya incluido (ver tests/merch-ingresos-imagenes.test.js).
      r = await inscripcionService.inscribirPaquete({
        alumno_id: idAlumno,
        horario_ids: ids,
        fecha_inicio_electiva: fechaInicio,
        forzar_concepto_vigente: true,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.code === 'P2002') throw new ApiError('El alumno ya está inscrito en uno de los horarios seleccionados.', 409);
      if (/⛔|deuda|AGOTADO/i.test(error.message)) throw new ApiError(error.message, 409);
      throw error;
    }

    return {
      cuenta_id: r.cuenta_id,
      inscripcion_ids: r.inscripciones.map((i) => i.id),
      monto_final: r.total_a_pagar,
      fecha_inicio: fechaInicio,
      estado: 'PENDIENTE_PAGO',
    };
  },
};
