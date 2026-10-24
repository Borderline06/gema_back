import { ApiError } from '../../../shared/utils/error.util.js';
import { ESTADOS_VALIDOS_PARA_CICLO } from '../../../shared/utils/ciclo.util.js';
import {
  buscarFeriado,
  cargarFeriadosActivos,
  claveDiaDesdeFecha,
} from '../../../shared/utils/feriado.util.js';

const NOMBRES_DIA = { 0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };
const nombreDia = (dia) => NOMBRES_DIA[Number(dia)] ?? `día ${dia}`;

/**
 * Verifica si el alumno tiene deudas que bloqueen el proceso.
 */
export const validarMuroDeDeuda = async (tx, alumnoId) => {
  const deudasPendientes = await tx.cuentas_por_cobrar.count({
    where: {
      alumno_id: Number.parseInt(alumnoId),
      estado: { in: ['PENDIENTE', 'PARCIAL', 'POR_VALIDAR'] },
      // 🛍️ Una orden de merch sin matrícula (ítems y ningún link) no bloquea inscribirse.
      NOT: { alumno_merch: { some: {} }, inscripciones_deudas_link: { none: {} } },
    },
  });

  if (deudasPendientes > 0) {
    throw new Error(
      '⛔ BLOQUEO: Tienes pagos pendientes o en revisión. Por favor, regulariza tu saldo o espera a que validemos tu último pago para inscribirte nuevamente.'
    );
  }
};

/**
 * Valida si un horario específico tiene cupos disponibles considerando inscripciones activas y temporales.
 */
export const validarAforoHorario = async (tx, idHorario, fechaLimiteZombie) => {
  const horario = await tx.horarios_clases.findUnique({ where: { id: idHorario } });
  if (!horario) throw new Error(`El horario ID ${idHorario} no existe.`);

  const ocupados = await tx.inscripciones.count({
    where: {
      horario_id: idHorario,
      OR: [
        { estado: 'ACTIVO' },
        { estado: 'POR_VALIDAR' },
        { estado: 'VENCIDO' },
        {
          AND: [
            { estado: 'PENDIENTE_PAGO' },
            { fecha_inscripcion: { gt: fechaLimiteZombie } },
          ],
        },
      ],
    },
  });

  if (ocupados >= (horario.capacidad_max || 20)) {
    throw new Error(`El horario del ${nombreDia(horario.dia_semana)} ya está AGOTADO.`);
  }

  return horario;
};

// =================================================================
// 🎯 BL-003: validaciones de la CLASE SUELTA.
//
// `validarAforoHorario` (arriba) se deja INTACTA a propósito: tiene 3
// llamadores y es el muro de aforo del flujo REGULAR. Las dos funciones de
// abajo son nuevas y se aplican ADEMÁS de aquella en el flujo INDIVIDUAL.
//
// Por qué dos chequeos de aforo y no uno: `validarAforoHorario` cuenta
// INSCRIPCIONES del horario sin discriminar fecha, lo que para una clase suelta
// es conservador (nunca sobrevende) pero pesimista. El chequeo por fecha es el
// que de verdad responde "¿cabe alguien el martes 14?".
// =================================================================

/**
 * 🎉 BL-003: rechaza la venta si la fecha de la clase cae en feriado activo.
 *
 * Semántica de fecha exacta CON AÑO (ver shared/utils/feriado.util.js).
 *
 * ⚠️ Esta SÍ lanza: corre antes de crear la cuenta por cobrar, así que abortar
 * la transacción es exactamente lo que se quiere (no se puede vender una clase
 * para un día en que no hay clase). La contraparte es `generarClaseUnica`, que
 * NO lanza porque corre dentro de la transacción del pago.
 *
 * @param {object} tx cliente Prisma transaccional
 * @param {Date} fechaClase
 * @param {object|null} feriadosPrecargados índice de `cargarFeriadosActivos`
 */
export const validarFechaNoFeriado = async (tx, fechaClase, feriadosPrecargados = null) => {
  const indice = feriadosPrecargados ?? (await cargarFeriadosActivos(tx));
  const claveDia = claveDiaDesdeFecha(fechaClase);

  const feriado = buscarFeriado(claveDia, indice);
  if (feriado) {
    throw new ApiError(
      `⛔ La fecha de la clase (${claveDia}) es feriado: ${feriado.descripcion}. Elige otra fecha.`,
      409
    );
  }

  return indice;
};

/**
 * 🎯 BL-003: aforo de una FECHA concreta, no del horario en general.
 *
 * Cuenta las clases ya agendadas de ese horario ese día exacto. Recibe el
 * `horario` YA CARGADO — `validarAforoHorario` lo devuelve y los llamadores
 * descartaban ese retorno, así que no hace falta una consulta extra.
 *
 * Usa el mismo fallback `capacidad_max || 20` que `validarAforoHorario` para no
 * introducir una segunda constante de capacidad en el sistema.
 */
export const validarAforoFechaClase = async (tx, horario, fechaClase) => {
  const ocupados = await tx.registros_asistencia.count({
    where: {
      fecha: fechaClase,
      estado: { in: ESTADOS_VALIDOS_PARA_CICLO },
      inscripciones: { horario_id: horario.id },
    },
  });

  if (ocupados >= (horario.capacidad_max || 20)) {
    throw new ApiError(
      `⛔ El horario del ${nombreDia(horario.dia_semana)} ya está AGOTADO para la fecha ${claveDiaDesdeFecha(fechaClase)}.`,
      409
    );
  }

  return ocupados;
};

/**
 * Verifica si ya existe una deuda de renovación generada recientemente.
 */
export const existeRenovacionReciente = async (tx, alumnoId, inicioBusqueda) => {
  const deuda = await tx.cuentas_por_cobrar.findFirst({
    where: {
      alumno_id: alumnoId,
      estado: 'PENDIENTE',
      detalle_adicional: { contains: 'Renovación Automática' },
      creado_en: { gte: inicioBusqueda },
    },
  });
  return !!deuda;
};