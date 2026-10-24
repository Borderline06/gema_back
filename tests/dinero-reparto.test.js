import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aCentimos,
  aMonto,
  redondear2,
  repartirMonto,
  sumarMontos,
} from '../src/shared/utils/dinero.util.js';

// Precios sembrados en prisma/seed-demo.js
const PLAN_1_DIA = 150;
const PLAN_2_DIAS = 280;
const PLAN_3_DIAS = 400;
const PLAN_4_DIAS = 500;
const CLASE_UNICA = 37.5;

// ------------------------------------------------------------------- aCentimos

test('aCentimos redondea a céntimos enteros', () => {
  assert.equal(aCentimos(400), 40000);
  assert.equal(aCentimos('37.50'), 3750);
  assert.equal(aCentimos(133.333), 13333);
  assert.equal(aCentimos(133.335), 13334);
  assert.equal(aCentimos(0), 0);
});

test('aCentimos rechaza lo que no es un número finito', () => {
  assert.throws(() => aCentimos(undefined), /Monto inválido/);
  assert.throws(() => aCentimos(NaN), /Monto inválido/);
  assert.throws(() => aCentimos('abc'), /Monto inválido/);
  assert.throws(() => aCentimos(Infinity), /Monto inválido/);
});

test('aMonto y redondear2 son el inverso a 2 decimales', () => {
  assert.equal(aMonto(13334), 133.34);
  assert.equal(redondear2(133.3333333), 133.33);
  assert.equal(redondear2(399.99999), 400);
});

// --------------------------------------------------------------- repartirMonto

test('repartirMonto reparte el plan de 3 días sin perder el céntimo', () => {
  // 🐞 BL-002: antes era 400/3 = 133.3333… -> 133.33 x3 = 399.99
  const partes = repartirMonto(PLAN_3_DIAS, 3);
  assert.deepEqual(partes, [133.34, 133.33, 133.33]);
  assert.equal(sumarMontos(partes), 400);
});

test('repartirMonto con división exacta no inventa residuo', () => {
  assert.deepEqual(repartirMonto(PLAN_2_DIAS, 2), [140, 140]);
  assert.deepEqual(repartirMonto(PLAN_4_DIAS, 4), [125, 125, 125, 125]);
  assert.deepEqual(repartirMonto(PLAN_1_DIA, 1), [150]);
});

test('repartirMonto respeta los decimales de la clase única', () => {
  assert.deepEqual(repartirMonto(CLASE_UNICA, 1), [37.5]);
  assert.deepEqual(repartirMonto(CLASE_UNICA, 2), [18.75, 18.75]);
});

test('repartirMonto cuadra después de un descuento porcentual', () => {
  // Plan de 3 días con 15% de beneficio: 400 - 60 = 340
  const conDescuento = PLAN_3_DIAS - PLAN_3_DIAS * 0.15;
  const partes = repartirMonto(conDescuento, 3);
  assert.equal(sumarMontos(partes), 340);
  assert.deepEqual(partes, [113.34, 113.33, 113.33]);
});

test('repartirMonto acepta cero y strings tipo Decimal', () => {
  assert.deepEqual(repartirMonto(0, 3), [0, 0, 0]);
  assert.equal(sumarMontos(repartirMonto('400.00', 3)), 400);
});

test('repartirMonto rechaza particiones inválidas', () => {
  assert.throws(() => repartirMonto(400, 0), /se esperaba un entero mayor a 0/);
  assert.throws(() => repartirMonto(400, -2), /se esperaba un entero mayor a 0/);
  assert.throws(() => repartirMonto(400, 2.5), /se esperaba un entero mayor a 0/);
  assert.throws(() => repartirMonto(400, undefined), /se esperaba un entero mayor a 0/);
});

test('repartirMonto rechaza montos no numéricos o negativos', () => {
  // 🐞 BL-002 foco #4: `montoTotal` ausente en el body producía monto_asignado = NaN
  assert.throws(() => repartirMonto(undefined, 2), /Monto inválido/);
  assert.throws(() => repartirMonto(NaN, 2), /Monto inválido/);
  assert.throws(() => repartirMonto(-10, 2), /monto negativo/);
});

test('la invariante suma(partes) == redondear2(total) se cumple siempre', () => {
  for (let i = 0; i < 500; i++) {
    const total = Math.round(Math.random() * 100000) / 100; // 0.00 .. 1000.00
    const n = 1 + Math.floor(Math.random() * 7);
    const partes = repartirMonto(total, n);

    assert.equal(partes.length, n);
    assert.equal(
      sumarMontos(partes),
      redondear2(total),
      `total=${total} n=${n} partes=${partes}`
    );
    // Ninguna parte difiere de otra en más de un céntimo
    assert.ok(aCentimos(Math.max(...partes)) - aCentimos(Math.min(...partes)) <= 1);
  }
});

// ----------------------------------------------------------------- sumarMontos

test('sumarMontos no arrastra error de float', () => {
  assert.equal(sumarMontos([0.1, 0.2]), 0.3);
  assert.equal(sumarMontos([133.34, 133.33, 133.33]), 400);
  assert.equal(sumarMontos([]), 0);
});
