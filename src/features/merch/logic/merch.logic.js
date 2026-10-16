import { ApiError } from '../../../shared/utils/error.util.js';
import { aCentimos, aMonto, redondear2 } from '../../../shared/utils/dinero.util.js';

export const ESTADO_MERCH = { ACTIVO: 'ACTIVO', INACTIVO: 'INACTIVO' };

export const ESTADO_ITEM = {
  RESERVADO: 'RESERVADO',
  POSEE: 'POSEE',
  PERDIDO: 'PERDIDO',
  DEVUELTO: 'DEVUELTO',
};

export const TIPO_TRANSACCION = { MATRICULA: 'MATRICULA', MERCH: 'MERCH', MIXTO: 'MIXTO' };

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

/** Agrupa la colección por estado para `GET /merch/alumno/:id`. */
export function agruparColeccion(items) {
  const grupos = { posee: [], perdido: [], devuelto: [], reservado: [] };
  for (const item of items) {
    const clave = String(item.estado_item).toLowerCase();
    if (grupos[clave]) grupos[clave].push(item);
  }
  return grupos;
}
