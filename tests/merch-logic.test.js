import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agruparColeccion,
  agruparMerchIds,
  construirLineas,
  detalleMerch,
  filasAlumnoMerch,
} from '../src/features/merch/logic/merch.logic.js';

const catalogo = [
  { id: 1, nombre: 'Camiseta', precio: '50.00', stock: 10, estado: 'ACTIVO' },
  { id: 2, nombre: 'Gorra', precio: '33.33', stock: 5, estado: 'ACTIVO' },
  { id: 3, nombre: 'Termo', precio: '20.00', stock: 4, estado: 'INACTIVO' },
  { id: 4, nombre: 'Medalla', precio: '10.00', stock: 1, estado: 'ACTIVO' },
];

test('agruparMerchIds: ids repetidos son unidades y conserva el orden', () => {
  assert.deepEqual(agruparMerchIds([2, 1, 2, '2']), [
    { merch_id: 2, cantidad: 3 },
    { merch_id: 1, cantidad: 1 },
  ]);
});

test('agruparMerchIds: undefined/null = sin merch; basura = 400', () => {
  assert.deepEqual(agruparMerchIds(undefined), []);
  assert.deepEqual(agruparMerchIds(null), []);
  assert.throws(() => agruparMerchIds('5'), { statusCode: 400 });
  assert.throws(() => agruparMerchIds([1, 'x']), { statusCode: 400 });
  assert.throws(() => agruparMerchIds([0]), { statusCode: 400 });
});

test('construirLineas: total en céntimos exactos (33.33 x3 = 99.99)', () => {
  const { lineas, total } = construirLineas(agruparMerchIds([2, 2, 2, 1]), catalogo);
  assert.equal(total, 149.99);
  assert.equal(lineas[0].subtotal, 99.99);
  assert.equal(lineas[0].precio_unitario, 33.33);
});

test('construirLineas: producto inexistente = 404, inactivo = 409, sin stock = 409', () => {
  assert.throws(() => construirLineas([{ merch_id: 99, cantidad: 1 }], catalogo), {
    statusCode: 404,
  });
  assert.throws(() => construirLineas([{ merch_id: 3, cantidad: 1 }], catalogo), {
    statusCode: 409,
  });
  assert.throws(() => construirLineas([{ merch_id: 4, cantidad: 2 }], catalogo), {
    statusCode: 409,
  });
});

test('filasAlumnoMerch: una fila por unidad con el precio congelado', () => {
  const { lineas } = construirLineas(agruparMerchIds([2, 2, 1]), catalogo);
  const filas = filasAlumnoMerch(lineas, { alumno_id: 7, estado_item: 'RESERVADO' });
  assert.equal(filas.length, 3);
  assert.deepEqual(
    filas.map((f) => f.monto_pagado),
    [33.33, 33.33, 50]
  );
  assert.ok(filas.every((f) => f.alumno_id === 7 && f.estado_item === 'RESERVADO'));
});

test('detalleMerch y agruparColeccion', () => {
  const { lineas } = construirLineas(agruparMerchIds([2, 2, 1]), catalogo);
  assert.equal(detalleMerch(lineas), 'Merch: Gorra x2, Camiseta x1');

  const grupos = agruparColeccion([
    { estado_item: 'POSEE' },
    { estado_item: 'PERDIDO' },
    { estado_item: 'POSEE' },
    { estado_item: 'RESERVADO' },
  ]);
  assert.equal(grupos.posee.length, 2);
  assert.equal(grupos.perdido.length, 1);
  assert.equal(grupos.devuelto.length, 0);
  assert.equal(grupos.reservado.length, 1);
});
