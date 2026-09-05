import { prisma } from '../../config/database.config.js';
import { logger } from '../../shared/utils/logger.util.js';
import { notificacionesService } from '../notificaciones/notificaciones.service.js';
import { twilioProvider } from '../../shared/services/twilio.whatsapp.service.js';
import { emailService } from '../../shared/services/brevo.email.service.js';
import { inscripcionService } from './inscripcion.service.js';

// 🔥 IMPORTAMOS EL SID DE LA PLANTILLA DESDE TUS SECRETOS 🔥
import { TWILIO_TEMPLATE_PAGO_PARCIAL_SID, TWILIO_TEMPLATE_VENCIMIENTO_SID } from '../../config/secret.config.js';

/// 🔥 IMPORTAMOS DAYJS Y CONFIGURAMOS LIMA Y ESPAÑOL 🔥
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import 'dayjs/locale/es.js'; // 👈 Importamos español

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('es'); // 👈 Activamos español globalmente
const TZ_LIMA = 'America/Lima';

// Función para dividir arreglos en lotes (chunks)
const chunkArray = (array, size) => {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};
class InscripcionCronService {
  async limpiarReservasZombies() {
    const param = await prisma.parametros_sistema.findUnique({
      where: { clave: 'TIEMPO_LIMITE_RESERVA_MIN' },
    });
    const minutosLimite = param ? Number.parseInt(param.valor) : 20;
    const horaCorte = new Date(Date.now() - minutosLimite * 60 * 1000);

    // 1. Buscamos las inscripciones zombies
    const zombies = await prisma.inscripciones.findMany({
      where: {
        estado: 'PENDIENTE_PAGO',
        creado_en: { lt: horaCorte },
      },
      include: {
        inscripciones_deudas_link: {
          orderBy: {
            id: "desc",
          }
        },
        _count: {
          select: {
            registros_asistencia: true,
            congelamientos: true,
          }
        }
      }
    });

    if (zombies.length === 0) return;

    for (const zombie of zombies) {
      try {
        await prisma.$transaction(async (tx) => {

          // 🚩 REORDENADO: primero decidimos el destino de la inscripción (¿tiene historial real?)
          // Esto evita borrar el link de deuda de una inscripción que va a sobrevivir como ACTIVO.
          const tieneHistorial = zombie._count.registros_asistencia > 0 || zombie._count.congelamientos > 0;

          // 2. Si tiene un link al puente, hay que limpiar las dependencias de la cuenta
          if (zombie.inscripciones_deudas_link.length > 0) {
            const cuentaId = zombie.inscripciones_deudas_link[0].cuenta_id;
            const cuenta = await tx.cuentas_por_cobrar.findUnique({
              where: { id: cuentaId }
            })

            // 🚩 FIX: solo borramos el link/cuenta si la inscripción NO va a quedar ACTIVA.
            // Si tiene historial, el link representa su ciclo vigente real y debe conservarse
            // para que el dashboard siga contándolo correctamente como activo.
            if (cuenta?.estado === 'PENDIENTE' && !tieneHistorial) {
              // PASO A: Borrar los links en el PUENTE (Esto evita el error que tuviste)
              await tx.inscripciones_deudas_link.deleteMany({
                where: { cuenta_id: cuentaId }
              });

              // PASO B: Borrar descuentos si existen
              await tx.descuentos_aplicados.deleteMany({
                where: { cuenta_id: cuentaId }
              });

              // PASO C: Borrar la CUENTA
              await tx.cuentas_por_cobrar.delete({
                where: { id: cuentaId }
              });
            }
          }

          if (!tieneHistorial) {
            await tx.inscripciones.delete({
              where: { id: zombie.id }
            });
          }
        });
        logger.info(`[FRANCOTIRADOR] Zombie ${zombie.id} liquidado con éxito.`);
      } catch (error) {
        logger.error(`[ERROR FRANCOTIRADOR] ID ${zombie.id}: ${error.message}`);
      }
    }
  }

  async gestionarVencimientos() {
    const hoyLima = dayjs().tz('America/Lima').startOf('day');
    logger.info(`[VERDUGO] Iniciando revisión de ciclos. Hoy: ${hoyLima.format('YYYY-MM-DD')}`);

    try {
      const inscripcionesActivas = await prisma.inscripciones.findMany({
        where: { estado: 'ACTIVO' }
      });

      let totalFinalizados = 0;

      for (const insc of inscripcionesActivas) {
        try {
          const fechaInicio = dayjs(insc.fecha_inscripcion).tz('America/Lima').startOf('day');
          const diasTranscurridos = hoyLima.diff(fechaInicio, 'day');

          if (diasTranscurridos >= 30) {
            // 🚩 Cierre real del ciclo: día 30 exacto, no "hoy" (que puede traer tolerancia)
            const fechaFinCicloReal = fechaInicio.add(30, 'day').toDate();

            await prisma.$transaction(async (tx) => {
              await tx.inscripciones.update({
                where: { id: insc.id },
                data: {
                  estado: 'FINALIZADO',
                  id_grupo_transaccion: null,
                  actualizado_en: new Date(),
                }
              });

              // 🚩 NUEVO: cerramos el link de deuda que sigue abierto para esta inscripción
              await tx.inscripciones_deudas_link.updateMany({
                where: {
                  inscripcion_id: insc.id,
                  fecha_fin_ciclo: null
                },
                data: {
                  fecha_fin_ciclo: fechaFinCicloReal
                }
              });
            });

            totalFinalizados++;
            logger.info(`[VERDUGO] ✅ Slot ${insc.id} liquidado (Días: ${diasTranscurridos}) y ciclo de deuda cerrado en ${fechaFinCicloReal.toISOString()}.`);
          }
        } catch (innerError) {
          logger.error(`[VERDUGO ERROR] ID ${insc.id}: ${innerError.message}`);
        }
      }

      logger.info(`[VERDUGO] Proceso terminado. Total cerrados: ${totalFinalizados}`);
    } catch (error) {
      logger.error(`[VERDUGO CRÍTICO]: ${error.message}`);
    }
  }

  async gestionarVencimientosIndividual() {
    const hoyLima = dayjs().tz('America/Lima').startOf('day');
    logger.info(`Iniciando revisión de inscripciones individuales. Hoy: ${hoyLima.format('YYYY-MM-DD')}`);

    try {
      const inscripcionesActivas = await prisma.inscripciones.findMany({
        where: { estado: 'ACTIVO', tipo_inscripcion: 'INDIVIDUAL' },
        include: {
          registros_asistencia: {
            select: {
              fecha: true,
            },
            take: 1,
            orderBy: {
              fecha: 'desc'
            }
          }
        }
      });

      let totalFinalizados = 0;

      for (const insc of inscripcionesActivas) {
        try {
          if (!insc.registros_asistencia[0]) continue;
          const fechaInicio = dayjs(insc.registros_asistencia[0].fecha.toISOString().slice(0, 10)).startOf('day');

          const diasTranscurridos = hoyLima.diff(fechaInicio, 'day');

          if (diasTranscurridos >= 1) {
            await prisma.inscripciones.update({
              where: { id: insc.id },
              data: {
                estado: 'FINALIZADO',
                actualizado_en: new Date(),
              }
            });

            totalFinalizados++;
            logger.info(`[VENCIMIENTO INDIVIDUAL] ✅ Slot ${insc.id} liquidado (Días transcurridos: ${diasTranscurridos}).`);
          }
        } catch (innerError) {
          logger.error(`[VENCIMIENTO INDIVIDUAL ERROR] ID ${insc.id}: ${innerError.message}`);
        }
      }

      logger.info(`[VENCIMIENTO INDIVIDUAL] Proceso terminado. Total cerrados: ${totalFinalizados}`);
    } catch (error) {
      logger.error(`[VENCIMIENTO INDIVIDUAL CRÍTICO]: ${error.message}`);
    }
  }

  async gestionarAntiguedad() {
    const hoyLima = dayjs().tz('America/Lima').startOf('day');
    logger.info(`Iniciando cambios de antiguedad en Alumnos. Hoy: ${hoyLima.format('YYYY-MM-DD')}`);
    try {
      const alumnos = await prisma.alumnos.findMany({
        where: {
          inscripciones: {
            none: {
              estado: 'ACTIVO'
            }
          }
        },
        select: {
          usuario_id: true,
          historial: true,
          inscripciones: {
            take: 1,
            orderBy: {
              fecha_inscripcion: 'desc'
            },
            select: {
              fecha_inscripcion: true
            }
          }
        }
      })

      let totalCambiosAntiguedad = 0;

      for (const alumno of alumnos) {
        try {
          if (!alumno.inscripciones[0]) continue;
          const fechaInicio = dayjs(alumno.inscripciones[0].fecha_inscripcion).tz('America/Lima').startOf('day');
          const diasTranscurridos = hoyLima.diff(fechaInicio, 'day');
          if (diasTranscurridos >= 60 && alumno.historial !== 'Nuevo') {
            await prisma.alumnos.update({
              where: { usuario_id: alumno.usuario_id },
              data: {
                historial: 'Nuevo',
              }
            })
            totalCambiosAntiguedad++;
            logger.info(`[ANTIGUEDAD] Alumno ${alumno.usuario_id} marcado como NUEVO. (Días transcurridos desde su ultima inscripción: ${diasTranscurridos})`);
          }
        } catch (e) {
          logger.error(`[ERROR] ID ${alumno.usuario_id}: ${e.message}`);
        }
      }
      logger.info(`Total alumnos cambiados a nuevos: ${totalCambiosAntiguedad}`);
    } catch (e) {
      logger.error(`[ERROR CRÍTICO]: ${e.message}`);
    }
  }

  // =================================================================
  // 🗡️ EL LIQUIDADOR DE PAGOS PARCIALES (Motor Completo)
  // =================================================================
  async liquidarMorososParciales() {
    // 🔥 CAMBIO AQUÍ: Obtenemos el inicio del día (00:00:00) EXACTAMENTE en la hora de Lima
    const hoyLimaInicioDia = dayjs().tz(TZ_LIMA).startOf('day');

    // 1. Obtenemos los días de anticipación del Profeta
    const paramAnti = await prisma.parametros_sistema.findUnique({
      where: { clave: 'DIAS_ANTICIPACION_RENOVACION' },
    });
    const diasAnticipacionProfeta = paramAnti ? Number.parseInt(paramAnti.valor) : 5;

    // 🔥 REGLA DE ORO: El Liquidador ataca exactamente 1 día antes que el Profeta genere deuda nueva
    const diasAnticipacionLiquidador = diasAnticipacionProfeta + 1;

    // 2. Buscamos a TODOS los alumnos con deuda a medias ('PARCIAL')
    const morososParciales = await prisma.cuentas_por_cobrar.findMany({
      where: { estado: 'PARCIAL' },
      select: { alumno_id: true },
      distinct: ['alumno_id'],
    });

    if (morososParciales.length === 0) return;

    let totalFinalizados = 0;

    for (const { alumno_id } of morososParciales) {
      // 3. Buscamos su Fecha Madre para calcular el ciclo
      const inscripcionMadre = await prisma.inscripciones.findFirst({
        where: { alumno_id: alumno_id, estado: 'ACTIVO' },
        orderBy: { fecha_inscripcion: 'asc' },
      });

      if (!inscripcionMadre) continue;

      // 4. Calculamos fin de mes (Fecha Madre + 30 días)
      // 🔥 CAMBIO AQUÍ: Sumamos 30 días y calculamos el inicio de ese día en hora de Lima
      const finCiclo = dayjs(inscripcionMadre.fecha_inscripcion)
        .tz(TZ_LIMA)
        .add(30, 'day')
        .startOf('day');

      // 5. Calculamos el "Día del Juicio"
      // 🔥 CAMBIO AQUÍ: Restamos los días de anticipación usando dayjs
      const diaDelJuicioParcial = finCiclo.subtract(diasAnticipacionLiquidador, 'day');

      // 6. ¿Llegó el momento de liquidar?
      // 🔥 CAMBIO AQUÍ: Comparamos directamente con el valor absoluto en milisegundos (.valueOf())
      if (hoyLimaInicioDia.valueOf() >= diaDelJuicioParcial.valueOf()) {
        // 7. La Ejecución Letal con Notificación vinculada
        await prisma.$transaction([
          // Matamos inscripciones activas
          prisma.inscripciones.updateMany({
            where: { alumno_id: alumno_id, estado: 'ACTIVO' },
            // 🔥 CAMBIO AQUÍ: Convertimos de nuevo a Date nativo para Prisma
            data: { estado: 'FINALIZADO', actualizado_en: dayjs().toDate() },
          }),
          // 🔥 PENALIDAD: Pierde su estatus de alumno antiguo por moroso (La deuda PARCIAL se queda intacta)
          prisma.alumnos.update({
            where: { usuario_id: alumno_id },
            data: { historial: 'Nuevo' },
          }),
          // 🔔 Notificación para la alumna
          prisma.notificaciones.create({
            data: {
              alumno_id: alumno_id,
              titulo: '🗡️ Inscripción Liquidada',
              mensaje: `Tu acceso ha sido marcado como FINALIZADO por saldo pendiente (Pago Parcial). Has perdido los beneficios de alumno fundador.`,
              tipo: 'DANGER',
              categoria: 'SISTEMA',
            },
          }),
        ]);

        totalFinalizados++;
      }
    }

    // 8. Notificación de Resumen para el Admin
    if (totalFinalizados > 0) {
      await notificacionesService.crear({
        titulo: '🛡️ Resumen Liquidador Parcial',
        mensaje: `Se liquidaron ${totalFinalizados} alumnos con pagos incompletos.`,
        tipo: 'INFO',
        categoria: 'SISTEMA',
      });

      logger.info(
        `[LIQUIDADOR PARCIAL] Ejecución exitosa. Alumnos a FINALIZADO: ${totalFinalizados}.`
      );
    }
  }

  // =================================================================
  // 📧📲 RECORDATORIO: 22 Días (Pagos Parciales) - Email + WhatsApp
  // =================================================================
  async alertaMorososParcialesIndividual() {
    const hoyLimaInicioDia = dayjs().tz(TZ_LIMA).startOf('day');

    // 1. Buscamos a través de la tabla intermedia (EL PUENTE)
    const enlacesDeuda = await prisma.inscripciones_deudas_link.findMany({
      where: {
        cuentas_por_cobrar: { estado: 'PARCIAL' }
      },
      include: {
        inscripciones: true,
        cuentas_por_cobrar: {
          include: {
            alumnos: {
              include: { usuarios: true }
            }
          }
        }
      }
    });

    if (enlacesDeuda.length === 0) return;

    const enviosPendientes = [];

    // 2. Filtramos cuáles realmente cumplen 22 días HOY
    for (const enlace of enlacesDeuda) {
      const inscripcion = enlace.inscripciones;
      const cuenta = enlace.cuentas_por_cobrar;
      const usuario = cuenta.alumnos?.usuarios;

      if (!inscripcion || !usuario || !usuario.telefono_personal) continue;

      // Calculamos el día 22 de ESTA inscripción en específico
      const diaAviso22 = dayjs(inscripcion.fecha_inscripcion)
        .tz(TZ_LIMA)
        .add(22, 'day')
        .startOf('day');

      if (hoyLimaInicioDia.valueOf() === diaAviso22.valueOf()) {

        // Calculamos la fecha de corte (Ej: Si se inscribió el 5 de Mayo, vence el 5 de Junio)
        // Formato: "05 de junio"
        const fechaCorte = dayjs(inscripcion.fecha_inscripcion)
          .tz(TZ_LIMA)
          .add(29, 'day')
          .format('DD [de] MMMM');

        // Alternativa: Si prefieres usar la fecha de vencimiento real de la cuenta por cobrar:
        // const fechaCorte = dayjs(cuenta.fecha_vencimiento).tz(TZ_LIMA).format('DD [de] MMMM');

        enviosPendientes.push({
          telefono: usuario.telefono_personal,
          variables: {
            '1': usuario.nombres,    // {{1}} Nombre del alumno
            '2': fechaCorte          // {{2}} Fecha de corte calculada
          }
        });
      }
    }

    if (enviosPendientes.length === 0) {
      logger.info('[CRON] No hay morosos parciales cumpliendo 22 días hoy.');
      return;
    }

    // 3. Sistema de envíos por lotes (Batches) para respetar límites de Twilio
    // Twilio soporta 80/seg, nosotros enviaremos de 40 en 40 por seguridad.
    const lotes = chunkArray(enviosPendientes, 40);
    let totalEnviados = 0;

    for (const lote of lotes) {
      // Procesamos el lote actual en paralelo (los 40 mensajes a la vez)
      const promesasEnvio = lote.map((envio) =>
        twilioProvider.sendTemplateMessage(
          envio.telefono,
          TWILIO_TEMPLATE_PAGO_PARCIAL_SID,
          envio.variables
        )
      );

      const resultados = await Promise.all(promesasEnvio);

      // Contamos cuántos tuvieron éxito en este lote
      totalEnviados += resultados.filter(r => r.success).length;

      // Pausa de 1 segundo antes de enviar el siguiente lote de 40
      if (lotes.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info(`[RECORDATORIO PARCIAL INDIVIDUAL] Enviados ${totalEnviados} WhatsApps exitosamente usando la plantilla.`);
  }


  // =================================================================
  // 📲 ALERTA VENCIMIENTO INMINENTE: Día 29 de su ciclo (1 día antes)
  // =================================================================
  async alertaVencimientoInminenteWhatsApp() {
    const hoyLimaInicioDia = dayjs().tz(TZ_LIMA).startOf('day');

    // 1. Buscamos DIRECTAMENTE las inscripciones ACTIVAS
    // Ignoramos completamente si tienen deuda o no, solo nos importa su ciclo actual.
    const inscripcionesActivas = await prisma.inscripciones.findMany({
      where: {
        estado: 'ACTIVO'
      },
      include: {
        alumnos: {
          include: { usuarios: true }
        }
      }
    });

    if (inscripcionesActivas.length === 0) return;

    const enviosPendientes = [];

    // 2. Filtramos cuáles cumplen exactamente 29 días HOY
    for (const inscripcion of inscripcionesActivas) {
      const usuario = inscripcion.alumnos?.usuarios;

      // Validamos que exista el usuario y tenga teléfono
      if (!usuario || !usuario.telefono_personal) continue;

      // Calculamos el día 29 desde su fecha de inscripción
      const diaAviso29 = dayjs(inscripcion.fecha_inscripcion)
        .tz(TZ_LIMA)
        .add(29, 'day')
        .startOf('day');

      if (hoyLimaInicioDia.valueOf() === diaAviso29.valueOf()) {

        // Calculamos la fecha de corte (Día 30, su fecha exacta de renovación)
        // Formato: "15 de julio"
        const fechaCorte = dayjs(inscripcion.fecha_inscripcion)
          .tz(TZ_LIMA)
          .add(29, 'day')
          .format('DD [de] MMMM');

        enviosPendientes.push({
          telefono: usuario.telefono_personal,
          variables: {
            '1': usuario.nombres,    // {{1}} Nombre del alumno
            '2': fechaCorte          // {{2}} Fecha en que vence su mensualidad
          }
        });
      }
    }

    if (enviosPendientes.length === 0) {
      logger.info('[CRON] No hay inscripciones activas cumpliendo 29 días hoy.');
      return;
    }

    // 3. Sistema de envíos por lotes (Batches)
    const lotes = chunkArray(enviosPendientes, 40);
    let totalEnviados = 0;

    for (const lote of lotes) {
      // Procesamos el lote actual en paralelo
      const promesasEnvio = lote.map((envio) =>
        twilioProvider.sendTemplateMessage(
          envio.telefono,
          TWILIO_TEMPLATE_VENCIMIENTO_SID, // 👈 Usamos tu plantilla de aviso de vencimiento
          envio.variables
        )
      );

      const resultados = await Promise.all(promesasEnvio);

      // Contamos éxitos
      totalEnviados += resultados.filter(r => r.success).length;

      // Pausa de 1 segundo para no saturar Twilio
      if (lotes.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info(`[ALERTA RENOVACIÓN] Enviados ${totalEnviados} WhatsApps exitosamente.`);
  }

  async limpiarRenovacionesAbandonadas() {
    const ahora = new Date();
    logger.info(`[COBRADOR] Iniciando revisión de renovaciones vencidas sin pagar. Hoy: ${ahora.toISOString()}`);

    try {
      const cuentasAbandonadas = await prisma.cuentas_por_cobrar.findMany({
        where: {
          estado: 'PENDIENTE',
          detalle_adicional: { contains: 'RENOVACION' },
          fecha_vencimiento: { lt: ahora }
        }
      });

      let totalRevertidas = 0;

      for (const cuenta of cuentasAbandonadas) {
        try {
          await inscripcionService.eliminarPaqueteCompleto(cuenta.id);
          totalRevertidas++;
          logger.info(`[COBRADOR] ✅ Renovación abandonada revertida. Cuenta ${cuenta.id}, alumno ${cuenta.alumno_id}.`);
        } catch (innerError) {
          logger.error(`[COBRADOR ERROR] Cuenta ${cuenta.id}: ${innerError.message}`);
        }
      }

      logger.info(`[COBRADOR] Proceso terminado. Total revertidas: ${totalRevertidas}`);
    } catch (error) {
      logger.error(`[COBRADOR CRÍTICO]: ${error.message}`);
    }
  }

}

export const inscripcionCronService = new InscripcionCronService();
