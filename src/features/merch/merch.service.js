import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { aCentimos, aMonto, redondear2 } from '../../shared/utils/dinero.util.js';
import { sincronizarPuenteDeuda } from '../../shared/utils/deuda-puente.util.js';
import { cloudinaryService } from '../cloudinaryImg/cloudinary.service.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_LIMA = 'America/Lima';
import {
  CONCEPTO_INGRESO,
  calcularSplitIngresos,
  ESTADOS_PAGADOS,
  ESTADO_ITEM,
  ESTADO_MERCH,
  TIPO_TRANSACCION,
  agruparColeccion,
  TITULO_AVISO_LISTO,
  agruparMerchIds,
  armarAvisoListo,
  construirLineas,
  detalleMerch,
  esSaldoCompleto,
  filasAlumnoMerch,
  filtroBusquedaAlumno,
  normalizarEstadoItem,
  validarTransicionItem,
} from './logic/merch.logic.js';

const CARPETA_CLOUDINARY_MERCH = 'merch';

// Optimización de las fotos del catálogo: al subir se guarda reducido (máx. 800 px de lado,
// calidad automática, sin conservar el original de hasta 5 MB) y la URL se sirve con
// formato y calidad automáticos (WebP/AVIF cuando el navegador lo soporta).
export const OPTIMIZACION_IMAGEN_MERCH = {
  transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
  entrega: 'f_auto,q_auto',
};

// Estados de un ítem que cuentan como ingreso de merch: ya se cobró (RESERVADO no)
// y no se reembolsó (DEVUELTO no). El ingreso se reconoce al pagar, no al entregar.
const ESTADOS_CON_INGRESO = ESTADOS_PAGADOS;

// Mientras el aviso de "listo" siga sin leer, las unidades nuevas se suman a ese mismo aviso.
const VENTANA_AVISO_LISTO_MIN = 30;

// Estados en los que una cuenta todavía le debe plata (o una validación) a la academia.
const ESTADOS_CUENTA_ABIERTA = ['PENDIENTE', 'PARCIAL', 'POR_VALIDAR'];

// Cuenta que existe SOLO por una orden de merch: tiene ítems y ningún link de matrícula.
export const whereCuentaSoloMerch = {
  alumno_merch: { some: {} },
  inscripciones_deudas_link: { none: {} },
};

/**
 * Fila de ingreso en caja ligada a un pago (INGRESO_MERCH / INGRESO_MATRICULA). Idempotente
 * por (pago_id, concepto): si ya existe devuelve null y no escribe nada.
 */
const crearFilaIngreso = async (db, { pago, concepto, monto, usuarioAdminId, tipo, fecha }) => {
  const existente = await db.movimientos_financieros.findFirst({
    where: { pago_id: pago.id, concepto },
    select: { id: true },
  });
  if (existente) return null;
  return db.movimientos_financieros.create({
    data: {
      tipo_movimiento: 'INGRESO',
      monto,
      concepto,
      metodo_pago_id: pago.metodo_pago_id ?? null,
      registrado_por: usuarioAdminId ? Number(usuarioAdminId) : null,
      pago_id: pago.id,
      notas: `Pago #${pago.id} · cuenta #${pago.cuenta_id} (${tipo})`,
      ...(fecha && { fecha_movimiento: fecha }),
    },
  });
};

const enTransaccion = (tx, fn) => (tx ? fn(tx) : prisma.$transaction(fn));

/**
 * La mercancía se entrega físicamente en una sede: tiene que existir y estar activa.
 * `sedeId` ausente es válido solo si `obligatoria` es false (venta de taquilla).
 */
const validarSedeRecojo = async (db, sedeId, { obligatoria }) => {
  if (sedeId === undefined || sedeId === null || sedeId === '') {
    if (obligatoria) {
      throw new ApiError('⛔ Debes indicar la sede de recojo (sede_recojo_id).', 400);
    }
    return null;
  }
  const id = Number(sedeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError('⛔ sede_recojo_id inválido.', 400);
  }
  const sede = await db.sedes.findUnique({ where: { id } });
  if (!sede) throw new ApiError('⛔ La sede de recojo indicada no existe.', 404);
  if (sede.activo === false) {
    throw new ApiError(`⛔ La sede "${sede.nombre}" no está activa para recojo.`, 409);
  }
  return id;
};

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

  /**
   * `archivo` es el File de multer (campo `imagen`). Se sube a Cloudinary y se guardan
   * `imagen_url` (secure_url) e `imagen_public_id`. Si el insert falla, el asset recién
   * subido se borra para no dejar basura en la nube. `db`/`nube` son inyectables para tests.
   */
  crear: async (data, archivo = null, { db = prisma, nube = cloudinaryService } = {}) => {
    const { eliminar_imagen: _ignorado, ...campos } = data;
    let subida = null;
    if (archivo) {
      subida = await nube.upload(archivo, CARPETA_CLOUDINARY_MERCH, OPTIMIZACION_IMAGEN_MERCH);
      campos.imagen_url = subida.url;
      campos.imagen_public_id = subida.publicId;
    } else if (campos.imagen_url) {
      campos.imagen_public_id = null; // Base64 / URL externa (camino legacy por JSON)
    }

    try {
      return await db.merch.create({ data: campos });
    } catch (error) {
      if (subida) await nube.destroy(subida.publicId);
      throw error;
    }
  },

  /**
   * Cambio de foto (archivo nuevo, `eliminar_imagen` o `imagen_url` por JSON): tras guardar,
   * el asset anterior de Cloudinary se borra. Si el update falla, se borra el recién subido.
   */
  actualizar: async (id, data, archivo = null, { db = prisma, nube = cloudinaryService } = {}) => {
    const { eliminar_imagen, ...campos } = data;

    const actual = await db.merch.findUnique({
      where: { id: Number(id) },
      select: { id: true, imagen_public_id: true },
    });
    if (!actual) throw new ApiError('El producto de merch no existe.', 404);

    if (Object.keys(campos).length === 0 && !archivo && !eliminar_imagen) {
      throw new ApiError('Debe proporcionar al menos un campo para actualizar', 400);
    }

    let subida = null;
    if (archivo) {
      subida = await nube.upload(archivo, CARPETA_CLOUDINARY_MERCH, OPTIMIZACION_IMAGEN_MERCH);
      campos.imagen_url = subida.url;
      campos.imagen_public_id = subida.publicId;
    } else if (eliminar_imagen) {
      campos.imagen_url = null;
      campos.imagen_public_id = null;
    } else if (campos.imagen_url !== undefined) {
      campos.imagen_public_id = null; // JSON legacy: la foto ya no vive en Cloudinary
    }

    let actualizado;
    try {
      actualizado = await db.merch.update({
        where: { id: Number(id) },
        data: { ...campos, actualizado_en: new Date() },
      });
    } catch (error) {
      if (subida) await nube.destroy(subida.publicId);
      throw error;
    }

    const cambioFoto = campos.imagen_public_id !== undefined;
    if (cambioFoto && actual.imagen_public_id && actual.imagen_public_id !== campos.imagen_public_id) {
      await nube.destroy(actual.imagen_public_id);
    }
    return actualizado;
  },

  /**
   * Borra el producto y su foto de Cloudinary. Con ventas asociadas no se puede borrar
   * (la colección de los alumnos lo referencia): se desactiva con estado INACTIVO.
   */
  eliminar: async (id, { db = prisma, nube = cloudinaryService } = {}) => {
    const producto = await db.merch.findUnique({
      where: { id: Number(id) },
      select: { id: true, nombre: true, imagen_public_id: true },
    });
    if (!producto) throw new ApiError('El producto de merch no existe.', 404);

    const ventas = await db.alumno_merch.count({ where: { merch_id: producto.id } });
    if (ventas > 0) {
      throw new ApiError(
        `"${producto.nombre}" ya tiene ${ventas} unidad(es) vendida(s) y no se puede eliminar. Desactívalo (estado INACTIVO) para sacarlo del catálogo.`,
        409
      );
    }

    await db.merch.delete({ where: { id: producto.id } });
    await nube.destroy(producto.imagen_public_id);
    return { id: producto.id };
  },

  // --------------------------------------------------------------- Colección
  obtenerColeccion: async (alumnoId) => {
    const items = await prisma.alumno_merch.findMany({
      where: { alumno_id: Number(alumnoId) },
      include: {
        merch: { select: { id: true, nombre: true, imagen_url: true } },
        sedes: { select: { id: true, nombre: true } }, // dónde recoge
      },
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
        por_entregar: grupos.por_entregar.length,
        listo_para_recojo: grupos.listo_para_recojo.length,
        entregado: grupos.entregado.length,
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
    const { alumno_id, merch_ids, metodo_pago_id, codigo_operacion, notas, sede_recojo_id } = data;

    return enTransaccion(tx, async (db) => {
      const alumno = await db.alumnos.findUnique({ where: { usuario_id: Number(alumno_id) } });
      if (!alumno) throw new ApiError('El alumno no existe.', 404);

      // En taquilla la sede es opcional (se puede entregar en el acto).
      const sedeId = await validarSedeRecojo(db, sede_recojo_id, { obligatoria: false });
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
          sede_recojo_id: sedeId,
          // Pagado pero aún no en la mano del alumno: la logística lo mueve desde acá.
          estado_item: ESTADO_ITEM.POR_ENTREGAR,
        }),
      });

      // 💹 Nace cobrada y no pasa por validarPago: se deja aquí su INGRESO_MERCH para que el
      // listado de caja la muestre igual que a las órdenes validadas (todo el pago es merch).
      await crearFilaIngreso(db, {
        pago,
        concepto: CONCEPTO_INGRESO.MERCH,
        monto: total,
        usuarioAdminId: adminId,
        tipo: TIPO_TRANSACCION.MERCH,
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
  reservarParaCuenta: async (tx, { alumno_id, cuenta_id, merch_ids, sede_recojo_id, prefijo }) => {
    const sinMerch =
      merch_ids === undefined ||
      merch_ids === null ||
      (Array.isArray(merch_ids) && merch_ids.length === 0);
    if (sinMerch) {
      return { total: 0, lineas: [], detalle: null };
    }

    // Con merch en el pedido la sede es obligatoria: sin ella nadie sabe adónde enviarlo.
    const sedeId = await validarSedeRecojo(tx, sede_recojo_id, { obligatoria: true });
    const { lineas, total } = await validarYDescontarStock(tx, merch_ids);

    await tx.alumno_merch.createMany({
      data: filasAlumnoMerch(lineas, {
        alumno_id: Number(alumno_id),
        cuenta_id: Number(cuenta_id),
        sede_recojo_id: sedeId,
        estado_item: ESTADO_ITEM.RESERVADO,
      }),
    });

    return { total, lineas, detalle: detalleMerch(lineas, prefijo), sede_recojo_id: sedeId };
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
    { alumno_id, cuenta_id, detalle_base, monto_matricula, hubo_beneficios, merch_ids, sede_recojo_id }
  ) => {
    const reserva = await merchService.reservarParaCuenta(tx, {
      alumno_id,
      cuenta_id,
      merch_ids,
      sede_recojo_id,
    });
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

  /**
   * Pago completo aprobado: los ítems reservados pasan a POR_ENTREGAR. Ya están
   * pagados, pero siguen en la academia: la logística debe llevarlos a la sede.
   */
  confirmarMerchDeCuenta: async (tx, cuentaId, pagoId) => {
    const { count } = await tx.alumno_merch.updateMany({
      where: { cuenta_id: Number(cuentaId), estado_item: ESTADO_ITEM.RESERVADO },
      data: {
        estado_item: ESTADO_ITEM.POR_ENTREGAR,
        fecha_adquisicion: new Date(),
        pago_id: Number(pagoId),
      },
    });
    return count;
  },

  /**
   * Decisión única de merch al validar un pago (la llama validarPago):
   *  - APROBADO y deuda en 0  -> RESERVADO pasa a POR_ENTREGAR.
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

  /** Monto de merch vigente (reservado o ya pagado, no devuelto) que lleva una cuenta, en céntimos exactos. */
  sumarMerchDeCuenta: async (tx, cuentaId) => {
    const items = await tx.alumno_merch.findMany({
      where: {
        cuenta_id: Number(cuentaId),
        estado_item: { in: [ESTADO_ITEM.RESERVADO, ...ESTADOS_PAGADOS] },
      },
      select: { monto_pagado: true },
    });
    return aMonto(items.reduce((acc, i) => acc + aCentimos(i.monto_pagado), 0));
  },

  /**
   * Split de ingresos al APROBAR un pago (lo llama validarPago, en su misma transacción).
   * Deja en `movimientos_financieros` una fila INGRESO_MERCH y otra INGRESO_MATRICULA para
   * que caja vea la ganancia de merch por separado:
   *   MERCH -> 1 fila (todo el pago) · MIXTO -> 2 filas · MATRICULA -> ninguna.
   * Las filas llevan `pago_id`; los reportes que derivan ingresos desde `pagos` las excluyen
   * para no contar el mismo dinero dos veces. Idempotente por (pago_id, concepto).
   */
  registrarSplitIngresos: async (tx, { pago, usuarioAdminId, esPagoCompleto }) => {
    const tipo = await merchService.tipoTransaccionDeCuenta(tx, pago.cuenta_id);
    if (tipo === TIPO_TRANSACCION.MATRICULA) return [];

    const cuenta = await tx.cuentas_por_cobrar.findUnique({
      where: { id: Number(pago.cuenta_id) },
      select: { monto_final: true },
    });
    const merchTotal = await merchService.sumarMerchDeCuenta(tx, pago.cuenta_id);

    // Lo que merch ya recibió en los abonos anteriores de esta misma cuenta.
    const pagosCuenta = await tx.pagos.findMany({
      where: { cuenta_id: Number(pago.cuenta_id) },
      select: { id: true },
    });
    const previos = await tx.movimientos_financieros.findMany({
      where: {
        concepto: CONCEPTO_INGRESO.MERCH,
        pago_id: { in: pagosCuenta.map((p) => p.id).filter((id) => id !== pago.id) },
      },
      select: { monto: true },
    });
    const merchYaRegistrado = aMonto(previos.reduce((acc, m) => acc + aCentimos(m.monto), 0));

    // validarPago ya calculó esto (calcularSaldosAlcancía) y lo pasa tal cual. Si no viene,
    // se recalcula con la MISMA regla: saldo restante <= 1 céntimo.
    let completo = esPagoCompleto;
    if (completo === undefined) {
      const saldos = await tx.pagos.aggregate({
        _sum: { monto_pagado: true },
        where: { cuenta_id: Number(pago.cuenta_id), estado_validacion: 'APROBADO' },
      });
      completo = esSaldoCompleto(cuenta?.monto_final ?? 0, saldos._sum.monto_pagado ?? 0);
    }

    return merchService.escribirSplitIngresos(tx, {
      pago,
      tipo,
      montoCuenta: cuenta?.monto_final ?? 0,
      merchTotal,
      merchYaRegistrado,
      esPagoCompleto: completo,
      usuarioAdminId,
    });
  },

  /**
   * Calcula el reparto merch/matrícula de UN pago y escribe sus filas (las que tengan monto).
   * Es el único punto que escribe el split: lo usan validarPago (en vivo) y la regularización
   * histórica, así ambos reparten exactamente igual. `fecha` solo la pasa el histórico para
   * que la fila caiga en el mes en que se cobró el pago. Devuelve solo las filas nuevas.
   */
  escribirSplitIngresos: async (
    db,
    { pago, tipo, montoCuenta, merchTotal, merchYaRegistrado, esPagoCompleto, usuarioAdminId, fecha }
  ) => {
    const { merch, matricula } = calcularSplitIngresos({
      montoPago: pago.monto_pagado,
      montoCuenta,
      merchTotal,
      merchYaRegistrado,
      esPagoCompleto,
    });

    const filas = [
      { concepto: CONCEPTO_INGRESO.MERCH, monto: merch },
      { concepto: CONCEPTO_INGRESO.MATRICULA, monto: matricula },
    ].filter((f) => f.monto > 0);

    const creadas = [];
    for (const { concepto, monto } of filas) {
      const fila = await crearFilaIngreso(db, { pago, concepto, monto, usuarioAdminId, tipo, fecha });
      if (fila) creadas.push(fila);
    }
    return creadas;
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
   * deuda_id = cuenta_id) y el admin la valida: con el pago completo pasan a
   * POR_ENTREGAR y la academia los lleva a `sede_recojo_id`.
   */
  crearOrden: async ({ alumno_id, merch_ids, sede_recojo_id }, tx = null) => {
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

      const sedeId = await validarSedeRecojo(db, sede_recojo_id, { obligatoria: true });
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
          sede_recojo_id: sedeId,
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
        sede_recojo_id: sedeId,
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

  // ------------------------------------------------- Estado de ítem y logística
  /**
   * Único punto por donde se mueve un ítem a mano (logística y correcciones).
   * Valida la transición, deja la huella de quién y cuándo, repone stock en
   * DEVUELTO y, si pasa a LISTO_PARA_RECOJO, avisa al alumno (un solo aviso agrupado).
   * Repetir el mismo estado es un no-op. `notificar: false` lo usan los lotes, que
   * avisan una sola vez al final.
   */
  moverItem: async (itemId, estadoSolicitado, adminId = null, tx = null, { notificar = true } = {}) => {
    const nuevoEstado = normalizarEstadoItem(estadoSolicitado); // POSEE (legacy) = ENTREGADO

    return enTransaccion(tx, async (db) => {
      const item = await db.alumno_merch.findUnique({ where: { id: Number(itemId) } });
      if (!item) throw new ApiError('El ítem de merch no existe.', 404);

      const actual = normalizarEstadoItem(item.estado_item);
      if (actual === nuevoEstado) return { ...item, sin_cambios: true };
      validarTransicionItem(actual, nuevoEstado);

      const ahora = new Date();
      const data = { estado_item: nuevoEstado };
      if (adminId) data.gestionado_por = Number(adminId);
      if (nuevoEstado === ESTADO_ITEM.LISTO_PARA_RECOJO) data.fecha_listo = ahora;
      if (nuevoEstado === ESTADO_ITEM.ENTREGADO && actual !== ESTADO_ITEM.PERDIDO) {
        data.fecha_entrega = ahora;
      }
      // Revertir: vuelve a esperar en el local, como si la entrega no hubiera ocurrido.
      if (nuevoEstado === ESTADO_ITEM.POR_ENTREGAR) {
        data.fecha_entrega = null;
        data.fecha_listo = null;
      }

      const actualizado = await db.alumno_merch.update({ where: { id: item.id }, data });

      if (nuevoEstado === ESTADO_ITEM.DEVUELTO) {
        await db.merch.update({
          where: { id: item.merch_id },
          data: { stock: { increment: 1 }, actualizado_en: ahora },
        });
      }

      if (nuevoEstado === ESTADO_ITEM.LISTO_PARA_RECOJO && notificar) {
        await merchService.avisarPedidosListos(db, item.alumno_id);
      }

      return actualizado;
    });
  },

  /**
   * UN solo aviso con todo lo que el alumno tiene listo en las sedes. Si ya hay un aviso
   * de "listo" sin leer de los últimos 30 minutos (el admin va marcando unidad por
   * unidad), se actualiza ese mismo aviso con la lista completa en vez de crear otro.
   */
  avisarPedidosListos: async (db, alumnoId) => {
    const listos = await db.alumno_merch.findMany({
      where: { alumno_id: Number(alumnoId), estado_item: ESTADO_ITEM.LISTO_PARA_RECOJO },
      include: { merch: { select: { nombre: true } }, sedes: { select: { nombre: true } } },
      orderBy: { id: 'asc' },
    });
    const mensaje = armarAvisoListo(listos);
    if (!mensaje) return null;

    const desde = new Date(Date.now() - VENTANA_AVISO_LISTO_MIN * 60 * 1000);
    const previo = await db.notificaciones.findFirst({
      where: {
        alumno_id: Number(alumnoId),
        titulo: TITULO_AVISO_LISTO,
        leido: false,
        creado_en: { gte: desde },
      },
      orderBy: { creado_en: 'desc' },
    });

    if (previo) {
      return db.notificaciones.update({
        where: { id: previo.id },
        data: { mensaje, creado_en: new Date() },
      });
    }
    return db.notificaciones.create({
      data: {
        alumno_id: Number(alumnoId),
        titulo: TITULO_AVISO_LISTO,
        mensaje,
        tipo: 'SUCCESS',
        categoria: 'VENTAS',
      },
    });
  },

  // Compatibilidad con PATCH /items/:id/estado (PERDIDO / DEVUELTO / corrección).
  cambiarEstadoItem: async (itemId, nuevoEstado, adminId = null, tx = null) =>
    merchService.moverItem(itemId, nuevoEstado, adminId, tx),

  /**
   * Pedido en la sede: avisa al alumno UNA vez, aunque se marquen varias unidades.
   *  - `item_ids`: más unidades para marcar en la misma operación.
   *  - `incluir_orden`: marca también las demás unidades POR_ENTREGAR de la misma orden y sede.
   * Devuelve el ítem principal y cuántas unidades cambiaron de verdad.
   */
  marcarListoParaRecojo: async (itemId, adminId, { item_ids = [], incluir_orden = false } = {}, tx = null) => {
    return enTransaccion(tx, async (db) => {
      const principal = await db.alumno_merch.findUnique({ where: { id: Number(itemId) } });
      if (!principal) throw new ApiError('El ítem de merch no existe.', 404);

      const ids = new Set([Number(itemId), ...item_ids.map(Number)]);
      if (incluir_orden && principal.cuenta_id) {
        const hermanos = await db.alumno_merch.findMany({
          where: {
            cuenta_id: principal.cuenta_id,
            estado_item: ESTADO_ITEM.POR_ENTREGAR,
            sede_recojo_id: principal.sede_recojo_id,
          },
          select: { id: true },
        });
        hermanos.forEach((h) => ids.add(h.id));
      }

      let actualizadas = 0;
      const alumnos = new Set();
      let resultado = null;
      for (const id of ids) {
        const r = await merchService.moverItem(id, ESTADO_ITEM.LISTO_PARA_RECOJO, adminId, db, {
          notificar: false,
        });
        if (id === Number(itemId)) resultado = r;
        if (!r.sin_cambios) {
          actualizadas += 1;
          alumnos.add(r.alumno_id);
        }
      }
      for (const alumnoId of alumnos) {
        await merchService.avisarPedidosListos(db, alumnoId);
      }

      return { ...resultado, items_actualizados: actualizadas };
    });
  },

  /** El recepcionista se lo dio en mano al alumno (desde POR_ENTREGAR o LISTO_PARA_RECOJO). */
  marcarEntregado: async (itemId, adminId, tx = null) =>
    merchService.moverItem(itemId, ESTADO_ITEM.ENTREGADO, adminId, tx),

  /** Error del recepcionista: el ítem ENTREGADO vuelve a POR_ENTREGAR. */
  revertirEntrega: async (itemId, adminId, tx = null) =>
    merchService.moverItem(itemId, ESTADO_ITEM.POR_ENTREGAR, adminId, tx),

  /**
   * Bandeja de recepción: qué hay que entregar y dónde. Por defecto lo pendiente
   * (POR_ENTREGAR y LISTO_PARA_RECOJO). Filtros: `sede_id` y `busqueda` (nombre,
   * apellido o DNI del alumno). No trae imagen_url (es Base64 y haría pesadísima la lista).
   */
  listarLogistica: async ({ estados, sede_id, busqueda } = {}) => {
    const filtroEstados = estados?.length
      ? estados
      : [ESTADO_ITEM.POR_ENTREGAR, ESTADO_ITEM.LISTO_PARA_RECOJO];
    const filtroAlumno = filtroBusquedaAlumno(busqueda);

    return prisma.alumno_merch.findMany({
      where: {
        estado_item: { in: filtroEstados },
        ...(sede_id && { sede_recojo_id: Number(sede_id) }),
        ...(filtroAlumno && { alumnos: filtroAlumno }),
      },
      include: {
        merch: { select: { id: true, nombre: true } },
        sedes: { select: { id: true, nombre: true } },
        alumnos: {
          select: {
            usuarios: {
              select: { nombres: true, apellidos: true, numero_documento: true, telefono_personal: true },
            },
          },
        },
        cuentas_por_cobrar: { select: { id: true, detalle_adicional: true } },
      },
      orderBy: [{ sede_recojo_id: 'asc' }, { fecha_adquisicion: 'asc' }],
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
