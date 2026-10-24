/**
 * =================================================================
 * 💰 BL-002 — DIAGNÓSTICO DE MONTOS (inscripciones_deudas_link)
 * =================================================================
 *
 * SOLO LECTURA. No escribe nada, nunca.
 *
 * Mide el daño histórico que dejaron los escritores que ya se corrigieron en
 * código, comprobando la invariante:
 *
 *   SUM(inscripciones_deudas_link.monto_asignado) == cuentas_por_cobrar.monto_final
 *
 * Reporta tres cosas:
 *
 *   A) DESCUADRES — cuentas donde la suma del puente no coincide con la deuda.
 *      Las causas conocidas: el reparto `total / n` perdía el céntimo del
 *      residuo (400/3 -> 399.99), y en inscribirPaquete el puente se escribía
 *      ANTES de aplicar los beneficios y nadie lo re-equilibraba (ahí el
 *      descuadre es del tamaño del descuento, no de un céntimo).
 *
 *   B) CUENTAS HUÉRFANAS — cuentas por cobrar sin ningún link. Las generaba
 *      generarRenovacionesMasivas, que creaba la deuda y no el puente.
 *
 *   C) MONTOS INVÁLIDOS — monto_asignado en 0 o negativo.
 *
 * El fix en código solo corrige lo que se escriba DE AHORA EN ADELANTE; las
 * filas ya guardadas siguen torcidas. Este script sirve para decidir si hace
 * falta un backfill y con qué criterio.
 *
 * Uso:
 *   node prisma/diagnostico-montos-BL002.js
 *   node prisma/diagnostico-montos-BL002.js --todos   # lista todas las filas
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const LISTAR_TODO = process.argv.includes('--todos');
const LIMITE_MUESTRA = LISTAR_TODO ? Number.MAX_SAFE_INTEGER : 25;
const TOLERANCIA = 0.01; // la misma que usa el código de pagos

const money = (v) => Number(v ?? 0).toFixed(2);
const linea = (n) => '-'.repeat(n);

async function main() {
  console.log('💰 BL-002 — Diagnóstico de montos del puente inscripción ↔ deuda');
  console.log('='.repeat(72));

  const cuentas = await prisma.cuentas_por_cobrar.findMany({
    select: {
      id: true,
      alumno_id: true,
      monto_final: true,
      estado: true,
      detalle_adicional: true,
      creado_en: true,
      inscripciones_deudas_link: {
        select: { id: true, monto_asignado: true, inscripcion_id: true },
        orderBy: { id: 'asc' },
      },
      descuentos_aplicados: { select: { monto_dinero_descontado: true } },
    },
    orderBy: { id: 'asc' },
  });

  const descuadres = [];
  const huerfanas = [];
  const invalidos = [];

  for (const c of cuentas) {
    const links = c.inscripciones_deudas_link;
    const montoFinal = Number(c.monto_final ?? 0);

    if (links.length === 0) {
      huerfanas.push(c);
      continue;
    }

    // Suma en céntimos para no arrastrar error de float en el propio informe.
    const sumaCentimos = links.reduce(
      (acc, l) => acc + Math.round(Number(l.monto_asignado) * 100),
      0
    );
    const suma = sumaCentimos / 100;
    const diferencia = Math.round((montoFinal - suma) * 100) / 100;

    if (Math.abs(diferencia) > TOLERANCIA) {
      const descontado = c.descuentos_aplicados.reduce(
        (acc, d) => acc + Number(d.monto_dinero_descontado ?? 0),
        0
      );
      descuadres.push({
        cuenta: c,
        montoFinal,
        suma,
        diferencia,
        descontado,
        slots: links.length,
      });
    }

    for (const l of links) {
      const m = Number(l.monto_asignado);
      if (!Number.isFinite(m) || m <= 0) invalidos.push({ cuenta: c, link: l });
    }
  }

  // -------------------------------------------------------------- A) descuadres
  console.log(`\nA) DESCUADRES  (|monto_final - SUM(monto_asignado)| > ${TOLERANCIA})`);
  console.log(linea(72));
  if (descuadres.length === 0) {
    console.log('   ✅ Ninguno. La invariante se cumple en todas las cuentas con links.');
  } else {
    // Un descuadre de 1-2 céntimos es el bug del reparto; uno grande es el del
    // orden de los descuentos. Separarlos ayuda a decidir el backfill.
    const porCentimos = descuadres.filter((d) => Math.abs(d.diferencia) <= 0.05);
    const porDescuento = descuadres.filter((d) => Math.abs(d.diferencia) > 0.05);

    console.log(`   ⚠️  ${descuadres.length} cuentas descuadradas de ${cuentas.length}`);
    console.log(`       · ${porCentimos.length} por céntimos del reparto (<= S/ 0.05)`);
    console.log(`       · ${porDescuento.length} por descuento no propagado al puente (> S/ 0.05)`);

    const total = descuadres.reduce((acc, d) => acc + Math.abs(d.diferencia), 0);
    console.log(`       · Desvío acumulado: S/ ${money(total)}`);

    console.log('\n   cuenta | alumno | monto_final | suma_puente |     dif | slots | descontado | estado');
    for (const d of descuadres.slice(0, LIMITE_MUESTRA)) {
      console.log(
        `   ${String(d.cuenta.id).padStart(6)} |` +
          ` ${String(d.cuenta.alumno_id).padStart(6)} |` +
          ` ${money(d.montoFinal).padStart(11)} |` +
          ` ${money(d.suma).padStart(11)} |` +
          ` ${money(d.diferencia).padStart(7)} |` +
          ` ${String(d.slots).padStart(5)} |` +
          ` ${money(d.descontado).padStart(10)} |` +
          ` ${d.cuenta.estado}`
      );
    }
    if (descuadres.length > LIMITE_MUESTRA) {
      console.log(`   … y ${descuadres.length - LIMITE_MUESTRA} más (usa --todos)`);
    }
  }

  // --------------------------------------------------------------- B) huérfanas
  console.log('\nB) CUENTAS SIN NINGÚN LINK');
  console.log(linea(72));
  if (huerfanas.length === 0) {
    console.log('   ✅ Ninguna.');
  } else {
    console.log(`   ⚠️  ${huerfanas.length} cuentas sin puente.`);
    console.log('       Si el detalle dice "Renovación Automática" son las que dejaba');
    console.log('       generarRenovacionesMasivas antes del fix de BL-002.');
    console.log('\n   cuenta | alumno | monto_final | estado       | detalle');
    for (const c of huerfanas.slice(0, LIMITE_MUESTRA)) {
      console.log(
        `   ${String(c.id).padStart(6)} |` +
          ` ${String(c.alumno_id).padStart(6)} |` +
          ` ${money(c.monto_final).padStart(11)} |` +
          ` ${String(c.estado).padEnd(12)} |` +
          ` ${(c.detalle_adicional ?? '').slice(0, 60)}`
      );
    }
    if (huerfanas.length > LIMITE_MUESTRA) {
      console.log(`   … y ${huerfanas.length - LIMITE_MUESTRA} más (usa --todos)`);
    }
  }

  // --------------------------------------------------------------- C) inválidos
  console.log('\nC) MONTOS INVÁLIDOS EN EL PUENTE (<= 0 o no numéricos)');
  console.log(linea(72));
  if (invalidos.length === 0) {
    console.log('   ✅ Ninguno.');
  } else {
    console.log(`   ⚠️  ${invalidos.length} links con monto inválido.`);
    for (const { cuenta, link } of invalidos.slice(0, LIMITE_MUESTRA)) {
      console.log(
        `   link ${String(link.id).padStart(6)} | cuenta ${String(cuenta.id).padStart(6)} |` +
          ` inscripcion ${String(link.inscripcion_id).padStart(6)} |` +
          ` monto_asignado = ${link.monto_asignado}`
      );
    }
  }

  // ----------------------------------------------------------------- resumen
  console.log('\n' + '='.repeat(72));
  console.log('RESUMEN');
  console.log(`   Cuentas revisadas .......... ${cuentas.length}`);
  console.log(`   Descuadradas ............... ${descuadres.length}`);
  console.log(`   Sin links .................. ${huerfanas.length}`);
  console.log(`   Links con monto inválido ... ${invalidos.length}`);
  console.log('\n   Este script NO escribió nada en la base de datos.');
}

main()
  .catch((e) => {
    console.error('❌ Falló el diagnóstico:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
