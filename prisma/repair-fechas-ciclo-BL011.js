/**
 * =================================================================
 * 🔧 BL-011 — REPARACIÓN DE FECHAS DE CICLO (inscripciones_deudas_link)
 * =================================================================
 *
 * Arregla los datos que quedaron torcidos por los escritores que ya se
 * corrigieron en código:
 *
 *   A) fecha_inicio_ciclo NULL  → links previos al backfill. Se rellenan desde
 *      inscripciones.fecha_inscripcion_original (que nunca se pisa, al
 *      contrario de fecha_inscripcion, que se sobreescribe en cada renovación)
 *      y se marcan con es_estimado = true.
 *
 *   B) Cierres corridos un día → finalizarVoluntaria / separarFinalizarVoluntaria
 *      escribían `fecha_fin_ciclo: new Date()` sobre una columna @db.Date.
 *      Postgres trunca al día UTC, así que una finalización hecha entre las
 *      19:00 y 23:59 de Lima cerraba el ciclo UN DÍA TARDE.
 *
 *   C) Informe, sin tocar nada → links cuyo span difiere de 30 días.
 *
 * ⚠️ El caso B es una HEURÍSTICA, no una certeza: la columna es DATE, el
 * instante exacto de escritura ya se perdió. Se reconstruye comparando contra
 * inscripciones.actualizado_en, que se escribe en la MISMA transacción que el
 * cierre. Si algo volvió a tocar la inscripción después, actualizado_en ya no
 * sirve como testigo. Por eso el dry-run imprime cada fila candidata para que
 * un humano la apruebe antes de aplicar.
 *
 * Uso:
 *   node prisma/repair-fechas-ciclo-BL011.js            # dry-run (no escribe)
 *   node prisma/repair-fechas-ciclo-BL011.js --apply    # aplica los cambios
 *   npm run db:repair:ciclos
 *
 * Es idempotente: correrlo dos veces con --apply no vuelve a cambiar nada.
 */

import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

import {
  DIAS_CICLO,
  TZ_LIMA,
  aFechaUTC,
  diaLimaAFechaUTC,
  diasEntreUTC,
  sumarDiasUTC,
} from '../src/shared/utils/ciclo.util.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--apply');

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'NULL');
const mismoDia = (a, b) => {
  const ua = aFechaUTC(a);
  const ub = aFechaUTC(b);
  if (!ua || !ub) return false;
  return ua.getTime() === ub.getTime();
};

/**
 * Clasifica los links en los tres grupos del informe. Función pura y exportada
 * para poder testearla con datos sintéticos sin tocar la base.
 *
 * @param {Array} links links con `inscripciones` incluida
 * @returns {{sinInicio: Array, corridos: Array, spansRaros: Array}}
 */
export function clasificarLinks(links) {
  // --- A) fecha_inicio_ciclo NULL ---
  const sinInicio = [];
  for (const link of links) {
    if (link.fecha_inicio_ciclo) continue;
    const insc = link.inscripciones;
    const origen = insc?.fecha_inscripcion_original || insc?.fecha_inscripcion;
    sinInicio.push({ link, propuesta: origen ? diaLimaAFechaUTC(origen) : null });
  }

  // --- B) Cierres corridos un día (heurística) ---
  // Se excluye a propósito lo que escribieron los otros dos cierres, que son
  // correctos por construcción:
  //   - cron VERDUGO: fin === inicio + 30d
  //   - renovación:   la inscripción NO quedó en FINALIZADO
  const corridos = [];
  for (const link of links) {
    if (!link.fecha_fin_ciclo || !link.fecha_inicio_ciclo) continue;

    const insc = link.inscripciones;
    if (!insc || insc.estado !== 'FINALIZADO' || !insc.actualizado_en) continue;

    const cierreCron = sumarDiasUTC(aFechaUTC(link.fecha_inicio_ciclo), DIAS_CICLO);
    if (mismoDia(link.fecha_fin_ciclo, cierreCron)) continue; // lo cerró el cron, está bien

    const diaTestigo = diaLimaAFechaUTC(insc.actualizado_en);
    if (mismoDia(link.fecha_fin_ciclo, diaTestigo)) continue; // ya coincide, nada que hacer

    corridos.push({ link, propuesta: diaTestigo });
  }

  // --- C) Informe: spans distintos de 30 días (NO se tocan) ---
  const spansRaros = links
    .filter((l) => l.fecha_inicio_ciclo && l.fecha_fin_ciclo)
    .map((l) => ({ link: l, span: diasEntreUTC(l.fecha_inicio_ciclo, l.fecha_fin_ciclo) }))
    .filter(({ span }) => span !== DIAS_CICLO);

  return { sinInicio, corridos, spansRaros };
}

async function main() {
  console.log('='.repeat(78));
  console.log(`🔧 BL-011 — Reparación de fechas de ciclo  [${APLICAR ? 'APLICAR' : 'DRY-RUN'}]`);
  console.log('='.repeat(78));

  const links = await prisma.inscripciones_deudas_link.findMany({
    include: {
      inscripciones: {
        select: {
          id: true,
          estado: true,
          actualizado_en: true,
          fecha_inscripcion: true,
          fecha_inscripcion_original: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`\nLinks totales en BD: ${links.length}\n`);

  const { sinInicio, corridos, spansRaros } = clasificarLinks(links);

  // -----------------------------------------------------------------
  // A) fecha_inicio_ciclo NULL
  // -----------------------------------------------------------------
  console.log('-'.repeat(78));
  console.log(`A) fecha_inicio_ciclo NULL: ${sinInicio.length} link(s)`);
  console.log('-'.repeat(78));
  for (const { link, propuesta } of sinInicio) {
    if (!propuesta) {
      console.log(`  link ${link.id} (insc ${link.inscripcion_id}) → ⛔ sin fecha de origen, NO se puede inferir`);
      continue;
    }
    console.log(`  link ${link.id} (insc ${link.inscripcion_id}) → ${iso(propuesta)}  [es_estimado = true]`);
  }

  // -----------------------------------------------------------------
  // B) Cierres corridos un día (heurística)
  // -----------------------------------------------------------------
  console.log('\n' + '-'.repeat(78));
  console.log(`B) Cierres corridos (heurística, revisar a mano): ${corridos.length} link(s)`);
  console.log('-'.repeat(78));
  for (const { link, propuesta } of corridos) {
    const delta = diasEntreUTC(propuesta, link.fecha_fin_ciclo);
    console.log(
      `  link ${link.id} (insc ${link.inscripcion_id}) ` +
      `fin actual ${iso(link.fecha_fin_ciclo)} → propuesto ${iso(propuesta)} ` +
      `(${delta > 0 ? '+' : ''}${delta}d) | actualizado_en ${dayjs(link.inscripciones.actualizado_en).tz(TZ_LIMA).format('YYYY-MM-DD HH:mm')} Lima`
    );
  }

  // -----------------------------------------------------------------
  // C) Informe: spans distintos de 30 días (NO se tocan)
  // -----------------------------------------------------------------
  console.log('\n' + '-'.repeat(78));
  console.log(`C) Ciclos con span != ${DIAS_CICLO}d: ${spansRaros.length} link(s) — SOLO INFORME, no se modifican`);
  console.log('-'.repeat(78));
  console.log('   (normal en renovaciones tempranas/tardías y finalizaciones anticipadas)');
  for (const { link, span } of spansRaros.slice(0, 40)) {
    console.log(
      `  link ${link.id} (insc ${link.inscripcion_id}) ` +
      `${iso(link.fecha_inicio_ciclo)} → ${iso(link.fecha_fin_ciclo)} = ${span}d ` +
      `| insc ${link.inscripciones?.estado}`
    );
  }
  if (spansRaros.length > 40) console.log(`  ... y ${spansRaros.length - 40} más`);

  // -----------------------------------------------------------------
  // Aplicación
  // -----------------------------------------------------------------
  const porAplicar = sinInicio.filter((x) => x.propuesta).length + corridos.length;

  console.log('\n' + '='.repeat(78));
  if (!APLICAR) {
    console.log(`DRY-RUN: no se escribió nada. Cambios pendientes: ${porAplicar}`);
    console.log('Para aplicar: node prisma/repair-fechas-ciclo-BL011.js --apply');
    console.log('='.repeat(78));
    return;
  }

  if (porAplicar === 0) {
    console.log('Nada que aplicar. ✅');
    console.log('='.repeat(78));
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const { link, propuesta } of sinInicio) {
      if (!propuesta) continue;
      await tx.inscripciones_deudas_link.update({
        where: { id: link.id },
        data: { fecha_inicio_ciclo: propuesta, es_estimado: true },
      });
    }
    for (const { link, propuesta } of corridos) {
      await tx.inscripciones_deudas_link.update({
        where: { id: link.id },
        data: { fecha_fin_ciclo: propuesta },
      });
    }
  });

  console.log(`✅ Aplicados ${porAplicar} cambio(s).`);
  console.log('Volvé a correr sin --apply: debe reportar 0 pendientes.');
  console.log('='.repeat(78));
}

// Solo corre si se ejecuta directamente, para que clasificarLinks se pueda
// importar y testear sin abrir conexión ni escribir nada.
const esEntrada = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (esEntrada) {
  main()
    .catch((e) => {
      console.error('\n❌ Falló la reparación:', e.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
