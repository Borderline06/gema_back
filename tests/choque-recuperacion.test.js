import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asistenciaService,
  detectarChoquesCiclo,
  lanzarSiHayChoques,
} from '../src/features/asistencia/asistencia.service.js';
import { ApiError } from '../src/shared/utils/error.util.js';

// =================================================================
// 🤝 BL-010: un choque con una recuperación PROGRAMADA aborta con 409.
// =================================================================

const dbDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
// Una columna @db.Time(6) llega como Date del 01/01/1970 con la hora en UTC.
const dbTime = (hhmm) => new Date(`1970-01-01T${hhmm}:00.000Z`);
// Lo que produce clase-fecha.util.js: mediodía en hora LOCAL del server.
const mediodiaLocal = (iso) => new Date(`${iso}T12:00:00`);

const HORA = dbTime('18:30');
const DIA_MARTES = 2;
// Ciclo de 30 días desde el martes 03/03/2026: 03, 10, 17, 24 y 31 de marzo.
const INICIO_CICLO = mediodiaLocal('2026-03-03');

const recuperacion = (id, fechaISO, hora = '18:30', estado = 'PROGRAMADA') => ({
  id,
  estado,
  fecha_programada: dbDate(fechaISO),
  horario_destino_id: 7,
  horarios_clases: { id: 7, hora_inicio: dbTime(hora) },
});

/**
 * `tx` falso. `recuperaciones.findMany` respeta el filtro `estado.in` que pide
 * el código, así que una recuperación que no sea PROGRAMADA no llega al índice
 * igual que en la base real.
 */
const crearTx = ({ recuperaciones = [], tipo = 'REGULAR' } = {}) => {
  const registro = { createMany: [], whereRecuperaciones: null };

  const tx = {
    inscripciones: {
      findUnique: async () => ({
        tipo_inscripcion: tipo,
        alumno_id: 42,
        horarios_clases: { hora_inicio: HORA },
      }),
    },
    registros_asistencia: {
      findFirst: async () => null,
      createMany: async (args) => {
        registro.createMany.push(args);
        return { count: args.data.length };
      },
    },
    recuperaciones: {
      findMany: async ({ where }) => {
        registro.whereRecuperaciones = where;
        return recuperaciones.filter((r) => where.estado.in.includes(r.estado));
      },
    },
    feriados: { findMany: async () => [] },
  };

  return { tx, registro };
};

const paramsCiclo = (extra = {}) => ({
  inscripcion_id: 100,
  dia_semana: DIA_MARTES,
  usuario_admin_id: 1,
  coordinador_id: 5,
  fecha_inicio: INICIO_CICLO,
  tipo_inscripcion: 'REGULAR',
  alumno_id: 42,
  hora_inicio: HORA,
  ...extra,
});

const esChoque409 = (e) => {
  assert.ok(e instanceof ApiError, 'debe ser un ApiError');
  assert.equal(e.statusCode, 409);
  assert.equal(e.details.codigo, 'CHOQUE_RECUPERACION');
  return true;
};

// ------------------------------------------------------- detectarChoquesCiclo

const CICLO = ['2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24'].map(mediodiaLocal);
const indiceCon = (pares) => ({
  porSlot: new Map(
    pares.map(([clave, id]) => [clave, { id, estado: 'PROGRAMADA' }])
  ),
});

test('detectarChoquesCiclo: mismo día + misma hora es un choque', () => {
  const choques = detectarChoquesCiclo({
    fechas: CICLO,
    horaInicio: HORA,
    indiceRecuperaciones: indiceCon([['2026-03-10T18:30', 55]]),
  });

  assert.deepEqual(choques, [
    { fecha: '2026-03-10', hora: '18:30', recuperacion_id: 55, estado_recuperacion: 'PROGRAMADA' },
  ]);
});

test('detectarChoquesCiclo: misma fecha en OTRA hora no es un choque', () => {
  const choques = detectarChoquesCiclo({
    fechas: CICLO,
    horaInicio: HORA,
    indiceRecuperaciones: indiceCon([['2026-03-10T20:00', 55]]),
  });
  assert.deepEqual(choques, []);
});

test('detectarChoquesCiclo: misma hora en una fecha fuera del ciclo no es un choque', () => {
  const choques = detectarChoquesCiclo({
    fechas: CICLO,
    horaInicio: HORA,
    indiceRecuperaciones: indiceCon([['2026-03-11T18:30', 55]]),
  });
  assert.deepEqual(choques, []);
});

test('detectarChoquesCiclo: sin índice, índice vacío o sin hora devuelve []', () => {
  assert.deepEqual(
    detectarChoquesCiclo({ fechas: CICLO, horaInicio: HORA, indiceRecuperaciones: null }),
    []
  );
  assert.deepEqual(
    detectarChoquesCiclo({ fechas: CICLO, horaInicio: HORA, indiceRecuperaciones: indiceCon([]) }),
    []
  );
  assert.deepEqual(
    detectarChoquesCiclo({
      fechas: CICLO,
      horaInicio: null,
      indiceRecuperaciones: indiceCon([['2026-03-10T18:30', 1]]),
    }),
    []
  );
});

test('detectarChoquesCiclo: reporta TODOS los choques en orden cronológico', () => {
  const choques = detectarChoquesCiclo({
    // Fechas desordenadas a propósito.
    fechas: [CICLO[2], CICLO[0], CICLO[1]],
    horaInicio: HORA,
    indiceRecuperaciones: indiceCon([
      ['2026-03-17T18:30', 2],
      ['2026-03-03T18:30', 1],
    ]),
  });

  assert.deepEqual(
    choques.map((c) => [c.fecha, c.recuperacion_id]),
    [
      ['2026-03-03', 1],
      ['2026-03-17', 2],
    ]
  );
});

// ---------------------------------------------------------- lanzarSiHayChoques

test('lanzarSiHayChoques: sin choques no lanza', () => {
  assert.doesNotThrow(() => lanzarSiHayChoques([], 100));
  assert.doesNotThrow(() => lanzarSiHayChoques(null, 100));
});

test('lanzarSiHayChoques: 409 con fecha, hora y mensaje del conflicto', () => {
  const choques = [
    { fecha: '2026-03-10', hora: '18:30', recuperacion_id: 55, estado_recuperacion: 'PROGRAMADA' },
    { fecha: '2026-03-17', hora: '18:30', recuperacion_id: 56, estado_recuperacion: 'PROGRAMADA' },
  ];

  assert.throws(
    () => lanzarSiHayChoques(choques, 100),
    (e) => {
      esChoque409(e);
      assert.match(e.message, /10\/03\/2026/);
      assert.match(e.message, /18:30/);
      assert.match(e.message, /1 choque\(s\) más/);
      assert.equal(e.details.fecha, '2026-03-10', 'fecha/hora son las del primer choque');
      assert.equal(e.details.hora, '18:30');
      assert.equal(e.details.inscripcion_id, 100);
      assert.deepEqual(e.details.choques, choques);
      return true;
    }
  );
});

// ---------------------------------------------------- generarClasesFuturas

test('generarClasesFuturas: choque con recuperación PROGRAMADA → 409 y NO inserta nada', async () => {
  const { tx, registro } = crearTx({ recuperaciones: [recuperacion(55, '2026-03-17')] });

  await assert.rejects(asistenciaService.generarClasesFuturas(tx, paramsCiclo()), (e) => {
    esChoque409(e);
    assert.equal(e.details.fecha, '2026-03-17');
    assert.equal(e.details.hora, '18:30');
    assert.equal(e.details.choques[0].recuperacion_id, 55);
    assert.match(e.message, /17\/03\/2026 a las 18:30/);
    return true;
  });

  assert.equal(registro.createMany.length, 0, 'ninguna clase se inserta: la transacción se revierte');
});

test('generarClasesFuturas: solo consulta recuperaciones PROGRAMADA', async () => {
  const { tx, registro } = crearTx();

  await asistenciaService.generarClasesFuturas(tx, paramsCiclo());

  assert.equal(registro.whereRecuperaciones.alumno_id, 42);
  assert.deepEqual(registro.whereRecuperaciones.estado, { in: ['PROGRAMADA'] });
});

test('generarClasesFuturas: una recuperación COMPLETADA o VENCIDA en ese slot NO bloquea', async () => {
  const { tx, registro } = crearTx({
    recuperaciones: [
      recuperacion(1, '2026-03-10', '18:30', 'COMPLETADA_PRESENTE'),
      recuperacion(2, '2026-03-17', '18:30', 'COMPLETADA_FALTA'),
      recuperacion(3, '2026-03-24', '18:30', 'VENCIDA'),
    ],
  });

  const total = await asistenciaService.generarClasesFuturas(tx, paramsCiclo());

  assert.equal(total, 5);
  assert.equal(registro.createMany.length, 1);
});

test('generarClasesFuturas: recuperación PROGRAMADA a otra hora no bloquea', async () => {
  const { tx, registro } = crearTx({ recuperaciones: [recuperacion(55, '2026-03-17', '20:00')] });

  const total = await asistenciaService.generarClasesFuturas(tx, paramsCiclo());

  assert.equal(total, 5);
  assert.equal(registro.createMany[0].data.length, 5);
});

test('generarClasesFuturas: sin choques inserta el ciclo completo sin reubicar fechas', async () => {
  const { tx, registro } = crearTx();

  const total = await asistenciaService.generarClasesFuturas(tx, paramsCiclo());

  assert.equal(total, 5);
  const fechas = registro.createMany[0].data.map((d) => d.fecha.getDate());
  assert.deepEqual(fechas, [3, 10, 17, 24, 31]);
});

test('generarClasesFuturas: lee alumno y hora de la BD si el llamador no los pasa', async () => {
  const { tx, registro } = crearTx({ recuperaciones: [recuperacion(55, '2026-03-10')] });

  await assert.rejects(
    asistenciaService.generarClasesFuturas(tx, {
      inscripcion_id: 100,
      dia_semana: DIA_MARTES,
      usuario_admin_id: 1,
      coordinador_id: 5,
      fecha_inicio: INICIO_CICLO,
    }),
    esChoque409
  );
  assert.equal(registro.createMany.length, 0);
});

test('generarClasesFuturas: un choque lanza 409 también en un cambio de horario (misma ruta)', async () => {
  // updateInscripcion llama a generarClasesFuturas con la fila recién creada;
  // lo que importa es que el throw salga ANTES del createMany.
  const { tx, registro } = crearTx({ recuperaciones: [recuperacion(9, '2026-03-31')] });

  await assert.rejects(
    asistenciaService.generarClasesFuturas(tx, paramsCiclo({ fecha_inicio: INICIO_CICLO })),
    (e) => esChoque409(e) && e.details.fecha === '2026-03-31'
  );
  assert.equal(registro.createMany.length, 0);
});

// ------------------------------------------------------ generarClaseUnica

test('generarClaseUnica: choque con recuperación PROGRAMADA → 409 y NO inserta', async () => {
  const { tx, registro } = crearTx({
    tipo: 'INDIVIDUAL',
    recuperaciones: [recuperacion(77, '2026-03-03')],
  });

  await assert.rejects(
    asistenciaService.generarClaseUnica(tx, {
      inscripcion_id: 100,
      dia_semana: DIA_MARTES,
      coordinador_id: 5,
      fecha_inicio: INICIO_CICLO,
      alumno_id: 42,
      hora_inicio: HORA,
    }),
    (e) => esChoque409(e) && e.details.fecha === '2026-03-03' && e.details.hora === '18:30'
  );

  assert.equal(registro.createMany.length, 0);
});

test('generarClasesFuturas con inscripción INDIVIDUAL delega y también bloquea con 409', async () => {
  const { tx, registro } = crearTx({
    tipo: 'INDIVIDUAL',
    recuperaciones: [recuperacion(77, '2026-03-03')],
  });

  await assert.rejects(
    asistenciaService.generarClasesFuturas(tx, paramsCiclo({ tipo_inscripcion: 'INDIVIDUAL' })),
    esChoque409
  );
  assert.equal(registro.createMany.length, 0);
});

test('generarClaseUnica: sin choque inserta la única clase', async () => {
  const { tx, registro } = crearTx({ tipo: 'INDIVIDUAL' });

  const total = await asistenciaService.generarClaseUnica(tx, {
    inscripcion_id: 100,
    dia_semana: DIA_MARTES,
    coordinador_id: 5,
    fecha_inicio: INICIO_CICLO,
    alumno_id: 42,
    hora_inicio: HORA,
  });

  assert.equal(total, 1);
  assert.equal(registro.createMany[0].data.length, 1);
});

// ---------------------------------------------------- validarChoquesCiclo

test('validarChoquesCiclo: lanza el 409 sin insertar nada (pre-validación de validarPago)', async () => {
  const { tx, registro } = crearTx({ recuperaciones: [recuperacion(55, '2026-03-24')] });

  await assert.rejects(
    asistenciaService.validarChoquesCiclo(tx, paramsCiclo()),
    (e) => esChoque409(e) && e.details.fecha === '2026-03-24'
  );
  assert.equal(registro.createMany.length, 0);
});

test('validarChoquesCiclo: sin choques devuelve cuántas clases se generarían y NO inserta', async () => {
  const { tx, registro } = crearTx();

  const total = await asistenciaService.validarChoquesCiclo(tx, paramsCiclo());

  assert.equal(total, 5);
  assert.equal(registro.createMany.length, 0, 'dryRun no escribe');
});

test('validarChoquesCiclo: cubre también la clase única de una INDIVIDUAL', async () => {
  const { tx, registro } = crearTx({
    tipo: 'INDIVIDUAL',
    recuperaciones: [recuperacion(77, '2026-03-03')],
  });

  await assert.rejects(
    asistenciaService.validarChoquesCiclo(tx, paramsCiclo({ tipo_inscripcion: 'INDIVIDUAL' })),
    esChoque409
  );
  assert.equal(registro.createMany.length, 0);
});
