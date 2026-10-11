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
import { reubicarFechasConChoque } from '../src/features/asistencia/asistencia.service.js';

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

test('ESTADOS_RECUPERACION_OCUPAN_SLOT incluye COMPLETADA_PRESENTE', () => {
  // Es el estado que dejó una fila física [RECUPERACION] peleando por el
  // @@unique([inscripcion_id, fecha]): si se omitiera, skipDuplicates volvería
  // a comerse la clase regular en silencio.
  assert.ok(ESTADOS_RECUPERACION_OCUPAN_SLOT.includes('COMPLETADA_PRESENTE'));
  assert.ok(!ESTADOS_RECUPERACION_OCUPAN_SLOT.includes('PENDIENTE'));
  assert.ok(!ESTADOS_RECUPERACION_OCUPAN_SLOT.includes('VENCIDA'));
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

// ------------------------------------------------- reubicarFechasConChoque

const CICLO_MARTES = ['2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24'].map(mediodiaLocal);
const claves = (fechas) => fechas.map((f) => f.toISOString().slice(0, 10));

test('reubicarFechasConChoque: sin índice o sin hora devuelve el plan intacto', () => {
  const sinIndice = reubicarFechasConChoque({
    fechas: CICLO_MARTES,
    horaInicio: dbTime('18:30'),
    indiceRecuperaciones: null,
  });
  assert.deepEqual(claves(sinIndice.fechas), claves(CICLO_MARTES));
  assert.equal(sinIndice.choques.length, 0);

  const sinHora = reubicarFechasConChoque({
    fechas: CICLO_MARTES,
    horaInicio: null,
    indiceRecuperaciones: indiceCon([['2026-03-10T18:30', 1]]),
  });
  assert.deepEqual(claves(sinHora.fechas), claves(CICLO_MARTES));
});

test('reubicarFechasConChoque: la clase que choca se va al FINAL, sin mover las demás', () => {
  // Recuperación el martes 10/03 a las 18:30 = el slot del alumno está tomado.
  const r = reubicarFechasConChoque({
    fechas: CICLO_MARTES,
    horaInicio: dbTime('18:30'),
    indiceRecuperaciones: indiceCon([['2026-03-10T18:30', 55]]),
  });

  // Las otras tres fechas NO se mueven y la del 10 aterriza una semana después
  // de la última (31/03): misma semántica que la reposición al final del ciclo.
  assert.deepEqual(claves(r.fechas), ['2026-03-03', '2026-03-17', '2026-03-24', '2026-03-31']);
  assert.equal(r.fechas.length, CICLO_MARTES.length, 'el alumno no pierde ninguna sesión');
  assert.equal(r.omitidas.length, 0);

  assert.equal(r.choques.length, 1);
  assert.deepEqual(r.choques[0], {
    fecha: '2026-03-10',
    hora: '18:30',
    recuperacion_id: 55,
    estado_recuperacion: 'PROGRAMADA',
    fecha_reubicada: '2026-03-31',
  });
});

test('reubicarFechasConChoque: una recuperación a otra hora no estorba', () => {
  const r = reubicarFechasConChoque({
    fechas: CICLO_MARTES,
    horaInicio: dbTime('18:30'),
    indiceRecuperaciones: indiceCon([['2026-03-10T20:00', 55]]),
  });

  assert.deepEqual(claves(r.fechas), claves(CICLO_MARTES));
  assert.equal(r.choques.length, 0);
});

test('reubicarFechasConChoque: dos choques se reubican en cadena sin pisarse', () => {
  const r = reubicarFechasConChoque({
    fechas: CICLO_MARTES,
    horaInicio: dbTime('18:30'),
    indiceRecuperaciones: indiceCon([
      ['2026-03-03T18:30', 1],
      ['2026-03-17T18:30', 2],
    ]),
  });

  assert.deepEqual(claves(r.fechas), ['2026-03-10', '2026-03-24', '2026-03-31', '2026-04-07']);
  assert.equal(new Set(claves(r.fechas)).size, 4, 'ninguna fecha repetida');
  assert.equal(r.choques.length, 2);
  assert.equal(r.omitidas.length, 0);
});

test('reubicarFechasConChoque: sin hueco en 6 semanas omite la fecha y NUNCA lanza', () => {
  // Todas las ocurrencias semanales posibles están ocupadas.
  const todasOcupadas = [
    '2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24',
    '2026-03-31', '2026-04-07', '2026-04-14',
  ].map((d) => [`${d}T18:30`, 1]);

  const r = reubicarFechasConChoque({
    fechas: [mediodiaLocal('2026-03-03')],
    horaInicio: dbTime('18:30'),
    indiceRecuperaciones: indiceCon(todasOcupadas),
  });

  assert.deepEqual(r.fechas, [], 'se omite en vez de lanzar: la $transaction del pago sobrevive');
  assert.equal(r.omitidas.length, 1);
  assert.equal(r.omitidas[0].motivo, 'SIN_HUECO_LIBRE');
});
