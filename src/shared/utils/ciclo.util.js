import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

import { ApiError } from './error.util.js';
// 🎯 BL-001: la dirección de dependencia es siempre ciclo → tipo-inscripcion,
// nunca al revés (tipo-inscripcion.util.js no importa nada).
import { esIndividual } from './tipo-inscripcion.util.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// =================================================================
// 🎯 BL-011 / BL-012: fuente única de verdad de la vigencia de un ciclo.
//
// Antes esta lógica vivía duplicada y divergente en cuatro servicios
// (cron VERDUGO, renovación, exportador BL-013, dashboard). Todo lo que
// decida "cuánto dura un ciclo" o "en qué día cae una fecha" vive acá.
//
// ⚠️ Las columnas fecha_inicio_ciclo / fecha_fin_ciclo son @db.Date: Prisma
// las entrega SIEMPRE a medianoche UTC. Cualquier cálculo con getters locales
// corre un día en Lima (UTC-5), así que acá todo se hace en UTC.
// =================================================================

export const TZ_LIMA = 'America/Lima';

// Cierre real del ciclo regular que aplica el cron VERDUGO
// (inscripcion-cron.service.js -> gestionarVencimientos).
// Ojo: NO es el mismo número que DIAS_VIGENCIA_INSCRIPCION (29), que es la
// regla del badge de la tabla de alumnos.
export const DIAS_CICLO = 30;

// 🎯 BL-001: una inscripción INDIVIDUAL es una clase suelta, no un ciclo.
// Su "ciclo" dura el día de la clase, así que el cron de individuales cierra
// fecha_fin_ciclo en la fecha de esa clase en vez de a los 30 días.
export const DIAS_CICLO_INDIVIDUAL = 1;

/**
 * 🎯 BL-001: cuántos días dura el ciclo de una inscripción según su tipo.
 * NULL se asume REGULAR (ver tipo-inscripcion.util.js).
 */
export const diasCicloDeTipo = (inscripcionOTipo) =>
  esIndividual(inscripcionOTipo) ? DIAS_CICLO_INDIVIDUAL : DIAS_CICLO;

// 🎯 Estados reales de registros_asistencia: PRESENTE | FALTA | CANCELADO | PROGRAMADA.
// CANCELADO no cuenta como clase del ciclo.
export const ESTADOS_VALIDOS_PARA_CICLO = ['PRESENTE', 'FALTA', 'PROGRAMADA'];

const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const MS_POR_DIA = 86400000;

/**
 * Normaliza cualquier fecha a medianoche UTC del día calendario que representa.
 * Unifica los dos formatos que convivían en la misma llave del historial:
 * un @db.Date (00:00 UTC) y un Timestamp(6) guardado a mediodía de Lima.
 */
export const aFechaUTC = (valor) => {
  if (!valor) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Suma días en UTC. Usar setDate local desplazaría el día en Lima.
 */
export const sumarDiasUTC = (fecha, dias) => {
  const d = new Date(fecha);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
};

/**
 * Días calendario entre dos fechas (sin contar el día final).
 */
export const diasEntreUTC = (desde, hasta) => {
  const a = aFechaUTC(desde);
  const b = aFechaUTC(hasta);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / MS_POR_DIA);
};

/**
 * 🎯 BL-011: fin real del ciclo.
 * fecha_fin_ciclo es NULL mientras el ciclo está abierto, así que se deriva
 * fecha_inicio_ciclo + 30d, que es el cierre que aplicará el cron VERDUGO.
 * Misma definición que ya usaba el exportador BL-013.
 */
export const finCicloEfectivo = (inicio, fin) => {
  if (fin) return aFechaUTC(fin);
  const ini = aFechaUTC(inicio);
  if (!ini) return null;
  return sumarDiasUTC(ini, DIAS_CICLO);
};

/**
 * Rango del mes en UTC: [medianoche del día 1, fin del último día].
 */
export const rangoMesUTC = (mes, anio) => ({
  desde: new Date(Date.UTC(anio, mes - 1, 1)),
  hasta: new Date(Date.UTC(anio, mes, 0, 23, 59, 59, 999)),
});

/**
 * 🎯 BL-012: un ciclo pertenece a un mes si SOLAPA con él, no si empieza en él.
 * Así un ciclo del 15/ene al 15/feb sale tanto en enero como en febrero.
 *
 * ⚠️ Divergencia deliberada con dashboard.service.js, que trata
 * fecha_fin_ciclo === null como "abierto para siempre". Acá un ciclo abierto
 * vale inicio + 30d, porque BL-011 fija que el ciclo regular dura 30 días.
 */
export const cicloSolapaMes = (inicio, fin, mes, anio) => {
  const ini = aFechaUTC(inicio);
  if (!ini) return false;
  const finEfectivo = finCicloEfectivo(inicio, fin);
  const { desde, hasta } = rangoMesUTC(mes, anio);
  return ini <= hasta && finEfectivo >= desde;
};

/**
 * Toma el día calendario de Lima de un instante y lo devuelve a mediodía UTC.
 *
 * 🔧 BL-011: esto es lo que arregla los escritores que hacían
 * `fecha_fin_ciclo: new Date()` sobre una columna @db.Date. Postgres trunca al
 * día UTC, así que entre las 19:00 y 23:59 de Lima el ciclo quedaba cerrado un
 * día tarde. Mediodía UTC está lejos de los dos bordes del día.
 */
export const diaLimaAFechaUTC = (instante = new Date()) => {
  const diaLima = dayjs(instante).tz(TZ_LIMA).format('YYYY-MM-DD');
  return new Date(`${diaLima}T12:00:00.000Z`);
};

/**
 * 'Enero 2026'. Array fijo en vez de dayjs.locale('es') para no mutar el
 * locale global de dayjs desde un util compartido.
 */
export const etiquetaMes = (mes, anio) => `${MESES_ES[mes - 1] ?? 'Mes'} ${anio}`;

/**
 * Comparador cronológico ascendente para links de deuda.
 *
 * 🔧 BL-011: reemplaza al orderBy fecha_inicio_ciclo asc de Prisma.
 * Postgres ordena ASC NULLS LAST, así que los links previos al backfill (sin
 * fecha_inicio_ciclo) recibían el numero_mes_ciclo más alto. Acá los NULL van
 * al final de forma explícita, con creado_en como desempate.
 */
export const compararInicioCicloAsc = (a, b) => {
  const ta = a?.fecha_inicio_ciclo ? new Date(a.fecha_inicio_ciclo).getTime() : null;
  const tb = b?.fecha_inicio_ciclo ? new Date(b.fecha_inicio_ciclo).getTime() : null;

  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  if (ta === null && tb !== null) return 1;
  if (tb === null && ta !== null) return -1;

  const ca = a?.creado_en ? new Date(a.creado_en).getTime() : 0;
  const cb = b?.creado_en ? new Date(b.creado_en).getTime() : 0;
  return ca - cb;
};

/**
 * Comparador descendente (más reciente primero) para filas ya construidas del
 * historial. Null-safe: evita el `new Date(null)` que mandaba los ciclos sin
 * fecha a la época 1970.
 */
export const compararFilaCicloDesc = (a, b) => {
  const ta = a?.fecha_inicio_ciclo ? new Date(a.fecha_inicio_ciclo).getTime() : null;
  const tb = b?.fecha_inicio_ciclo ? new Date(b.fecha_inicio_ciclo).getTime() : null;

  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
};

/**
 * Valida y parsea los query params mes/anio.
 *
 * Regex de entero estricto en vez de parseInt (que aceptaría "1abc"), igual
 * que el validador de sede_id de historial_academico.service.js.
 * ⚠️ Llamar SIEMPRE fuera del try del servicio: el catch de los servicios
 * reempaqueta todo como 500 y se comería este 400.
 *
 * @returns {{mes:number, anio:number}|null} null = sin filtro (solo si no es requerido)
 */
export const parsearMesAnio = (mes, anio, { requerido = false } = {}) => {
  const vacio = (v) => v === null || v === undefined || v === '';

  if (vacio(mes) && vacio(anio)) {
    if (requerido) {
      throw new ApiError('Los parámetros mes y anio son obligatorios', 400);
    }
    return null;
  }

  if (vacio(mes) || vacio(anio)) {
    throw new ApiError('Los parámetros mes y anio deben enviarse juntos', 400);
  }

  const mesBruto = String(mes).trim();
  const anioBruto = String(anio).trim();

  if (!/^[0-9]+$/.test(mesBruto) || Number(mesBruto) < 1 || Number(mesBruto) > 12) {
    throw new ApiError('El parámetro mes debe ser un entero entre 1 y 12', 400);
  }
  if (!/^[0-9]+$/.test(anioBruto) || Number(anioBruto) < 2000 || Number(anioBruto) > 2100) {
    throw new ApiError('El parámetro anio debe ser un entero entre 2000 y 2100', 400);
  }

  return { mes: Number(mesBruto), anio: Number(anioBruto) };
};
