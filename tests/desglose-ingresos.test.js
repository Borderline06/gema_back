import test from 'node:test';
import assert from 'node:assert/strict';
import { armarDesgloseIngresos } from '../src/features/movimientos_financieros/desglose-ingresos.logic.js';

const fila = (id, concepto, monto, pago_id, extra = {}) => ({
  id,
  concepto,
  monto,
  pago_id,
  fecha_movimiento: new Date('2026-03-15T15:00:00Z'),
  pagos: {
    id: pago_id,
    tipo_transaccion: extra.tipo ?? 'MIXTO',
    cuentas_por_cobrar: { alumnos: { usuarios: { nombres: 'Ana', apellidos: 'Pérez' } } },
  },
});

test('desglose: merch sale de las filas INGRESO_MERCH y matrícula es lo cobrado menos el merch', () => {
  const r = armarDesgloseIngresos({
    mes: 3,
    anio: 2026,
    // 450 de un pago MIXTO + 400 de una matrícula normal (sin filas) + 83.33 de merch suelto
    totalCobrado: 933.33,
    filas: [
      fila(1, 'INGRESO_MERCH', 50, 10),
      fila(2, 'INGRESO_MATRICULA', 400, 10),
      fila(3, 'INGRESO_MERCH', 83.33, 11, { tipo: 'MERCH' }),
    ],
  });

  assert.equal(r.total_cobrado, 933.33);
  assert.equal(r.ingresos_merch, 133.33);
  assert.equal(r.ingresos_matricula, 800);
  assert.equal(r.ingresos_merch + r.ingresos_matricula, r.total_cobrado);
  assert.deepEqual(r.periodo, { mes: 3, anio: 2026 });
  assert.equal(r.base, 'fecha_pago');
});

test('desglose: lista cada fila automática con alumno, pago de origen y tipo', () => {
  const r = armarDesgloseIngresos({
    mes: 3,
    anio: 2026,
    totalCobrado: 450,
    filas: [fila(1, 'INGRESO_MERCH', 50, 10), fila(2, 'INGRESO_MATRICULA', 400, 10)],
  });

  assert.equal(r.movimientos.length, 2);
  assert.deepEqual(r.movimientos[0], {
    id: 1,
    concepto: 'INGRESO_MERCH',
    monto: 50,
    fecha: new Date('2026-03-15T15:00:00Z'),
    pago_id: 10,
    tipo_transaccion: 'MIXTO',
    alumno: 'Ana Pérez',
  });
});

test('desglose: mes sin cobros ni filas devuelve ceros y lista vacía', () => {
  const r = armarDesgloseIngresos({ mes: 1, anio: 2026, totalCobrado: null, filas: [] });
  assert.equal(r.total_cobrado, 0);
  assert.equal(r.ingresos_merch, 0);
  assert.equal(r.ingresos_matricula, 0);
  assert.deepEqual(r.movimientos, []);
});

test('desglose: si el merch registrado supera lo cobrado, matrícula no queda negativa', () => {
  const r = armarDesgloseIngresos({ mes: 3, anio: 2026, totalCobrado: 40, filas: [fila(1, 'INGRESO_MERCH', 50, 10)] });
  assert.equal(r.ingresos_matricula, 0);
});

test('desglose: tolera una fila sin pago ni alumno asociado', () => {
  const r = armarDesgloseIngresos({
    mes: 3,
    anio: 2026,
    totalCobrado: 50,
    filas: [{ id: 9, concepto: 'INGRESO_MERCH', monto: 50, pago_id: 7, fecha_movimiento: new Date(), pagos: null }],
  });
  assert.equal(r.movimientos[0].alumno, 'N/A');
  assert.equal(r.movimientos[0].tipo_transaccion, null);
});

test('desglose: sin errores de punto flotante (0.1 + 0.2)', () => {
  const r = armarDesgloseIngresos({
    mes: 3,
    anio: 2026,
    totalCobrado: 0.3,
    filas: [fila(1, 'INGRESO_MERCH', 0.1, 1), fila(2, 'INGRESO_MERCH', 0.2, 2)],
  });
  assert.equal(r.ingresos_merch, 0.3);
  assert.equal(r.ingresos_matricula, 0);
});
