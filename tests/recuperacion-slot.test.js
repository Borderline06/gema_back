import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claveSlot,
  buscarChoqueRecuperacion,
  haySlotOcupado,
  cargarSlotsRecuperacion,
  ESTADOS_RECUPERACION_OCUPAN_SLOT,
} from '../src/shared/utils/recuperacion-slot.util.js';
import { siguienteOcurrenciaSemanal } from '../src/shared/utils/clase-fecha.util.js';
import { formatHoraUTC } from '../src/shared/utils/date.util.js';

const dbDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
// Una columna @db.Time(6) llega como Date del 01/01/1970 con la hora en UTC.
const dbTime = (hhmm) => new Date(`1970-01-01T${hhmm}:00.000Z`);
// Lo que produce clase-fecha.util.js: mediodía en hora LOCAL del server.
const mediodiaLocal = (iso) => new Date(`${iso}T12:00:00`);

const indiceCon = (pares) => ({
  porSlot: new Map(pares.map(([clave, id], i) => [clave, { id: id ?? i + 1, estado: 'PROGRAMADA' }])),
});

// ---------------------------------------------------------------- formatHoraUTC

test('formatHoraUTC lee la hora en UTC y tolera valores vacíos', () => {
  assert.equal(formatHoraUTC(dbTime('18:30')), '18:30');
  assert.equal(formatHoraUTC(dbTime('07:05')), '07:05');
  assert.equal(formatHoraUTC(null), '--:--');
  assert.equal(formatHoraUTC(new Date('no-es-fecha')), '--:--');
});

// ------------------------------------------------- siguienteOcurrenciaSemanal

test('siguienteOcurrenciaSemanal conserva el día de semana y no muta la entrada', () => {
  const martes = mediodiaLocal('2026-03-03');
  const original = martes.getTime();

  const siguiente = siguienteOcurrenciaSemanal(martes);

  assert.equal(siguiente.getDay(), martes.getDay(), 'sigue siendo el mismo día de semana');
  assert.equal(siguiente.getDate(), 10);
  assert.equal(martes.getTime(), original, 'no muta el Date recibido');
});

// ------------------------------------------------------------------- claveSlot

test('claveSlot da la MISMA clave para un @db.Date y para mediodía local', () => {
  // Es el invariante que hace que la generación (mediodía local) y las
  // recuperaciones (@db.Date) se puedan comparar entre sí.
  const hora = dbTime('18:30');

  assert.equal(claveSlot(dbDate('2026-03-10'), hora), '2026-03-10T18:30');
  assert.equal(claveSlot(mediodiaLocal('2026-03-10'), hora), '2026-03-10T18:30');
});

test('claveSlot devuelve null con fecha inválida', () => {
  assert.equal(claveSlot(null, dbTime('18:30')), null);
  assert.equal(claveSlot(new Date('no-es-fecha'), dbTime('18:30')), null);
});

test('ESTADOS_RECUPERACION_OCUPAN_SLOT es ESTRICTAMENTE [PROGRAMADA] (BL-010)', () => {
  assert.deepEqual([...ESTADOS_RECUPERACION_OCUPAN_SLOT], ['PROGRAMADA']);
});

// ------------------------------------------------- buscarChoqueRecuperacion

test('buscarChoqueRecuperacion es puro y null-safe', () => {
  const indice = indiceCon([['2026-03-10T18:30', 99]]);

  assert.equal(buscarChoqueRecuperacion('2026-03-10T18:30', indice).id, 99);
  assert.equal(buscarChoqueRecuperacion('2026-03-17T18:30', indice), null);
  assert.equal(buscarChoqueRecuperacion('2026-03-10T19:30', indice), null, 'otra hora no choca');
  assert.equal(buscarChoqueRecuperacion(null, indice), null);
  assert.equal(buscarChoqueRecuperacion('2026-03-10T18:30', null), null);
  assert.equal(haySlotOcupado('2026-03-10T18:30', indice), true);
});

test('cargarSlotsRecuperacion no consulta con un alumnoId inválido', async () => {
  const clienteQueExplota = {
    recuperaciones: {
      findMany: async () => {
        throw new Error('no debería consultarse');
      },
    },
  };

  const vacio = await cargarSlotsRecuperacion(clienteQueExplota, null);
  assert.equal(vacio.porSlot.size, 0);
  assert.deepEqual(vacio.filas, []);
});

test('cargarSlotsRecuperacion ignora las recuperaciones sin horario destino', async () => {
  const cliente = {
    recuperaciones: {
      findMany: async () => [
        {
          id: 1,
          estado: 'PROGRAMADA',
          fecha_programada: dbDate('2026-03-10'),
          horario_destino_id: 7,
          horarios_clases: { id: 7, hora_inicio: dbTime('18:30') },
        },
        // Ticket a medio agendar: no bloquea ningún slot.
        {
          id: 2,
          estado: 'PROGRAMADA',
          fecha_programada: dbDate('2026-03-17'),
          horario_destino_id: null,
          horarios_clases: null,
        },
      ],
    },
  };

  const indice = await cargarSlotsRecuperacion(cliente, 42);

  assert.equal(indice.porSlot.size, 1);
  assert.equal(indice.porSlot.get('2026-03-10T18:30').id, 1);
});

test('cargarSlotsRecuperacion consulta SOLO recuperaciones PROGRAMADA con fecha agendada', async () => {
  let whereUsado = null;
  const cliente = {
    recuperaciones: {
      findMany: async ({ where }) => {
        whereUsado = where;
        return [];
      },
    },
  };

  await cargarSlotsRecuperacion(cliente, 42);

  assert.equal(whereUsado.alumno_id, 42);
  assert.deepEqual(whereUsado.estado, { in: ['PROGRAMADA'] });
  assert.deepEqual(whereUsado.fecha_programada, { not: null });
});
