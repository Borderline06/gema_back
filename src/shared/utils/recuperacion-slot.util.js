import { claveDiaDesdeFecha } from './feriado.util.js';
import { formatHoraUTC } from './date.util.js';

// =================================================================
// 🤝 BL-010: slots que el alumno YA tiene ocupados por una recuperación.
//
// Estado previo: la generación de clases (`generarClasesFuturas` /
// `generarClaseUnica`) insertaba con `createMany({ skipDuplicates: true })` sin
// mirar la tabla `recuperaciones`. Eso producía DOS fallos distintos:
//
//   1️⃣ DUPLICADO EN LA AGENDA. Con una recuperación `PROGRAMADA` ese día/hora,
//      `obtenerAgendaCoordinador` inyecta al alumno como `insc-recu-<id>`
//      ADEMÁS de su clase regular `PROGRAMADA`: el coordinador lo ve dos veces
//      en el mismo turno.
//
//   2️⃣ CLASE PERDIDA EN SILENCIO. Al marcar una recuperación como PRESENTE,
//      `procesarAsistenciaMasiva` crea una fila FÍSICA de registros_asistencia
//      en esa fecha con comentario `[RECUPERACION]`. Esa fila ocupa el
//      @@unique([inscripcion_id, fecha]), así que `skipDuplicates` descarta la
//      clase regular sin avisar — y la agenda filtra los `[RECUPERACION]` de
//      las inscripciones regulares, con lo que la sesión desaparece del todo.
//      El alumno paga 30 días y recibe una clase menos.
//
// 🚩 CRITERIO DE CHOQUE: mismo DÍA + misma HORA DE INICIO, aunque sea en otra
// cancha. El alumno no puede estar en dos canchas a la vez. Es deliberadamente
// más amplio que el de `validarElegibilidad` (recuperacion.service.js:420), que
// exige `id_horario === horarioDestinoId` y por eso deja pasar la recuperación
// a la misma hora en otro horario.
//
// 🧱 Mismo patrón que feriado.util.js: `cargar*` hace UNA consulta y devuelve
// índices, `buscar*` decide en memoria, puro y sincrónico. Así se evalúan las N
// fechas de un ciclo dentro de la misma transacción con una sola query.
// =================================================================

/**
 * Estados de `recuperaciones` que OCUPAN el slot del alumno.
 *
 * Por regla de negocio del ticket, SOLO `PROGRAMADA` (estrictamente): es una
 * clase futura ya agendada que chocaría con la nueva. Se excluyen `PENDIENTE`
 * (sin agendar: `fecha_programada` es NULL), `VENCIDA` y las `COMPLETADA_*`.
 *
 * ⚠️ Riesgo conocido de excluir `COMPLETADA_PRESENTE`: si un ciclo retroactivo
 * cae sobre una recuperación ya completada, la fila física `[RECUPERACION]`
 * ocupa el @@unique([inscripcion_id, fecha]) y `skipDuplicates` descarta la
 * clase regular (fallo 2️⃣ de la cabecera). Es consecuencia directa del criterio
 * estricto; para cubrirlo bastaría añadir el estado a esta lista.
 */
export const ESTADOS_RECUPERACION_OCUPAN_SLOT = Object.freeze(['PROGRAMADA']);

/**
 * Clave de slot: 'YYYY-MM-DDTHH:mm'.
 *
 * El día sale de `claveDiaDesdeFecha` (getters UTC) y la hora de `formatHoraUTC`
 * (una columna @db.Time(6) llega como Date de 1970 con la hora en UTC).
 *
 * @param {Date|string} fecha día de la clase (@db.Date, o el Date a mediodía
 *   local que produce clase-fecha.util.js)
 * @param {Date|null} horaInicio valor de horarios_clases.hora_inicio
 * @returns {string|null} null si la fecha no es válida
 */
export const claveSlot = (fecha, horaInicio) => {
  const dia = claveDiaDesdeFecha(fecha);
  if (!dia) return null;
  return `${dia}T${formatHoraUTC(horaInicio)}`;
};

/**
 * Carga las recuperaciones que ocupan slots de UN alumno y devuelve el índice.
 *
 * Separar carga de decisión permite evaluar las ~5 fechas de un ciclo con una
 * única consulta dentro de la misma transacción.
 *
 * @param {import('@prisma/client').PrismaClient} cliente `tx` o `prisma`
 * @param {number} alumnoId
 * @returns {Promise<{porSlot: Map<string, object>, filas: object[]}>}
 */
export const cargarSlotsRecuperacion = async (cliente, alumnoId) => {
  const vacio = { porSlot: new Map(), filas: [] };

  const id = Number(alumnoId);
  if (!Number.isInteger(id) || id <= 0) return vacio;

  const filas = await cliente.recuperaciones.findMany({
    where: {
      alumno_id: id,
      fecha_programada: { not: null },
      estado: { in: [...ESTADOS_RECUPERACION_OCUPAN_SLOT] },
    },
    select: {
      id: true,
      estado: true,
      fecha_programada: true,
      horario_destino_id: true,
      horarios_clases: { select: { id: true, hora_inicio: true } },
    },
  });

  const porSlot = new Map();

  for (const fila of filas) {
    // Sin horario destino no hay hora que comparar: una recuperación a medio
    // agendar no bloquea ningún slot.
    if (!fila.horarios_clases?.hora_inicio) continue;

    const clave = claveSlot(fila.fecha_programada, fila.horarios_clases.hora_inicio);
    if (!clave) continue;

    // Primera gana: el @@unique([alumno_id, horario_destino_id,
    // fecha_programada]) no impide dos recuperaciones a la misma hora en
    // horarios distintos, y para decidir "está ocupado" cualquiera sirve.
    if (!porSlot.has(clave)) porSlot.set(clave, fila);
  }

  return { porSlot, filas };
};

/**
 * Devuelve la recuperación que ocupa ese slot, o null.
 * Puro y sincrónico: nunca consulta, nunca lanza.
 *
 * @param {string|null} clave de `claveSlot`
 * @param {{porSlot: Map<string, object>}|null} indice de `cargarSlotsRecuperacion`
 */
export const buscarChoqueRecuperacion = (clave, indice) => {
  if (!clave || !indice?.porSlot) return null;
  return indice.porSlot.get(clave) ?? null;
};

export const haySlotOcupado = (clave, indice) => !!buscarChoqueRecuperacion(clave, indice);
