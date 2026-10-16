import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { aCentimos, aMonto, redondear2 } from '../../shared/utils/dinero.util.js';
import { sincronizarPuenteDeuda } from '../../shared/utils/deuda-puente.util.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_LIMA = 'America/Lima';
import {
  ESTADO_ITEM,
  ESTADO_MERCH,
  TIPO_TRANSACCION,
  agruparColeccion,
  agruparMerchIds,
  construirLineas,
  detalleMerch,
  filasAlumnoMerch,
} from './logic/merch.logic.js';

// Estados de un ítem que cuentan como ingreso de merch (RESERVADO aún no se
// cobró y DEVUELTO se reembolsó).
const ESTADOS_CON_INGRESO = [ESTADO_ITEM.POSEE, ESTADO_ITEM.PERDIDO];

// Estados en los que una cuenta todavía le debe plata (o una validación) a la academia.
const ESTADOS_CUENTA_ABIERTA = ['PENDIENTE', 'PARCIAL', 'POR_VALIDAR'];

// Cuenta que existe SOLO por una orden de merch: tiene ítems y ningún link de matrícula.
export const whereCuentaSoloMerch = {
  alumno_merch: { some: {} },
  inscripciones_deudas_link: { none: {} },
};

const enTransaccion = (tx, fn) => (tx ? fn(tx) : prisma.$transaction(fn));

/**
 * Valida los ítems pedidos contra el catálogo y descuenta el stock de forma
 * atómica (updateMany condicionado: dos compras simultáneas no pueden dejar el
 * stock en negativo). Devuelve las líneas con precio congelado y el total.
 */
const validarYDescontarStock = async (tx, merchIds) => {
  const pedido = agruparMerchIds(merchIds);
  if (pedido.length === 0) {
    throw new ApiError('Debes indicar al menos un producto de merch.', 400);
  }

  const catalogo = await tx.merch.findMany({
    where: { id: { in: pedido.map((p) => p.merch_id) } },
  });
  const { lineas, total } = construirLineas(pedido, catalogo);

  for (const linea of lineas) {
    const { count } = await tx.merch.updateMany({
      where: {
        id: linea.merch_id,
        estado: ESTADO_MERCH.ACTIVO,
        stock: { gte: linea.cantidad },
      },
      data: { stock: { decrement: linea.cantidad }, actualizado_en: new Date() },
    });
    if (count === 0) {
      throw new ApiError(`⛔ Stock insuficiente de "${linea.nombre}".`, 409);
    }
  }

  return { lineas, total };
};

export const merchService = {
  // ---------------------------------------------------------------- Catálogo
  listarCatalogo: async ({ incluirInactivos = false } = {}) => {
    return prisma.merch.findMany({
      where: incluirInactivos ? {} : { estado: ESTADO_MERCH.ACTIVO },
      orderBy: { nombre: 'asc' },
    });
  },

  crear: async (data) => {
    return prisma.merch.create({ data });
  },

  actualizar: async (id, data) => {
    return prisma.merch.update({
      where: { id: Number(id) },
      data: { ...data, actualizado_en: new Date() },
    });
  },

  // --------------------------------------------------------------- Colección
  obtenerColeccion: async (alumnoId) => {
    const items = await prisma.alumno_merch.findMany({
      where: { alumno_id: Number(alumnoId) },
      include: { merch: { select: { id: true, nombre: true, imagen_url: true } } },
      orderBy: { fecha_adquisicion: 'desc' },
    });

    const grupos = agruparColeccion(items);
    return {
      alumno_id: Number(alumnoId),
      ...grupos,
      resumen: {
        posee: grupos.posee.length,
        perdido: grupos.perdido.length,
        devuelto: grupos.devuelto.length,
        reservado: grupos.reservado.length,
      },
    };
  },

  // ------------------------------------------------------- Compra independiente
  /**
   * Venta de merch sin matrícula. Nace ya cobrada: cuenta PAGADA + pago
   * APROBADO con tipo_transaccion 'MERCH' (mismo precedente que la venta
   * express), así el ingreso suma al dashboard y a la caja.
   */
  comprarIndependiente: async (data, adminId, tx = null) => {
    const { alumno_id, merch_ids, metodo_pago_id, codigo_operacion, notas } = data;

    return enTransaccion(tx, async (db) => {
      const alumno = await db.alumnos.findUnique({ where: { usuario_id: Number(alumno_id) } });
      if (!alumno) throw new ApiError('El alumno no existe.', 404);

      const { lineas, total } = await validarYDescontarStock(db, merch_ids);

      const cuenta = await db.cuentas_por_cobrar.create({
        data: {
          alumno_id: Number(alumno_id),
          detalle_adicional: detalleMerch(lineas),
          monto_final: total,
          fecha_vencimiento: new Date(),
          estado: 'PAGADA',
        },
      });

      const pago = await db.pagos.create({
        data: {
          cuenta_id: cuenta.id,
          metodo_pago_id: Number(metodo_pago_id),
          monto_pagado: total,
          codigo_operacion: codigo_operacion || `MERCH-${Date.now().toString().slice(-6)}`,
          estado_validacion: 'APROBADO',
          revisado_por: Number(adminId),
          notas_validacion: (notas || 'Venta de merch').slice(0, 200),
          tipo_transaccion: TIPO_TRANSACCION.MERCH,
        },
      });

      await db.alumno_merch.createMany({
        data: filasAlumnoMerch(lineas, {
          alumno_id: Number(alumno_id),
          cuenta_id: cuenta.id,
          pago_id: pago.id,
          estado_item: ESTADO_ITEM.POSEE,
        }),
      });

      await db.notificaciones.create({
        data: {
          alumno_id: Number(alumno_id),
          titulo: '🛍️ Compra de Merch',
          mensaje: `Registramos tu compra por S/ ${total.toFixed(2)}: ${detalleMerch(lineas).replace('Merch: ', '')}.`,
          tipo: 'SUCCESS',
          categoria: 'VENTAS',
        },
      });

      return {
        mensaje: 'Compra de merch registrada.',
        total_pagado: total,
        cuenta_id: cuenta.id,
        pago_id: pago.id,
        items: lineas,
      };
    });
  },

  // ------------------------------------------------------ Combo con matrícula
  /**
   * Reserva stock y crea los ítems RESERVADO de una cuenta de matrícula.
   * Sin merch_ids devuelve total 0 y no toca nada (la matrícula queda igual).
   */
  reservarParaCuenta: async (tx, { alumno_id, cuenta_id, merch_ids }) => {
    const sinMerch =
      merch_ids === undefined ||
      merch_ids === null ||
      (Array.isArray(merch_ids) && merch_ids.length === 0);
    if (sinMerch) {
      return { total: 0, lineas: [], detalle: null };
    }

    const { lineas, total } = await validarYDescontarStock(tx, merch_ids);

    await tx.alumno_merch.createMany({
      data: filasAlumnoMerch(lineas, {
        alumno_id: Number(alumno_id),
        cuenta_id: Number(cuenta_id),
        estado_item: ESTADO_ITEM.RESERVADO,
      }),
    });

    return { total, lineas, detalle: detalleMerch(lineas) };
  },

  /**
   * Cierra el monto de una cuenta de matrícula (paso final de inscribirPaquete).
   * El merch se suma DESPUÉS de los beneficios, así un descuento sobre la
   * matrícula no recae sobre el merch. Mantiene el invariante del puente
   * SUM(monto_asignado) == monto_final. Sin merch_ids el resultado es el mismo
   * que antes de existir el módulo.
   */
  cerrarCuentaConMerch: async (
    tx,
    { alumno_id, cuenta_id, detalle_base, monto_matricula, hubo_beneficios, merch_ids }
  ) => {
    const reserva = await merchService.reservarParaCuenta(tx, { alumno_id, cuenta_id, merch_ids });
    const montoFinal = redondear2(monto_matricula + reserva.total);

    await tx.cuentas_por_cobrar.update({
      where: { id: cuenta_id },
      data: {
        monto_final: montoFinal,
        estado: montoFinal <= 0.01 ? 'PAGADA' : 'PENDIENTE',
        ...(reserva.detalle && { detalle_adicional: `${detalle_base} | ${reserva.detalle}` }),
      },
    });

    if (hubo_beneficios || reserva.total > 0) {
      await sincronizarPuenteDeuda(tx, cuenta_id, montoFinal);
    }

    return { montoFinal, merch: reserva };
  },

  /** Pago aprobado: los ítems reservados de la cuenta pasan a POSEE. */
  confirmarMerchDeCuenta: async (tx, cuentaId, pagoId) => {
    const { count } = await tx.alumno_merch.updateMany({
      where: { cuenta_id: Number(cuentaId), estado_item: ESTADO_ITEM.RESERVADO },
      data: {
        estado_item: ESTADO_ITEM.POSEE,
        fecha_adquisicion: new Date(),
        pago_id: Number(pagoId),
      },
    });
    return count;
  },

  /**
   * Decisión única de merch al validar un pago (la llama validarPago):
   *  - APROBADO y deuda en 0  -> RESERVADO pasa a POSEE.
   *  - APROBADO con saldo     -> no pasa nada: sigue RESERVADO hasta completar el pago.
   *  - RECHAZADO sin abonos aprobados previos (cuenta queda RECHAZADO) -> se libera la
   *    reserva. Si ya había un abono aprobado (cuenta PARCIAL) se conserva: hay plata
   *    pagada sobre esos ítems y el alumno puede reintentar el saldo.
   */
  procesarPagoValidado: async (tx, { cuentaId, pagoId, esAprobado, esPagoCompleto, nuevoEstadoDeuda }) => {
    if (esAprobado) {
      const confirmados = esPagoCompleto
        ? await merchService.confirmarMerchDeCuenta(tx, cuentaId, pagoId)
        : 0;
      return { confirmados, liberados: 0 };
    }
    const liberados =
      nuevoEstadoDeuda === 'PARCIAL' ? 0 : await merchService.liberarMerchDeCuenta(tx, cuentaId);
    return { confirmados: 0, liberados };
  },

  /**
   * Arrepentimiento: el alumno cancela su orden de merch PENDIENTE. Borra los
   * ítems RESERVADO, repone el stock al instante y elimina la cuenta.
   * `cuentaId` es el cuenta_id que devolvió POST /merch/orden.
   */
  cancelarOrden: async (cuentaId, solicitante, tx = null) => {
    return enTransaccion(tx, async (db) => {
      const cuenta = await db.cuentas_por_cobrar.findUnique({ where: { id: Number(cuentaId) } });
      if (!cuenta) throw new ApiError('La orden no existe.', 404);

      if (solicitante.rol === 'Alumno' && cuenta.alumno_id !== solicitante.id) {
        throw new ApiError('No puedes cancelar la orden de otro alumno.', 403);
      }
      if (!(await merchService.esCuentaSoloMerch(db, cuenta.id))) {
        throw new ApiError('La cuenta indicada no es una orden de merch.', 409);
      }
      if (cuenta.estado !== 'PENDIENTE') {
        throw new ApiError(
          `Solo se puede cancelar una orden PENDIENTE (esta está ${cuenta.estado}). Si ya enviaste un voucher, espera a que lo validemos.`,
          409
        );
      }
      const pagos = await db.pagos.count({ where: { cuenta_id: cuenta.id } });
      if (pagos > 0) {
        throw new ApiError('La orden ya tiene un pago registrado y no se puede cancelar.', 409);
      }

      const liberados = await merchService.liberarMerchDeCuenta(db, cuenta.id);
      await db.cuentas_por_cobrar.delete({ where: { id: cuenta.id } });

      return { mensaje: 'Orden cancelada. El stock fue devuelto.', cuenta_id: cuenta.id, items_liberados: liberados };
    });
  },

  /** Pago rechazado / cuenta vencida o borrada: devuelve el stock y quita las reservas. */
  liberarMerchDeCuenta: async (tx, cuentaId) => {
    const reservados = await tx.alumno_merch.findMany({
      where: { cuenta_id: Number(cuentaId), estado_item: ESTADO_ITEM.RESERVADO },
      select: { merch_id: true },
    });
    if (reservados.length === 0) return 0;

    const porProducto = new Map();
    for (const { merch_id } of reservados) {
      porProducto.set(merch_id, (porProducto.get(merch_id) || 0) + 1);
    }
    for (const [merchId, cantidad] of porProducto) {
      await tx.merch.update({
        where: { id: merchId },
        data: { stock: { increment: cantidad }, actualizado_en: new Date() },
      });
    }

    await tx.alumno_merch.deleteMany({
      where: { cuenta_id: Number(cuentaId), estado_item: ESTADO_ITEM.RESERVADO },
    });
    return reservados.length;
  },

  /**
   * Etiqueta del pago según lo que cobra la cuenta:
   *   merch + matrícula -> 'MIXTO' · solo merch (orden del alumno) -> 'MERCH' · resto -> 'MATRICULA'.
   */
  tipoTransaccionDeCuenta: async (tx, cuentaId) => {
    const merchEnCuenta = await tx.alumno_merch.count({ where: { cuenta_id: Number(cuentaId) } });
    if (merchEnCuenta === 0) return TIPO_TRANSACCION.MATRICULA;

    const links = await tx.inscripciones_deudas_link.count({
      where: { cuenta_id: Number(cuentaId) },
    });
    return links > 0 ? TIPO_TRANSACCION.MIXTO : TIPO_TRANSACCION.MERCH;
  },

  /** Monto de merch (reservado o poseído) que lleva una cuenta, en céntimos exactos. */
  sumarMerchDeCuenta: async (tx, cuentaId) => {
    const items = await tx.alumno_merch.findMany({
      where: {
        cuenta_id: Number(cuentaId),
        estado_item: { in: [ESTADO_ITEM.RESERVADO, ESTADO_ITEM.POSEE] },
      },
      select: { monto_pagado: true },
    });
    return aMonto(items.reduce((acc, i) => acc + aCentimos(i.monto_pagado), 0));
  },

  /** true si la cuenta es una orden de merch sin matrícula (no toca inscripciones). */
  esCuentaSoloMerch: async (tx, cuentaId) => {
    const n = await tx.cuentas_por_cobrar.count({
      where: { id: Number(cuentaId), ...whereCuentaSoloMerch },
    });
    return n > 0;
  },

  // ------------------------------------------------------- Orden del alumno
  /**
   * Orden de merch creada por el propio alumno. Reserva el stock y deja una
   * cuenta PENDIENTE (48 h, igual que la matrícula) con los ítems RESERVADO.
   * El alumno paga con el flujo estándar (POST /api/pagos/reportar con
   * deuda_id = cuenta_id) y el admin la valida: ahí pasan a POSEE.
   */
  crearOrden: async ({ alumno_id, merch_ids }, tx = null) => {
    return enTransaccion(tx, async (db) => {
      const alumno = await db.alumnos.findUnique({ where: { usuario_id: Number(alumno_id) } });
      if (!alumno) throw new ApiError('El alumno no existe.', 404);

      // Una sola orden abierta por alumno: evita acaparar stock con reservas repetidas.
      const abiertas = await db.cuentas_por_cobrar.count({
        where: {
          alumno_id: Number(alumno_id),
          estado: { in: ESTADOS_CUENTA_ABIERTA },
          ...whereCuentaSoloMerch,
        },
      });
      if (abiertas > 0) {
        throw new ApiError(
          '⛔ Ya tienes una orden de merch pendiente. Págala o espera a que venza para crear otra.',
          409
        );
      }

      const { lineas, total } = await validarYDescontarStock(db, merch_ids);

      const vence = dayjs().tz(TZ_LIMA).add(2, 'day').endOf('day');
      const cuenta = await db.cuentas_por_cobrar.create({
        data: {
          alumno_id: Number(alumno_id),
          // El admin lee este campo al validar el pago para saber qué entregar.
          detalle_adicional: detalleMerch(lineas, 'Orden Merch'),
          monto_final: total,
          fecha_vencimiento: vence.toDate(), // 48 horas de reserva
          estado: 'PENDIENTE',
        },
      });

      await db.alumno_merch.createMany({
        data: filasAlumnoMerch(lineas, {
          alumno_id: Number(alumno_id),
          cuenta_id: cuenta.id,
          estado_item: ESTADO_ITEM.RESERVADO,
        }),
      });

      await db.notificaciones.create({
        data: {
          alumno_id: Number(alumno_id),
          titulo: '🛍️ Orden de Merch generada',
          mensaje: `Reservamos tu pedido por S/ ${total.toFixed(2)}. Adjunta tu voucher antes del ${vence.format('DD/MM/YYYY')} para confirmarlo.`,
          tipo: 'INFO',
          categoria: 'VENTAS',
        },
      });

      return {
        mensaje: 'Orden de merch generada. Adjunta tu voucher para confirmarla.',
        cuenta_id: cuenta.id,
        total_a_pagar: total,
        fecha_vencimiento: vence.toDate(),
        items: lineas,
      };
    });
  },

  /**
   * Cron: libera las órdenes de merch que vencieron sin pago. Sin esto la
   * reserva retendría el stock para siempre (el Francotirador solo limpia
   * cuentas con inscripciones). Solo toca cuentas PENDIENTE: una POR_VALIDAR
   * ya tiene un voucher esperando al admin.
   */
  limpiarOrdenesVencidas: async (db = prisma) => {
    const hoyLima = dayjs.tz(dayjs().tz(TZ_LIMA).format('YYYY-MM-DD'), TZ_LIMA).toDate();
    const vencidas = await db.cuentas_por_cobrar.findMany({
      where: { estado: 'PENDIENTE', fecha_vencimiento: { lt: hoyLima }, ...whereCuentaSoloMerch },
      select: { id: true },
    });

    let liberadas = 0;
    for (const { id } of vencidas) {
      await db.$transaction(async (tx) => {
        // Re-chequeo dentro de la transacción: pudo pagarse entre el findMany y acá.
        const sigueAbierta = await tx.cuentas_por_cobrar.count({ where: { id, estado: 'PENDIENTE' } });
        if (!sigueAbierta) return;
        await merchService.liberarMerchDeCuenta(tx, id);
        await tx.cuentas_por_cobrar.delete({ where: { id } });
        liberadas += 1;
      });
    }
    return liberadas;
  },

  // ------------------------------------------------------------ Estado de ítem
  cambiarEstadoItem: async (itemId, nuevoEstado, tx = null) => {
    return enTransaccion(tx, async (db) => {
      const item = await db.alumno_merch.findUnique({ where: { id: Number(itemId) } });
      if (!item) throw new ApiError('El ítem de merch no existe.', 404);

      if (item.estado_item === ESTADO_ITEM.RESERVADO) {
        throw new ApiError('El ítem está reservado: aún no se aprobó el pago.', 409);
      }
      if (item.estado_item === ESTADO_ITEM.DEVUELTO) {
        throw new ApiError('El ítem ya fue devuelto.', 409);
      }
      if (item.estado_item === nuevoEstado) return item;

      const actualizado = await db.alumno_merch.update({
        where: { id: item.id },
        data: { estado_item: nuevoEstado },
      });

      if (nuevoEstado === ESTADO_ITEM.DEVUELTO) {
        await db.merch.update({
          where: { id: item.merch_id },
          data: { stock: { increment: 1 }, actualizado_en: new Date() },
        });
      }
      return actualizado;
    });
  },

  // ----------------------------------------------------------------- Métricas
  /**
   * Ingreso total atribuible a merch (suelto + parte de combos), aislado del
   * resto. Un DEVUELTO no cuenta: el reembolso se registra como egreso en caja.
   */
  sumarIngresosMerch: async (db = prisma, { desde, hasta } = {}) => {
    const items = await db.alumno_merch.findMany({
      where: {
        estado_item: { in: ESTADOS_CON_INGRESO },
        ...((desde || hasta) && {
          fecha_adquisicion: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) },
        }),
      },
      select: { monto_pagado: true },
    });
    return aMonto(items.reduce((acc, i) => acc + aCentimos(i.monto_pagado), 0));
  },

  obtenerMetricas: async ({ desde, hasta } = {}) => {
    const items = await prisma.alumno_merch.findMany({
      where: {
        estado_item: { in: ESTADOS_CON_INGRESO },
        ...((desde || hasta) && {
          fecha_adquisicion: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) },
        }),
      },
      include: {
        merch: { select: { nombre: true } },
        pagos: { select: { tipo_transaccion: true } },
      },
    });

    let total = 0;
    let suelto = 0;
    let combo = 0;
    const productos = new Map();

    for (const item of items) {
      const centimos = aCentimos(item.monto_pagado);
      total += centimos;
      if (item.pagos?.tipo_transaccion === TIPO_TRANSACCION.MERCH) suelto += centimos;
      else combo += centimos;

      const acum = productos.get(item.merch_id) || {
        merch_id: item.merch_id,
        nombre: item.merch.nombre,
        unidades: 0,
        ingresos: 0,
      };
      acum.unidades += 1;
      acum.ingresos += centimos;
      productos.set(item.merch_id, acum);
    }

    return {
      ingresos_merch: aMonto(total),
      ingresos_venta_suelta: aMonto(suelto),
      ingresos_en_matricula: aMonto(combo),
      unidades_vendidas: items.length,
      productos: [...productos.values()]
        .map((p) => ({ ...p, ingresos: aMonto(p.ingresos) }))
        .sort((a, b) => b.ingresos - a.ingresos),
    };
  },

  /** Suma de pagos MERCH aprobados (venta suelta) — para totales de caja. */
  sumarPagosMerchSueltos: async (db = prisma) => {
    const agg = await db.pagos.aggregate({
      _sum: { monto_pagado: true },
      where: { estado_validacion: 'APROBADO', tipo_transaccion: TIPO_TRANSACCION.MERCH },
    });
    return redondear2(Number(agg._sum.monto_pagado || 0));
  },
};
