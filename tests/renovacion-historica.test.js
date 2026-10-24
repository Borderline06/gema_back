import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esPaqueteFinalizado,
  existeInscripcionEquivalente,
  elegirConceptoVigente,
  ordenarAlternativas,
} from '../src/features/inscripciones/utils/renovacion.util.js';

test('esPaqueteFinalizado', () => {
  assert.equal(esPaqueteFinalizado([]), false);
  assert.equal(esPaqueteFinalizado(['FINALIZADO', 'ACTIVO']), false);
  assert.equal(esPaqueteFinalizado(['FINALIZADO', 'FINALIZADO']), true);
});

test('existeInscripcionEquivalente', () => {
  const insc = [{ horario_id: 1, estado: 'ACTIVO' }, { horario_id: 2, estado: 'FINALIZADO' }];
  assert.equal(existeInscripcionEquivalente([1], insc), true);
  assert.equal(existeInscripcionEquivalente([1, 2], insc), false);
  assert.equal(existeInscripcionEquivalente([], insc), false);
  assert.equal(existeInscripcionEquivalente([3], [{ horario_id: 3, estado: 'PENDIENTE_PAGO' }]), true);
});

test('elegirConceptoVigente prefiere mismo codigo y exige vigente/activo', () => {
  const cand = [
    { id: 1, activo: true, es_vigente: false, cantidad_clases_semanal: 2, codigo_interno: 'A' },
    { id: 2, activo: true, es_vigente: true, cantidad_clases_semanal: 2, codigo_interno: 'B' },
    { id: 3, activo: true, es_vigente: true, cantidad_clases_semanal: 2, codigo_interno: 'A' },
  ];
  assert.equal(elegirConceptoVigente(cand, { codigo_interno: 'A' }, 2).id, 3);
  assert.equal(elegirConceptoVigente(cand, { codigo_interno: 'Z' }, 2).id, 2);
  assert.equal(elegirConceptoVigente(cand, null, 5), null);
});

test('ordenarAlternativas pone primero el mismo día', () => {
  const r = ordenarAlternativas([{ id: 1, dia_semana: 2 }, { id: 2, dia_semana: 3 }], 3);
  assert.deepEqual(r.map((x) => x.id), [2, 1]);
});
