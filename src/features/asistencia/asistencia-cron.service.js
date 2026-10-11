import { prisma } from '../../config/database.config.js';
import { logger } from '../../shared/utils/logger.util.js';
// 🎯 BL-005: misma aritmética de ciclo que usa la reprogramación masiva.
import {
  cargarCiclosVigentes,
  resolverCorrimientoDeCiclo,
  aplicarCorrimientoDeCiclo,
} from '../../shared/utils/reprogramacion-ciclo.util.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrAfter);

// Minutos antes de la clase en los que el cron deja de aplicar parches
const MINUTOS_CORTE = 30;

/**
 * Calcula el siguiente día de clase válido después de una fecha dada.
 * @param {Date} desdeFecha - Fecha de referencia (normalmente la última clase del ciclo).
 * @param {number[]} diasValidos - Array de días ISO (1=Lunes … 7=Domingo).
 * @returns {Date} La próxima fecha de clase disponible.
 * @throws {Error} Si diasValidos está vacío (alumno sin horarios activos).
 */
const calcularSiguienteDia = (desdeFecha, diasValidos) => {
  if (!diasValidos || diasValidos.length === 0) {
    throw new Error(
      'calcularSiguienteDia: diasValidos no puede estar vacío (alumno sin horarios activos)'
    );
  }

  const next = new Date(desdeFecha);
  next.setUTCHours(12, 0, 0, 0);

  for (let i = 1; i <= 31; i++) {
    next.setUTCDate(next.getUTCDate() + 1);
    const diaSemana = next.getUTCDay() === 0 ? 7 : next.getUTCDay();
    if (diasValidos.includes(diaSemana)) return next;
  }

  return next;
};

class AsistenciaCronService {
  /**
   * Marca registros sin marcar (más de 60 días) como SIN_REGISTRO.
   */
  async sinRegistroAsistencias() {
    const dia0 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    const registrosActualizados = await prisma.registros_asistencia.updateMany({
      where: {
        estado: 'PROGRAMADA',
        fecha: { lte: new Date() },
        inscripciones: {
          fecha_inscripcion_original: { lte: dia0 },
        },
      },
      data: { estado: 'SIN_REGISTRO' },
    });

    if (registrosActualizados.count > 0) {
      logger.info(`Se actualizaron ${registrosActualizados.count} registros como SIN REGISTRO.`);
    }
  }

  /**
   * Detecta alumnos que se inscribieron DESPUÉS de una reprogramación masiva
   * y les aplica el mismo beneficio de forma automática.
   * Se ejecuta cada 30 minutos para cubrir inscripciones tardías.
   * @returns {Promise<number>} Total de alumnos sincronizados en esta ejecución.
   */
  async sincronizarAlumnosNuevosConReprogramaciones() {
    const ahora = dayjs().tz('America/Lima');
    const hoy = ahora.startOf('day').toDate();

    let totalSincronizados = 0;

    // 1. Buscamos reprogramaciones masivas activas (hoy o futuras)
    const reprosActivas = await prisma.reprogramaciones_clases.findMany({
      where: {
        es_masiva: true,
        estado: 'ACTIVO',
        fecha_origen: { gte: hoy },
      },
      include: { horarios_clases: true },
    });

    for (const repro of reprosActivas) {
      // 🛡️ GUARD: Si la repro es hoy, dejamos de parchar 30 min antes de la clase
      // Comparamos puras fechas (YYYY-MM-DD) para evitar desfases de zona horaria (UTC vs Lima)
      const fechaOrigenStr = dayjs(repro.fecha_origen).utc().format('YYYY-MM-DD');
      const ahoraStr = ahora.format('YYYY-MM-DD');

      if (fechaOrigenStr === ahoraStr) {
        // Guard defensivo: si no hay hora definida, saltamos esta repro
        if (!repro.horarios_clases?.hora_inicio) {
          logger.warn(`[SINCRONIZADOR] Repro ID ${repro.id} sin hora_inicio definida, se omite.`);
          continue;
        }

        const horaClase = dayjs(
          `${ahora.format('YYYY-MM-DD')}T${repro.horarios_clases.hora_inicio.toISOString().substring(11, 16)}`
        );
        if (ahora.isSameOrAfter(horaClase.subtract(MINUTOS_CORTE, 'minute'))) continue;
      }

      // 2. Alumnos desincronizados: inscritos en el horario, ACTIVOS
      //    y sin ningún registro vinculado a esta repro
      //    Solo los que se inscribieron DESPUÉS de que se creó la reprogramación
      const alumnosDesincronizados = await prisma.inscripciones.findMany({
        where: {
          horario_id: repro.horario_id,
          estado: 'ACTIVO',
          registros_asistencia: {
            none: { reprogramacion_clase_id: repro.id },
          },
        },
        include: {
          alumnos: {
            include: {
              inscripciones: {
                where: { estado: 'ACTIVO' },
                include: { horarios_clases: { select: { dia_semana: true } } },
              },
            },
          },
        },
      });

      for (const ins of alumnosDesincronizados) {
        try {
          await prisma.$transaction(async (tx) => {
            // ♻️ IDEMPOTENCIA: Si ya existe una reposición para esta repro, no duplicamos
            const yaExisteReposicion = await tx.registros_asistencia.findFirst({
              where: {
                inscripcion_id: ins.id,
                reprogramacion_clase_id: repro.id,
              },
            });
            if (yaExisteReposicion) return;

            // =================================================================
            // 🎯 BL-005: estado del ciclo ANTES de marcar el origen como
            // REPROGRAMADO (después ya no cuenta como clase del ciclo y la
            // pregunta "¿era la primera?" no se puede responder).
            //
            // Este cron le aplica la reprogramación a los alumnos que se
            // inscribieron DESPUÉS de crearla, así que sin esto el mismo bug
            // reaparecía por acá para cada inscrito tardío.
            // =================================================================
            const ciclos = await cargarCiclosVigentes(tx, [ins.id]);
            const corrimiento = resolverCorrimientoDeCiclo(ciclos.get(ins.id), repro.fecha_origen);

            // 🔍 Verificar el registro de la clase origen
            const registroOrigen = await tx.registros_asistencia.findFirst({
              where: {
                inscripcion_id: ins.id,
                fecha: repro.fecha_origen,
              },
            });

            // Si el alumno ya tiene la clase marcada como PRESENTE o FALTA, no se toca
            if (
              registroOrigen &&
              ['PRESENTE', 'FALTA', 'JUSTIFICADO_LESION'].includes(registroOrigen.estado)
            ) {
              return;
            }

            // A) Días de entrenamiento del alumno
            const diasDelAlumno = [
              ...new Set(ins.alumnos.inscripciones.map((i) => i.horarios_clases.dia_semana)),
            ];

            // B) Última clase programada en el ciclo (solo estados "reales")
            const ultimaClase = await tx.registros_asistencia.findFirst({
              where: {
                inscripcion_id: ins.id,
                estado: { in: ['PENDIENTE', 'PROGRAMADA', 'PRESENTE', 'FALTA'] },
              },
              orderBy: { fecha: 'desc' },
            });

            if (!ultimaClase) return;

            // C) Calcular siguiente día hábil de reposición
            const fechaReposicion = calcularSiguienteDia(ultimaClase.fecha, diasDelAlumno);

            // D) Calcular desfase en días para extender la facturación
            const diffMs = fechaReposicion.getTime() - new Date(ultimaClase.fecha).getTime();
            const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

            // E1) Marcar clase origen como REPROGRAMADA (solo si no tiene estado definitivo)
            if (registroOrigen) {
              await tx.registros_asistencia.update({
                where: { id: registroOrigen.id },
                data: {
                  estado: 'REPROGRAMADO',
                  reprogramacion_clase_id: repro.id,
                  comentario: `Sincro automática: ${repro.motivo}`,
                },
              });
            }

            // E2) Crear el registro de reposición al final del ciclo
            await tx.registros_asistencia.create({
              data: {
                inscripcion_id: ins.id,
                fecha: fechaReposicion,
                fecha_original: repro.fecha_origen,
                estado: 'PENDIENTE',
                reprogramacion_clase_id: repro.id,
                comentario: `Reposición Sincronizada [NO_RECUPERABLE]. Motivo: ${repro.motivo}`,
              },
            });

            // 🎯 BL-005: si la clase movida era la PRIMERA del ciclo, el ciclo
            // arranca en la siguiente clase real y el corte se recalcula desde
            // ahí. EXCLUYENTE con el E3 de abajo: si corrieran los dos, el corte
            // se movería dos veces (ver el mismo razonamiento en
            // clase.service.js -> reprogramarMasivamente).
            if (corrimiento?.eraPrimeraClase && corrimiento.dias) {
              await aplicarCorrimientoDeCiclo(tx, {
                link: ciclos.get(ins.id).link,
                inscripcionId: ins.id,
                dias: corrimiento.dias,
              });

              totalSincronizados++;
              return;
            }

            // E3) Extender facturación usando Prisma (sin SQL raw)
            const inscripcionActual = await tx.inscripciones.findUnique({
              where: { id: ins.id },
              select: { fecha_inscripcion: true },
            });

            const nuevaFechaInscripcion = new Date(inscripcionActual.fecha_inscripcion);
            nuevaFechaInscripcion.setDate(nuevaFechaInscripcion.getDate() + diffDays);

            await tx.inscripciones.update({
              where: { id: ins.id },
              data: { fecha_inscripcion: nuevaFechaInscripcion },
            });

            totalSincronizados++;
          });
        } catch (error) {
          logger.error(
            `[SINCRONIZADOR] Error procesando inscripcion_id=${ins.id} para repro_id=${repro.id}:`,
            error
          );
          // Continuamos con el siguiente alumno aunque éste falle
        }
      }
    }

    return totalSincronizados;
  }
}

export const asistenciaCronService = new AsistenciaCronService();
