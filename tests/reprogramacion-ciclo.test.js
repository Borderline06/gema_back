import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTADOS_CLASE_VIGENTE,
  resolverCorrimientoDeCiclo,
  resolverReversionDeCiclo,
} from '../src/shared/utils/reprogramacion-ciclo.util.js';

// Fecha de una columna @db.Date: Prisma la entrega a medianoche UTC.
const dbDate = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Ciclo tipo: abre el lunes 02/03 (BL-006: el admin puede abrirlo un día antes
// de la primera clase) y entrena los martes.
const cicloMartes = () => ({
  link: { id: 10, fecha_inicio_ciclo: dbDate('2026-03-02') },
  clases: [
    { id: 1, fecha: dbDate('2026-03-03') },
    { id: 2, fecha: dbDate('2026-03-10') },
    { id: 3, fecha: dbDate('2026-03-17') },
    { id: 4, fecha: dbDate('2026-03-24') },
  ],
});

test('ESTADOS_CLASE_VIGENTE incluye PENDIENTE (las reposiciones cuentan como clase)', () => {
  assert.ok(ESTADOS_CLASE_VIGENTE.includes('PENDIENTE'));
  assert.ok(!ESTADOS_CLASE_VIGENTE.includes('REPROGRAMADO'));
  assert.ok(!ESTADOS_CLASE_VIGENTE.includes('CANCELADO'));
});

test('resolverCorrimientoDeCiclo: mover la primera clase corre el ciclo a la siguiente', () => {
  const r = resolverCorrimientoDeCiclo(cicloMartes(), dbDate('2026-03-03'));

  assert.equal(r.eraPrimeraClase, true);
  assert.equal(r.dias, 7);
  assert.equal(r.siguienteClase.toISOString(), dbDate('2026-03-10').toISOString());
});

test('resolverCorrimientoDeCiclo: mover una clase intermedia NO corre el ciclo', () => {
  for (const fecha of ['2026-03-10', '2026-03-17', '2026-03-24']) {
    const r = resolverCorrimientoDeCiclo(cicloMartes(), dbDate(fecha));
    assert.equal(r.eraPrimeraClase, false, fecha);
    assert.equal(r.dias, null, fecha);
  }
});

test('resolverCorrimientoDeCiclo: tolera la fecha anclada a mediodía local', () => {
  // La reprogramación masiva ancla fecha_origen a mediodía; el ciclo viene de
  // columnas @db.Date a medianoche UTC. Las dos tienen que dar la misma clave.
  const r = resolverCorrimientoDeCiclo(cicloMartes(), new Date('2026-03-03T12:00:00'));

  assert.equal(r.eraPrimeraClase, true);
  assert.equal(r.dias, 7);
});

test('resolverCorrimientoDeCiclo: sin clases o sin ciclo devuelve nulo y no lanza', () => {
  const link = { id: 10, fecha_inicio_ciclo: dbDate('2026-03-02') };

  assert.equal(resolverCorrimientoDeCiclo(undefined, dbDate('2026-03-03')).eraPrimeraClase, false);
  assert.equal(
    resolverCorrimientoDeCiclo({ link, clases: [] }, dbDate('2026-03-03')).eraPrimeraClase,
    false
  );
  assert.equal(resolverCorrimientoDeCiclo(cicloMartes(), null).eraPrimeraClase, false);
});

test('resolverCorrimientoDeCiclo: ciclo de una sola clase no tiene destino', () => {
  const ciclo = {
    link: { id: 10, fecha_inicio_ciclo: dbDate('2026-03-02') },
    clases: [{ id: 1, fecha: dbDate('2026-03-03') }],
  };

  const r = resolverCorrimientoDeCiclo(ciclo, dbDate('2026-03-03'));

  // Era la primera, pero sin siguiente clase no hay corrimiento que aplicar:
  // el llamador conserva su comportamiento de siempre.
  assert.equal(r.eraPrimeraClase, true);
  assert.equal(r.dias, null);
});

test('resolverReversionDeCiclo: deshace exactamente el delta que aplicó la ida', () => {
  // Estado POST-aplicación: el inicio se corrió al 09/03 (02/03 + 7) y la clase
  // del 03/03 quedó en REPROGRAMADO, así que ya no está en `clases`.
  const cicloCorrido = {
    link: { id: 10, fecha_inicio_ciclo: dbDate('2026-03-09') },
    clases: [
      { id: 2, fecha: dbDate('2026-03-10') },
      { id: 3, fecha: dbDate('2026-03-17') },
    ],
  };

  const r = resolverReversionDeCiclo(cicloCorrido, dbDate('2026-03-03'));

  assert.equal(r.debeRevertir, true);
  assert.equal(r.dias, 7, 'mismo delta que la ida, para que ida y vuelta se anulen');
});

test('resolverReversionDeCiclo: no toca un ciclo que la ida nunca corrió', () => {
  // La clase movida era intermedia: el inicio sigue siendo anterior a ella.
  const r = resolverReversionDeCiclo(cicloMartes(), dbDate('2026-03-17'));

  assert.equal(r.debeRevertir, false);
  assert.equal(r.dias, null);
});

test('resolverReversionDeCiclo: sin link o sin clases no lanza', () => {
  assert.equal(resolverReversionDeCiclo(undefined, dbDate('2026-03-03')).debeRevertir, false);
  assert.equal(
    resolverReversionDeCiclo({ link: { id: 1, fecha_inicio_ciclo: null }, clases: [] }, dbDate('2026-03-03'))
      .debeRevertir,
    false
  );
});
