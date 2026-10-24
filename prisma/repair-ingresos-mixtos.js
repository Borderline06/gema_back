/**
 * =================================================================
 * 🔧 REGULARIZACIÓN DE CAJA — pagos MIXTO anteriores al split de ingresos
 * =================================================================
 *
 * Los pagos MIXTO (matrícula + merch) aprobados antes de que validarPago escribiera
 * INGRESO_MERCH / INGRESO_MATRICULA no dejaron filas en movimientos_financieros. Este script
 * las crea con la MISMA función de reparto que usa validarPago (ver
 * src/features/merch/merch.regularizacion.js), pago por pago y en orden cronológico.
 *
 * Solo INSERTA filas (con pago_id, que el balance excluye): no modifica pagos, cuentas ni
 * movimientos existentes. Los pagos que ya tienen su fila se saltan, así que es idempotente.
 *
 * Uso:
 *   node --env-file=.env prisma/repair-ingresos-mixtos.js            # dry-run (no escribe)
 *   node --env-file=.env prisma/repair-ingresos-mixtos.js --apply    # aplica los cambios
 *   npm run db:repair:ingresos-mixtos [-- --apply]
 *
 * El dry-run ejecuta el flujo completo dentro de una transacción por cuenta y la revierte, por
 * lo que el informe es exactamente lo que se escribiría. Revisa "descuadres" y "omitidas" antes
 * de aplicar: son cuentas que necesitan revisión manual.
 */

import { pathToFileURL } from 'node:url';
import { prisma } from '../src/config/database.config.js';
import { regularizarIngresosMixtosHistoricos } from '../src/features/merch/merch.regularizacion.js';

const soles = (n) => `S/ ${Number(n).toFixed(2)}`;

const imprimir = (r) => {
  console.log(`\n${r.aplicado ? '✅ APLICADO' : '🔎 DRY-RUN (no se escribió nada)'}`);
  console.log(`Cuentas con pagos MIXTO aprobados evaluadas: ${r.cuentas_evaluadas}`);
  console.log(`Cuentas a regularizar: ${r.cuentas_regularizadas} · pagos: ${r.pagos_regularizados} · filas: ${r.filas_creadas}`);
  console.log(`  INGRESO_MERCH:     ${soles(r.monto_merch)}`);
  console.log(`  INGRESO_MATRICULA: ${soles(r.monto_matricula)}`);

  for (const c of r.detalle) {
    console.log(`\n  Cuenta #${c.cuenta_id}`);
    for (const p of c.pagos) {
      console.log(`    pago #${p.pago_id}: ${soles(p.monto)} -> merch ${soles(p.merch)} + matrícula ${soles(p.matricula)}${p.esPagoCompleto ? ' (completa la deuda)' : ' (abono parcial)'}`);
    }
  }
  if (r.omitidas.length) {
    console.log('\n⚠️  Omitidas (revisar a mano):');
    r.omitidas.forEach((o) => console.log(`  cuenta #${o.cuenta_id}: ${o.motivo}`));
  }
  if (r.descuadres.length) {
    console.log('\n⚠️  Descuadres (las filas no suman lo esperado, revisar a mano):');
    r.descuadres.forEach((d) => console.log(`  cuenta #${d.cuenta_id}: merch ${soles(d.merchRegistrado)} de ${soles(d.merchTotal)} · filas ${soles(d.totalFilas)} de ${soles(d.totalMixto)}`));
  }
  if (r.errores.length) {
    console.log('\n❌ Errores (esas cuentas no se modificaron):');
    r.errores.forEach((e) => console.log(`  cuenta #${e.cuenta_id}: ${e.error}`));
  }
  if (!r.aplicado && r.filas_creadas > 0) console.log('\nPara aplicar: npm run db:repair:ingresos-mixtos -- --apply');
};

const main = async () => {
  const aplicar = process.argv.includes('--apply');
  try {
    const resultado = await regularizarIngresosMixtosHistoricos({ aplicar });
    imprimir(resultado);
    if (resultado.errores.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

// Solo corre al invocarse directamente (importarlo desde un test no toca la base).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
