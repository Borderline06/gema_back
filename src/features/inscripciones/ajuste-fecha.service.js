import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { parsearFechaInicioCiclo } from '../../shared/utils/ciclo.util.js';
import { esIndividual } from '../../shared/utils/tipo-inscripcion.util.js';
import {
  cargarFeriadosActivos,
  buscarFeriado,
  claveDiaDesdeFecha,
  claveDiaLima,
} from '../../shared/utils/feriado.util.js';
import { cargarSlotsRecuperacion } from '../../shared/utils/recuperacion-slot.util.js';
import { reubicarFechasConChoque } from '../asistencia/asistencia.service.js';

// =================================================================
// BL-006: ajuste de fecha de inicio de un paquete YA PAGADO.
// dia_semana se guarda 1..7 (1 = Lunes ... 7 = Domingo). Se tolera 0 = Domingo.
// =================================================================

const NOMBRES_DIA = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  7: 'Domingo',
};

// Estados que se pueden borrar y regenerar. Todo lo demás (PRESENTE, FALTA,
// JUSTIFICADO_LESION, COMPLETADA_*, REPROGRAMADO, ...) se respeta.
const ESTADOS_REGENERABLES = ['PROGRAMADA', 'PENDIENTE'];
// Estados que NO cuentan como "asistencia registrada".
const ESTADOS_SIN_ASISTENCIA = ['PROGRAMADA', 'PENDIENTE', 'REPROGRAMADO'];

const MAX_DIAS_BUSQUEDA = 400;
const DIAS_CICLO_SIN_CLASES = 30;

// ------------------------- Funciones puras -------------------------

/** 'YYYY-MM-DD' -> 1..7 (1 = Lunes, 7 = Domingo). */
export const diaSemanaDeClave = (clave) => {
  const d = new Date(`${clave}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

const normalizarDia = (d) => (Number(d) === 0 ? 7 : Number(d));

export const nombreDia = (d) => NOMBRES_DIA[normalizarDia(d)] ?? String(d);

/** ¿La fecha cae en uno de los días de semana del paquete? */
export const esDiaPermitido = (clave, diasPermitidos) =>
  diasPermitidos.map(normalizarDia).includes(diaSemanaDeClave(clave));

/**
 * Calcula `cantidad` fechas desde `fechaInicio` (inclusive) sobre los días
 * permitidos, saltando feriados (el feriado no consume cupo: la clase se
 * corre a la siguiente fecha válida, así se conserva el total).
 *
 * @returns {string[]} 'YYYY-MM-DD' ordenadas
 */
export const calcularFechasRegeneracion = ({
  fechaInicio,
  diasPermitidos,
  cantidad,
  feriados = new Set(),
}) => {
  const dias = new Set(diasPermitidos.map(normalizarDia));
  const out = [];
  if (!cantidad || cantidad <= 0 || dias.size === 0) return out;

  const cursor = new Date(`${fechaInicio}T12:00:00Z`);
  for (let i = 0; i < MAX_DIAS_BUSQUEDA && out.length < cantidad; i++) {
    const clave = cursor.toISOString().slice(0, 10);
    if (dias.has(diaSemanaDeClave(clave)) && !feriados.has(clave)) out.push(clave);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
};

/** Fecha local a mediodía, igual que el resto de la generación de clases. */
const aFechaClase = (clave) => new Date(`${clave}T12:00:00`);

// registros_asistencia.fecha es @db.Date: se compara contra medianoche UTC.
const aFechaClaveUTC = (clave) => new Date(`${clave}T00:00:00Z`);

// ------------------------- Carga de contexto -------------------------

const cargarContexto = async (cliente, cuentaId) => {
  const cuenta = await cliente.cuentas_por_cobrar.findUnique({ where: { id: cuentaId } });
  if (!cuenta) throw new ApiError('No se encontró la cuenta indicada.', 404);

  const links = await cliente.inscripciones_deudas_link.findMany({
    where: { cuenta_id: cuentaId },
    include: {
      inscripciones: {
        include: { horarios_clases: { select: { dia_semana: true, hora_inicio: true } } },
      },
    },
  });
  if (links.length === 0) {
    throw new ApiError('No se encontraron inscripciones vinculadas a esta cuenta.', 404);
  }

  const pagoAprobado =
    (await cliente.pagos.count({
      where: { cuenta_id: cuentaId, estado_validacion: 'APROBADO' },
    })) > 0;

  const inscripciones = links.map((l) => l.inscripciones);
  const tipo = inscripciones.some((i) => esIndividual(i)) ? 'INDIVIDUAL' : 'REGULAR';

  // Inicio actual del ciclo: el más temprano de los links; si no hay, fecha_inscripcion.
  const clavesLink = links
    .map((l) => claveDiaDesdeFecha(l.fecha_inicio_ciclo))
    .filter(Boolean)
    .sort();
  const clavesInsc = inscripciones.map((i) => claveDiaLima(i.fecha_inscripcion)).sort();
  const fechaInicioActual = clavesLink[0] ?? clavesInsc[0] ?? null;

  const diasPermitidos = [
    ...new Set(inscripciones.map((i) => normalizarDia(i.horarios_clases.dia_semana))),
  ].sort((a, b) => a - b);

  // Solo el ciclo vigente: desde el inicio actual (no cuenta asistencia de ciclos previos).
  const registros = await cliente.registros_asistencia.findMany({
    where: {
      inscripcion_id: { in: inscripciones.map((i) => i.id) },
      ...(fechaInicioActual ? { fecha: { gte: aFechaClaveUTC(fechaInicioActual) } } : {}),
    },
    orderBy: { fecha: 'asc' },
  });

  const regenerables = registros.filter(
    (r) => ESTADOS_REGENERABLES.includes(r.estado) && r.reprogramacion_clase_id == null
  );
  const conAsistencia = registros.filter((r) => !ESTADOS_SIN_ASISTENCIA.includes(r.estado));
  const primeraClase = registros.length ? claveDiaDesdeFecha(registros[0].fecha) : fechaInicioActual;

  return {
    cuenta,
    inscripciones,
    tipo,
    pagoAprobado,
    fechaInicioActual,
    diasPermitidos,
    regenerables,
    conAsistencia,
    primeraClase,
  };
};

const motivoBloqueo = (ctx, hoy) => {
  if (!ctx.pagoAprobado) return 'El pago de este paquete aún no está aprobado.';
  if (ctx.conAsistencia.length > 0) {
    return 'El paquete ya tiene asistencia registrada; no se puede cambiar la fecha de inicio.';
  }
  if (ctx.primeraClase && ctx.primeraClase < hoy) {
    return 'La primera clase del paquete ya pasó; no se puede cambiar la fecha de inicio.';
  }
  return null;
};

// ------------------------- API -------------------------

export const ajusteFechaService = {
  obtenerEstado: async (cuentaIdRaw) => {
    const cuentaId = Number.parseInt(cuentaIdRaw, 10);
    if (!Number.isInteger(cuentaId)) throw new ApiError('Cuenta inválida.', 400);

    const ctx = await cargarContexto(prisma, cuentaId);
    const bloqueo = motivoBloqueo(ctx, claveDiaLima());

    return {
      cuenta_id: cuentaId,
      tipo: ctx.tipo,
      pago_aprobado: ctx.pagoAprobado,
      puede_ajustar: bloqueo === null,
      motivo_bloqueo: bloqueo,
      fecha_inicio_actual: ctx.fechaInicioActual,
      primera_clase: ctx.primeraClase,
      dias_permitidos: ctx.diasPermitidos,
      dias_permitidos_nombres: ctx.diasPermitidos.map(nombreDia),
      clases_a_regenerar: ctx.tipo === 'INDIVIDUAL' ? 1 : ctx.regenerables.length,
    };
  },

  ajustarFecha: async (cuentaIdRaw, { nueva_fecha, motivo }, usuarioId) => {
    const cuentaId = Number.parseInt(cuentaIdRaw, 10);
    if (!Number.isInteger(cuentaId)) throw new ApiError('Cuenta inválida.', 400);

    // Valida formato y fechas imposibles (400) antes de tocar la BD.
    const fechaTs = parsearFechaInicioCiclo(nueva_fecha);
    const hoy = claveDiaLima();
    if (nueva_fecha < hoy) throw new ApiError('La nueva fecha no puede ser anterior a hoy.', 400);

    return prisma.$transaction(async (tx) => {
      const ctx = await cargarContexto(tx, cuentaId);

      const bloqueo = motivoBloqueo(ctx, hoy);
      if (bloqueo) throw new ApiError(bloqueo, 409);

      if (!esDiaPermitido(nueva_fecha, ctx.diasPermitidos)) {
        throw new ApiError(
          `La nueva fecha debe caer en uno de los días del paquete: ${ctx.diasPermitidos
            .map(nombreDia)
            .join(', ')}.`,
          400
        );
      }

      const indiceFeriados = await cargarFeriadosActivos(tx);
      const feriado = buscarFeriado(nueva_fecha, indiceFeriados);
      if (feriado) {
        throw new ApiError(`La nueva fecha (${nueva_fecha}) es feriado: ${feriado.descripcion}.`, 409);
      }
      const feriados = new Set(indiceFeriados.exactos.keys());

      const esInd = ctx.tipo === 'INDIVIDUAL';
      const cantidad = ctx.regenerables.length;
      const eliminar = ctx.regenerables.map((r) => r.id);

      // 1. Fechas (claves) a generar
      let claves;
      if (esInd) {
        claves = [nueva_fecha];
      } else if (cantidad > 0) {
        claves = calcularFechasRegeneracion({
          fechaInicio: nueva_fecha,
          diasPermitidos: ctx.diasPermitidos,
          cantidad,
          feriados,
        });
      } else {
        // Nunca se generaron: generación normal de un ciclo de 30 días.
        const limite = new Date(`${nueva_fecha}T12:00:00Z`);
        limite.setUTCDate(limite.getUTCDate() + DIAS_CICLO_SIN_CLASES - 1);
        const tope = limite.toISOString().slice(0, 10);
        claves = calcularFechasRegeneracion({
          fechaInicio: nueva_fecha,
          diasPermitidos: ctx.diasPermitidos,
          cantidad: 60,
          feriados,
        }).filter((c) => c <= tope);
      }

      // 2. Asigna cada fecha a la inscripción cuyo día coincide
      const porInsc = new Map();
      for (const clave of claves) {
        const dia = diaSemanaDeClave(clave);
        const insc =
          ctx.inscripciones.find((i) => normalizarDia(i.horarios_clases.dia_semana) === dia) ??
          ctx.inscripciones[0];
        if (!porInsc.has(insc.id)) porInsc.set(insc.id, { insc, claves: [] });
        porInsc.get(insc.id).claves.push(clave);
      }

      // 3. BL-010: esquiva recuperaciones ya agendadas
      const advertencias = [];
      const creados = [];
      for (const { insc, claves: clavesInsc } of porInsc.values()) {
        const indice = await cargarSlotsRecuperacion(tx, insc.alumno_id);
        const { fechas, choques, omitidas } = reubicarFechasConChoque({
          fechas: clavesInsc.map(aFechaClase),
          horaInicio: insc.horarios_clases.hora_inicio,
          indiceRecuperaciones: indice,
        });
        for (const c of choques) {
          advertencias.push(
            c.fecha_reubicada
              ? `La clase del ${c.fecha} chocaba con una recuperación (${c.hora}); se movió al ${c.fecha_reubicada}.`
              : `La clase del ${c.fecha} chocaba con una recuperación (${c.hora}).`
          );
        }
        for (const o of omitidas) {
          advertencias.push(`No se halló horario libre para la clase del ${o.fecha}; se omitió.`);
        }
        for (const f of fechas) creados.push({ insc, fecha: f });
      }

      // 4. Borra solo lo regenerable y crea lo nuevo
      let clasesEliminadas = 0;
      if (eliminar.length) {
        clasesEliminadas = (
          await tx.registros_asistencia.deleteMany({ where: { id: { in: eliminar } } })
        ).count;
      }

      let clasesGeneradas = 0;
      if (creados.length) {
        const r = await tx.registros_asistencia.createMany({
          data: creados.map(({ insc, fecha }) => ({
            inscripcion_id: insc.id,
            fecha,
            estado: 'PROGRAMADA',
            comentario: `Regenerado por ajuste de fecha - Admin ID: ${usuarioId}`,
          })),
          skipDuplicates: true,
        });
        clasesGeneradas = r.count;
        if (clasesGeneradas < creados.length) {
          advertencias.push(
            `${creados.length - clasesGeneradas} clase(s) no se crearon porque ya existía un registro en esa fecha.`
          );
        }
      }

      const fechasFinales = [...new Set(creados.map((c) => claveDiaDesdeFecha(c.fecha)))].sort();

      // 5. Inicio del ciclo (mismo criterio que actualizarFechaInicioPorPago)
      await tx.inscripciones.updateMany({
        where: { id: { in: ctx.inscripciones.map((i) => i.id) } },
        data: {
          fecha_inscripcion: fechaTs,
          fecha_inscripcion_original: fechaTs,
          actualizado_en: new Date(),
        },
      });
      await tx.inscripciones_deudas_link.updateMany({
        where: { cuenta_id: cuentaId },
        data: esInd
          ? { fecha_inicio_ciclo: fechaTs, fecha_fin_ciclo: fechaTs }
          : { fecha_inicio_ciclo: fechaTs },
      });

      // 6. Auditoría
      await tx.auditoria_ajuste_fecha.create({
        data: {
          cuenta_id: cuentaId,
          fecha_anterior: aFechaClaveUTC(ctx.fechaInicioActual ?? nueva_fecha),
          fecha_nueva: aFechaClaveUTC(nueva_fecha),
          clases_eliminadas: clasesEliminadas,
          clases_generadas: clasesGeneradas,
          motivo: motivo ?? null,
          realizado_por: usuarioId,
        },
      });

      return {
        cuenta_id: cuentaId,
        fecha_inicio: nueva_fecha,
        clases_eliminadas: clasesEliminadas,
        clases_generadas: clasesGeneradas,
        fechas: fechasFinales,
        advertencias,
      };
    });
  },
};
