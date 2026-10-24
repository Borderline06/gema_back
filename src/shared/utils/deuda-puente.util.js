import { repartirMonto } from './dinero.util.js';

/**
 * 🌉 BL-002: sincroniza la "alcancía" (`inscripciones_deudas_link`) con la deuda
 * real de la cuenta.
 *
 * INVARIANTE que esta función garantiza:
 *   SUM(inscripciones_deudas_link.monto_asignado) == cuentas_por_cobrar.monto_final
 *
 * Antes de BL-002 el reparto se hacía con `monto / n` en cada sitio de escritura
 * (8 sitios, 3 fórmulas distintas) y nadie re-equilibraba el puente cuando el
 * `monto_final` cambiaba después (descuentos, cambio de plan). De ahí el reporte
 * de que `monto_asignado` "a veces se calcula mal".
 *
 * ⚠️ Usa `update` por `link.id` y NO `updateMany`: las partes pueden diferir en
 * 1 céntimo entre sí, así que no hay un único valor que aplicar a todas.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {number} cuentaId
 * @param {number|string} montoTotal El `monto_final` vigente de la cuenta.
 * @returns {Promise<number>} Cuántos links se sincronizaron (0 = la cuenta no
 *   tiene links todavía, no es un error).
 */
export async function sincronizarPuenteDeuda(tx, cuentaId, montoTotal) {
  const links = await tx.inscripciones_deudas_link.findMany({
    where: { cuenta_id: Number(cuentaId) },
    // Orden estable -> el céntimo de residuo cae siempre en el mismo slot.
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  if (links.length === 0) return 0;

  const partes = repartirMonto(montoTotal, links.length);

  for (let i = 0; i < links.length; i++) {
    await tx.inscripciones_deudas_link.update({
      where: { id: links[i].id },
      data: { monto_asignado: partes[i] },
    });
  }

  return links.length;
}
