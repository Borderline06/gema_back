import { prisma } from '../../config/database.config.js';
import { aCentimos, aMonto } from '../../shared/utils/dinero.util.js';
import { CONCEPTO_INGRESO, TIPO_TRANSACCION, esSaldoCompleto } from './logic/merch.logic.js';
import { merchService } from './merch.service.js';

/**
 * Regulariza la caja de los pagos MIXTO (matrícula + merch) aprobados ANTES de que
 * validarPago escribiera el split INGRESO_MERCH / INGRESO_MATRICULA.
 *
 * Reproduce lo que habría hecho validarPago pago por pago, en el orden en que se cobraron:
 *   - `esPagoCompleto` con la misma regla (saldo restante <= 1 céntimo, acumulando los
 *     abonos aprobados hasta ese pago incluido), igual que calcularSaldosAlcancía.
 *   - el reparto sale de `merchService.escribirSplitIngresos`, la misma función que usa
 *     validarPago: abonos parciales proporcionales y el pago que completa la deuda lleva el
 *     remanente exacto de merch.
 *   - cada fila lleva `pago_id`, así el balance la excluye y no cuenta el dinero dos veces.
 *
 * El total de merch de la cuenta son TODAS sus unidades (cualquier estado, incluso DEVUELTO):
 * cuando se cobró el pago, esas unidades formaban parte de lo pagado. Es idempotente: un pago
 * que ya tiene su fila no se vuelve a tocar.
 *
 * Cada cuenta va en su propia transacción. Sin `aplicar` (dry-run) se ejecuta TODO el flujo real
 * y al final se revierte, así el informe es exactamente lo que se escribiría.
 */

// Se lanza al final de cada transacción del dry-run para revertirla. Se reconoce por nombre
// (no por identidad) por si el cliente de BD relanza una copia del error.
class RollbackDryRun extends Error {
  constructor() {
    super('Rollback intencional del dry-run');
    this.name = 'RollbackDryRun';
  }
}
const esRollbackDryRun = (error) => error?.name === 'RollbackDryRun';

const sumar = (montos) => aMonto(montos.reduce((acc, m) => acc + aCentimos(m), 0));

const porFechaEId = (a, b) =>
  new Date(a.fecha_pago ?? 0).getTime() - new Date(b.fecha_pago ?? 0).getTime() || a.id - b.id;

/** Procesa una cuenta con la transacción `tx`. Devuelve su informe (sin lanzar por casos raros). */
const regularizarCuenta = async (tx, cuentaId) => {
  const informe = { cuenta_id: cuentaId, pagos: [], filas: 0, merch: 0, matricula: 0 };

  const cuenta = await tx.cuentas_por_cobrar.findUnique({
    where: { id: cuentaId },
    select: { id: true, monto_final: true },
  });
  const unidades = await tx.alumno_merch.findMany({
    where: { cuenta_id: cuentaId },
    select: { monto_pagado: true },
  });
  const merchTotal = sumar(unidades.map((u) => u.monto_pagado));

  if (!cuenta || merchTotal <= 0) {
    return { ...informe, omitida: 'Sin unidades de merch registradas: no se puede repartir el pago.' };
  }

  const aprobados = (
    await tx.pagos.findMany({ where: { cuenta_id: cuentaId, estado_validacion: 'APROBADO' } })
  ).sort(porFechaEId);

  const existentes = await tx.movimientos_financieros.findMany({
    where: { pago_id: { in: aprobados.map((p) => p.id) } },
    select: { pago_id: true, concepto: true, monto: true },
  });
  const filasPorPago = (pagoId) => existentes.filter((f) => f.pago_id === pagoId);

  let acumulado = 0;
  const idsAnteriores = [];
  for (const pago of aprobados) {
    acumulado = aMonto(aCentimos(acumulado) + aCentimos(pago.monto_pagado));
    const esPagoCompleto = esSaldoCompleto(cuenta.monto_final, acumulado);

    const esMixto = pago.tipo_transaccion === TIPO_TRANSACCION.MIXTO;
    if (esMixto && filasPorPago(pago.id).length === 0 && Number(pago.monto_pagado) > 0) {
      const merchYaRegistrado = sumar(
        existentes
          .filter((f) => f.concepto === CONCEPTO_INGRESO.MERCH && idsAnteriores.includes(f.pago_id))
          .map((f) => f.monto)
      );

      const creadas = await merchService.escribirSplitIngresos(tx, {
        pago,
        tipo: TIPO_TRANSACCION.MIXTO,
        montoCuenta: cuenta.monto_final,
        merchTotal,
        merchYaRegistrado,
        esPagoCompleto,
        usuarioAdminId: pago.revisado_por,
        fecha: pago.fecha_pago ?? undefined, // cae en el mes en que se cobró
      });

      existentes.push(...creadas);
      const merch = sumar(creadas.filter((f) => f.concepto === CONCEPTO_INGRESO.MERCH).map((f) => f.monto));
      const matricula = sumar(creadas.filter((f) => f.concepto === CONCEPTO_INGRESO.MATRICULA).map((f) => f.monto));
      informe.pagos.push({ pago_id: pago.id, monto: Number(pago.monto_pagado), merch, matricula, esPagoCompleto });
      informe.filas += creadas.length;
      informe.merch = sumar([informe.merch, merch]);
      informe.matricula = sumar([informe.matricula, matricula]);
    }
    idsAnteriores.push(pago.id);
  }

  // Control de cuadre: con la deuda saldada, las filas de la cuenta deben sumar exactamente el
  // merch total y el total cobrado de los pagos MIXTO. Si no, queda marcado para revisión manual.
  if (informe.filas > 0 && esSaldoCompleto(cuenta.monto_final, acumulado)) {
    const filasCuenta = existentes.filter((f) => aprobados.some((p) => p.id === f.pago_id));
    const merchRegistrado = sumar(filasCuenta.filter((f) => f.concepto === CONCEPTO_INGRESO.MERCH).map((f) => f.monto));
    const totalMixto = sumar(aprobados.filter((p) => p.tipo_transaccion === TIPO_TRANSACCION.MIXTO).map((p) => p.monto_pagado));
    const totalFilas = sumar(filasCuenta.map((f) => f.monto));
    if (merchRegistrado !== merchTotal || totalFilas !== totalMixto) {
      informe.descuadre = { merchTotal, merchRegistrado, totalMixto, totalFilas };
    }
  }

  return informe;
};

/**
 * @param {{ db?: object, aplicar?: boolean }} opciones `aplicar: false` = dry-run (no escribe).
 */
export const regularizarIngresosMixtosHistoricos = async ({ db = prisma, aplicar = false } = {}) => {
  const candidatos = await db.pagos.findMany({
    where: { estado_validacion: 'APROBADO', tipo_transaccion: TIPO_TRANSACCION.MIXTO },
    select: { cuenta_id: true },
  });
  const cuentaIds = [...new Set(candidatos.map((p) => p.cuenta_id))].sort((a, b) => a - b);

  const resumen = {
    aplicado: aplicar,
    cuentas_evaluadas: cuentaIds.length,
    cuentas_regularizadas: 0,
    pagos_regularizados: 0,
    filas_creadas: 0,
    monto_merch: 0,
    monto_matricula: 0,
    omitidas: [],
    descuadres: [],
    detalle: [],
    errores: [],
  };

  for (const cuentaId of cuentaIds) {
    let informe;
    try {
      await db.$transaction(async (tx) => {
        informe = await regularizarCuenta(tx, cuentaId);
        if (!aplicar) throw new RollbackDryRun();
      });
    } catch (error) {
      if (!esRollbackDryRun(error)) {
        resumen.errores.push({ cuenta_id: cuentaId, error: error?.message ?? String(error) });
        continue;
      }
    }

    if (informe.omitida) resumen.omitidas.push({ cuenta_id: cuentaId, motivo: informe.omitida });
    if (informe.descuadre) resumen.descuadres.push({ cuenta_id: cuentaId, ...informe.descuadre });
    if (informe.filas === 0) continue;

    resumen.cuentas_regularizadas += 1;
    resumen.pagos_regularizados += informe.pagos.length;
    resumen.filas_creadas += informe.filas;
    resumen.monto_merch = sumar([resumen.monto_merch, informe.merch]);
    resumen.monto_matricula = sumar([resumen.monto_matricula, informe.matricula]);
    resumen.detalle.push(informe);
  }

  return resumen;
};
