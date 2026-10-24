import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
// 💰 BL-002: el reparto del puente vive en un solo sitio.
import { redondear2 } from '../../shared/utils/dinero.util.js';
import { sincronizarPuenteDeuda } from '../../shared/utils/deuda-puente.util.js';

export const DescuentosAplicadosService = {
 async aplicar({ cuenta_id, tipo_beneficio_id, admin_id, motivo }) {
    // 1. Validaciones de existencia y carga de relaciones
    const cuenta = await prisma.cuentas_por_cobrar.findUnique({
      where: { id: cuenta_id },
      include: { descuentos_aplicados: true },
    });

    const beneficio = await prisma.tipos_beneficio.findUnique({
      where: { id: tipo_beneficio_id },
    });

    if (!beneficio || !cuenta) {
      throw new ApiError('Cuenta o Beneficio no encontrado.', 404);
    }

    // 2. Regla de "Una sola vez" por cuenta
    const yaTieneEseBeneficio = cuenta.descuentos_aplicados.some(
      (d) => d.tipo_beneficio_id === tipo_beneficio_id
    );
    if (yaTieneEseBeneficio) {
      throw new ApiError('Este beneficio ya fue aplicado a esta cuenta.', 400);
    }

    // 3. Verificación de estado de cuenta
    if (cuenta.estado === 'PAGADA') {
      throw new ApiError('No se pueden aplicar descuentos a una cuenta ya pagada.', 400);
    }

    // 4. Lógica de cálculo (Monto Fijo vs Porcentaje)
    const deudaActual = redondear2(cuenta.monto_final || 0);
    const valorNominal = Number(beneficio.valor_por_defecto);

    let descuentoReal = beneficio.es_porcentaje ? deudaActual * (valorNominal / 100) : valorNominal;

    // Protección contra saldos negativos
    // 💰 BL-002: a céntimos, para que lo que se guarda en
    // monto_dinero_descontado sea exactamente lo que se restó del monto_final.
    const descuentoFinal = redondear2(descuentoReal > deudaActual ? deudaActual : descuentoReal);

    // --- TRANSACCIÓN ATÓMICA ---
    return await prisma.$transaction(async (tx) => {
      // Paso A: Crear el registro del descuento
      const nuevoDescuento = await tx.descuentos_aplicados.create({
        data: {
          cuenta_id: cuenta_id,
          tipo_beneficio_id: tipo_beneficio_id,
          monto_nominal_aplicado: valorNominal,
          monto_dinero_descontado: descuentoFinal,
          motivo_detalle: motivo || `Descuento: ${beneficio.nombre}`,
          aplicado_por: admin_id,
          fecha_aplicacion: new Date(),
        },
      });

      // Paso B: Actualizar el monto_final en la cuenta
      const nuevoMonto = redondear2(deudaActual - descuentoFinal);

      await tx.cuentas_por_cobrar.update({
        where: { id: cuenta_id },
        data: {
          monto_final: nuevoMonto,
          estado: nuevoMonto <= 0.01 ? 'PAGADA' : cuenta.estado,
          actualizado_en: new Date(),
        },
      });

      // 🔥 PASO C: RE-EQUILIBRAR EL PUENTE (Sincronización de Alcancía)
      // 💰 BL-002: antes era `nuevoMonto / links.length` con un updateMany, así
      // que el céntimo del residuo se perdía (un descuento del 15% sobre el plan
      // de 3 clases dejaba 113.33 x3 = 339.99 contra un monto_final de 340.00).
      await sincronizarPuenteDeuda(tx, cuenta_id, nuevoMonto);

      return {
        descuentoFinal,
        descuento: nuevoDescuento,
      };
    });
  },

  async eliminar(descuento_id, restaurarBeneficio = false) {
    return await prisma.$transaction(async (tx) => {
      const descuento = await tx.descuentos_aplicados.findUnique({
        where: { id: descuento_id },
        include: { cuentas_por_cobrar: true },
      });

      if (!descuento) {
        throw new ApiError('El descuento no existe.', 404);
      }

      // SOLO si se pide restaurar (Caso del Francotirador)
      if (restaurarBeneficio) {
        const beneficioPendiente = await tx.beneficios_pendientes.findFirst({
          where: {
            alumno_id: descuento.cuentas_por_cobrar.alumno_id,
            tipo_beneficio_id: descuento.tipo_beneficio_id,
            usado: true,
          },
          orderBy: { fecha_asignacion: 'desc' },
        });

        if (beneficioPendiente) {
          await tx.beneficios_pendientes.update({
            where: { id: beneficioPendiente.id },
            data: { usado: false },
          });
        }
      }

      // Actualizamos la cuenta (esto sí debe pasar siempre para que el saldo sea real)
      const montoARestaurar = redondear2(descuento.monto_dinero_descontado);
      const nuevaDeuda = redondear2(
        redondear2(descuento.cuentas_por_cobrar.monto_final) + montoARestaurar
      );

      await tx.cuentas_por_cobrar.update({
        where: { id: descuento.cuenta_id },
        data: {
          monto_final: nuevaDeuda,
          estado: nuevaDeuda > 0.01 ? 'PENDIENTE' : 'PAGADA',
        },
      });

      // 🔥 PASO ADICIONAL: RE-EQUILIBRAR EL PUENTE (Al restaurar precio original)
      // 💰 BL-002: mismo reparto exacto que en aplicar().
      await sincronizarPuenteDeuda(tx, descuento.cuenta_id, nuevaDeuda);

      return await tx.descuentos_aplicados.delete({
        where: { id: descuento_id },
      });
    });
  },

  async obtenerPorCuenta(cuentaId) {
    return await prisma.descuentos_aplicados.findMany({
      where: { cuenta_id: cuentaId },
      include: {
        tipos_beneficio: true,
        administrador: {
          select: {
            usuario_id: true,
            usuarios: {
              select: {
                nombres: true,
                apellidos: true,
              },
            },
          },
        },
      },
    });
  },
};
