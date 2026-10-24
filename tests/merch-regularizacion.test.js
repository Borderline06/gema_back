import test from 'node:test';
import assert from 'node:assert/strict';
import { merchService } from '../src/features/merch/merch.service.js';
import { regularizarIngresosMixtosHistoricos } from '../src/features/merch/merch.regularizacion.js';
import { esSaldoCompleto } from '../src/features/merch/logic/merch.logic.js';
import { sumarMontos } from '../src/shared/utils/dinero.util.js';

/**
 * BD en memoria con la superficie de Prisma que usan registrarSplitIngresos (en vivo) y la
 * regularización histórica. `$transaction` revierte todo si el callback lanza.
 */
const crearDb = ({ cuentas = [], pagos = [], items = [], links = [], movimientos = [], falla = [] } = {}) => {
  const estado = {
    cuentas: cuentas.map((c) => ({ ...c })),
    pagos: pagos.map((p) => ({ ...p })),
    items: items.map((i) => ({ ...i })),
    links: links.map((l) => ({ ...l })),
    movimientos: movimientos.map((m) => ({ ...m })),
  };
  let seq = 900;
  const db = {
    estado,
    $transaction: async (fn) => {
      const copia = structuredClone(estado);
      try {
        return await fn(db);
      } catch (error) {
        Object.assign(estado, copia); // rollback
        throw error;
      }
    },
    cuentas_por_cobrar: {
      findUnique: async ({ where }) => {
        if (falla.includes(where.id)) throw new Error(`BD caída en cuenta ${where.id}`);
        return estado.cuentas.find((c) => c.id === where.id) ?? null;
      },
    },
    alumno_merch: {
      count: async ({ where }) => estado.items.filter((i) => i.cuenta_id === where.cuenta_id).length,
      findMany: async ({ where }) =>
        estado.items.filter(
          (i) => i.cuenta_id === where.cuenta_id && (!where.estado_item || where.estado_item.in.includes(i.estado_item))
        ),
    },
    inscripciones_deudas_link: {
      count: async ({ where }) => estado.links.filter((l) => l.cuenta_id === where.cuenta_id).length,
    },
    pagos: {
      findMany: async ({ where }) =>
        estado.pagos.filter(
          (p) =>
            (where.cuenta_id === undefined || p.cuenta_id === where.cuenta_id) &&
            (where.estado_validacion === undefined || p.estado_validacion === where.estado_validacion) &&
            (where.tipo_transaccion === undefined || p.tipo_transaccion === where.tipo_transaccion)
        ),
      aggregate: async ({ where }) => ({
        _sum: {
          monto_pagado: sumarMontos(
            estado.pagos
              .filter((p) => p.cuenta_id === where.cuenta_id && p.estado_validacion === where.estado_validacion)
              .map((p) => p.monto_pagado)
          ),
        },
      }),
    },
    movimientos_financieros: {
      findMany: async ({ where }) =>
        estado.movimientos.filter(
          (m) => where.pago_id.in.includes(m.pago_id) && (!where.concepto || m.concepto === where.concepto)
        ),
      findFirst: async ({ where }) =>
        estado.movimientos.find((m) => m.pago_id === where.pago_id && m.concepto === where.concepto) ?? null,
      create: async ({ data }) => {
        const m = { id: ++seq, ...data };
        estado.movimientos.push(m);
        return m;
      },
    },
  };
  return db;
};

const pago = (id, monto, fecha, extra = {}) => ({
  id,
  cuenta_id: 1,
  metodo_pago_id: 2,
  monto_pagado: monto,
  estado_validacion: 'APROBADO',
  tipo_transaccion: 'MIXTO',
  revisado_por: 3,
  fecha_pago: new Date(fecha),
  ...extra,
});

// Cuenta MIXTO: matrícula 400 + 2 unidades de merch a S/ 25 = 450.
const escenario = (pagos, extra = {}) =>
  crearDb({
    cuentas: [{ id: 1, monto_final: 450 }],
    items: [
      { cuenta_id: 1, estado_item: 'POR_ENTREGAR', monto_pagado: 25 },
      { cuenta_id: 1, estado_item: 'POR_ENTREGAR', monto_pagado: 25 },
    ],
    links: [{ cuenta_id: 1 }],
    pagos,
    ...extra,
  });

const suma = (db, concepto) =>
  sumarMontos(db.estado.movimientos.filter((m) => m.concepto === concepto).map((m) => m.monto));

test('pago MIXTO único histórico: separa merch y matrícula, con la fecha y el admin del pago', async () => {
  const db = escenario([pago(10, 450, '2026-03-15T15:00:00Z')]);
  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  assert.equal(r.filas_creadas, 2);
  assert.equal(r.monto_merch, 50);
  assert.equal(r.monto_matricula, 400);
  assert.deepEqual(r.descuadres, []);
  assert.deepEqual(r.errores, []);
  for (const fila of db.estado.movimientos) {
    assert.equal(fila.pago_id, 10);
    assert.equal(fila.tipo_movimiento, 'INGRESO');
    assert.equal(fila.registrado_por, 3);
    assert.equal(fila.metodo_pago_id, 2);
    assert.equal(fila.fecha_movimiento.toISOString(), '2026-03-15T15:00:00.000Z'); // mes del cobro, no de hoy
  }
});

test('abonos parciales: proporcionales y el que completa la deuda cierra el merch al céntimo', async () => {
  // Desordenados a propósito: se procesan por fecha_pago, no por id.
  const db = escenario([
    pago(12, 200, '2026-03-20T12:00:00Z'),
    pago(10, 100, '2026-03-01T12:00:00Z'),
    pago(11, 150, '2026-03-10T12:00:00Z'),
  ]);
  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  const porPago = Object.fromEntries(r.detalle[0].pagos.map((p) => [p.pago_id, p]));
  assert.deepEqual([porPago[10].merch, porPago[11].merch, porPago[12].merch], [11.11, 16.67, 22.22]);
  assert.equal(porPago[10].esPagoCompleto, false);
  assert.equal(porPago[12].esPagoCompleto, true);
  assert.equal(suma(db, 'INGRESO_MERCH'), 50);
  assert.equal(suma(db, 'INGRESO_MATRICULA'), 400);
  assert.deepEqual(r.descuadres, []);
});

test('dry-run: informa lo que haría pero no escribe nada', async () => {
  const db = escenario([pago(10, 450, '2026-03-15T15:00:00Z')]);
  const r = await regularizarIngresosMixtosHistoricos({ db });

  assert.equal(r.aplicado, false);
  assert.equal(r.filas_creadas, 2);
  assert.equal(r.monto_merch, 50);
  assert.equal(db.estado.movimientos.length, 0);
});

test('es idempotente: una segunda corrida no crea ni cambia nada', async () => {
  const db = escenario([pago(10, 100, '2026-03-01T12:00:00Z'), pago(11, 350, '2026-03-10T12:00:00Z')]);
  await regularizarIngresosMixtosHistoricos({ db, aplicar: true });
  const antes = structuredClone(db.estado.movimientos);

  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });
  assert.equal(r.filas_creadas, 0);
  assert.equal(r.cuentas_regularizadas, 0);
  assert.deepEqual(db.estado.movimientos, antes);
});

test('respeta lo ya escrito en vivo: solo completa los pagos que no tienen fila', async () => {
  const db = escenario([pago(10, 100, '2026-03-01T12:00:00Z'), pago(11, 350, '2026-03-10T12:00:00Z')]);
  // El primer pago ya fue regularizado antes; el segundo no.
  db.estado.movimientos.push(
    { id: 1, pago_id: 10, concepto: 'INGRESO_MERCH', monto: 11.11 },
    { id: 2, pago_id: 10, concepto: 'INGRESO_MATRICULA', monto: 88.89 }
  );

  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });
  assert.deepEqual(r.detalle[0].pagos.map((p) => p.pago_id), [11]);
  assert.equal(suma(db, 'INGRESO_MERCH'), 50); // 11.11 + remanente 38.89
  assert.equal(suma(db, 'INGRESO_MATRICULA'), 400);
});

test('solo reparte pagos MIXTO aprobados: ignora rechazados, pendientes y otros tipos', async () => {
  const db = escenario([
    pago(10, 450, '2026-03-01T12:00:00Z'),
    pago(11, 450, '2026-03-02T12:00:00Z', { estado_validacion: 'RECHAZADO' }),
    pago(12, 450, '2026-03-03T12:00:00Z', { estado_validacion: 'PENDIENTE' }),
    pago(13, 50, '2026-03-04T12:00:00Z', { tipo_transaccion: 'MATRICULA' }),
  ]);
  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  assert.deepEqual([...new Set(db.estado.movimientos.map((m) => m.pago_id))], [10]);
  assert.equal(r.pagos_regularizados, 1);
});

test('cuenta sin unidades de merch: se omite y se reporta para revisión manual', async () => {
  const db = escenario([pago(10, 450, '2026-03-15T15:00:00Z')], { items: [] });
  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  assert.equal(r.filas_creadas, 0);
  assert.equal(r.omitidas.length, 1);
  assert.equal(r.omitidas[0].cuenta_id, 1);
  assert.equal(db.estado.movimientos.length, 0);
});

test('las unidades devueltas después siguen contando: formaban parte de lo cobrado', async () => {
  const db = escenario([pago(10, 450, '2026-03-15T15:00:00Z')]);
  db.estado.items[0].estado_item = 'DEVUELTO';
  await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  assert.equal(suma(db, 'INGRESO_MERCH'), 50);
  assert.equal(suma(db, 'INGRESO_MATRICULA'), 400);
});

test('descuadre: si otro pago no MIXTO completó la deuda, queda marcado para revisión', async () => {
  const db = escenario([
    pago(10, 400, '2026-03-01T12:00:00Z'),
    pago(11, 50, '2026-03-02T12:00:00Z', { tipo_transaccion: 'MATRICULA' }),
  ]);
  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  assert.equal(r.descuadres.length, 1);
  assert.equal(r.descuadres[0].cuenta_id, 1);
  assert.equal(r.descuadres[0].merchTotal, 50);
  assert.equal(r.descuadres[0].merchRegistrado, 44.44);
});

test('un error en una cuenta la revierte y no frena a las demás', async () => {
  const db = crearDb({
    cuentas: [{ id: 1, monto_final: 450 }, { id: 2, monto_final: 450 }],
    items: [
      { cuenta_id: 1, estado_item: 'POR_ENTREGAR', monto_pagado: 50 },
      { cuenta_id: 2, estado_item: 'POR_ENTREGAR', monto_pagado: 50 },
    ],
    pagos: [pago(10, 450, '2026-03-01T12:00:00Z'), pago(20, 450, '2026-03-02T12:00:00Z', { cuenta_id: 2 })],
    falla: [1],
  });
  const r = await regularizarIngresosMixtosHistoricos({ db, aplicar: true });

  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].cuenta_id, 1);
  assert.deepEqual([...new Set(db.estado.movimientos.map((m) => m.pago_id))], [20]);
});

// ------------------------------------------------ mismo reparto que validarPago (en vivo)
test('equivalencia: el histórico escribe exactamente lo que validarPago habría escrito', async () => {
  const cobros = [
    { id: 10, monto: 100, fecha: '2026-03-01T12:00:00Z' },
    { id: 11, monto: 150, fecha: '2026-03-10T12:00:00Z' },
    { id: 12, monto: 200, fecha: '2026-03-20T12:00:00Z' },
  ];

  // EN VIVO: cada pago pasa de PENDIENTE a APROBADO y se llama registrarSplitIngresos
  // con el esPagoCompleto que validarPago calcula (calcularSaldosAlcancía).
  const vivo = escenario(cobros.map((c) => pago(c.id, c.monto, c.fecha, { estado_validacion: 'PENDIENTE' })));
  for (const c of cobros) {
    const p = vivo.estado.pagos.find((x) => x.id === c.id);
    p.estado_validacion = 'APROBADO';
    const total = sumarMontos(vivo.estado.pagos.filter((x) => x.estado_validacion === 'APROBADO').map((x) => x.monto_pagado));
    await merchService.registrarSplitIngresos(vivo, {
      pago: p,
      usuarioAdminId: 3,
      esPagoCompleto: esSaldoCompleto(450, total),
    });
  }

  // HISTÓRICO: los mismos pagos ya aprobados, sin filas.
  const historico = escenario(cobros.map((c) => pago(c.id, c.monto, c.fecha)));
  await regularizarIngresosMixtosHistoricos({ db: historico, aplicar: true });

  const forma = (db) =>
    db.estado.movimientos
      .map((m) => [m.pago_id, m.concepto, m.monto])
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  assert.deepEqual(forma(historico), forma(vivo));
});

test('esSaldoCompleto: misma tolerancia de 1 céntimo que calcularSaldosAlcancía', () => {
  assert.equal(esSaldoCompleto(450, 450), true);
  assert.equal(esSaldoCompleto(450, 449.99), true);
  assert.equal(esSaldoCompleto(450, 449.98), false);
  assert.equal(esSaldoCompleto(450, 500), true); // sobrepago
});
