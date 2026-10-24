import { DIAS_CICLO, aFechaUTC, diasEntreUTC } from './ciclo.util.js';
import { claveDiaDesdeFecha, claveDiaLima } from './feriado.util.js';
import { ESTADOS_CLASE_VIGENTE } from './reprogramacion-ciclo.util.js';

// =================================================================
// 🔢 Cambio de horario por CONTEO de clases (no por tope de fechas).
//
// Estado previo: `updateInscripcion` borraba todas las clases desde el inicio
// del ciclo y volvía a generar con `generarClasesFuturas`, que corta en
// inicio + 29 días. Un alumno que arrancó un martes y se pasa a jueves recibía
// jueves +2, +9, +16, +23 y el quinto (+30) quedaba fuera de la ventana: pagó 5
// clases y recibía 4.
//
// Regla de negocio: el plan de 1 día/semana garantiza CLASES_POR_CICLO clases.
// Al cambiar de horario: pendientes = CLASES_POR_CICLO − consumidas, y se
// generan exactamente esas desde la fecha efectiva (ver
// `asistenciaService.generarClasesPorConteo`).
//
// 🚩 INVARIANTE DE BL-006 QUE ACÁ SE RESPETA: `fecha_fin_ciclo` de una
// inscripción REGULAR vigente se queda en NULL. El cierre lo deriva
// `finCicloEfectivo()` y lo aplica el VERDUGO a los 30 días de
// `fecha_inscripcion`. Si la última clase cae más allá de ese cierre, NO se
// graba el fin: se corre el ancla (fecha_inscripcion + fecha_inicio_ciclo) lo
// justo para que el +30 derivado la cubra (mismo mecanismo que BL-005, ver
// reprogramacion-ciclo.util.js).
// =================================================================

// Una clase ya pasó por el alumno aunque la fecha sea futura/hoy.
const ESTADOS_CONSUMIDOS = Object.freeze(['PRESENTE', 'FALTA']);

/**
 * Reparte las clases del ciclo actual en las que se CONSERVAN y las que se
 * eliminan al cambiar de horario.
 *
 * Se conservan las anteriores a la fecha efectiva (cualquier estado: la
 * historia no se reescribe) y las ya marcadas PRESENTE/FALTA aunque caigan hoy
 * o después. Todo lo demás (programadas a futuro en el horario viejo) se borra.
 *
 * `consumidas` solo cuenta estados que son "clase del ciclo"
 * (ESTADOS_CLASE_VIGENTE): una clase CANCELADA por feriado o REPROGRAMADA no se
 * dictó, así que el alumno todavía la tiene pendiente.
 *
 * Pura y sincrónica.
 *
 * @param {{id: number, fecha: Date, estado: string|null}[]} clases del ciclo
 * @param {string} claveEfectiva 'YYYY-MM-DD' desde la que rige el nuevo horario
 * @returns {{retenidas: object[], idsAEliminar: number[], consumidas: number}}
 */
export const separarClasesParaCambio = (clases, claveEfectiva) => {
  const retenidas = [];
  const idsAEliminar = [];
  let consumidas = 0;

  for (const clase of clases ?? []) {
    const estado = clase.estado ?? 'PRESENTE';
    const clave = claveDiaDesdeFecha(clase.fecha);
    const esPasada = clave !== null && clave < claveEfectiva;

    if (esPasada || ESTADOS_CONSUMIDOS.includes(estado)) {
      retenidas.push(clase);
      if (ESTADOS_CLASE_VIGENTE.includes(estado)) consumidas += 1;
    } else {
      idsAEliminar.push(clase.id);
    }
  }

  return { retenidas, idsAEliminar, consumidas };
};

/**
 * Cuántos días hay que correr el ancla del ciclo para que el cierre del
 * VERDUGO no se lleve la última clase.
 *
 * El VERDUGO finaliza la inscripción cuando pasaron DIAS_CICLO días desde
 * `fecha_inscripcion` (día de Lima): la mañana del día +30 ya no existe. Una
 * clase en el día +30 o posterior se perdería, así que el último día utilizable
 * es +29 (DIAS_CICLO − 1).
 *
 * @param {Date|string} fechaInscripcion ancla actual (timestamp)
 * @param {Date|string} ultimaClase fecha de la última clase generada
 * @returns {number} 0 si ya cabe; > 0 = días a sumar al ancla
 */
export const diasParaCubrirUltimaClase = (fechaInscripcion, ultimaClase) => {
  // El VERDUGO cuenta desde el día CALENDARIO DE LIMA del timestamp, no desde su
  // día UTC (un timestamp tardío en Lima ya cae al día UTC siguiente).
  const ancla = aFechaUTC(`${claveDiaLima(fechaInscripcion)}T12:00:00.000Z`);
  const dias = diasEntreUTC(ancla, ultimaClase);
  if (dias === null) return 0;

  return Math.max(0, dias - (DIAS_CICLO - 1));
};
