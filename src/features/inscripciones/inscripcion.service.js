import { prisma } from '../../config/database.config.js';
import crypto from 'crypto';
import * as Utils from './utils/inscripcion.util.js';
import * as Validators from './validators/inscripcion.validator.js';
import * as Logic from './logic/inscripcion.logic.js';
import { asistenciaService } from '../asistencia/asistencia.service.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { CuentasPorCobrarService } from '../cuenta_por_cobrar/cuentas_por_cobrar.service.js';
import { pagosService } from '../pagos/pagos.service.js';
import { merchService } from '../merch/merch.service.js';
import { quitarDetalleMerch } from '../merch/logic/merch.logic.js';
import { formatFechaEs } from '../../shared/utils/date.util.js';
import {
  CLASES_POR_CICLO,
  ESTADOS_VALIDOS_PARA_CICLO,
  aFechaUTC,
  cicloSolapaMes,
  compararFilaCicloDesc,
  compararInicioCicloAsc,
  diaLimaAFechaUTC,
  diasEntreUTC,
  etiquetaMes,
  finCicloEfectivo,
  parsearMesAnio,
  sumarDiasUTC,
  rangoMesUTC,
} from '../../shared/utils/ciclo.util.js';
// 🎯 BL-001 / BL-003
import {
  TIPO_INSCRIPCION,
  esIndividual,
  whereTipoInscripcion,
} from '../../shared/utils/tipo-inscripcion.util.js';
import { calcularPrimeraFechaClase } from '../../shared/utils/clase-fecha.util.js';
// 🔢 Cambio de horario por conteo de clases.
import { diasParaCubrirUltimaClase } from '../../shared/utils/cambio-horario.util.js';
import { aplicarCorrimientoDeCiclo } from '../../shared/utils/reprogramacion-ciclo.util.js';
import { claveDiaDesdeFecha, claveDiaLima } from '../../shared/utils/feriado.util.js';
// 💰 BL-002: reparto de dinero en céntimos exactos y sincronización del puente.
import { repartirMonto, redondear2 } from '../../shared/utils/dinero.util.js';
import { sincronizarPuenteDeuda } from '../../shared/utils/deuda-puente.util.js';
// 🆕 BL-004: el pre-llenado devuelve los horarios con la misma forma que
// GET /api/horarios/nivel, reusando el select y el formateador de horarios.
import { HORARIO_SELECT, formatearHorario } from '../horarios/horario.service.js';

// 🔥 IMPORTAMOS DAYJS Y CONFIGURAMOS LIMA PARA LOS LOGS 🔥
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_LIMA = 'America/Lima';

export const inscripcionService = {
  // =================================================================
  // 🚀 MOTOR MAESTRO DE INSCRIPCIÓN: GEMA ACADEMY (VERSIÓN FINAL)
  // =================================================================
  inscribirPaquete: async (data) => {
    // `incluye_camiseta` es el flag legacy (+S/ 50 fijos): se sigue aceptando.
    // `merch_ids` (opcional) es el reemplazo: productos del catálogo de Merch.
    // `sede_recojo_id` (obligatorio solo si hay merch_ids): sede donde recogerá el pedido.
    const { alumno_id, horario_ids, fecha_inicio_electiva, incluye_camiseta, forzar_concepto_vigente, merch_ids, sede_recojo_id } = data;

    try {
      // 1. Validación de estructura de entrada (Utils sigue sirviendo)
      Utils.validarInputInscripcion(horario_ids);

      return await prisma.$transaction(async (tx) => {
        // 🛡️ PASO 0: MUROS DE SEGURIDAD (Regla de Oro: Muro de Deuda)
        await Validators.validarMuroDeDeuda(tx, alumno_id);

        // 🕵️‍♂️ PASO 1: DETECTIVE DE RÉGIMEN (Solo para saber si es Legacy o 2026)
        // Borramos Logic.calcularCicloUpgrade porque ya no hay sincronización.
        const esAlumnoLegacy = await Logic.detectarRegimenAlumno(tx, alumno_id);

        // 👮‍♂️ PASO 2: VALIDACIÓN DE CAPACIDAD Y BUSQUEDA DE PLAN
        // Buscamos el plan según la cantidad de horarios que el alumno está comprando HOY.
        const conceptoAplicar = await tx.catalogo_conceptos.findFirst({
          where: {
            cantidad_clases_semanal: horario_ids.length,
            activo: true,
            // BL-004: la renovación histórica fuerza el concepto vigente actual.
            es_vigente: forzar_concepto_vigente ? true : !esAlumnoLegacy
          }
        });

        if (!conceptoAplicar) {
          throw new Error(`⛔ No existe un plan para ${horario_ids.length} clases en el catálogo.`);
        }

        // 🧟 PASO 3: ANTI-ZOMBIE (Aforo)
        const paramZ = await tx.parametros_sistema.findUnique({ where: { clave: 'TIEMPO_LIMITE_RESERVA_MIN' } });
        const fechaLimiteZombie = new Date(Date.now() - (paramZ ? parseInt(paramZ.valor) : 20) * 60 * 1000);

        // 🔄 PASO 4: PROCESAR HORARIOS (Independencia Radical)
        const inscripcionesCreadas = [];
        const grupoUuid = crypto.randomUUID(); // ID único para este paquete de compra

        // La fecha de inicio es la electiva o hoy. Cada slot tendrá esta misma fecha de inicio.
        const inicioReal = fecha_inicio_electiva
          ? dayjs.tz(fecha_inicio_electiva, TZ_LIMA).hour(12).toDate()
          : dayjs.tz(TZ_LIMA).hour(12).toDate();
        for (const idHorario of horario_ids) {
          // Validar aforo por cada clase
          await Validators.validarAforoHorario(tx, idHorario, fechaLimiteZombie);

          // Crear la inscripción con sus propios 30 días limpios
          const nuevaInscripcion = await tx.inscripciones.create({
            data: {
              alumno_id: parseInt(alumno_id),
              horario_id: idHorario,
              id_grupo_transaccion: grupoUuid,
              estado: 'PENDIENTE_PAGO',
              fecha_inscripcion: inicioReal,
              fecha_inscripcion_original: inicioReal,
              // 🚩 BL-001: explícito en vez de depender del @default del schema.
              // Depender del default es lo que hacía que un `create` que omite
              // el campo (como el de updateInscripcion) degradara una
              // INDIVIDUAL a REGULAR en silencio. Además, las filas con
              // tipo_inscripcion = NULL no matchean el filtro estricto de
              // horario.service.js -> getHorariosByLevel.
              tipo_inscripcion: TIPO_INSCRIPCION.REGULAR,
            },
            include: { horarios_clases: true }
          });
          inscripcionesCreadas.push(nuevaInscripcion);
        }

        // 💸 PASO 5: CÁLCULO DE COBRO (Simple y Directo)
        // 💰 BL-002: el precio sale SIEMPRE del catálogo y se normaliza a 2
        // decimales, que es la precisión de la columna Decimal(10,2).
        let totalCobrar = redondear2(conceptoAplicar.precio_base);
        let detalleCobro = [`Plan ${horario_ids.length} clases/semana`];

        if (incluye_camiseta) {
          totalCobrar = redondear2(totalCobrar + 50);
          detalleCobro.push("Camiseta Oficial Gema");
        }

        // Generar la Cuenta por Cobrar única para esta transacción
        const nuevaCuenta = await tx.cuentas_por_cobrar.create({
          data: {
            alumno_id: parseInt(alumno_id),
            concepto_id: conceptoAplicar.id,
            monto_final: totalCobrar,
            detalle_adicional: detalleCobro.join(' | '),
            fecha_vencimiento: dayjs().tz(TZ_LIMA).add(2, 'day').endOf('day').toDate(), // 48 horas de reserva
            estado: 'PENDIENTE'
          }
        });

        // 🌉 PASO 6: VINCULACIÓN A LA TABLA PUENTE (La Alcancía)
        // 💰 BL-002: antes era `totalCobrar / n` y cada parte se redondeaba por
        // separado al entrar a Decimal(10,2), así que el plan de 3 clases
        // (S/ 400) dejaba 133.33 x3 = 399.99 en el puente contra un monto_final
        // de 400.00. repartirMonto asigna el céntimo de residuo al primer slot.
        const partesPorSlot = repartirMonto(totalCobrar, inscripcionesCreadas.length);

        await tx.inscripciones_deudas_link.createMany({
          data: inscripcionesCreadas.map((ins, i) => ({
            inscripcion_id: ins.id,
            cuenta_id: nuevaCuenta.id,
            monto_asignado: partesPorSlot[i],
            fecha_inicio_ciclo: inicioReal,   // 🚩 NUEVO
            fecha_fin_ciclo: null             // 🚩 NUEVO
          }))
        });

        // 💸 PASO 7: APLICACIÓN DE BENEFICIOS (Automáticos)
        const beneficiosEnCola = await tx.beneficios_pendientes.findMany({
          where: { alumno_id: parseInt(alumno_id), usado: false },
          include: { tipos_beneficio: true }
        });

        let montoActualizado = totalCobrar;
        for (const pendiente of beneficiosEnCola) {
          const valorNominal = parseFloat(pendiente.tipos_beneficio.valor_por_defecto);
          let descuentoReal = pendiente.tipos_beneficio.es_porcentaje
            ? montoActualizado * (valorNominal / 100)
            : valorNominal;

          // 💰 BL-002: a céntimos antes de restar, para que el descuento que se
          // guarda en descuentos_aplicados sea exactamente el que se descontó.
          const descuentoFinal = redondear2(
            descuentoReal > montoActualizado ? montoActualizado : descuentoReal
          );
          montoActualizado = redondear2(montoActualizado - descuentoFinal);

          await tx.descuentos_aplicados.create({
            data: {
              cuenta_id: nuevaCuenta.id,
              tipo_beneficio_id: pendiente.tipo_beneficio_id,
              monto_nominal_aplicado: valorNominal,
              monto_dinero_descontado: descuentoFinal,
              motivo_detalle: pendiente.motivo || "Beneficio automático",
              aplicado_por: pendiente.asignado_por
            }
          });
          await tx.beneficios_pendientes.update({ where: { id: pendiente.id }, data: { usado: true } });
        }

        // Actualizamos el monto final de la cuenta tras los beneficios y le
        // sumamos el merch opcional (cobro combinado en UNA sola cuenta).
        //
        // 🌉 BL-002 (FIX CENTRAL): el puente se escribió en el PASO 6 con el
        // precio de LISTA, porque los beneficios se resuelven recién acá. Antes
        // nadie lo re-equilibraba: monto_final quedaba descontado y
        // SUM(monto_asignado) se quedaba en el precio sin descuento para
        // siempre. cerrarCuentaConMerch re-equilibra el puente solo si hubo
        // beneficios o merch: sin ellos el PASO 6 ya dejó el puente cuadrado.
        const { montoFinal, merch: merchCombo } = await merchService.cerrarCuentaConMerch(tx, {
          alumno_id,
          cuenta_id: nuevaCuenta.id,
          detalle_base: detalleCobro.join(' | '),
          monto_matricula: montoActualizado,
          hubo_beneficios: beneficiosEnCola.length > 0,
          merch_ids,
          sede_recojo_id,
        });
        montoActualizado = montoFinal;

        // 🔔 PASO 8: NOTIFICACIÓN
        await tx.notificaciones.create({
          data: {
            alumno_id: parseInt(alumno_id),
            titulo: '✅ Inscripción Generada',
            mensaje: `Se ha reservado tu cupo. Total: S/ ${montoActualizado.toFixed(2)}.`,
            tipo: 'SUCCESS',
            categoria: 'SISTEMA'
          }
        });

        return {
          mensaje: 'Inscripción procesada exitosamente.',
          total_a_pagar: montoActualizado,
          cuenta_id: nuevaCuenta.id,
          inscripciones: inscripcionesCreadas,
          // Llaves nuevas (aditivas): solo informan el merch del cobro combinado.
          total_merch: merchCombo.total,
          merch: merchCombo.lineas
        };
      });

    } catch (error) {
      console.error(`❌ [FALLO MOTOR RADICAL] Alumno: ${alumno_id} | ${error.message}`);
      throw error;
    }
  },

  // =================================================================
  // 🔮 LA LÓGICA DEL PROFETA: Renovaciones Masivas (Reconstruido)
  // =================================================================
  generarRenovacionesMasivas: async (diasAnticipacion) => {
    const { inicio, fin } = Utils.calcularRangoRenovacion(diasAnticipacion);

    return await prisma.$transaction(async (tx) => {
      // 🚩 BL-001: una INDIVIDUAL no se renueva. Antes entraba al barrido por
      // filtrar solo por estado, y se le generaba deuda de renovación mensual.
      const candidatos = await tx.inscripciones.findMany({
        where: {
          estado: 'ACTIVO',
          fecha_inscripcion: { gte: inicio, lte: fin },
          ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
        },
        distinct: ['alumno_id'],
      });

      let renovacionesCreadas = 0;

      for (const candidato of candidatos) {
        const alumnoId = candidato.alumno_id;

        // 🛡️ Evitar duplicados si ya se generó renovación hoy
        if (await Validators.existeRenovacionReciente(tx, alumnoId, inicio)) continue;

        // 1. Contamos cuántas clases reales tiene el alumno activas
        // 🚩 BL-001: excluir INDIVIDUALes acá es CRÍTICO para el cobro. Sin
        // esto, un alumno con 2 horarios regulares + 1 clase suelta activa
        // buscaba el plan de cantidad_clases_semanal: 3 y se le cobraba de más.
        // 💰 BL-002: antes era un `count`. Ahora traemos las filas porque hacen
        // falta los ids (y el ciclo abierto de cada una) para crear los links
        // del puente, que esta función no creaba en absoluto.
        const inscripcionesActivas = await tx.inscripciones.findMany({
          where: {
            alumno_id: alumnoId,
            estado: 'ACTIVO',
            ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
          },
          select: {
            id: true,
            inscripciones_deudas_link: {
              where: { fecha_fin_ciclo: null },
              select: { id: true, fecha_inicio_ciclo: true },
              orderBy: { id: 'desc' },
              take: 1,
            },
          },
          orderBy: { id: 'asc' },
        });

        const totalCursosActivos = inscripcionesActivas.length;

        if (totalCursosActivos === 0) continue;

        // 🕵️‍♂️ Detective de Régimen (Legacy vs 2026)
        const esAlumnoLegacy = await Logic.detectarRegimenAlumno(tx, alumnoId);

        // 2. 🌟 BÚSQUEDA DINÁMICA: Buscamos el plan que calce con sus clases actuales
        const planAdecuado = await tx.catalogo_conceptos.findFirst({
          where: {
            cantidad_clases_semanal: totalCursosActivos,
            activo: true,
            es_vigente: !esAlumnoLegacy
          }
        });

        if (!planAdecuado) {
          console.log(`⚠️ No hay plan para ${totalCursosActivos} clases para el alumno ${alumnoId}`);
          continue;
        }

        // 3. Crear la Deuda Base
        const nuevaCuenta = await tx.cuentas_por_cobrar.create({
          data: {
            alumno_id: alumnoId,
            concepto_id: planAdecuado.id,
            // 💰 BL-002: normalizado a 2 decimales, la precisión de la columna.
            monto_final: redondear2(planAdecuado.precio_base),
            detalle_adicional: `Renovación Automática (Plan: ${planAdecuado.nombre})`,
            fecha_vencimiento: Utils.calcularFechaVencimiento(diasAnticipacion),
            estado: 'PENDIENTE',
          },
        });

        // 4. ⚡ APLICACIÓN DE BENEFICIOS PENDIENTES (Lógica recuperada)
        const beneficiosEnCola = await tx.beneficios_pendientes.findMany({
          where: { alumno_id: alumnoId, usado: false },
          include: { tipos_beneficio: true }
        });

        let montoCorriente = parseFloat(nuevaCuenta.monto_final);

        for (const pendiente of beneficiosEnCola) {
          const valorNominal = parseFloat(pendiente.tipos_beneficio.valor_por_defecto);

          let descuentoReal = pendiente.tipos_beneficio.es_porcentaje
            ? montoCorriente * (valorNominal / 100)
            : valorNominal;

          // 💰 BL-002: a céntimos antes de restar (ver inscribirPaquete).
          const descuentoFinal = redondear2(
            descuentoReal > montoCorriente ? montoCorriente : descuentoReal
          );
          montoCorriente = redondear2(montoCorriente - descuentoFinal);

          // A. Registrar el descuento aplicado
          await tx.descuentos_aplicados.create({
            data: {
              cuenta_id: nuevaCuenta.id,
              tipo_beneficio_id: pendiente.tipo_beneficio_id,
              monto_nominal_aplicado: valorNominal,
              monto_dinero_descontado: descuentoFinal,
              motivo_detalle: pendiente.motivo || "Beneficio aplicado en renovación automática",
              aplicado_por: pendiente.asignado_por,
              fecha_aplicacion: new Date()
            }
          });

          // B. Quemar el beneficio
          await tx.beneficios_pendientes.update({
            where: { id: pendiente.id },
            data: { usado: true }
          });
        }

        // 5. Actualizar saldo final de la cuenta si hubo descuentos
        if (montoCorriente !== parseFloat(nuevaCuenta.monto_final)) {
          await tx.cuentas_por_cobrar.update({
            where: { id: nuevaCuenta.id },
            data: {
              monto_final: montoCorriente,
              estado: montoCorriente <= 0.01 ? 'PAGADA' : 'PENDIENTE'
            }
          });
        }

        // =================================================================
        // 🌉 BL-002 (FIX CENTRAL del foco #3): crear el puente.
        //
        // Esta función creaba la cuentas_por_cobrar y NUNCA un
        // inscripciones_deudas_link. La deuda nacía huérfana: sin
        // monto_asignado, invisible para el historial de ciclos (filaCiclo) y
        // para todo lo que busca los links por cuenta_id.
        //
        // ⚠️ VIGENCIA: esta renovación se genera con ANTICIPACIÓN (el ciclo
        // actual sigue corriendo unos días más), así que NO se corta el ciclo
        // viejo "el día antes" como hace generarRenovacionPaquete —eso le
        // robaría días al alumno—. Se le estampa su fin NATURAL
        // (finCicloEfectivo = inicio + 30d, una fecha futura) y el ciclo nuevo
        // arranca al día siguiente. Así queda exactamente UN link con
        // fecha_fin_ciclo = null por inscripción, que es el invariante del que
        // dependen el VERDUGO, es_vigente de filaCiclo y la renovación.
        // =================================================================
        const partesRenovacion = repartirMonto(montoCorriente, totalCursosActivos);

        for (let i = 0; i < inscripcionesActivas.length; i++) {
          const insc = inscripcionesActivas[i];
          const linkVigente = insc.inscripciones_deudas_link[0] ?? null;

          // Fin natural del ciclo en curso -> el nuevo arranca al día siguiente.
          const finCicloActual = linkVigente
            ? finCicloEfectivo(linkVigente.fecha_inicio_ciclo, null)
            : null;

          if (linkVigente && finCicloActual) {
            await tx.inscripciones_deudas_link.update({
              where: { id: linkVigente.id },
              data: { fecha_fin_ciclo: finCicloActual },
            });
          }

          await tx.inscripciones_deudas_link.create({
            data: {
              inscripcion_id: insc.id,
              cuenta_id: nuevaCuenta.id,
              monto_asignado: partesRenovacion[i],
              // Sin ciclo previo del que derivar el arranque, el inicio queda
              // null: filaCiclo ya contempla ese caso (sin_vigencia) y
              // pagos.service.js lo estampa al validar el pago (BL-006).
              fecha_inicio_ciclo: finCicloActual ? sumarDiasUTC(finCicloActual, 1) : null,
              fecha_fin_ciclo: null,
            },
          });
        }

        // 6. 🔔 NOTIFICACIÓN PARA EL DASHBOARD
        await tx.notificaciones.create({
          data: {
            alumno_id: alumnoId,
            titulo: '💎 Renovación Generada',
            mensaje: `Se ha generado tu cuota de renovación (S/ ${montoCorriente.toFixed(2)}). Realiza tu pago antes del vencimiento.`,
            tipo: 'SUCCESS',
            categoria: 'COBRO'
          }
        });

        renovacionesCreadas++;
      }
      return renovacionesCreadas;
    });
  },

  getAllInscripciones: async () => {
    return await prisma.inscripciones.findMany({
      include: {
        alumnos: {
          include: { usuarios: { select: { nombres: true, apellidos: true, email: true } } },
        },
        horarios_clases: { include: { canchas: true, niveles_entrenamiento: true } },
      },
      orderBy: { fecha_inscripcion: 'desc' },
    });
  },
  obtenerPorAlumno: async (alumnoId) => {
    return await prisma.inscripciones.findMany({
      where: {
        alumno_id: Number.parseInt(alumnoId)
      },
      include: {
        // 1. Entramos a la tabla de Horarios
        horarios_clases: {
          include: {
            // 2. Entramos a la tabla de Canchas
            canchas: {
              include: {
                // 3. Entramos a la tabla de Sedes para el nombre (Lima, Callao, etc.)
                sedes: {
                  select: {
                    nombre: true
                  }
                }
              }
            },
            // 4. Traemos el nivel (Básico, Intermedio, etc.)
            niveles_entrenamiento: {
              select: {
                nombre: true
              }
            }
          }
        },
        // 5. Traemos la deuda para las fechas de vigencia (Ciclo)
        inscripciones_deudas_link: {
          include: {
            cuentas_por_cobrar: {
              select: {
                id: true,
                fecha_vencimiento: true,
                estado: true,
                detalle_adicional: true
              }
            }
          },
          orderBy: { creado_en: 'desc' },
          take: 1
        }
      },
      orderBy: { creado_en: 'desc' }
    });
  },
  obtenerNoFinalizadasPorAlumno: async (alumnoId) => {
    return await prisma.inscripciones.findMany({
      where: {
        alumno_id: Number.parseInt(alumnoId),
        estado: { notIn: ['FINALIZADO'] }
      },
      include: {
        horarios_clases: {
          include: {
            canchas: {
              include: {
                sedes: {
                  select: {
                    nombre: true,
                  }
                }
              }
            },
            niveles_entrenamiento: true,
            coordinadores: { include: { usuarios: true } }
          }
        },
        // 🎯 BL-001: la fecha exacta de una clase única vive en el link de deuda
        // (inicio = fin = día de la clase); el front de cambio de horario la necesita.
        inscripciones_deudas_link: {
          select: { fecha_inicio_ciclo: true, fecha_fin_ciclo: true },
          orderBy: { creado_en: 'desc' },
          take: 1
        }
      }
    });
  },
  getInscripcionById: async (id) => {
    return await prisma.inscripciones.findUnique({
      where: { id: Number.parseInt(id) },
      include: {
        alumnos: {
          include: { usuarios: { select: { nombres: true, apellidos: true, email: true } } },
        },
        horarios_clases: {
          include: {
            canchas: true,
            niveles_entrenamiento: true,
            coordinadores: { include: { usuarios: true } }
          }
        },
      }
    });
  },

  // =================================================================
  // 🗑️ ELIMINAR / CANCELAR INSCRIPCIÓN
  // =================================================================
  eliminarInscripcion: async (id) => {
    // Primero verificamos si existe
    const existe = await prisma.inscripciones.findUnique({
      where: { id: Number.parseInt(id) }
    });

    if (!existe) throw new Error('La inscripción no existe.');

    // En lugar de borrar físicamente, podrías cambiar el estado a 'CANCELADO'
    // Pero si el requerimiento es borrar de la BD:
    return await prisma.inscripciones.delete({
      where: { id: Number.parseInt(id) }
    });
  },
  // =================================================================
  // 👋 FINALIZACIÓN VOLUNTARIA (El usuario decide retirarse)
  // =================================================================
  finalizarInscripcionVoluntaria: async (id) => {
    return await prisma.$transaction(async (tx) => {
      // 1. Verificamos que la inscripción exista y sea del alumno
      const inscripcion = await tx.inscripciones.findUnique({
        where: { id: Number.parseInt(id) }
      });

      if (!inscripcion) {
        throw new Error('La inscripción no existe.');
      }

      // 🛡️ REGLA DE NEGOCIO: Solo se puede finalizar lo que está ACTIVO
      if (inscripcion.estado !== 'ACTIVO') {
        throw new Error(`No se puede finalizar una inscripción con estado ${inscripcion.estado}.`);
      }

      const inscripcionActualizada = await tx.inscripciones.update({
        where: { id: Number.parseInt(id) },
        data: {
          estado: 'FINALIZADO',
          actualizado_en: new Date()
        }
      });

      // 🚩 NUEVO: cerramos el ciclo de deuda vigente (mismo criterio que el Verdugo).
      // Sin esto, el link se queda con fecha_fin_ciclo: null para siempre y el
      // alumno sigue contando como "activo" en dashboards/reportes que miren fechas.
      //
      // 🔧 BL-011: antes acá iba `new Date()`. fecha_fin_ciclo es @db.Date y
      // Postgres trunca al día UTC, así que una finalización hecha entre las
      // 19:00 y 23:59 de Lima cerraba el ciclo UN DÍA TARDE.
      await tx.inscripciones_deudas_link.updateMany({
        where: {
          inscripcion_id: Number.parseInt(id),
          fecha_fin_ciclo: null
        },
        data: {
          fecha_fin_ciclo: diaLimaAFechaUTC()
        }
      });

      console.log(`✅ [CANCELACIÓN] El alumno ${inscripcion.alumno_id} finalizó voluntariamente el horario ${inscripcion.horario_id}.`);

      return {
        success: true,
        mensaje: 'Inscripción finalizada correctamente.',
        nuevo_estado: 'FINALIZADO'
      };
    });
  },

  separarFinalizarVoluntaria: async (id) => {
    return await prisma.$transaction(async (tx) => {
      const inscripcionId = Number(id);

      const inscripcion = await tx.inscripciones.findUnique({
        where: { id: inscripcionId },
        include: {
          inscripciones_deudas_link: {
            select: {
              cuentas_por_cobrar: true
            },
            orderBy: {
              creado_en: 'desc'
            },
            take: 1
          }
        }
      });

      if (!inscripcion) throw new Error('Inscripción no encontrada');

      const actualizada = await tx.inscripciones.update({
        where: { id: inscripcionId },
        data: {
          estado: 'FINALIZADO',
          id_grupo_transaccion: null,
          actualizado_en: new Date()
        }
      });

      if (inscripcion.estado === 'POR_VALIDAR') {
        const inscPaq = await tx.inscripciones.findMany({
          where: { id_grupo_transaccion: inscripcion.id_grupo_transaccion }
        })
        const cuenta = inscripcion.inscripciones_deudas_link?.[0]?.cuentas_por_cobrar;
        if (!cuenta) throw new Error('Cuenta no encontrada');

        if (inscPaq.length > 0) {
          const esLegacy = await Logic.detectarRegimenAlumno(tx, inscripcion.alumno_id)
          const cpto = await tx.catalogo_conceptos.findFirst({
            where: {
              activo: true,
              es_vigente: !esLegacy,
              cantidad_clases_semanal: inscPaq.length,
            }
          })
          if (!cpto) throw new Error('Concepto de pago no encontrado');

          // 💰 BL-002: normalizado a 2 decimales, como en inscribirPaquete.
          let montoIndividual = redondear2(cpto.precio_base);
          // El flag legacy se busca fuera del segmento de merch: un producto del
          // catálogo llamado "Camiseta ..." no debe sumar los S/ 50 del recargo viejo.
          if (quitarDetalleMerch(cuenta.detalle_adicional).toLowerCase().includes('camiseta')) {
            montoIndividual = redondear2(montoIndividual + 50);
          }
          // 🛍️ Esta función recalcula el monto desde el plan: el merch de la cuenta
          // (matrícula + merch) debe conservarse o el alumno terminaría pagando de menos.
          montoIndividual = redondear2(
            montoIndividual + (await merchService.sumarMerchDeCuenta(tx, cuenta.id))
          );
          const { monto_final } = await CuentasPorCobrarService.actualizar(tx, cuenta.id, {
            alumno_id: cuenta.alumno_id,
            concepto_id: cpto.id,
            detalle_adicional: `${cuenta.detalle_adicional} | Plan Actualizado por Finalización Voluntaria: ${cpto.cantidad_clases_semanal} clase(s)`,
            monto_final: montoIndividual,
            fecha_vencimiento: cuenta.fecha_vencimiento,
            estado: cuenta.estado,
          })

          await tx.inscripciones_deudas_link.deleteMany({
            where: {
              inscripcion_id: inscripcion.id,
              cuenta_id: cuenta.id,
            }
          })

          // 🌉 BL-002 (foco #5): la cuenta acaba de bajar al plan de N-1 clases
          // y este slot salió del puente, pero los links que quedan conservaban
          // el monto_asignado del plan ANTERIOR. Hay que repartir el monto nuevo
          // entre los slots supervivientes.
          await sincronizarPuenteDeuda(tx, cuenta.id, monto_final)

          await tx.pagos.updateMany({
            where: { cuenta_id: cuenta.id },
            data: {
              monto_pagado: monto_final,
            }
          })
        } else {
          await tx.inscripciones_deudas_link.deleteMany({
            where: {
              inscripcion_id: inscripcion.id,
              cuenta_id: cuenta.id,
            }
          })
          await CuentasPorCobrarService.eliminar(cuenta.id, true, tx);
        }
      } else {
        // 🚩 NUEVO: si la inscripción estaba ACTIVA (no POR_VALIDAR), su link de deuda
        // vigente no se toca en ninguna otra rama de esta función. Lo cerramos aquí
        // con el mismo criterio del Verdugo, para que no quede "vigente" para siempre.
        // 🔧 BL-011: día calendario de Lima, no `new Date()` (ver finalizarVoluntaria).
        await tx.inscripciones_deudas_link.updateMany({
          where: {
            inscripcion_id: inscripcionId,
            fecha_fin_ciclo: null
          },
          data: {
            fecha_fin_ciclo: diaLimaAFechaUTC()
          }
        });
      }

      return {
        success: true,
        mensaje: 'Horario removido del paquete y finalizado correctamente.',
        nuevoEstado: actualizada.estado
      };
    });
  },
  cancelarReservaPendiente: async (id) => {
    return await prisma.$transaction(async (tx) => {
      // 1. Identificar la inscripción "semilla"
      const inscripcionSemilla = await tx.inscripciones.findUnique({
        where: { id: Number.parseInt(id) },
      });

      if (!inscripcionSemilla || inscripcionSemilla.estado !== 'PENDIENTE_PAGO') {
        throw new Error('Solo se pueden cancelar reservas pendientes de pago.');
      }

      // 2. Localizar la deuda vinculada (usando el tiempo de creación como nexo)
      const deudaAsociada = await tx.cuentas_por_cobrar.findMany({
        where: {
          alumno_id: inscripcionSemilla.alumno_id,
          estado: 'PENDIENTE',
          alumnos: {
            inscripciones: {
              some: {
                id: inscripcionSemilla.id,
              }
            }
          }
        },
        include: {
          alumnos: {
            select: {
              inscripciones: {
                select: { id: true }
              }
            }
          }
        }
      });
      const inscAsociadas = [...new Set(deudaAsociada.flatMap(d => d.alumnos?.inscripciones?.map(i => i.id) ?? []))]

      if (deudaAsociada.length > 0) {
        // 3. EN CASCADA: Borramos todas las inscripciones que se crearon en ese mismo instante
        // Esto elimina el "paquete" completo (los 2 o 3 horarios que eligió)
        await tx.inscripciones.deleteMany({
          where: {
            id: { in: inscAsociadas },
            alumno_id: inscripcionSemilla.alumno_id,
            estado: 'PENDIENTE_PAGO',
          }
        });

        const deudasId = deudaAsociada.map(d => d.id)
        // 4. Devolvemos beneficios si existían
        const descuentos = await tx.descuentos_aplicados.findMany({ where: { cuenta_id: { in: deudasId } } });
        for (const desc of descuentos) {
          await tx.beneficios_pendientes.updateMany({
            where: { alumno_id: inscripcionSemilla.alumno_id, tipo_beneficio_id: desc.tipo_beneficio_id, usado: true },
            data: { usado: false },
          });
        }

        // 5. Borramos la deuda y sus relaciones (el merch reservado devuelve su stock)
        for (const id of deudasId) {
          await merchService.liberarMerchDeCuenta(tx, id);
        }
        await tx.descuentos_aplicados.deleteMany({ where: { cuenta_id: { in: deudasId } } });
        await tx.cuentas_por_cobrar.deleteMany({ where: { id: { in: deudasId } } });
      }

      return { success: true, mensaje: 'Paquete de reserva cancelado íntegramente.' };
    });
  },

  // inscripcion.service.js
  eliminarPaqueteCompleto: async (cuentaId, txExterna = null) => {
    const ejecutar = async (tx) => {
      // 1. Buscamos la cuenta para leer el detalle ANTES de borrarla
      const cuenta = await tx.cuentas_por_cobrar.findUnique({
        where: { id: parseInt(cuentaId) }
      });

      const links = await tx.inscripciones_deudas_link.findMany({
        where: { cuenta_id: parseInt(cuentaId) }
      });

      const idsInscripciones = links.map(l => l.inscripcion_id);

      // 2. 🔄 REVERSIÓN BASADA EN EL DETALLE DE LA CUENTA
      if (cuenta?.detalle_adicional?.includes('FECHA_ANT:')) {
        const parteFecha = cuenta.detalle_adicional.split('FECHA_ANT:')[1].split('|')[0];

        for (const idIns of idsInscripciones) {
          await tx.inscripciones.update({
            where: { id: idIns },
            data: {
              fecha_inscripcion: new Date(parteFecha),
              fecha_inscripcion_original: new Date(parteFecha),
              actualizado_en: new Date()
            }
          });

          const ultimoLinkCerrado = await tx.inscripciones_deudas_link.findFirst({
            where: {
              inscripcion_id: idIns,
              fecha_fin_ciclo: { not: null }
            },
            orderBy: { fecha_fin_ciclo: 'desc' }
          });

          if (ultimoLinkCerrado) {
            await tx.inscripciones_deudas_link.update({
              where: { id: ultimoLinkCerrado.id },
              data: { fecha_fin_ciclo: null }
            });
          }
        }
      }

      // 3. LIMPIEZA TOTAL
      await tx.inscripciones_deudas_link.deleteMany({ where: { cuenta_id: parseInt(cuentaId) } });
      await tx.descuentos_aplicados.deleteMany({ where: { cuenta_id: parseInt(cuentaId) } });
      await tx.pagos.deleteMany({ where: { cuenta_id: parseInt(cuentaId) } });
      await merchService.liberarMerchDeCuenta(tx, parseInt(cuentaId));
      await tx.cuentas_por_cobrar.delete({ where: { id: parseInt(cuentaId) } });

      if (cuenta.detalle_adicional.includes('RENOVACION')) {
        await tx.inscripciones.updateMany({
          where: {
            id: { in: idsInscripciones },
            estado: { in: ['PENDIENTE_PAGO', 'POR_VALIDAR'] }
          },
          data: { estado: 'ACTIVO' }
        });

        return { success: true };
      }

      const result = await tx.inscripciones.deleteMany({
        where: {
          id: { in: idsInscripciones },
          estado: { in: ['PENDIENTE_PAGO', 'POR_VALIDAR'] }
        }
      });

      return { success: true, borrados: result.count };
    };

    // 🚩 Si viene una tx externa (ej: desde validarPago), la reusamos.
    // Si no, abrimos una propia (comportamiento actual, sin romper nada).
    if (txExterna) {
      return await ejecutar(txExterna);
    }
    return await prisma.$transaction(ejecutar);
  },

  updateInscripcion: async (data) => {
    // fechaClase ('YYYY-MM-DD'): solo para INDIVIDUAL, fecha exacta elegida por el admin.
    const { alumnoId, inscripcionId, horarioId, adminId, fechaClase } = data;

    if (!alumnoId) throw new ApiError('El campo alumnoId es requerido', 400);
    if (!inscripcionId) throw new ApiError('El campo inscripcionId es requerido', 400);
    if (!horarioId) throw new ApiError('El campo horarioId es requerido', 400);
    // if (!adminId) throw new ApiError('El campo adminId es requerido', 400); //No es necesario

    return await prisma.$transaction(async (tx) => {
      const insc = await tx.inscripciones.findFirst({
        where: { alumno_id: alumnoId, id: inscripcionId },
        include: {
          inscripciones_deudas_link: {
            orderBy: {
              creado_en: 'desc',
            }
          },
        }
      })
      if (!insc) throw new ApiError('No existe inscripción con esa ID', 404);

      const inscTotales = await inscripcionService.obtenerNoFinalizadasPorAlumno(insc.alumno_id)
      const yaExiste = inscTotales.some(i => i.horario_id === horarioId)
      if (yaExiste) throw new ApiError('El horario destino ya pertenece a una inscripción del alumno.', 400);

      // 🚩 BL-001: el link anterior se lee ANTES de tocar nada, y se comprueba
      // que exista. Antes se accedía a [0] más abajo sin guardia: una
      // inscripción sin link (p. ej. tras limpiarReservasZombies) reventaba con
      // TypeError y el controlador devolvía un 500 genérico.
      const linkAnterior = insc.inscripciones_deudas_link[0];
      if (!linkAnterior) {
        throw new ApiError(
          'La inscripción no tiene un ciclo de deuda vinculado; no se puede cambiar de horario.',
          409
        );
      }

      // 👮‍♂️ BL-003: aforo del horario DESTINO. Antes no se validaba, así que un
      // admin podía mover un alumno a un horario ya agotado.
      const paramZ = await tx.parametros_sistema.findUnique({ where: { clave: 'TIEMPO_LIMITE_RESERVA_MIN' } });
      const fechaLimiteZombie = new Date(Date.now() - (paramZ ? parseInt(paramZ.valor) : 20) * 60 * 1000);

      // validarAforoHorario lanza un Error plano (sin statusCode) y el
      // controlador de este endpoint mapea eso a 500. Como la validación de
      // aforo es NUEVA acá, un horario agotado se vería como un fallo de
      // servidor, así que la reempaquetamos como 409 de negocio. El validador
      // se deja intacto porque lo comparten otros 3 llamadores.
      let horarioDestino;
      try {
        horarioDestino = await Validators.validarAforoHorario(tx, horarioId, fechaLimiteZombie);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(e.message, 409);
      }

      // 🎯 BL-001: si la inscripción es INDIVIDUAL, resolvemos la fecha de su
      // única clase en el horario destino y la validamos como en la venta.
      const esInscripcionIndividual = esIndividual(insc);
      let fechaClaseDestino = null;
      // Fecha de arranque de la nueva inscripción: la original, salvo que el
      // admin elija una fecha exacta (ver más abajo).
      let inicioNuevaInscripcion = insc.fecha_inscripcion_original;

      if (fechaClase && !esInscripcionIndividual) {
        throw new ApiError('fechaClase solo aplica a inscripciones de clase única.', 400);
      }

      if (esInscripcionIndividual) {
        if (fechaClase) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaClase)) {
            throw new ApiError('fechaClase debe tener formato YYYY-MM-DD.', 400);
          }
          if (fechaClase < dayjs().tz(TZ_LIMA).format('YYYY-MM-DD')) {
            throw new ApiError('⛔ La fecha de la clase no puede estar en el pasado.', 400);
          }
          // Mismo anclaje (12:00 Lima) que inscribirIndividual, para que la
          // fecha validada sea la que luego inserta generarClaseUnica.
          inicioNuevaInscripcion = dayjs.tz(fechaClase, TZ_LIMA).hour(12).toDate();
        }

        fechaClaseDestino = calcularPrimeraFechaClase(
          inicioNuevaInscripcion,
          horarioDestino.dia_semana
        );
        if (!fechaClaseDestino) {
          throw new ApiError(
            '⛔ No se pudo determinar la fecha de la clase en el horario destino.',
            400
          );
        }
        // Con fecha exacta no se admite que la ventana "salte" a otro día:
        // la fecha pedida debe caer en el día de semana del horario destino.
        if (fechaClase && dayjs(fechaClaseDestino).tz(TZ_LIMA).format('YYYY-MM-DD') !== fechaClase) {
          throw new ApiError(
            '⛔ La fecha elegida no corresponde al día de semana del horario destino.',
            400
          );
        }
        await Validators.validarFechaNoFeriado(tx, fechaClaseDestino);
        await Validators.validarAforoFechaClase(tx, horarioDestino, fechaClaseDestino);
      }

      // 🔢 REGULAR: el cambio es por CONTEO de clases (ver cambio-horario.util.js).
      // Ya no se borra todo el ciclo para regenerarlo: se conserva lo que el
      // alumno ya consumió, se borra solo lo futuro del horario viejo, y abajo se
      // generan CLASES_POR_CICLO − consumidas desde la fecha efectiva.
      // INDIVIDUAL no cambia: es una sola clase.
      let planCambio = null;
      let inicioCicloUTC = null;
      let claveEfectiva = null;

      if (esInscripcionIndividual) {
        const count = await asistenciaService.eliminarClases(tx, insc.id, insc.fecha_inscripcion_original);
        console.log(`Se eliminaron ${count} registros de asistencia.`)
      } else {
        inicioCicloUTC = aFechaUTC(
          linkAnterior.fecha_inicio_ciclo ?? insc.fecha_inscripcion_original ?? insc.fecha_inscripcion
        );
        // Rige desde hoy (Lima); si el ciclo aún no arrancó (BL-006 permite una
        // fecha de inicio futura), desde su inicio.
        const claveInicioCiclo = claveDiaDesdeFecha(inicioCicloUTC);
        const claveHoy = claveDiaLima();
        claveEfectiva = claveHoy > claveInicioCiclo ? claveHoy : claveInicioCiclo;

        planCambio = await asistenciaService.depurarClasesParaCambioHorario(tx, {
          inscripcion_id: insc.id,
          inicioCiclo: inicioCicloUTC,
          claveEfectiva,
        });
        console.log(
          `Cambio de horario ${insc.id}: ${planCambio.eliminadas} clases futuras eliminadas, ${planCambio.consumidas} ya consumidas.`
        );
      }

      await tx.inscripciones.update({
        where: { alumno_id: insc.alumno_id, id: insc.id },
        data: {
          estado: 'FINALIZADO',
          id_grupo_transaccion: null,
          actualizado_en: new Date()
        },
      })

      const createdInsc = await tx.inscripciones.create({
        data: {
          alumno_id: insc.alumno_id,
          horario_id: horarioId,
          fecha_inscripcion: inicioNuevaInscripcion, //Para asegurar que se reinicie la fecha de inscripción con la original (PARA CASOS AISLADOS DE REPROGRAMACIÓN MASIVA)
          fecha_inscripcion_original: inicioNuevaInscripcion,
          estado: insc.estado,
          actualizado_en: new Date(),
          creado_en: insc.creado_en,
          id_grupo_transaccion: insc.id_grupo_transaccion,
          // 🚩 BL-001 (FIX CENTRAL): antes este create NO copiaba el tipo, así
          // que la nueva inscripción caía al @default('REGULAR') del schema y
          // una clase suelta se convertía en membresía mensual — y acto seguido
          // recibía 30 días de clases.
          tipo_inscripcion: insc.tipo_inscripcion,
        },
        include: {
          horarios_clases: true
        }
      })

      const nuevoLink = await tx.inscripciones_deudas_link.create({
        data: {
          inscripcion_id: createdInsc.id,
          cuenta_id: linkAnterior.cuenta_id,
          monto_asignado: Number(linkAnterior.monto_asignado),
          // 🚩 REGULAR: conserva la vigencia real del ciclo (si estaba abierto
          // sigue abierto, si estaba cerrado sigue cerrado).
          // 🚩 BL-001 INDIVIDUAL: el "ciclo" es el día de la clase, y el
          // horario destino puede moverla, así que se recalcula en vez de
          // copiarse.
          fecha_inicio_ciclo: esInscripcionIndividual ? fechaClaseDestino : linkAnterior.fecha_inicio_ciclo,
          fecha_fin_ciclo: esInscripcionIndividual ? fechaClaseDestino : linkAnterior.fecha_fin_ciclo,
        }
      })

      await tx.inscripciones_deudas_link.deleteMany({
        where: {
          inscripcion_id: insc.id,
          cuenta_id: linkAnterior.cuenta_id,
        }
      })

      // 🔢 Las clases ya consumidas pasan a la inscripción nueva (dueña del link
      // del ciclo). Va antes de generar: la destino tiene que estar vacía por el
      // @@unique([inscripcion_id, fecha]).
      if (planCambio) {
        await asistenciaService.trasladarClasesDelCiclo(tx, {
          desde: insc.id,
          hacia: createdInsc.id,
          inicioCiclo: inicioCicloUTC,
        });
      }

      let inscripcionRespuesta = createdInsc;

      if (createdInsc.estado === 'ACTIVO') {
        // 🎯 BL-001: bifurcación por tipo. Antes se llamaba siempre a
        // generarClasesFuturas, generándole 30 días a las clases sueltas.
        if (esInscripcionIndividual) {
          await asistenciaService.generarClaseUnica(tx, {
            inscripcion_id: createdInsc.id,
            dia_semana: createdInsc.horarios_clases.dia_semana,
            coordinador_id: createdInsc.horarios_clases.coordinador_id,
            fecha_inicio: createdInsc.fecha_inscripcion,
            // 🤝 BL-010: la fila ya está en mano (el create la trae con
            // horarios_clases incluido), así que la detección de choque con
            // recuperaciones no reconsulta nada.
            alumno_id: createdInsc.alumno_id,
            hora_inicio: createdInsc.horarios_clases.hora_inicio,
          })

          // Solo la clase suelta: marca como PRESENTE lo que ya pasó. En REGULAR
          // NO aplica, pisaría los FALTA reales de las clases conservadas.
          const hoy = new Date()
          hoy.setHours(12, 0, 0, 0)
          await tx.registros_asistencia.updateMany({
            where: {
              inscripcion_id: createdInsc.id,
              fecha: {
                gte: createdInsc.fecha_inscripcion,
                lt: hoy
              }
            },
            data: {
              estado: 'PRESENTE'
            }
          })
        } else {
          // 🔢 Pendientes = CLASES_POR_CICLO − consumidas, generadas por conteo
          // desde la fecha efectiva, saltando feriados.
          const pendientes = Math.max(0, CLASES_POR_CICLO - planCambio.consumidas);

          const fechasNuevas = await asistenciaService.generarClasesPorConteo(tx, {
            inscripcion_id: createdInsc.id,
            dia_semana: createdInsc.horarios_clases.dia_semana,
            usuario_admin_id: Number.parseInt(adminId),
            coordinador_id: createdInsc.horarios_clases.coordinador_id,
            fecha_inicio: dayjs.tz(claveEfectiva, TZ_LIMA).hour(12).toDate(),
            cantidad: pendientes,
            // 🤝 BL-010: idem.
            alumno_id: createdInsc.alumno_id,
            hora_inicio: createdInsc.horarios_clases.hora_inicio,
          })

          // 🚩 Fin de ciclo SIN escribir fecha_fin_ciclo (invariante BL-006, ver
          // cambio-horario.util.js): si la última clase pasa del cierre
          // derivado (+30 días del VERDUGO), se corre el ancla lo justo.
          const ultimaClase = fechasNuevas[fechasNuevas.length - 1];
          const dias = ultimaClase
            ? diasParaCubrirUltimaClase(createdInsc.fecha_inscripcion, ultimaClase)
            : 0;

          if (dias > 0) {
            const corrido = await aplicarCorrimientoDeCiclo(tx, {
              link: nuevoLink,
              inscripcionId: createdInsc.id,
              dias,
            });

            // Link legacy sin fecha_inicio_ciclo: aplicarCorrimientoDeCiclo no
            // puede moverlo, pero el VERDUGO solo mira fecha_inscripcion, así que
            // se corre esa para no perder la última clase.
            if (!corrido) {
              await tx.inscripciones.update({
                where: { id: createdInsc.id },
                data: {
                  fecha_inscripcion: sumarDiasUTC(createdInsc.fecha_inscripcion, dias),
                  actualizado_en: new Date(),
                },
              });
            }

            console.log(
              `Cambio de horario ${createdInsc.id}: última clase ${ultimaClase.toISOString().slice(0, 10)} pasa del cierre; ancla del ciclo corrida ${dias} día(s).`
            );

            inscripcionRespuesta = await tx.inscripciones.findUnique({
              where: { id: createdInsc.id },
              include: { horarios_clases: true },
            });
          }
        }
      }

      await tx.notificaciones.create({
        data: {
          alumno_id: createdInsc.alumno_id,
          titulo: `Cambio de Horario por el Administrador`,
          mensaje: `Tu horario ha sido modificado, verifica tu plan de entrenamiento.`,
          tipo: 'WARNING',
          categoria: 'SISTEMA',
        }
      });

      return inscripcionRespuesta
    });
  },
  // ... al final de inscripcionService

  // =================================================================
  // 📅 ACTUALIZAR FECHA DE INICIO (Desde Validación de Pago)
  // =================================================================
  actualizarFechaInicioPorPago: async (cuentaId, nuevaFecha) => {
    return await prisma.$transaction(async (tx) => {
      const links = await tx.inscripciones_deudas_link.findMany({
        where: { cuenta_id: Number.parseInt(cuentaId) }
      });

      if (links.length === 0) {
        throw new ApiError('No se encontraron inscripciones vinculadas a esta cuenta.', 404);
      }

      const idsInscripciones = links.map(l => l.inscripcion_id);
      const fechaFormateada = dayjs.tz(nuevaFecha, TZ_LIMA).startOf('day').toDate();

      await tx.inscripciones.updateMany({
        where: { id: { in: idsInscripciones } },
        data: {
          fecha_inscripcion: fechaFormateada,
          fecha_inscripcion_original: fechaFormateada,
          actualizado_en: new Date()
        }
      });

      // 🚩 NUEVO: sincroniza el link con la fecha real ya confirmada
      await tx.inscripciones_deudas_link.updateMany({
        where: { cuenta_id: Number.parseInt(cuentaId) },
        data: { fecha_inicio_ciclo: fechaFormateada }
      });

      return { success: true, count: idsInscripciones.length, nueva_fecha: fechaFormateada };
    });
  },

  // =================================================================
  // 🆕 BL-004: ÚLTIMO PLAN DEL ALUMNO (pre-llenado de reinscripción)
  //
  // Devuelve el último PAQUETE REGULAR completo, con los IDS de sede / nivel /
  // horario, para que el front pre-llene el formulario y mande el POST / de
  // siempre. Es SOLO LECTURA: no crea nada ni toca FASE A.
  //
  // Por qué no sirve ninguno de los endpoints que ya había: obtenerPorAlumno y
  // el historial de ciclos devuelven sede y nivel por NOMBRE, y sin ids el
  // front no puede pre-seleccionar nada.
  //
  // ⚠️ El paquete se reconstruye por cuenta_id y NO por id_grupo_transaccion:
  // el cron VERDUGO pone id_grupo_transaccion = null al finalizar la
  // inscripción (inscripcion-cron.service.js -> gestionarVencimientos), que es
  // EXACTAMENTE el caso que nos interesa acá (alumno con ciclo vencido que
  // reinscribe). inscribirPaquete crea UNA cuenta por paquete, así que la
  // cuenta sí sobrevive como agrupador.
  // =================================================================
  obtenerUltimoPlanAlumno: async (alumnoId, cuentaId = null) => {
    // BL-004: cuentaId opcional -> reconstruye ESE paquete histórico en vez del último.
    const idAlumno = Number.parseInt(alumnoId);

    const sinPlan = {
      tiene_plan_previo: false,
      alumno_id: idAlumno,
      cuenta_id_origen: null,
      horarios: [],
      plan: null,
      ultimo_ciclo: null,
      fecha_inicio_sugerida: dayjs(diaLimaAFechaUTC()).utc().format('YYYY-MM-DD'),
    };

    // 🚩 BL-001: whereTipoInscripcion tolera tipo_inscripcion = NULL (las filas
    // legacy previas a la migración, que son REGULAR). Ocupa la llave OR, que
    // acá está libre.
    const whereRegular = {
      alumno_id: idAlumno,
      ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
    };

    // 1️⃣ El último link de deuda REGULAR del alumno.
    // ⚠️ orderBy creado_en y NO fecha_inicio_ciclo: Postgres ordena DESC NULLS
    // FIRST, así que los links previos al backfill (sin fecha_inicio_ciclo) se
    // llevarían el primer puesto. Es el mismo problema que compararInicioCicloAsc
    // corrige en el historial. creado_en tiene @default(now()), nunca es null.
    const ultimoLink = await prisma.inscripciones_deudas_link.findFirst({
      where: {
        inscripciones: whereRegular,
        ...(cuentaId ? { cuenta_id: Number.parseInt(cuentaId) } : {}),
      },
      orderBy: { creado_en: 'desc' },
      include: {
        cuentas_por_cobrar: { include: { catalogo_conceptos: true } },
      },
    });

    let cuentaIdOrigen = null;
    let idsInscripciones = [];
    let conceptoPlan = null;

    if (ultimoLink) {
      cuentaIdOrigen = ultimoLink.cuenta_id;
      conceptoPlan = ultimoLink.cuentas_por_cobrar?.catalogo_conceptos ?? null;

      const linksDelPaquete = await prisma.inscripciones_deudas_link.findMany({
        where: { cuenta_id: cuentaIdOrigen },
        select: { inscripcion_id: true },
      });
      idsInscripciones = [...new Set(linksDelPaquete.map((l) => l.inscripcion_id))];
    } else {
      // 2️⃣ Fallback: inscripción REGULAR que nunca llegó a generar cuenta.
      // Acá sí toca agrupar por id_grupo_transaccion, porque no hay cuenta.
      const ultimaInsc = await prisma.inscripciones.findFirst({
        where: whereRegular,
        orderBy: [{ fecha_inscripcion: 'desc' }, { id: 'desc' }],
        select: { id: true, id_grupo_transaccion: true },
      });

      if (!ultimaInsc) return sinPlan;

      if (ultimaInsc.id_grupo_transaccion) {
        const hermanas = await prisma.inscripciones.findMany({
          where: {
            alumno_id: idAlumno,
            id_grupo_transaccion: ultimaInsc.id_grupo_transaccion,
          },
          select: { id: true },
        });
        idsInscripciones = hermanas.map((i) => i.id);
      } else {
        idsInscripciones = [ultimaInsc.id];
      }
    }

    if (idsInscripciones.length === 0) return sinPlan;

    const inscripciones = await prisma.inscripciones.findMany({
      where: { id: { in: idsInscripciones } },
      include: { horarios_clases: { select: HORARIO_SELECT } },
      orderBy: { id: 'asc' },
    });

    if (inscripciones.length === 0) return sinPlan;

    // 3️⃣ Disponibilidad real de cada horario, con el MISMO muro de aforo que
    // va a aplicar el POST de inscripción. Así el pre-llenado nunca ofrece un
    // horario que después rebote con "AGOTADO".
    const paramZ = await prisma.parametros_sistema.findUnique({
      where: { clave: 'TIEMPO_LIMITE_RESERVA_MIN' },
    });
    const fechaLimiteZombie = new Date(
      Date.now() - (paramZ ? Number.parseInt(paramZ.valor) : 20) * 60 * 1000
    );

    const horarios = [];
    for (const insc of inscripciones) {
      const h = insc.horarios_clases;
      if (!h) continue;

      let disponible = true;
      let motivoNoDisponible = null;

      if (!h.activo) {
        disponible = false;
        motivoNoDisponible = 'El horario fue desactivado por administración.';
      } else {
        try {
          // Se reusa el validador en vez de duplicar la cuenta de ocupados:
          // es el mismo criterio (ACTIVO / POR_VALIDAR / VENCIDO / reservas no
          // zombies) que decidirá si la reinscripción pasa.
          await Validators.validarAforoHorario(prisma, h.id, fechaLimiteZombie);
        } catch (error) {
          disponible = false;
          motivoNoDisponible = error.message;
        }
      }

      horarios.push({
        ...formatearHorario(h),
        inscripcion_id: insc.id,
        estado_inscripcion: insc.estado,
        disponible,
        motivo_no_disponible: motivoNoDisponible,
      });
    }

    // 4️⃣ Ciclo del último link + fecha sugerida para arrancar el siguiente.
    let ultimoCiclo = null;
    let fechaInicioSugerida = diaLimaAFechaUTC();

    if (ultimoLink) {
      const inicio = aFechaUTC(ultimoLink.fecha_inicio_ciclo);
      const fin = aFechaUTC(ultimoLink.fecha_fin_ciclo);
      const corte = finCicloEfectivo(ultimoLink.fecha_inicio_ciclo, ultimoLink.fecha_fin_ciclo);
      const esVigente = ultimoLink.fecha_fin_ciclo === null;

      // Mismas llaves que filaCiclo del historial, para que el front no tenga
      // que aprender un segundo vocabulario de fechas.
      ultimoCiclo = {
        fecha_inicio_ciclo: inicio,
        fecha_fin_ciclo: fin,
        fecha_corte_ciclo: corte,
        es_vigente: esVigente,
      };

      // Si el ciclo sigue corriendo, el siguiente arranca al día siguiente del
      // corte; si ya cerró, hoy. Esta es la fecha que el front puede mandar
      // como fecha_inicio_ciclo al validar el pago (BL-006).
      if (esVigente && corte) {
        const siguiente = sumarDiasUTC(corte, 1);
        if (siguiente > fechaInicioSugerida) fechaInicioSugerida = siguiente;
      }
    }

    return {
      tiene_plan_previo: true,
      alumno_id: idAlumno,
      cuenta_id_origen: cuentaIdOrigen,
      horarios,
      // Mismo criterio que Logic.obtenerPlanParaRenovar: un plan desactivado
      // por administración no se hereda.
      // No se reusa esa función tal cual porque busca la última cuenta del
      // alumno SIN filtrar por tipo, y a un alumno cuya última compra fue una
      // clase suelta le devolvería CLASE_UNITARIA_2026 como "su plan".
      plan:
        conceptoPlan && conceptoPlan.activo
          ? {
              id: conceptoPlan.id,
              codigo_interno: conceptoPlan.codigo_interno,
              nombre: conceptoPlan.nombre,
              precio_base: Number(conceptoPlan.precio_base),
              cantidad_clases_semanal: conceptoPlan.cantidad_clases_semanal,
              activo: conceptoPlan.activo,
            }
          : null,
      ultimo_ciclo: ultimoCiclo,
      // Se formatea en UTC a propósito: diaLimaAFechaUTC y sumarDiasUTC trabajan
      // en UTC, y un format() en hora local del server correría el día.
      fecha_inicio_sugerida: dayjs(fechaInicioSugerida).utc().format('YYYY-MM-DD'),
    };
  },

  inscribirIndividual: async (data, tx = null) => {
    // 💰 BL-002 (foco #4): antes llegaba `montoDividido` y SOBRESCRIBÍA el
    // precio del catálogo. Ahora el precio sale siempre de
    // catalogo_conceptos.precio_base; `omitirNotificacion` reemplaza el doble
    // uso que tenía montoDividido como flag del flujo admin.
    const { alumno_id, idHorario, fecha_inicio_electiva, omitirNotificacion } = data;

    const ejecutar = async (tx) => {
      await Validators.validarMuroDeDeuda(tx, alumno_id);

      const conceptoAplicar = await tx.catalogo_conceptos.findFirst({
        where: {
          codigo_interno: 'CLASE_UNITARIA_2026',
          activo: true,
        }
      });

      if (!conceptoAplicar) {
        throw new ApiError(`⛔ No existe un plan para CLASE_UNITARIA_2026.`, 404);
      }

      const paramZ = await tx.parametros_sistema.findUnique({ where: { clave: 'TIEMPO_LIMITE_RESERVA_MIN' } });
      const fechaLimiteZombie = new Date(Date.now() - (paramZ ? parseInt(paramZ.valor) : 20) * 60 * 1000);

      const inicioReal = fecha_inicio_electiva
        ? dayjs.tz(fecha_inicio_electiva, TZ_LIMA).hour(12).toDate()
        : dayjs.tz(TZ_LIMA).hour(12).toDate();

      // 🚩 BL-003: capturamos el horario que validarAforoHorario ya devuelve
      // (antes se descartaba) para tener dia_semana y capacidad_max sin una
      // consulta extra.
      const horario = await Validators.validarAforoHorario(tx, idHorario, fechaLimiteZombie);

      // =================================================================
      // 🎯 BL-003: la clase suelta necesita saber EN QUÉ DÍA cae antes de
      // cobrar, para poder validar feriado y aforo de esa fecha puntual.
      //
      // 🔒 calcularPrimeraFechaClase usa la MISMA ventana de 7 días que
      // generarClaseUnica, así que la fecha que validamos acá es por
      // construcción la que se insertará cuando validarPago genere la clase.
      // =================================================================
      const fechaClase = calcularPrimeraFechaClase(inicioReal, horario.dia_semana);
      if (!fechaClase) {
        throw new ApiError(
          '⛔ No se pudo determinar la fecha de la clase para el horario seleccionado.',
          400
        );
      }

      // 🎉 Feriado: rechaza la venta (no se crea inscripción ni cuenta).
      await Validators.validarFechaNoFeriado(tx, fechaClase);

      // 👮‍♂️ Aforo de esa fecha exacta (además del aforo global de arriba).
      await Validators.validarAforoFechaClase(tx, horario, fechaClase);

      const nuevaInscripcion = await tx.inscripciones.create({
        data: {
          alumno_id: parseInt(alumno_id),
          horario_id: idHorario,
          id_grupo_transaccion: null,
          estado: 'PENDIENTE_PAGO',
          // ⚠️ fecha_inscripcion se queda en inicioReal, NO en fechaClase:
          // pagos.service.js pasa fecha_inscripcion como fecha_inicio y la
          // ventana de 7 días resuelve la misma fechaClase. Moverla
          // desplazaría la aritmética de 22/29 días de los crons, el
          // calcularFechaCorte del historial y varios orderBy.
          fecha_inscripcion: inicioReal,
          fecha_inscripcion_original: inicioReal,
          tipo_inscripcion: TIPO_INSCRIPCION.INDIVIDUAL,
        },
        include: { horarios_clases: true }
      });

      // 💰 BL-002 (foco #4): el precio es SIEMPRE el de CLASE_UNITARIA_2026.
      // Antes `montoTotal` venía crudo del body de /individual-admin y se
      // dividía entre data.length, así que una orden de 2 clases en la que el
      // front mandaba el precio unitario cobraba la mitad; si el campo venía
      // `undefined`, monto_asignado terminaba en NaN.
      let totalCobrar = redondear2(conceptoAplicar.precio_base);
      let detalleCobro = [`Plan Individual`];

      // // Si en caso se puede incluir camiseta en clase individual, se descomenta.
      // if (incluye_camiseta) {
      //   totalCobrar += 50;
      //   detalleCobro.push("Camiseta Oficial Gema");
      // }

      const nuevaCuenta = await tx.cuentas_por_cobrar.create({
        data: {
          alumno_id: parseInt(alumno_id),
          concepto_id: conceptoAplicar.id,
          monto_final: totalCobrar,
          detalle_adicional: detalleCobro.join(' | '),
          fecha_vencimiento: dayjs().tz(TZ_LIMA).add(2, 'day').endOf('day').toDate(), // 48 horas de reserva
          estado: 'PENDIENTE'
        }
      });

      // =================================================================
      // 🚩 BL-001: una INDIVIDUAL NO genera ciclo.
      //
      // El link se MANTIENE porque es el puente inscripción ↔ deuda que
      // pagos.service.js necesita para activar la inscripción y generar la
      // clase; quitarlo rompería el flujo de pago. Lo que cambia es que nace
      // CERRADO en la fecha de la clase en vez de con fecha_fin_ciclo: null.
      //
      // Sin esto, finCicloEfectivo() le derivaba inicio + 30 días y una clase
      // suelta se reportaba como un ciclo mensual abierto en el historial, el
      // export BL-013 y el dashboard.
      // =================================================================
      await tx.inscripciones_deudas_link.create({
        data: {
          inscripcion_id: nuevaInscripcion.id,
          cuenta_id: nuevaCuenta.id,
          monto_asignado: totalCobrar,
          fecha_inicio_ciclo: fechaClase,
          fecha_fin_ciclo: fechaClase
        }
      });

      // // Si los beneficios y descuentos aplican tambien para las clases individuales, descomentamos lo siguiente y cambiamos el valor de total_a_pagar en notificaciones y en el return
      // const beneficiosEnCola = await tx.beneficios_pendientes.findMany({
      //   where: { alumno_id: parseInt(alumno_id), usado: false },
      //   include: { tipos_beneficio: true }
      // });

      // let montoActualizado = totalCobrar;
      // for (const pendiente of beneficiosEnCola) {
      //   const valorNominal = parseFloat(pendiente.tipos_beneficio.valor_por_defecto);
      //   let descuentoReal = pendiente.tipos_beneficio.es_porcentaje
      //     ? montoActualizado * (valorNominal / 100)
      //     : valorNominal;

      //   const descuentoFinal = descuentoReal > montoActualizado ? montoActualizado : descuentoReal;
      //   montoActualizado -= descuentoFinal;

      //   await tx.descuentos_aplicados.create({
      //     data: {
      //       cuenta_id: nuevaCuenta.id,
      //       tipo_beneficio_id: pendiente.tipo_beneficio_id,
      //       monto_nominal_aplicado: valorNominal,
      //       monto_dinero_descontado: descuentoFinal,
      //       motivo_detalle: pendiente.motivo || "Beneficio automático",
      //       aplicado_por: pendiente.asignado_por
      //     }
      //   });
      //   await tx.beneficios_pendientes.update({ where: { id: pendiente.id }, data: { usado: true } });
      // }

      // await tx.cuentas_por_cobrar.update({
      //   where: { id: nuevaCuenta.id },
      //   data: {
      //     monto_final: montoActualizado,
      //     estado: montoActualizado <= 0.01 ? 'PAGADA' : 'PENDIENTE'
      //   }
      // });

      if (!omitirNotificacion) {
        await tx.notificaciones.create({
          data: {
            alumno_id: parseInt(alumno_id),
            titulo: '✅ Inscripción por Clase Única Generada',
            mensaje: `Se ha reservado tu cupo. Total: S/ ${totalCobrar.toFixed(2)}.`,
            tipo: 'SUCCESS',
            categoria: 'SISTEMA'
          }
        });
      }

      return {
        mensaje: 'Inscripción procesada exitosamente.',
        total_a_pagar: totalCobrar,
        inscripcion: nuevaInscripcion
      };
    }

    try {
      if (tx) {
        return await ejecutar(tx);
      }
      return await prisma.$transaction(ejecutar);
    } catch (error) {
      console.error(`❌ [FALLO DURANTE INSCRIPCIÓN INDIVIDUAL] Alumno: ${alumno_id} | ${error.message}`);
      throw error;
    }
  },

  inscribirIndividualByAdmin: async (data) => {
    try {
      return await prisma.$transaction(async (tx) => {

        const alumnoIds = [...new Set(data.map(d => d.alumno_id))];
        if (alumnoIds.length !== 1) throw new ApiError("Se están registrando dos o más alumnos diferentes en el mismo proceso de inscripción individual.", 400);

        let results = [];
        for (const d of data) {
          const {
            alumno_id, idHorario, fecha_inicio_electiva,
            metodo_pago,
            usuario_admin_id
          } = d;

          // 💰 BL-002 (foco #4): se eliminó `montoTotal / data.length`. El
          // monto lo pone el catálogo dentro de inscribirIndividual; acá solo
          // silenciamos la notificación al alumno, que es lo único que el viejo
          // `montoDividido` aportaba además del precio.
          const dataInsc = await inscripcionService.inscribirIndividual({ alumno_id: Number(alumno_id), idHorario: Number(idHorario), fecha_inicio_electiva, omitirNotificacion: true }, tx);

          const deuda = await tx.inscripciones_deudas_link.findFirst({
            where: { inscripcion_id: dataInsc.inscripcion.id }
          })
          if (!deuda) throw new ApiError('Error durante la inscripción individual.', 404);
          const deuda_id = deuda.cuenta_id;
          const monto = deuda.monto_asignado;

          const dataPago = await pagosService.registrarPago({ deuda_id, monto, metodo_pago: Number(metodo_pago) }, tx);

          const pago_id = dataPago.pago.id;
          const accion = 'APROBAR';
          const notas = 'Inscripción por clase única y pago realizados desde rol admin.'

          const resultado = await pagosService.validarPago({ pago_id, accion, usuario_admin_id: Number(usuario_admin_id), notas }, tx);

          results.push(resultado)
        }
        return results;
      })
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof PrismaClientKnownRequestError) throw new ApiError(e.message, 400, { prismaCode: e.code, meta: e.meta });
      throw new ApiError(e instanceof Error ? e.message : 'Error Interno', 500);
    }
  },
  // =================================================================
  // 📊 HISTORIAL HÍBRIDO (INSCRIPCIONES + MESES COBRADOS)
  //
  // 🔧 BL-011: las fechas de ciclo salen de fecha_inicio_ciclo /
  // fecha_fin_ciclo del link, normalizadas en UTC, y fecha_corte_ciclo pasa a
  // ser el FIN REAL del ciclo (antes devolvía el plazo de pago de la cuenta).
  // 🆕 BL-012: filtro opcional por mes/anio con regla de solapamiento.
  //
  // ⚠️ REGLA DE ORO: las 14 llaves que ya consume el frontend siguen intactas.
  // Lo nuevo se añade; nada se renombra ni se elimina.
  // =================================================================
  obtenerHistorialCiclosAlumno: async (alumnoId, filtro = {}) => {
    const id = Number.parseInt(alumnoId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('ID de alumno inválido', 400);
    }

    // ⚠️ Fuera del try: el catch de abajo reempaqueta todo como 500 y se
    // comería este 400 (misma convención que historial_academico.service.js).
    const mesAnio = parsearMesAnio(filtro.mes, filtro.anio);

    try {
      const inscripcionesBrutas = await prisma.inscripciones.findMany({
        where: { alumno_id: id },
        include: INCLUDE_HISTORIAL_CICLOS,
        orderBy: { fecha_inscripcion: 'desc' }
      });

      const historialMeses = construirHistorialCiclos(inscripcionesBrutas);

      // 🆕 BL-012: sin params el resultado es el histórico completo, igual que antes.
      if (!mesAnio) return historialMeses;

      return historialMeses.filter((fila) =>
        cicloSolapaMes(fila.fecha_inicio_ciclo, fila.fecha_fin_ciclo, mesAnio.mes, mesAnio.anio)
      );

    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [ERROR OBTENER HISTORIAL MESES] Alumno: ${alumnoId} | ${error.message}`);
      throw new ApiError('Error al obtener el historial de ciclos del alumno', 500);
    }
  },

  // =================================================================
  // 🆕 BL-012: HISTORIAL DE CICLOS POR MES, CON DESGLOSE DE CLASES
  //
  // Endpoint hermano del anterior: mismas llaves por ciclo + un sub-nodo
  // desglose_mes con las clases/asistencias del tramo que cae en el mes
  // pedido. Un ciclo a caballo entre dos meses (15/ene–15/feb) aparece en
  // AMBOS, con el desglose recortado al mes consultado.
  // =================================================================
  obtenerHistorialCiclosPorMes: async (alumnoId, filtro = {}) => {
    const id = Number.parseInt(alumnoId, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('ID de alumno inválido', 400);
    }

    // ⚠️ Acá mes/anio SÍ son obligatorios. También fuera del try.
    const { mes, anio } = parsearMesAnio(filtro.mes, filtro.anio, { requerido: true });

    try {
      const inscripcionesBrutas = await prisma.inscripciones.findMany({
        where: { alumno_id: id },
        include: {
          ...INCLUDE_HISTORIAL_CICLOS,
          // Las asistencias cuelgan de la inscripción, no del link: se reparten
          // por ciclo más abajo según la ventana de vigencia de cada uno.
          registros_asistencia: {
            where: { estado: { in: ESTADOS_VALIDOS_PARA_CICLO } },
            select: { fecha: true, estado: true },
            orderBy: { fecha: 'asc' }
          }
        },
        orderBy: { fecha_inscripcion: 'desc' }
      });

      // Se construye el historial COMPLETO para que numero_mes_ciclo sea el
      // número real del ciclo dentro de su inscripción, no el del mes filtrado.
      const todosLosCiclos = construirHistorialCiclos(inscripcionesBrutas);

      const asistenciasPorInscripcion = new Map(
        inscripcionesBrutas.map((insc) => [insc.id, insc.registros_asistencia || []])
      );

      const { desde, hasta } = rangoMesUTC(mes, anio);

      const ciclos = todosLosCiclos
        .filter((fila) => cicloSolapaMes(fila.fecha_inicio_ciclo, fila.fecha_fin_ciclo, mes, anio))
        .map((fila) => ({
          ...fila,
          desglose_mes: desgloseDelTramo(
            fila,
            asistenciasPorInscripcion.get(fila.inscripcion_id) || [],
            desde,
            hasta
          )
        }));

      const resumen_mes = ciclos.reduce((acc, c) => ({
        total_clases: acc.total_clases + c.desglose_mes.total_clases,
        clases_presente: acc.clases_presente + c.desglose_mes.clases_presente,
        clases_falta: acc.clases_falta + c.desglose_mes.clases_falta,
        clases_programadas: acc.clases_programadas + c.desglose_mes.clases_programadas,
      }), { total_clases: 0, clases_presente: 0, clases_falta: 0, clases_programadas: 0 });

      return {
        mes,
        anio,
        etiqueta_mes: etiquetaMes(mes, anio),
        rango_mes: { desde, hasta },
        // 🎯 Alimenta el selector del frontend sin una segunda llamada. Se
        // calcula sobre TODOS los ciclos, no solo los del mes pedido.
        meses_disponibles: construirMesesDisponibles(todosLosCiclos),
        total_ciclos: ciclos.length,
        resumen_mes,
        ciclos,
      };

    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [ERROR HISTORIAL CICLOS POR MES] Alumno: ${alumnoId} | ${mes}/${anio} | ${error.message}`);
      throw new ApiError('Error al obtener el historial de ciclos por mes', 500);
    }
  },
};


// =================================================================
// --- HELPERS HISTORIAL DE CICLOS (BL-011 / BL-012) ---
// =================================================================

// Un solo include compartido por los dos endpoints del historial, para que
// ambos vean exactamente los mismos datos de sede/nivel/profesor.
const INCLUDE_HISTORIAL_CICLOS = {
  horarios_clases: {
    include: {
      canchas: { include: { sedes: true } },
      niveles_entrenamiento: true,
      coordinadores: { include: { usuarios: true } }
    }
  },
  inscripciones_deudas_link: {
    include: { cuentas_por_cobrar: true }
    // 🔧 BL-011: el orderBy de Prisma se quitó a propósito. Postgres ordena
    // ASC NULLS LAST, así que los links sin fecha_inicio_ciclo (previos al
    // backfill) se llevaban el numero_mes_ciclo más alto. Se ordena en JS con
    // compararInicioCicloAsc, que manda los NULL al final explícitamente.
  }
};

// Datos de la inscripción que se repiten en cada fila del historial.
function datosInscripcion(inscripcion) {
  const hc = inscripcion.horarios_clases;
  return {
    inscripcion_id: inscripcion.id,
    estado_inscripcion: inscripcion.estado,
    sede: hc?.canchas?.sedes?.nombre || 'S/D',
    nivel: hc?.niveles_entrenamiento?.nombre || 'S/D',
    profesor: hc?.coordinadores?.usuarios?.nombres || 'S/D',
    tipo_inscripcion: inscripcion.tipo_inscripcion,
  };
}

// Fila de un ciclo real (con link de deuda).
// Las 14 primeras llaves son el contrato que ya consume el frontend.
function filaCiclo(inscripcion, link, numeroMesCiclo) {
  const cuenta = link.cuentas_por_cobrar;
  const inicio = aFechaUTC(link.fecha_inicio_ciclo);
  const fin = aFechaUTC(link.fecha_fin_ciclo);
  const corte = finCicloEfectivo(link.fecha_inicio_ciclo, link.fecha_fin_ciclo);
  const esVigente = link.fecha_fin_ciclo === null;

  return {
    ...datosInscripcion(inscripcion),

    numero_mes_ciclo: numeroMesCiclo,
    fecha_inicio_ciclo: inicio,                 // ✅ dato real del link, normalizado en UTC
    fecha_fin_ciclo: fin,                       // ✅ null si sigue vigente
    // 🔧 BL-011: antes acá venía cuenta.fecha_vencimiento, que es el PLAZO DE
    // PAGO (hoy + 2 días), no el fin del ciclo. Ahora es el fin real.
    // El plazo de pago no se pierde: va en fecha_vencimiento_pago.
    fecha_corte_ciclo: corte,
    estado_pago_mes: cuenta?.estado ?? 'SIN_CUENTA',
    monto_mes: Number(link.monto_asignado),
    cuenta_id: cuenta?.id ?? null,
    es_estimado: link.es_estimado,              // true = viene del backfill

    // --- 🆕 llaves aditivas (el front puede ignorarlas sin romperse) ---
    estado_ciclo: esVigente ? 'VIGENTE' : 'CERRADO',
    es_vigente: esVigente,
    sin_vigencia: inicio === null,              // sin fecha_inicio_ciclo en BD
    dias_ciclo: diasEntreUTC(inicio, corte),
    fecha_inicio_ciclo_label: formatFechaEs(inicio),
    fecha_fin_ciclo_label: fin ? formatFechaEs(fin) : 'Vigente',
    fecha_corte_ciclo_label: formatFechaEs(corte),
    fecha_vencimiento_pago: cuenta?.fecha_vencimiento ?? null,
  };
}

// Fila de una inscripción que todavía no generó cuenta por cobrar.
// 🔧 BL-011: mismo juego de llaves que filaCiclo — antes esta rama omitía
// es_estimado y metía un Timestamp(6) crudo en fecha_inicio_ciclo.
function filaSinCuenta(inscripcion) {
  const inicio = aFechaUTC(inscripcion.fecha_inscripcion);
  const corte = finCicloEfectivo(inscripcion.fecha_inscripcion, null);

  return {
    ...datosInscripcion(inscripcion),

    numero_mes_ciclo: 1,
    fecha_inicio_ciclo: inicio,
    fecha_fin_ciclo: null,
    fecha_corte_ciclo: corte,
    estado_pago_mes: 'SIN_CUENTA',
    monto_mes: 0,
    cuenta_id: null,
    es_estimado: false,

    estado_ciclo: 'SIN_CUENTA',
    es_vigente: true,
    sin_vigencia: inicio === null,
    dias_ciclo: diasEntreUTC(inicio, corte),
    fecha_inicio_ciclo_label: formatFechaEs(inicio),
    fecha_fin_ciclo_label: 'Vigente',
    fecha_corte_ciclo_label: formatFechaEs(corte),
    fecha_vencimiento_pago: null,
  };
}

// Aplana inscripciones -> filas de ciclo, numerando y ordenando bien.
function construirHistorialCiclos(inscripciones) {
  const filas = [];

  for (const inscripcion of inscripciones) {
    const links = [...(inscripcion.inscripciones_deudas_link || [])].sort(compararInicioCicloAsc);

    if (links.length === 0) {
      filas.push(filaSinCuenta(inscripcion));
      continue;
    }

    // numero_mes_ciclo se asigna DESPUÉS de ordenar: es el orden cronológico
    // real del ciclo dentro de su inscripción.
    links.forEach((link, index) => filas.push(filaCiclo(inscripcion, link, index + 1)));
  }

  // 🔧 BL-011: comparador null-safe. El sort anterior hacía new Date(null),
  // que es la época 1970, y hundía los ciclos sin fecha al fondo de la lista.
  filas.sort(compararFilaCicloDesc);

  return filas;
}

// 🆕 BL-012: clases y asistencias del tramo del ciclo que cae dentro del mes.
// El tramo es la intersección de [inicio, fin efectivo] con [desdeMes, hastaMes].
function desgloseDelTramo(fila, asistencias, desdeMes, hastaMes) {
  const vacio = {
    dias_del_ciclo_en_el_mes: 0,
    total_clases: 0,
    clases_presente: 0,
    clases_falta: 0,
    clases_programadas: 0,
    clases: [],
  };

  // Sin fecha_inicio_ciclo no hay ventana que recortar: no se puede atribuir
  // ninguna asistencia a este ciclo.
  if (!fila.fecha_inicio_ciclo || !fila.fecha_corte_ciclo) return vacio;

  const inicioTramo = new Date(Math.max(fila.fecha_inicio_ciclo.getTime(), desdeMes.getTime()));
  const finTramo = new Date(Math.min(fila.fecha_corte_ciclo.getTime(), hastaMes.getTime()));
  if (finTramo < inicioTramo) return vacio;

  const clases = asistencias
    .map((r) => ({ fechaUTC: aFechaUTC(r.fecha), estado: r.estado, fecha: r.fecha }))
    .filter((r) => r.fechaUTC && r.fechaUTC >= inicioTramo && r.fechaUTC <= finTramo)
    .map((r) => ({
      fecha: r.fechaUTC,
      fecha_label: formatFechaEs(r.fechaUTC),
      estado: r.estado,
    }));

  return {
    dias_del_ciclo_en_el_mes: diasEntreUTC(inicioTramo, finTramo) + 1, // inclusivo
    total_clases: clases.length,
    clases_presente: clases.filter((c) => c.estado === 'PRESENTE').length,
    clases_falta: clases.filter((c) => c.estado === 'FALTA').length,
    clases_programadas: clases.filter((c) => c.estado === 'PROGRAMADA').length,
    clases,
  };
}

// 🆕 BL-012: meses que el selector del frontend debe ofrecer. Un ciclo aporta
// TODOS los meses que toca, así que uno del 15/ene al 15/feb aparece en enero
// y en febrero.
function construirMesesDisponibles(filas) {
  const mapa = new Map();

  for (const fila of filas) {
    if (!fila.fecha_inicio_ciclo || !fila.fecha_corte_ciclo) continue;

    let cursor = new Date(Date.UTC(
      fila.fecha_inicio_ciclo.getUTCFullYear(),
      fila.fecha_inicio_ciclo.getUTCMonth(),
      1
    ));
    const limite = new Date(Date.UTC(
      fila.fecha_corte_ciclo.getUTCFullYear(),
      fila.fecha_corte_ciclo.getUTCMonth(),
      1
    ));

    while (cursor <= limite) {
      const mes = cursor.getUTCMonth() + 1;
      const anio = cursor.getUTCFullYear();
      const clave = `${anio}-${String(mes).padStart(2, '0')}`;

      const existente = mapa.get(clave);
      if (existente) {
        existente.total_ciclos += 1;
      } else {
        mapa.set(clave, { mes, anio, etiqueta: etiquetaMes(mes, anio), total_ciclos: 1 });
      }

      cursor = new Date(Date.UTC(anio, mes, 1)); // siguiente mes
    }
  }

  // Más reciente primero, igual que el historial.
  return [...mapa.values()].sort((a, b) => (b.anio - a.anio) || (b.mes - a.mes));
}

// --- HELPER (Calendario) ---
function contarClasesEnIntervalo(diaSemana, inicio, fin) {
  let contador = 0;
  let puntero = new Date(inicio);
  puntero.setHours(12, 0, 0, 0);
  let finFijo = new Date(fin);
  finFijo.setHours(23, 59, 59, 999);

  while (puntero <= finFijo) {
    if (puntero.getDay() === diaSemana) contador++;
    puntero.setDate(puntero.getDate() + 1);
  }
  return contador;
}