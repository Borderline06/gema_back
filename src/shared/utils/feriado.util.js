import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

import { TZ_LIMA, aFechaUTC } from './ciclo.util.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// =================================================================
// 🎉 BL-003: verificación de feriados reutilizable.
//
// Estado previo: `feriadoService.verificarSiEsFeriado` existía pero NO tenía un
// solo llamador en todo src/, y además era inutilizable: hacía
// `findUnique({ where: { fecha: new Date(fecha) } })` sobre una columna
// `fecha @unique @db.Date`. Con el string '2026-07-28' funciona (medianoche
// UTC), pero con un Date a mediodía (el formato que produce
// clase-fecha.util.js y el que guarda fecha_inscripcion) no matchea NUNCA.
// Ni generarClasesFuturas ni generarClaseUnica consultaban feriados.
//
// 🚩 SEMÁNTICA CANÓNICA: fecha exacta CON AÑO.
// Es lo que modela la tabla (`fecha @unique @db.Date`, una fila por año) y es
// lo correcto para feriados móviles (ej. Viernes Santo).
//
// ⚠️ DIVERGENCIA CONOCIDA, deliberadamente NO corregida acá:
// clase.service.js compara solo getUTCDate() + getUTCMonth(), ignorando el
// año, así que trata los feriados como recurrentes. Este util soporta AMBOS
// modos vía la opción `recurrente`, de forma que ese archivo pueda migrar sin
// cambiar su comportamiento. Unificar la semántica es decisión de negocio y va
// en un ticket aparte.
//
// 🗓️ DOS CLAVES DE DÍA, no una. El sistema convive con dos formatos:
//   · feriados.fecha y registros_asistencia.fecha son @db.Date → Prisma los
//     entrega a MEDIANOCHE UTC → la clave sale con getters UTC.
//   · inscripciones.fecha_inscripcion es Timestamp(6) a mediodía de Lima
//     (17:00Z) → con getters UTC el día sigue siendo correcto, pero un
//     timestamp posterior a las 19:00 de Lima ya cae al día UTC siguiente.
// Por eso se exponen las dos y la elección es explícita en cada llamador, en
// vez de un `new Date()` adivinando.
// =================================================================

/**
 * Clave de día de un valor que viene de una columna @db.Date (o de cualquier
 * Date anclado a mediodía). Usa getters UTC vía aFechaUTC.
 *
 * @returns {string|null} 'YYYY-MM-DD'
 */
export const claveDiaDesdeFecha = (valor) => {
  const d = aFechaUTC(valor);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
};

/**
 * Clave de día calendario de Lima de un instante cualquiera. Para timestamps
 * "de reloj" (now(), creado_en) donde el día UTC puede no ser el día de Lima.
 *
 * @returns {string} 'YYYY-MM-DD'
 */
export const claveDiaLima = (instante = new Date()) =>
  dayjs(instante).tz(TZ_LIMA).format('YYYY-MM-DD');

/**
 * Carga los feriados activos UNA sola vez y devuelve índices para decidir en
 * memoria. Separar carga de decisión permite evaluar N fechas con una única
 * consulta dentro de la misma transacción.
 *
 * `activo` se filtra en SQL (el verificarSiEsFeriado viejo lo evaluaba después
 * del findUnique, que es equivalente pero inconsistente con clase.service.js).
 *
 * @param {import('@prisma/client').PrismaClient} cliente `tx` o `prisma`
 */
export const cargarFeriadosActivos = async (cliente) => {
  const filas = await cliente.feriados.findMany({ where: { activo: true } });

  const exactos = new Map();     // 'YYYY-MM-DD' -> fila
  const recurrentes = new Map(); // 'MM-DD'      -> fila

  for (const fila of filas) {
    const clave = claveDiaDesdeFecha(fila.fecha);
    if (!clave) continue;

    if (!exactos.has(clave)) exactos.set(clave, fila);

    const mmdd = clave.slice(5);
    if (!recurrentes.has(mmdd)) recurrentes.set(mmdd, fila);
  }

  return { exactos, recurrentes, filas };
};

/**
 * Devuelve la fila del feriado que aplica a esa clave de día, o null.
 * Puro y sincrónico: nunca consulta, nunca lanza.
 *
 * @param {string|null} claveDia 'YYYY-MM-DD'
 * @param {{exactos: Map, recurrentes: Map}} indice de cargarFeriadosActivos
 * @param {{recurrente?: boolean}} opciones `recurrente: true` replica la
 *   comparación día+mes de clase.service.js (ignora el año).
 */
export const buscarFeriado = (claveDia, indice, { recurrente = false } = {}) => {
  if (!claveDia || !indice) return null;

  const exacto = indice.exactos.get(claveDia);
  if (exacto) return exacto;

  if (!recurrente) return null;
  return indice.recurrentes.get(claveDia.slice(5)) ?? null;
};

export const esFeriadoEnIndice = (claveDia, indice, opciones) =>
  !!buscarFeriado(claveDia, indice, opciones);

export const descripcionFeriado = (claveDia, indice, opciones) =>
  buscarFeriado(claveDia, indice, opciones)?.descripcion ?? null;
