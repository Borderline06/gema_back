import { ApiError } from '../../../shared/utils/error.util.js';
import { aCentimos, aMonto, redondear2 } from '../../../shared/utils/dinero.util.js';

export const ESTADO_MERCH = { ACTIVO: 'ACTIVO', INACTIVO: 'INACTIVO' };

/**
 * Ciclo de un ítem:
 *   RESERVADO (sin pagar) -> POR_ENTREGAR (pagado) -> LISTO_PARA_RECOJO (en la sede) -> ENTREGADO
 * Aparte: PERDIDO y DEVUELTO. POSEE es legacy (equivale a ENTREGADO): se lee, ya no se escribe.
 */
export const ESTADO_ITEM = {
  RESERVADO: 'RESERVADO',
  POR_ENTREGAR: 'POR_ENTREGAR',
  LISTO_PARA_RECOJO: 'LISTO_PARA_RECOJO',
  ENTREGADO: 'ENTREGADO',
  POSEE: 'POSEE',
  PERDIDO: 'PERDIDO',
  DEVUELTO: 'DEVUELTO',
};

/** Estados con el dinero ya cobrado y la mercancía no devuelta: cuentan como ingreso de merch. */
export const ESTADOS_PAGADOS = [
  ESTADO_ITEM.POR_ENTREGAR,
  ESTADO_ITEM.LISTO_PARA_RECOJO,
  ESTADO_ITEM.ENTREGADO,
  ESTADO_ITEM.POSEE,
  ESTADO_ITEM.PERDIDO,
];

/**
 * Movimientos permitidos a mano. RESERVADO -> POR_ENTREGAR solo lo hace la validación del pago.
 * POR_ENTREGAR -> ENTREGADO directo cubre al alumno que ya está en el mostrador; ENTREGADO ->
 * POR_ENTREGAR es el "revertir" del recepcionista que se equivocó.
 */
const TRANSICIONES = {
  [ESTADO_ITEM.RESERVADO]: [],
  [ESTADO_ITEM.POR_ENTREGAR]: [
    ESTADO_ITEM.LISTO_PARA_RECOJO,
    ESTADO_ITEM.ENTREGADO,
    ESTADO_ITEM.DEVUELTO,
  ],
  [ESTADO_ITEM.LISTO_PARA_RECOJO]: [ESTADO_ITEM.ENTREGADO, ESTADO_ITEM.DEVUELTO],
  [ESTADO_ITEM.ENTREGADO]: [ESTADO_ITEM.POR_ENTREGAR, ESTADO_ITEM.PERDIDO, ESTADO_ITEM.DEVUELTO],
  [ESTADO_ITEM.POSEE]: [ESTADO_ITEM.POR_ENTREGAR, ESTADO_ITEM.PERDIDO, ESTADO_ITEM.DEVUELTO],
  [ESTADO_ITEM.PERDIDO]: [ESTADO_ITEM.ENTREGADO],
  [ESTADO_ITEM.DEVUELTO]: [],
};

const MOTIVO_BLOQUEO = {
  [ESTADO_ITEM.RESERVADO]: 'la orden aún no está pagada',
  [ESTADO_ITEM.DEVUELTO]: 'el ítem ya fue devuelto',
};

/** POSEE era el nombre viejo de ENTREGADO. */
export const normalizarEstadoItem = (estado) =>
  estado === ESTADO_ITEM.POSEE ? ESTADO_ITEM.ENTREGADO : estado;

/** Lanza 409 si el ítem no puede pasar de `actual` a `nuevo`. */
export function validarTransicionItem(actual, nuevo) {
  const permitidos = TRANSICIONES[actual] ?? [];
  if (permitidos.includes(nuevo)) return;

  const motivo = MOTIVO_BLOQUEO[actual];
  throw new ApiError(
    motivo
      ? `⛔ No se puede pasar de ${actual} a ${nuevo}: ${motivo}.`
      : `⛔ No se puede pasar de ${actual} a ${nuevo}. Desde ${actual} solo se permite: ${permitidos.join(', ') || 'ninguno'}.`,
    409
  );
}

export const TIPO_TRANSACCION = { MATRICULA: 'MATRICULA', MERCH: 'MERCH', MIXTO: 'MIXTO' };

/** Conceptos de las filas de `movimientos_financieros` que genera la aprobación de un pago. */
export const CONCEPTO_INGRESO = { MERCH: 'INGRESO_MERCH', MATRICULA: 'INGRESO_MATRICULA' };

/**
 * Misma regla que `calcularSaldosAlcancía` (pagos.logic.js): la deuda queda saldada cuando el
 * saldo restante es <= 1 céntimo. `totalPagado` incluye el pago que se está procesando.
 */
export const esSaldoCompleto = (montoCuenta, totalPagado) =>
  Math.max(0, Number(montoCuenta) - Number(totalPagado)) <= 0.01;

/**
 * Reparte un pago aprobado entre la parte de merch y la de matrícula.
 *
 * La parte de merch es proporcional al peso del merch en la cuenta. Un abono parcial
 * lleva su proporción; el pago que COMPLETA la deuda lleva el remanente exacto
 * (`merchTotal - merchYaRegistrado`), así la suma de todos los pagos de la cuenta
 * cierra en `merchTotal` sin arrastrar céntimos de redondeo. Todo en céntimos enteros.
 *
 * @returns {{ merch: number, matricula: number }} montos de 2 decimales; merch + matricula = montoPago.
 */
export function calcularSplitIngresos({
  montoPago,
  montoCuenta,
  merchTotal,
  merchYaRegistrado = 0,
  esPagoCompleto = false,
}) {
  const pago = aCentimos(montoPago);
  const cuenta = aCentimos(montoCuenta);
  const totalMerch = aCentimos(merchTotal);
  const yaRegistrado = aCentimos(merchYaRegistrado);

  if (pago <= 0 || totalMerch <= 0 || cuenta <= 0) {
    return { merch: 0, matricula: aMonto(Math.max(pago, 0)) };
  }

  const remanente = Math.max(totalMerch - yaRegistrado, 0);
  const proporcional = Math.round((pago * Math.min(totalMerch, cuenta)) / cuenta);
  const merchCentimos = Math.min(esPagoCompleto ? remanente : proporcional, remanente, pago);

  return { merch: aMonto(merchCentimos), matricula: aMonto(pago - merchCentimos) };
}

/**
 * Normaliza `merch_ids` (ids repetidos = unidades) a [{ merch_id, cantidad }].
 * Conserva el orden de primera aparición para que el detalle sea reproducible.
 */
export function agruparMerchIds(merchIds) {
  if (merchIds === undefined || merchIds === null) return [];
  if (!Array.isArray(merchIds)) {
    throw new ApiError('merch_ids debe ser un arreglo de ids de producto.', 400);
  }

  const cantidades = new Map();
  for (const crudo of merchIds) {
    const id = Number(crudo);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError(`Id de merch inválido: ${crudo}`, 400);
    }
    cantidades.set(id, (cantidades.get(id) || 0) + 1);
  }

  return [...cantidades].map(([merch_id, cantidad]) => ({ merch_id, cantidad }));
}

/**
 * Cruza lo pedido con el catálogo y valida existencia, estado y stock.
 * `catalogo` son filas de `merch` (cualquier subconjunto que incluya los pedidos).
 * Devuelve líneas con el precio ya congelado y el total en 2 decimales.
 */
export function construirLineas(pedido, catalogo) {
  const porId = new Map(catalogo.map((m) => [m.id, m]));

  const lineas = pedido.map(({ merch_id, cantidad }) => {
    const producto = porId.get(merch_id);
    if (!producto) {
      throw new ApiError(`El producto de merch ${merch_id} no existe.`, 404);
    }
    if (producto.estado !== ESTADO_MERCH.ACTIVO) {
      throw new ApiError(`⛔ "${producto.nombre}" no está disponible.`, 409);
    }
    if (producto.stock < cantidad) {
      throw new ApiError(
        `⛔ Stock insuficiente de "${producto.nombre}": quedan ${producto.stock}, se pidieron ${cantidad}.`,
        409
      );
    }

    const precio = redondear2(producto.precio);
    return {
      merch_id,
      nombre: producto.nombre,
      cantidad,
      precio_unitario: precio,
      subtotal: aMonto(aCentimos(precio) * cantidad),
    };
  });

  return { lineas, total: aMonto(lineas.reduce((acc, l) => acc + aCentimos(l.subtotal), 0)) };
}

/**
 * Texto para `detalle_adicional` de la cuenta, p. ej. "Merch: Polo x2, Gorra x1".
 * El admin lo lee en su panel para saber qué entregar; la orden del alumno usa el
 * prefijo 'Orden Merch' ("Orden Merch: Camiseta Oficial GEMA x1, Gorra x2").
 */
export function detalleMerch(lineas, prefijo = 'Merch') {
  return `${prefijo}: ${lineas.map((l) => `${l.nombre} x${l.cantidad}`).join(', ')}`;
}

const SEGMENTO_MERCH = /^(Orden )?Merch:/;

/** Quita del detalle los segmentos de merch, para que sus nombres no se confundan con otros conceptos. */
export function quitarDetalleMerch(detalle) {
  return String(detalle ?? '')
    .split(' | ')
    .filter((segmento) => !SEGMENTO_MERCH.test(segmento.trim()))
    .join(' | ');
}

/** Una fila `alumno_merch` por unidad, con el precio congelado. */
export function filasAlumnoMerch(lineas, base) {
  return lineas.flatMap((l) =>
    Array.from({ length: l.cantidad }, () => ({
      ...base,
      merch_id: l.merch_id,
      monto_pagado: l.precio_unitario,
    }))
  );
}

/**
 * Agrupa la colección por estado para `GET /merch/alumno/:id`.
 * `posee` se conserva por compatibilidad con el frontend y ahora significa "ya lo
 * tiene en la mano": los ENTREGADO (y los POSEE legacy) aparecen en `entregado` y en `posee`.
 */
export function agruparColeccion(items) {
  const grupos = {
    posee: [],
    perdido: [],
    devuelto: [],
    reservado: [],
    por_entregar: [],
    listo_para_recojo: [],
    entregado: [],
  };
  for (const item of items) {
    const estado = String(item.estado_item);
    if (estado === ESTADO_ITEM.ENTREGADO || estado === ESTADO_ITEM.POSEE) {
      grupos.entregado.push(item);
      grupos.posee.push(item);
      continue;
    }
    const clave = estado.toLowerCase();
    if (grupos[clave]) grupos[clave].push(item);
  }
  return grupos;
}

/**
 * Filtro Prisma para buscar por nombre, apellido o documento del alumno. Cada palabra
 * debe aparecer en alguno de los tres campos ("juan perez" encuentra a Juan Pérez);
 * así sirve igual un DNI completo, un pedazo de DNI o un nombre con apellido.
 */
export function filtroBusquedaAlumno(busqueda) {
  const palabras = String(busqueda ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (palabras.length === 0) return undefined;

  return {
    usuarios: {
      AND: palabras.map((p) => ({
        OR: [
          { nombres: { contains: p, mode: 'insensitive' } },
          { apellidos: { contains: p, mode: 'insensitive' } },
          { numero_documento: { contains: p } },
        ],
      })),
    },
  };
}

export const TITULO_AVISO_LISTO = '📦 Tu pedido está listo para recoger';

/**
 * Un solo aviso para todo lo que el alumno tiene esperándolo en las sedes, agrupado por
 * sede y producto: "Gorra x2 y Camiseta x1 en Miraflores". `items` traen merch.nombre y
 * sedes.nombre. Devuelve null si no hay nada que avisar.
 */
export function armarAvisoListo(items) {
  if (!items?.length) return null;

  const porSede = new Map();
  for (const item of items) {
    const sede = item.sedes?.nombre ?? null;
    const productos = porSede.get(sede) ?? new Map();
    const nombre = item.merch?.nombre ?? 'Producto';
    productos.set(nombre, (productos.get(nombre) || 0) + 1);
    porSede.set(sede, productos);
  }

  const partes = [...porSede].map(([sede, productos]) => {
    const lista = [...productos].map(([nombre, n]) => (n > 1 ? `${nombre} x${n}` : nombre));
    const texto =
      lista.length > 1 ? `${lista.slice(0, -1).join(', ')} y ${lista.at(-1)}` : lista[0];
    return sede ? `${texto} en la sede ${sede}` : `${texto} en recepción`;
  });

  const total = items.length;
  return `Ya puedes recoger ${total > 1 ? 'tus pedidos' : 'tu pedido'}: ${partes.join('; ')}.`;
}
