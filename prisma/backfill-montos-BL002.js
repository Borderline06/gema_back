/**
 * BL-002 - BACKFILL de inscripciones_deudas_link.monto_asignado
 *
 * DRY-RUN por defecto (solo imprime). Solo escribe con --aplicar.
 *
 * Re-equilibra, con sincronizarPuenteDeuda y UNA transaccion por cuenta, las
 * cuentas donde |monto_final - SUM(monto_asignado)| > 0.01, o que tienen algun
 * monto_asignado <= 0 mientras monto_final > 0.
 * Cuentas SIN links: solo se reportan (no se puede inferir el puente de forma segura).
 *
 * Uso:
 *   node prisma/backfill-montos-BL002.js            # dry-run
 *   node prisma/backfill-montos-BL002.js --aplicar  # escribe
 */
import { PrismaClient } from '@prisma/client';
import { repartirMonto } from '../src/shared/utils/dinero.util.js';
import { sincronizarPuenteDeuda } from '../src/shared/utils/deuda-puente.util.js';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const TOLERANCIA = 0.01;
const money = (v) => Number(v ?? 0).toFixed(2);

async function main() {
  console.log(`BL-002 backfill de montos - modo: ${APLICAR ? 'APLICAR (escribe)' : 'DRY-RUN (no escribe)'}`);

  const cuentas = await prisma.cuentas_por_cobrar.findMany({
    select: {
      id: true,
      monto_final: true,
      inscripciones_deudas_link: { select: { id: true, monto_asignado: true }, orderBy: { id: 'asc' } },
    },
    orderBy: { id: 'asc' },
  });

  const huerfanas = [];
  const pendientes = [];

  for (const c of cuentas) {
    const links = c.inscripciones_deudas_link;
    if (links.length === 0) {
      huerfanas.push(c.id);
      continue;
    }
    const montoFinal = Number(c.monto_final ?? 0);
    const suma = links.reduce((a, l) => a + Math.round(Number(l.monto_asignado) * 100), 0) / 100;
    const diff = Math.round((montoFinal - suma) * 100) / 100;
    const invalido = montoFinal > 0 && links.some((l) => !(Number(l.monto_asignado) > 0));
    if (Math.abs(diff) > TOLERANCIA || invalido) {
      pendientes.push({ id: c.id, montoFinal, suma, diff, invalido, nuevo: repartirMonto(montoFinal, links.length) });
    }
  }

  console.log(`\nCuentas a corregir: ${pendientes.length}`);
  for (const p of pendientes) {
    console.log(
      `  cuenta ${p.id}: monto_final=${money(p.montoFinal)} suma_actual=${money(p.suma)} dif=${money(p.diff)}` +
        `${p.invalido ? ' [monto<=0]' : ''} -> [${p.nuevo.map(money).join(', ')}]`
    );
  }
  console.log(`\nCuentas sin links (solo reporte, no se tocan): ${huerfanas.length}${huerfanas.length ? ' ids: ' + huerfanas.slice(0, 50).join(', ') : ''}`);

  if (!APLICAR) {
    console.log('\nDRY-RUN: nada se escribio. Usa --aplicar para ejecutar.');
    return;
  }

  let ok = 0;
  let fallos = 0;
  for (const p of pendientes) {
    try {
      await prisma.$transaction((tx) => sincronizarPuenteDeuda(tx, p.id, p.montoFinal));
      ok++;
    } catch (e) {
      fallos++;
      console.error(`  cuenta ${p.id} fallo: ${e.message}`);
    }
  }
  console.log(`\nAplicado: ${ok} cuentas corregidas, ${fallos} fallos.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
