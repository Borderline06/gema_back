import test from 'node:test';
import assert from 'node:assert/strict';

import { construirDisponibilidad } from '../src/features/horarios/horario.service.js';
import { horarioSchema } from '../src/features/horarios/horario.schema.js';

// Índice de feriados con la forma de cargarFeriadosActivos.
const feriados = (...claves) => ({
  exactos: new Map(claves.map((c) => [c, { descripcion: 'Feriado' }])),
  recurrentes: new Map(),
});

const sinFeriados = feriados();

// 2026-10-20 es martes (dia_semana = 2); 2026-10-25 es domingo (dia_semana = 7).
test('solo emite las fechas del día de semana del horario', () => {
  const r = construirDisponibilidad({
    horario: { dia_semana: 2, capacidad_max: 8 },
    desde: '2026-10-15',
    hasta: '2026-11-05',
    conteos: new Map(),
    indiceFeriados: sinFeriados,
  });

  assert.deepEqual(
    r.map((x) => x.fecha),
    ['2026-10-20', '2026-10-27', '2026-11-03']
  );
});

test('domingo se mapea a 7', () => {
  const r = construirDisponibilidad({
    horario: { dia_semana: 7, capacidad_max: 8 },
    desde: '2026-10-24',
    hasta: '2026-10-26',
    conteos: new Map(),
    indiceFeriados: sinFeriados,
  });

  assert.deepEqual(r.map((x) => x.fecha), ['2026-10-25']);
});

test('fecha sin registros => ocupados 0 y disponible', () => {
  const [d] = construirDisponibilidad({
    horario: { dia_semana: 2, capacidad_max: 8 },
    desde: '2026-10-20',
    hasta: '2026-10-20',
    conteos: new Map(),
    indiceFeriados: sinFeriados,
  });

  assert.deepEqual(d, {
    fecha: '2026-10-20',
    ocupados: 0,
    capacidad_max: 8,
    disponible: true,
    es_feriado: false,
  });
});

test('cupo lleno => disponible false; uno menos => true', () => {
  const r = construirDisponibilidad({
    horario: { dia_semana: 2, capacidad_max: 8 },
    desde: '2026-10-20',
    hasta: '2026-10-27',
    conteos: new Map([
      ['2026-10-20', 7],
      ['2026-10-27', 8],
    ]),
    indiceFeriados: sinFeriados,
  });

  assert.equal(r[0].disponible, true);
  assert.equal(r[1].disponible, false);
  assert.equal(r[1].ocupados, 8);
});

test('feriado => no disponible aunque haya cupo', () => {
  const [d] = construirDisponibilidad({
    horario: { dia_semana: 2, capacidad_max: 8 },
    desde: '2026-11-03',
    hasta: '2026-11-03',
    conteos: new Map(),
    indiceFeriados: feriados('2026-11-03'),
  });

  assert.equal(d.es_feriado, true);
  assert.equal(d.disponible, false);
  assert.equal(d.ocupados, 0);
});

test('capacidad_max nula o 0 cae al fallback 20 (igual que el validador)', () => {
  const [d] = construirDisponibilidad({
    horario: { dia_semana: 2, capacidad_max: null },
    desde: '2026-10-20',
    hasta: '2026-10-20',
    conteos: new Map([['2026-10-20', 19]]),
    indiceFeriados: sinFeriados,
  });

  assert.equal(d.capacidad_max, 20);
  assert.equal(d.disponible, true);
});

// --------------------------------------------------- disponibilidadQuerySchema

const parse = (q) => horarioSchema.disponibilidadQuerySchema.safeParse(q);

test('query válida pasa', () => {
  assert.equal(parse({ desde: '2026-10-15', hasta: '2026-10-15' }).success, true);
});

test('query rechaza faltantes, formato, fecha imposible, orden y rango excesivo', () => {
  assert.equal(parse({ desde: '2026-10-15' }).success, false);
  assert.equal(parse({ desde: '15/10/2026', hasta: '2026-10-20' }).success, false);
  assert.equal(parse({ desde: '2026-02-30', hasta: '2026-03-05' }).success, false);
  assert.equal(parse({ desde: '2026-10-20', hasta: '2026-10-15' }).success, false);
  // 93 días inclusive > 92
  assert.equal(parse({ desde: '2026-01-01', hasta: '2026-04-03' }).success, false);
  // 92 días inclusive es el máximo permitido
  assert.equal(parse({ desde: '2026-01-01', hasta: '2026-04-02' }).success, true);
});
