import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esDiaPermitido,
  calcularFechasRegeneracion,
  diaSemanaDeClave,
  nombreDia,
} from '../src/features/inscripciones/ajuste-fecha.service.js';

const LMV = [1, 3, 5];

test('2026-10-12 es lunes (1)', () => {
  assert.equal(diaSemanaDeClave('2026-10-12'), 1);
  assert.equal(diaSemanaDeClave('2026-10-18'), 7);
  assert.equal(nombreDia(7), 'Domingo');
});

test('paquete Lun-Mie-Vie: martes se rechaza, miercoles se acepta', () => {
  assert.equal(esDiaPermitido('2026-10-13', LMV), false);
  assert.equal(esDiaPermitido('2026-10-14', LMV), true);
});

test('regenera la misma cantidad de clases en orden', () => {
  const f = calcularFechasRegeneracion({ fechaInicio: '2026-10-14', diasPermitidos: LMV, cantidad: 5 });
  assert.deepEqual(f, ['2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23']);
});

test('salta feriados sin perder cantidad', () => {
  const f = calcularFechasRegeneracion({
    fechaInicio: '2026-10-14',
    diasPermitidos: LMV,
    cantidad: 4,
    feriados: new Set(['2026-10-16']),
  });
  assert.equal(f.length, 4);
  assert.ok(!f.includes('2026-10-16'));
  assert.deepEqual(f, ['2026-10-14', '2026-10-19', '2026-10-21', '2026-10-23']);
});

test('INDIVIDUAL: una sola clase en la nueva fecha', () => {
  const f = calcularFechasRegeneracion({ fechaInicio: '2026-10-15', diasPermitidos: [4], cantidad: 1 });
  assert.deepEqual(f, ['2026-10-15']);
});

test('cantidad 0 no genera', () => {
  assert.deepEqual(calcularFechasRegeneracion({ fechaInicio: '2026-10-14', diasPermitidos: LMV, cantidad: 0 }), []);
});
