import { prisma } from '../../config/database.config.js';
import { logger } from '../../shared/utils/logger.util.js';
import { notificacionesService } from '../notificaciones/notificaciones.service.js';
import { twilioProvider } from '../../shared/services/twilio.whatsapp.service.js';
import { emailService } from '../../shared/services/brevo.email.service.js';
import { inscripcionService } from './inscripcion.service.js';
import { merchService } from '../merch/merch.service.js';
import { DIAS_CICLO, aFechaUTC, diaLimaAFechaUTC } from '../../shared/utils/ciclo.util.js';
// 🎯 BL-001
import { TIPO_INSCRIPCION, esIndividual, whereTipoInscripcion } from '../../shared/utils/tipo-inscripcion.util.js';
import { DIAS_VENTANA_INDIVIDUAL } from '../../shared/utils/clase-fecha.util.js';

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

              // PASO C: Borrar la CUENTA (el merch reservado devuelve su stock)
              await merchService.liberarMerchDeCuenta(tx, cuentaId);
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
      // 🚩 BL-001: el VERDUGO es el cron del CICLO DE 30 DÍAS, así que solo le
      // toca a las REGULAR. Antes barría todo lo ACTIVO y aplicaba la regla de
      // 30 días también a las clases sueltas, compitiendo con
      // gestionarVencimientosIndividual (01:00 vs 01:05): ganaba el que corría
      // primero.
      const inscripcionesActivas = await prisma.inscripciones.findMany({
        where: {
          estado: 'ACTIVO',
          ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
        }
      });

      let totalFinalizados = 0;

      for (const insc of inscripcionesActivas) {
        try {
          const fechaInicio = dayjs(insc.fecha_inscripcion).tz('America/Lima').startOf('day');
          const diasTranscurridos = hoyLima.diff(fechaInicio, 'day');

          if (diasTranscurridos >= DIAS_CICLO) {
            // 🚩 Cierre real del ciclo: día 30 exacto, no "hoy" (que puede traer tolerancia)
            // 🔧 BL-011: a mediodía, para que el truncado a @db.Date no dependa
            // de que las 05:00Z caigan en el día correcto. DIAS_CICLO vive en
            // shared/utils/ciclo.util.js, que es la única definición del largo.
            const fechaFinCicloReal = fechaInicio.add(DIAS_CICLO, 'day').hour(12).toDate();

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
          const asistencia = insc.registros_asistencia[0];

          // =================================================================
          // 🚩 BL-001: dos caminos, porque desde que el VERDUGO filtra por
          // REGULAR este cron es el ÚNICO que puede finalizar una INDIVIDUAL.
          //
          // Antes, una INDIVIDUAL ACTIVO sin registros de asistencia hacía
          // `continue` y acababa muriendo a los 30 días por el VERDUGO. Al
          // sacarla de su barrido, ese `continue` la dejaría ACTIVO PARA
          // SIEMPRE — y como validarAforoHorario cuenta los ACTIVO, cada una
          // se comería un cupo de forma indefinida. De ahí el fallback.
          // =================================================================
          let diasTranscurridos;
          let fechaCierreCiclo;

          if (asistencia) {
            const fechaClase = dayjs(asistencia.fecha.toISOString().slice(0, 10)).startOf('day');
            diasTranscurridos = hoyLima.diff(fechaClase, 'day');
            // El ciclo de una clase suelta cierra el día de la clase.
            // 🔧 BL-011: fecha_fin_ciclo es @db.Date; normalizamos con aFechaUTC
            // en vez de un new Date() que Postgres truncaría al día UTC
            // equivocado según la hora de Lima.
            fechaCierreCiclo = aFechaUTC(asistencia.fecha);
          } else {
            // Sin asistencia generada: se usa la fecha de inscripción y se
            // espera la ventana completa de la clase suelta antes de matarla.
            const fechaInscripcion = dayjs(insc.fecha_inscripcion).tz(TZ_LIMA).startOf('day');
            diasTranscurridos = hoyLima.diff(fechaInscripcion, 'day');
            if (diasTranscurridos < DIAS_VENTANA_INDIVIDUAL) continue;
            fechaCierreCiclo = diaLimaAFechaUTC();
          }

          if (diasTranscurridos >= 1) {
            await prisma.$transaction(async (tx) => {
              await tx.inscripciones.update({
                where: { id: insc.id },
                data: {
                  estado: 'FINALIZADO',
                  actualizado_en: new Date(),
                }
              });

              // 🚩 BL-001: cerramos el ciclo del link. Antes este cron
              // finalizaba la inscripción pero dejaba fecha_fin_ciclo en null
              // PARA SIEMPRE, y finCicloEfectivo() le derivaba inicio + 30d, así
              // que una clase suelta se reportaba como ciclo mensual abierto.
              // Mismo patrón que ya usa el VERDUGO y las finalizaciones
              // voluntarias.
              await tx.inscripciones_deudas_link.updateMany({
                where: {
                  inscripcion_id: insc.id,
                  fecha_fin_ciclo: null
                },
                data: {
                  fecha_fin_ciclo: fechaCierreCiclo
                }
              });
            });

            totalFinalizados++;
            logger.info(`[VENCIMIENTO INDIVIDUAL] ✅ Slot ${insc.id} liquidado (Días transcurridos: ${diasTranscurridos}) y ciclo cerrado en ${fechaCierreCiclo.toISOString()}.`);
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
      // 🚩 BL-001: la "fecha madre" del ciclo mensual solo puede salir de una
      // inscripción REGULAR. Antes podía tomar una clase suelta y calcular el
      // ciclo del alumno a 30 días de una clase de un día.
      const inscripcionMadre = await prisma.inscripciones.findFirst({
        where: {
          alumno_id: alumno_id,
          estado: 'ACTIVO',
          ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
        },
        orderBy: { fecha_inscripcion: 'asc' },
      });

      if (!inscripcionMadre) continue;

      // 4. Calculamos fin de mes (Fecha Madre + 30 días)
      // 🔥 CAMBIO AQUÍ: Sumamos 30 días y calculamos el inicio de ese día en hora de Lima
      // 🔧 BL-001: DIAS_CICLO en vez del 30 literal (ciclo.util.js es la única definición).
      const finCiclo = dayjs(inscripcionMadre.fecha_inscripcion)
        .tz(TZ_LIMA)
        .add(DIAS_CICLO, 'day')
        .startOf('day');

      // 5. Calculamos el "Día del Juicio"
      // 🔥 CAMBIO AQUÍ: Restamos los días de anticipación usando dayjs
      const diaDelJuicioParcial = finCiclo.subtract(diasAnticipacionLiquidador, 'day');

      // 6. ¿Llegó el momento de liquidar?
      // 🔥 CAMBIO AQUÍ: Comparamos directamente con el valor absoluto en milisegundos (.valueOf())
      if (hoyLimaInicioDia.valueOf() >= diaDelJuicioParcial.valueOf()) {
        // 🚩 BL-001: resolvemos los IDs a liquidar ANTES de la transacción, por
        // dos motivos: (a) solo deben caer las REGULAR — antes el updateMany
        // mataba TODAS las ACTIVO del alumno, incluidas clases sueltas ya
        // pagadas por una deuda mensual ajena; (b) con los IDs en mano podemos
        // cerrar también fecha_fin_ciclo de sus links, que este cron dejaba en
        // null para siempre (mismo bug que BL-011 arregló en otros sitios).
        const aLiquidar = await prisma.inscripciones.findMany({
          where: {
            alumno_id: alumno_id,
            estado: 'ACTIVO',
            ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
          },
          select: { id: true },
        });
        const idsALiquidar = aLiquidar.map((i) => i.id);

        if (idsALiquidar.length === 0) continue;

        // 7. La Ejecución Letal con Notificación vinculada
        await prisma.$transaction([
          // Matamos inscripciones activas
          prisma.inscripciones.updateMany({
            where: { id: { in: idsALiquidar } },
            // 🔥 CAMBIO AQUÍ: Convertimos de nuevo a Date nativo para Prisma
            data: { estado: 'FINALIZADO', actualizado_en: dayjs().toDate() },
          }),
          // 🚩 BL-001: cerramos el ciclo de deuda que quedaba abierto.
          prisma.inscripciones_deudas_link.updateMany({
            where: { inscripcion_id: { in: idsALiquidar }, fecha_fin_ciclo: null },
            data: { fecha_fin_ciclo: diaLimaAFechaUTC() },
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

      // 🚩 BL-001: el aviso de 22 días es de ciclo mensual. Una clase suelta no
      // tiene día 22, así que se descarta (antes recibía el WhatsApp igual).
      if (esIndividual(inscripcion)) continue;

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
    // 🚩 BL-001: esta plantilla avisa "tu MENSUALIDAD vence el día X". Antes
    // barría todo lo ACTIVO, así que un alumno que solo compró una clase suelta
    // recibía un WhatsApp de renovación mensual (con costo de Twilio).
    const inscripcionesActivas = await prisma.inscripciones.findMany({
      where: {
        estado: 'ACTIVO',
        ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR)
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
