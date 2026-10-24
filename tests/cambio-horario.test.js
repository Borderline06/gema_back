import test from 'node:test';
import assert from 'node:assert/strict';

import { calcularFechasPorConteo } from '../src/shared/utils/clase-fecha.util.js';
import {
  diasParaCubrirUltimaClase,
  separarClasesParaCambio,
} from '../src/shared/utils/cambio-horario.util.js';
import { CLASES_POR_CICLO } from '../src/shared/utils/ciclo.util.js';

// Mediodía local, el ancla que usa toda la generación de clases.
const local = (iso) => new Date(`${iso}T12:00:00`);
const dia = (fecha) => {
  const f = new Date(fecha);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
};
// Fecha de una columna @db.Date: medianoche UTC.
const dbDate = (iso) => new Date(`${iso}T00:00:00.000Z`);

const JUEVES = 4;
const MARTES = 2;

test('CLASES_POR_CICLO es 5', () => {
  assert.equal(CLASES_POR_CICLO, 5);
});

test('calcularFechasPorConteo: bug de la 5ta clase — martes → jueves entrega las 5', () => {
  // Ciclo abierto el martes 03/03/2026; cambia a jueves sin haber ido.
  // Por tope de 30 días eran 4 (el quinto jueves cae el día +30).
  const fechas = calcularFechasPorConteo(local('2026-03-03'), JUEVES, 5);

  assert.deepEqual(fechas.map(dia), [
    '2026-03-05',
    '2026-03-12',
    '2026-03-19',
    '2026-03-26',
    '2026-04-02',
  ]);
});

test('calcularFechasPorConteo: si la fecha de inicio ya es el día de la clase, la incluye', () => {
  const fechas = calcularFechasPorConteo(local('2026-03-03'), MARTES, 2);
  assert.deepEqual(fechas.map(dia), ['2026-03-03', '2026-03-10']);
});

test('calcularFechasPorConteo: cantidad exacta para cualquier día de la semana', () => {
  for (let diaSemana = 0; diaSemana <= 6; diaSemana++) {
    const fechas = calcularFechasPorConteo(local('2026-03-03'), diaSemana, CLASES_POR_CICLO);
    assert.equal(fechas.length, CLASES_POR_CICLO, `dia ${diaSemana}`);
    assert.equal(fechas[0].getDay(), diaSemana, `dia ${diaSemana}`);
  }
});

test('calcularFechasPorConteo: salta feriados SIN consumir cupo', () => {
  const feriados = new Set(['2026-03-12']);
  const fechas = calcularFechasPorConteo(local('2026-03-03'), JUEVES, 4, {
    esFeriado: (f) => feriados.has(dia(f)),
  });

  assert.deepEqual(fechas.map(dia), ['2026-03-05', '2026-03-19', '2026-03-26', '2026-04-02']);
});

test('calcularFechasPorConteo: cantidad 0 devuelve vacío y negativa lanza', () => {
  assert.deepEqual(calcularFechasPorConteo(local('2026-03-03'), JUEVES, 0), []);
  assert.throws(() => calcularFechasPorConteo(local('2026-03-03'), JUEVES, -1));
  assert.throws(() => calcularFechasPorConteo(local('2026-03-03'), JUEVES, 2.5));
});

test('calcularFechasPorConteo: no entra en bucle infinito si todo es feriado', () => {
  assert.throws(() => calcularFechasPorConteo(local('2026-03-03'), JUEVES, 5, { esFeriado: () => true }));
});

test('separarClasesParaCambio: "ya fue a 1 martes" → 1 consumida y le tocan 4', () => {
  const clases = [
    { id: 1, fecha: dbDate('2026-03-03'), estado: 'PRESENTE' },
    { id: 2, fecha: dbDate('2026-03-10'), estado: 'PROGRAMADA' },
    { id: 3, fecha: dbDate('2026-03-17'), estado: 'PROGRAMADA' },
    { id: 4, fecha: dbDate('2026-03-24'), estado: 'PROGRAMADA' },
    { id: 5, fecha: dbDate('2026-03-31'), estado: 'PROGRAMADA' },
  ];

  const r = separarClasesParaCambio(clases, '2026-03-05');

  assert.equal(r.consumidas, 1);
  assert.deepEqual(r.retenidas.map((c) => c.id), [1]);
  assert.deepEqual(r.idsAEliminar, [2, 3, 4, 5]);
  assert.equal(CLASES_POR_CICLO - r.consumidas, 4);
});

test('separarClasesParaCambio: sin clases consumidas le tocan las 5', () => {
  const clases = [
    { id: 1, fecha: dbDate('2026-03-10'), estado: 'PROGRAMADA' },
    { id: 2, fecha: dbDate('2026-03-17'), estado: 'PROGRAMADA' },
  ];

  const r = separarClasesParaCambio(clases, '2026-03-03');

  assert.equal(r.consumidas, 0);
  assert.deepEqual(r.idsAEliminar, [1, 2]);
});

test('separarClasesParaCambio: la historia pasada se conserva con su estado real (FALTA incluida)', () => {
  const clases = [
    { id: 1, fecha: dbDate('2026-03-03'), estado: 'FALTA' },
    { id: 2, fecha: dbDate('2026-03-10'), estado: 'CANCELADO' },
  ];

  const r = separarClasesParaCambio(clases, '2026-03-20');

  // La FALTA consumió la clase; la CANCELADA (feriado) no se dictó → sigue pendiente.
  assert.equal(r.consumidas, 1);
  assert.equal(r.retenidas.length, 2);
  assert.deepEqual(r.idsAEliminar, []);
});

test('separarClasesParaCambio: una clase de hoy ya marcada PRESENTE no se borra', () => {
  const clases = [
    { id: 1, fecha: dbDate('2026-03-05'), estado: 'PRESENTE' },
    { id: 2, fecha: dbDate('2026-03-05'), estado: 'PROGRAMADA' },
  ];

  const r = separarClasesParaCambio(clases, '2026-03-05');

  assert.equal(r.consumidas, 1);
  assert.deepEqual(r.retenidas.map((c) => c.id), [1]);
  assert.deepEqual(r.idsAEliminar, [2]);
});

test('separarClasesParaCambio: una reposición PENDIENTE futura se regenera, no cuenta', () => {
  const r = separarClasesParaCambio(
    [{ id: 9, fecha: dbDate('2026-04-07'), estado: 'PENDIENTE' }],
    '2026-03-05'
  );

  assert.equal(r.consumidas, 0);
  assert.deepEqual(r.idsAEliminar, [9]);
});

test('separarClasesParaCambio: lista vacía o nula no lanza', () => {
  assert.deepEqual(separarClasesParaCambio([], '2026-03-05'), {
    retenidas: [],
    idsAEliminar: [],
    consumidas: 0,
  });
  assert.equal(separarClasesParaCambio(undefined, '2026-03-05').consumidas, 0);
});

test('diasParaCubrirUltimaClase: una última clase dentro de +29 no corre nada', () => {
  // Ancla: mediodía de Lima del 03/03 (17:00Z). +29 días = 01/04.
  const ancla = new Date('2026-03-03T17:00:00.000Z');

  assert.equal(diasParaCubrirUltimaClase(ancla, local('2026-03-26')), 0);
  assert.equal(diasParaCubrirUltimaClase(ancla, local('2026-04-01')), 0);
});

test('diasParaCubrirUltimaClase: el día +30 ya lo mata el VERDUGO → corre 1 día', () => {
  const ancla = new Date('2026-03-03T17:00:00.000Z');

  // 02/04 = día +30: el VERDUGO finaliza esa mañana, antes de la clase.
  assert.equal(diasParaCubrirUltimaClase(ancla, local('2026-04-02')), 1);
});

test('diasParaCubrirUltimaClase: con un feriado en medio la 5ta cae al día +35 → corre 6', () => {
  const ancla = new Date('2026-03-03T17:00:00.000Z');

  assert.equal(diasParaCubrirUltimaClase(ancla, local('2026-04-07')), 6);
});

test('diasParaCubrirUltimaClase: usa el día de Lima, no el día UTC del timestamp', () => {
  // 22:00 en Lima del 03/03 = 03:00Z del 04/03. El VERDUGO cuenta desde el 03/03.
  const anclaTarde = new Date('2026-03-04T03:00:00.000Z');

  assert.equal(diasParaCubrirUltimaClase(anclaTarde, local('2026-04-02')), 1);
});
