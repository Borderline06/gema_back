import { prisma } from '../../config/database.config.js';
import { asistenciaService } from '../asistencia/asistencia.service.js';
import { cloudinaryService } from '../cloudinaryImg/cloudinary.service.js';
import * as Validators from './validators/pagos.validator.js';
import * as Logic from './logic/pagos.logic.js';
import * as Utils from './utils/pagos.util.js';
import { notificacionesService } from '../notificaciones/notificaciones.service.js';
import { inscripcionService } from '../inscripciones/inscripcion.service.js';
// 🎯 BL-001: una sola definición de "es individual" en todo el backend.
import { esIndividual } from '../../shared/utils/tipo-inscripcion.util.js';

export const pagosService = {
  // 1. REGISTRAR EL PAGO (Integrado con Cloudinary 🚀)
  registrarPago: async (data, tx = null) => {
    // 1. Validar input básico
    Utils.validarInputPago(data);
    const { deuda_id, monto, metodo_pago, codigo_operacion, voucher_url, voucherFile } = data;

    // 📸 PASO 0: SUBIR IMAGEN A CLOUDINARY (si se envió un archivo)
    let imageUrl = voucher_url || null;

    if (voucherFile) {
      try {
        const cloudinaryResponse = await cloudinaryService.upload(voucherFile, 'yape');
        imageUrl = cloudinaryResponse.url;
      } catch (error) {
        throw new Error(`Error al subir la imagen a Cloudinary: ${error.message}`);
      }
    }

    const ejecutar = async (tx) => {
      // 🛡️ PASO A: VALIDAR LA DEUDA
      const deuda = await Validators.validarDeudaParaPago(tx, deuda_id);
      // 🔥 NUEVA REGLA: LOS UPGRADES NO ACEPTAN PAGOS PARCIALES
      const esUpgrade = deuda.detalle_adicional && deuda.detalle_adicional.includes('Upgrade');
      // Usamos una tolerancia de 0.01 céntimos por si hay problemas de redondeo en JS
      if (esUpgrade && parseFloat(monto) < (parseFloat(deuda.monto_final) - 0.01)) {
        throw new Error(`⛔ PAGO DENEGADO: Los Upgrades de horario no aceptan pagos a medias. Debes cancelar el monto total exacto de S/ ${deuda.monto_final}.`);
      }

      // 💳 PASO B: RESOLVER EL MÉTODO DE PAGO
      const metodoPagoId = await Logic.resolverMetodoPagoId(tx, metodo_pago);

      // 📝 PASO C: CREAR EL REGISTRO DE PAGO
      const nuevoPago = await tx.pagos.create({
        data: {
          cuenta_id: parseInt(deuda_id),
          metodo_pago_id: metodoPagoId,
          monto_pagado: parseFloat(monto),
          url_comprobante: imageUrl,
          codigo_operacion: codigo_operacion || 'S/N',
          estado_validacion: 'PENDIENTE',
          fecha_pago: new Date(),
        },
      });

      // 🔄 PASO D: ACTUALIZAR ESTADOS (Inmunidad temporal contra el Francotirador)
      await tx.cuentas_por_cobrar.update({
        where: { id: parseInt(deuda_id) },
        data: { estado: 'POR_VALIDAR', actualizado_en: new Date() },
      });

      const inscripcionesUpdate = await tx.inscripciones.updateMany({
        where: { alumno_id: deuda.alumno_id, estado: 'PENDIENTE_PAGO' },
        data: { estado: 'POR_VALIDAR', actualizado_en: new Date() },
      });

      return {
        success: true,
        mensaje: 'Pago registrado exitosamente. Esperando validación.',
        pago: nuevoPago,
        cupos_asegurados: inscripcionesUpdate.count,
      };
    }
    if (tx) {
      return await ejecutar(tx);
    }
    return await prisma.$transaction(ejecutar);
  },

  // 2. VALIDAR EL PAGO (Tu lógica + Corrección de Monto + Sincronización de Fechas 🛡️)
  validarPago: async (data, tx = null) => {
  const { pago_id, accion, usuario_admin_id, notas, monto_real_confirmado } = data;
  const esAprobado = accion === 'APROBAR';

  if (!['APROBAR', 'RECHAZAR'].includes(accion)) {
    throw new Error('La acción debe ser APROBAR o RECHAZAR.');
  }

  const ejecutar = async (tx) => {
    // 🛡️ PASO 1: Buscar y Validar el pago
    let pago = await Validators.buscarYValidarPagoPendiente(tx, pago_id);

    // 👮‍♂️ PASO 2: Corrección de Monto por el Admin
    if (esAprobado && monto_real_confirmado) {
      const montoAdmin = Number.parseFloat(monto_real_confirmado);
      if (montoAdmin !== Number(pago.monto_pagado)) {
        pago = await tx.pagos.update({
          where: { id: pago.id },
          data: {
            monto_pagado: montoAdmin,
            notas_validacion: `Monto corregido por Admin. (Reportado: ${pago.monto_pagado})`,
            codigo_operacion: pago.codigo_operacion || 'Pagado | Sin código',
          },
          include: { cuentas_por_cobrar: true },
        });
      }
    }

    // 💰 PASO 3: Lógica de Alcancía
    let saldoRestante = 0;
    let esPagoCompleto = false;
    if (esAprobado) {
      const saldos = await Logic.calcularSaldosAlcancía(tx, pago);
      saldoRestante = saldos.saldoRestante;
      esPagoCompleto = saldos.esPagoCompleto;
    }

    // 🔄 PASO 4: Determinar Evolución de Estados
    const { nuevoEstadoDeuda, activarAlumno } = await Logic.definirEvolucionDeEstados(
      tx,
      pago,
      esAprobado,
      esPagoCompleto
    );

    // 📝 PASO 5: Actualizar el Pago y la Deuda
    const notaFinalInformativa = esAprobado
      ? esPagoCompleto ? 'PAGO TOTAL' : `ABONO PARCIAL. Resta: S/ ${saldoRestante.toFixed(2)}`
      : 'Rechazado';

    const pagoActualizado = await tx.pagos.update({
      where: { id: pago.id },
      data: {
        estado_validacion: esAprobado ? 'APROBADO' : 'RECHAZADO',
        revisado_por: Number.parseInt(usuario_admin_id),
        notas_validacion: `${notas || ''} | ${notaFinalInformativa}`,
        fecha_pago: new Date(),
        codigo_operacion: pago.codigo_operacion || 'Pagado | Sin código',
      },
    });

    await tx.cuentas_por_cobrar.update({
      where: { id: pago.cuenta_id },
      data: { estado: nuevoEstadoDeuda },
    });

    // 🎓 PASO 6: GESTIÓN DE INSCRIPCIONES
    // 🚩 CAMBIO CLAVE: Quitamos la condición "&& esPagoCompleto"
    // Si 'activarAlumno' es true, significa que este pago (sea parcial o total) 
    // habilita al alumno para tener clases.
    if (activarAlumno) {

      const links = await tx.inscripciones_deudas_link.findMany({
        where: { cuenta_id: pago.cuenta_id },
        include: {
          inscripciones: {
            include: { horarios_clases: true }
          }
        }
      });

      for (const link of links) {
        const insc = link.inscripciones;

        // 🛡️ SEGURO: Solo activar y generar clases si la inscripción está 'POR_VALIDAR'
        // Esto evita que si el alumno hace un SEGUNDO abono parcial, se le vuelvan a generar clases.
        if (insc.estado === 'POR_VALIDAR') {
          await tx.inscripciones.update({
            where: { id: insc.id },
            data: {
              estado: 'ACTIVO',
              actualizado_en: new Date()
            },
          });

          // 🚩 BL-001: antes era una comparación estricta contra el string.
          // esIndividual() tolera NULL, minúsculas y espacios, y es la misma
          // definición que usan ahora los crons, el cambio de horario y la
          // guardia de generarClasesFuturas.
          if (esIndividual(insc)) {
            await asistenciaService.generarClaseUnica(tx, {
              inscripcion_id: insc.id,
              dia_semana: insc.horarios_clases.dia_semana,
              coordinador_id: insc.horarios_clases.coordinador_id,
              fecha_inicio: insc.fecha_inscripcion,
            });
            continue;
          }

          // GENERACIÓN DE ASISTENCIAS
          await asistenciaService.generarClasesFuturas(tx, {
            inscripcion_id: insc.id,
            dia_semana: insc.horarios_clases.dia_semana,
            usuario_admin_id: Number.parseInt(usuario_admin_id),
            coordinador_id: insc.horarios_clases.coordinador_id,
            fecha_inicio: insc.fecha_inscripcion,
            // 🚩 BL-001: ya tenemos la fila, así que le ahorramos la consulta a
            // la guardia de tipo de generarClasesFuturas.
            tipo_inscripcion: insc.tipo_inscripcion,
          });
        }
      }
    } else if (!esAprobado) {
      // ❌ Lógica de rechazo
      // 🚩 FIX: distinguimos si la cuenta rechazada es una RENOVACIÓN de un paquete
      // existente (tiene historial: asistencias, congelamientos, etc.) o una
      // inscripción NUEVA recién creada (segura de borrar).
      // Antes esto siempre hacía deleteMany, lo cual para una renovación podía:
      //   a) fallar por FK (registros_asistencia -> inscripciones es NoAction), o
      //   b) si no había historial aún, borrar de verdad una inscripción con
      //      meses de datos históricos del alumno.
      const esRenovacion = pago.cuentas_por_cobrar.detalle_adicional?.includes('RENOVACION');

      if (esRenovacion) {
        // Revierte correctamente: restaura fecha original, reabre el link viejo,
        // borra el link/cuenta de la renovación fallida. NO borra la inscripción.
        await inscripcionService.eliminarPaqueteCompleto(pago.cuenta_id, tx);
      } else {
        const links = await tx.inscripciones_deudas_link.findMany({
          where: { cuenta_id: pago.cuenta_id }
        });
        const idsInsc = links.map(l => l.inscripcion_id);
        await tx.inscripciones.deleteMany({
          where: { id: { in: idsInsc }, estado: 'POR_VALIDAR' }
        });
      }
    }

    // 🔔 PASO 7: NOTIFICACIÓN (Se mantiene igual)
    await notificacionesService.crear({
      alumnoId: pago.cuentas_por_cobrar.alumno_id,
      titulo: esAprobado ? '✅ Pago Validado' : '❌ Pago Rechazado',
      mensaje: esAprobado
        ? `Tu pago de S/ ${pagoActualizado.monto_pagado} fue aprobado. ${!esPagoCompleto ? 'Recuerda que tienes un saldo pendiente.' : ''}`
        : `Tu pago fue rechazado. Revisa tus observaciones.`,
      tipo: esAprobado ? 'SUCCESS' : 'DANGER',
      categoria: 'PAGOS',
    });

    return {
      resultado: Utils.generarMensajeResultado(accion, esPagoCompleto, saldoRestante),
      pago: pagoActualizado,
      saldo_pendiente: saldoRestante,
    };
  }
  if (tx) {
    return await ejecutar(tx);
  }
  return await prisma.$transaction(ejecutar);
},
  obtenerTodos: async () => {
    return await prisma.pagos.findMany({
      include: {
        cuentas_por_cobrar: {
          include: { alumnos: { include: { usuarios: true } } },
        },
        metodos_pago: true,
        administrador: { include: { usuarios: true } },
      },
      orderBy: { fecha_pago: 'desc' },
    });
  },

  // =====================================================================
  // ⚡ NUEVO: VENTA EXPRESS (Taquilla para Clases Sueltas)
  // =====================================================================
  registrarVentaExpress: async (data, adminId) => {
    const {
      alumno_id,
      monto,
      metodo_pago_id,
      nombre_visitante,
      telefono,
      horario_texto
    } = data;

    return await prisma.$transaction(async (tx) => {
      // 1. Crear una deuda "Fantasma" que ya nace pagada
      const nuevaDeuda = await tx.cuentas_por_cobrar.create({
        data: {
          alumno_id: parseInt(alumno_id),
          // Guardamos los datos de la visita en el detalle
          detalle_adicional: `Pase Invitado: ${nombre_visitante} | Cel: ${telefono || 'N/A'} | Clase: ${horario_texto}`,
          monto_final: parseFloat(monto),
          fecha_vencimiento: new Date(),
          estado: 'PAGADA'
        }
      });

      // 2. Registrar el pago ya aprobado por el Admin
      const nuevoPago = await tx.pagos.create({
        data: {
          cuenta_id: nuevaDeuda.id,
          metodo_pago_id: parseInt(metodo_pago_id),
          monto_pagado: parseFloat(monto),
          codigo_operacion: `VISITA-${Date.now().toString().slice(-6)}`,
          estado_validacion: 'APROBADO',
          revisado_por: parseInt(adminId), // Eddy aprueba su propia venta
          notas_validacion: 'Venta rápida en Taquilla'
        }
      });

      // 3. Notificar al sistema para auditoría
      await tx.notificaciones.create({
        data: {
          usuario_id: parseInt(adminId),
          titulo: '🎟️ Pase Generado',
          mensaje: `Se vendió una clase suelta a ${nombre_visitante} por S/ ${monto}.`,
          tipo: 'SUCCESS',
          categoria: 'VENTAS'
        }
      });

      return {
        success: true,
        mensaje: `Pase registrado para ${nombre_visitante}`,
        deuda: nuevaDeuda,
        pago: nuevoPago
      };
    });
  },

  // 4. OBTENER PAGO POR ID
  obtenerPorId: async (id) => {
    const pago = await prisma.pagos.findUnique({
      where: { id: Number.parseInt(id) },
      include: {
        cuentas_por_cobrar: true,
        metodos_pago: true,
      },
    });
    if (!pago) throw new Error('El pago no existe.');
    return pago;
  },

  obtenerPorAlumno: async (alumnoId) => {
    return await prisma.pagos.findMany({
      where: {
        cuentas_por_cobrar: {
          alumno_id: Number.parseInt(alumnoId),
        },
      },
      include: {
        cuentas_por_cobrar: {
          include: {
            alumnos: {
              include: { usuarios: true },
            },
          },
        },
        metodos_pago: true,
        administrador: {
          include: { usuarios: true },
        },
      },
      orderBy: { fecha_pago: 'desc' },
    });
  },

  obtenerTodosParaAdmin: async () => {
    const pagos = await prisma.pagos.findMany({
      include: {
        cuentas_por_cobrar: {
          include: {
            alumnos: {
              include: {
                usuarios: {
                  select: {
                    nombres: true,
                    apellidos: true,
                    numero_documento: true,
                    email: true,
                    telefono_personal: true
                  }
                }
              }
            }
          },
        },
        metodos_pago: true,
      },
      orderBy: { fecha_pago: 'desc' },
    });

    return pagos;
  },

  // 5. ELIMINAR REGISTRO DE PAGO (Uso delicado)
  eliminarPago: async (id) => {
    return await prisma.pagos.delete({
      where: { id: Number.parseInt(id) },
    });
  },
  // En tu archivo de servicios de pagos (Backend)
  obtenerDetalleCompleto: async (pagoId) => {
    const pago = await prisma.pagos.findUnique({
      where: { id: Number.parseInt(pagoId) },
      include: {
        metodos_pago: true,
        cuentas_por_cobrar: {
          include: {
            // 🔥 ESTA ES LA LÍNEA QUE FALTABA:
            // Sin esto, el frontend no puede sumar los abonos anteriores
            pagos: true,

            alumnos: {
              include: { usuarios: true }
            },
            inscripciones_deudas_link: {
              include: {
                inscripciones: {
                  include: {
                    horarios_clases: {
                      include: {
                        canchas: { include: { sedes: true } },
                        niveles_entrenamiento: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!pago) throw new Error('El registro de pago no existe.');

    return pago;
  },
};
