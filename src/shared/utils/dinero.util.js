import { ApiError } from './error.util.js';

/**
 * 💰 BL-002: única fuente de verdad para la aritmética de dinero.
 *
 * Todas las columnas de dinero del schema son `Decimal(10, 2)`, pero el código
 * las lee con `Number()` / `parseFloat()` y opera en float64. El problema no es
 * la imprecisión del float (a 2 decimales es irrelevante), sino el REPARTO:
 * `400 / 3 = 133.3333…` se persiste redondeado a `133.33` en los tres slots, y
 * la suma del puente queda en `399.99` contra un `monto_final` de `400.00`.
 *
 * La solución es repartir en céntimos enteros y asignar el residuo, en vez de
 * dividir y dejar que Postgres redondee cada parte por su cuenta.
 */

/** Céntimos enteros de un monto. Mismo criterio de redondeo que Decimal(10,2). */
export function aCentimos(valor) {
  const num = Number(valor);
  if (!Number.isFinite(num)) {
    throw new ApiError(`Monto inválido: ${valor}`, 400);
  }
  return Math.round(num * 100);
}

/** Monto de 2 decimales a partir de céntimos enteros. */
export function aMonto(centimos) {
  return centimos / 100;
}

/** Redondea un monto a 2 decimales, igual que lo haría la columna en BD. */
export function redondear2(valor) {
  return aMonto(aCentimos(valor));
}

/**
 * Reparte `total` en `n` partes de 2 decimales cuya suma es EXACTAMENTE
 * `redondear2(total)`. El residuo de céntimos se asigna a las primeras partes,
 * así el reparto es determinista y reproducible.
 *
 *   repartirMonto(400, 3)  -> [133.34, 133.33, 133.33]   suma 400.00
 *   repartirMonto(280, 2)  -> [140, 140]
 *   repartirMonto(37.5, 1) -> [37.5]
 *
 * @param {number|string|import('@prisma/client').Prisma.Decimal} total
 * @param {number} n Cantidad de partes (> 0, entero).
 * @returns {number[]} Array de `n` montos.
 */
export function repartirMonto(total, n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(
      `No se puede repartir un monto entre ${n} partes: se esperaba un entero mayor a 0.`,
      400
    );
  }

  const totalCentimos = aCentimos(total);
  if (totalCentimos < 0) {
    throw new ApiError(`No se puede repartir un monto negativo: ${total}`, 400);
  }

  const base = Math.floor(totalCentimos / n);
  const residuo = totalCentimos - base * n; // 0 .. n-1

  return Array.from({ length: n }, (_, i) => aMonto(base + (i < residuo ? 1 : 0)));
}

/** Suma una lista de montos sin arrastrar error de float. */
export function sumarMontos(montos) {
  return aMonto(montos.reduce((acc, m) => acc + aCentimos(m), 0));
}
