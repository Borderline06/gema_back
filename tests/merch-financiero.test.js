import test from 'node:test';
import assert from 'node:assert/strict';
import { merchService } from '../src/features/merch/merch.service.js';
import { sumarMontos } from '../src/shared/utils/dinero.util.js';

/**
 * BD en memoria con la superficie de Prisma que usa el módulo Merch.
 * Todas las operaciones reciben `tx` por parámetro, así que no hace falta
 * levantar Postgres para verificar la contabilidad.
 */
const crearDb = ({ productos = [], links = [] } = {}) => {
  const estado = {
    merch: productos.map((p) => ({ estado: 'ACTIVO', ...p })),
    cuentas: [],
    pagos: [],
    items: [],
    links: links.map((l) => ({ ...l })),
    notificaciones: [],
    alumnos: [{ usuario_id: 7 }],
  };
  let seq = 100;
  const coincide = (fila, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(fila[k]);
      if (v && typeof v === 'object' && 'gte' in v) return fila[k] >= v.gte;
      return fila[k] === v;
    });

  const db = {
    estado,
    alumnos: { findUnique: async ({ where }) => estado.alumnos.find((a) => a.usuario_id === where.usuario_id) ?? null },
    merch: {
      findMany: async ({ where }) => estado.merch.filter((m) => coincide(m, where)),
      updateMany: async ({ where, data }) => {
        const filas = estado.merch.filter((m) => coincide(m, where));
        filas.forEach((m) => {
          if (data.stock?.decrement) m.stock -= data.stock.decrement;
        });
        return { count: filas.length };
      },
      update: async ({ where, data }) => {
        const m = estado.merch.find((x) => x.id === where.id);
        if (data.stock?.increment) m.stock += data.stock.increment;
        return m;
      },
    },
    cuentas_por_cobrar: {
      create: async ({ data }) => {
        const c = { id: ++seq, ...data };
        estado.cuentas.push(c);
        return c;
      },
      update: async ({ where, data }) => Object.assign(estado.cuentas.find((c) => c.id === where.id), data),
    },
    pagos: {
      create: async ({ data }) => {
        const p = { id: ++seq, ...data };
        estado.pagos.push(p);
        return p;
      },
    },
    alumno_merch: {
      createMany: async ({ data }) => {
        data.forEach((d) => estado.items.push({ id: ++seq, ...d }));
        return { count: data.length };
      },
      findMany: async ({ where }) => estado.items.filter((i) => coincide(i, where)),
      findUnique: async ({ where }) => estado.items.find((i) => i.id === where.id) ?? null,
      count: async ({ where }) => estado.items.filter((i) => coincide(i, where)).length,
      updateMany: async ({ where, data }) => {
        const filas = estado.items.filter((i) => coincide(i, where));
        filas.forEach((i) => Object.assign(i, data));
        return { count: filas.length };
      },
      update: async ({ where, data }) => Object.assign(estado.items.find((i) => i.id === where.id), data),
      deleteMany: async ({ where }) => {
        const antes = estado.items.length;
        estado.items = estado.items.filter((i) => !coincide(i, where));
        return { count: antes - estado.items.length };
      },
    },
    inscripciones_deudas_link: {
      findMany: async ({ where }) => estado.links.filter((l) => l.cuenta_id === where.cuenta_id),
      update: async ({ where, data }) => Object.assign(estado.links.find((l) => l.id === where.id), data),
    },
    notificaciones: { create: async ({ data }) => estado.notificaciones.push(data) },
  };
  return db;
};

const productos = [
  { id: 1, nombre: 'Camiseta', precio: 50, stock: 10 },
  { id: 2, nombre: 'Gorra', precio: 33.33, stock: 5 },
];

// ---------------------------------------------------------------- venta suelta
test('compra independiente: pago APROBADO con tipo MERCH y montos que cuadran', async () => {
  const db = crearDb({ productos });
  const r = await merchService.comprarIndependiente(
    { alumno_id: 7, merch_ids: [1, 2, 2, 2], metodo_pago_id: 1 },
    99,
    db
  );

  assert.equal(r.total_pagado, 149.99);
  const [pago] = db.estado.pagos;
  assert.equal(pago.tipo_transaccion, 'MERCH');
  assert.equal(pago.estado_validacion, 'APROBADO');
  assert.equal(pago.monto_pagado, 149.99);
  assert.equal(pago.revisado_por, 99);

  const [cuenta] = db.estado.cuentas;
  assert.equal(cuenta.estado, 'PAGADA');
  assert.equal(cuenta.monto_final, pago.monto_pagado);

  // El dinero del pago == lo que quedó registrado en la colección del alumno.
  assert.equal(db.estado.items.length, 4);
  assert.equal(sumarMontos(db.estado.items.map((i) => i.monto_pagado)), pago.monto_pagado);
  assert.ok(db.estado.items.every((i) => i.estado_item === 'POSEE' && i.pago_id === pago.id));

  // Stock descontado.
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 9);
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 2);
});

test('compra independiente: sin stock responde 409 y no escribe nada', async () => {
  const db = crearDb({ productos });
  await assert.rejects(
    merchService.comprarIndependiente({ alumno_id: 7, merch_ids: [1, 2, 2, 2, 2, 2, 2], metodo_pago_id: 1 }, 99, db),
    { statusCode: 409 }
  );
  assert.equal(db.estado.pagos.length, 0);
  assert.equal(db.estado.cuentas.length, 0);
  assert.equal(db.estado.items.length, 0);
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 5);
});

test('compra independiente: alumno inexistente = 404', async () => {
  const db = crearDb({ productos });
  await assert.rejects(
    merchService.comprarIndependiente({ alumno_id: 555, merch_ids: [1], metodo_pago_id: 1 }, 99, db),
    { statusCode: 404 }
  );
});

// ------------------------------------------------------------ combo con matrícula
const cuentaDeMatricula = (db, monto = 400) => {
  db.estado.cuentas.push({ id: 1, alumno_id: 7, monto_final: monto, estado: 'PENDIENTE', detalle_adicional: 'Plan 3 clases/semana' });
  // Puente como lo deja el PASO 6 de inscribirPaquete: 400 repartido en 3 slots.
  db.estado.links.push(
    { id: 11, cuenta_id: 1, monto_asignado: 133.34 },
    { id: 12, cuenta_id: 1, monto_asignado: 133.33 },
    { id: 13, cuenta_id: 1, monto_asignado: 133.33 }
  );
};

const sumaPuente = (db) => sumarMontos(db.estado.links.map((l) => l.monto_asignado));

test('combo: monto_final = matrícula + merch y el puente sigue cuadrando al céntimo', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);

  const { montoFinal, merch } = await merchService.cerrarCuentaConMerch(db, {
    alumno_id: 7,
    cuenta_id: 1,
    detalle_base: 'Plan 3 clases/semana',
    monto_matricula: 400,
    hubo_beneficios: false,
    merch_ids: [2, 2, 2],
  });

  assert.equal(merch.total, 99.99);
  assert.equal(montoFinal, 499.99);
  const cuenta = db.estado.cuentas[0];
  assert.equal(cuenta.monto_final, 499.99);
  assert.equal(cuenta.estado, 'PENDIENTE');
  assert.equal(cuenta.detalle_adicional, 'Plan 3 clases/semana | Merch: Gorra x3');
  assert.equal(sumaPuente(db), cuenta.monto_final);

  // Reservado, no poseído, y con el stock ya descontado.
  assert.ok(db.estado.items.every((i) => i.estado_item === 'RESERVADO' && i.cuenta_id === 1));
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 2);
});

test('combo: el descuento recae solo en la matrícula, no en el merch', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);

  // La matrícula ya llegó con beneficios aplicados: 400 -> 360.
  const { montoFinal } = await merchService.cerrarCuentaConMerch(db, {
    alumno_id: 7,
    cuenta_id: 1,
    detalle_base: 'Plan 3 clases/semana',
    monto_matricula: 360,
    hubo_beneficios: true,
    merch_ids: [1],
  });

  assert.equal(montoFinal, 410);
  assert.equal(sumaPuente(db), 410);
});

test('regresión: sin merch_ids la cuenta queda exactamente como antes', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);

  const { montoFinal, merch } = await merchService.cerrarCuentaConMerch(db, {
    alumno_id: 7,
    cuenta_id: 1,
    detalle_base: 'Plan 3 clases/semana',
    monto_matricula: 400,
    hubo_beneficios: false,
    merch_ids: undefined,
  });

  assert.equal(montoFinal, 400);
  assert.equal(merch.total, 0);
  const cuenta = db.estado.cuentas[0];
  assert.equal(cuenta.monto_final, 400);
  assert.equal(cuenta.estado, 'PENDIENTE');
  assert.equal(cuenta.detalle_adicional, 'Plan 3 clases/semana'); // intacto
  // Puente no re-escrito (133.34/133.33/133.33 sigue igual).
  assert.deepEqual(db.estado.links.map((l) => l.monto_asignado), [133.34, 133.33, 133.33]);
  assert.equal(db.estado.items.length, 0);
});

test('regresión: matrícula gratis (monto 0) sin merch nace PAGADA', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db, 0);
  await merchService.cerrarCuentaConMerch(db, {
    alumno_id: 7, cuenta_id: 1, detalle_base: 'x', monto_matricula: 0, hubo_beneficios: true, merch_ids: [],
  });
  assert.equal(db.estado.cuentas[0].estado, 'PAGADA');
});

test('combo: merch sin stock = 409 (la inscripción completa se revierte)', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  await assert.rejects(
    merchService.cerrarCuentaConMerch(db, {
      alumno_id: 7, cuenta_id: 1, detalle_base: 'x', monto_matricula: 400, hubo_beneficios: false, merch_ids: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    }),
    { statusCode: 409 }
  );
  assert.equal(db.estado.cuentas[0].monto_final, 400);
});

test('etiqueta del pago: MIXTO si la cuenta lleva merch, MATRICULA si no', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  assert.equal(await merchService.tipoTransaccionDeCuenta(db, 1), 'MATRICULA');
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [1] });
  assert.equal(await merchService.tipoTransaccionDeCuenta(db, 1), 'MIXTO');
});

test('pago aprobado: las reservas pasan a POSEE ligadas al pago', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [1, 2] });

  const n = await merchService.confirmarMerchDeCuenta(db, 1, 555);
  assert.equal(n, 2);
  assert.ok(db.estado.items.every((i) => i.estado_item === 'POSEE' && i.pago_id === 555));
  // Confirmar dos veces no vuelve a tocar nada (segundo abono parcial).
  assert.equal(await merchService.confirmarMerchDeCuenta(db, 1, 556), 0);
});

test('pago rechazado / cuenta vencida: se repone el stock y se borran las reservas', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [1, 2, 2] });
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 3);

  const liberados = await merchService.liberarMerchDeCuenta(db, 1);
  assert.equal(liberados, 3);
  assert.equal(db.estado.items.length, 0);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 10);
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 5);
});

test('liberar no toca lo ya pagado (POSEE) ni falla sin reservas', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [1] });
  await merchService.confirmarMerchDeCuenta(db, 1, 9);

  assert.equal(await merchService.liberarMerchDeCuenta(db, 1), 0);
  assert.equal(db.estado.items.length, 1);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 9);
});

// ------------------------------------------------------------------- estados
test('DEVUELTO repone stock; PERDIDO no; RESERVADO y DEVUELTO no se pueden mover', async () => {
  const db = crearDb({ productos });
  await merchService.comprarIndependiente({ alumno_id: 7, merch_ids: [1, 1], metodo_pago_id: 1 }, 99, db);
  const [a, b] = db.estado.items;
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 8);

  await merchService.cambiarEstadoItem(a.id, 'PERDIDO', db);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 8);

  await merchService.cambiarEstadoItem(b.id, 'DEVUELTO', db);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 9);
  await assert.rejects(merchService.cambiarEstadoItem(b.id, 'POSEE', db), { statusCode: 409 });

  db.estado.items.push({ id: 900, estado_item: 'RESERVADO', merch_id: 1 });
  await assert.rejects(merchService.cambiarEstadoItem(900, 'PERDIDO', db), { statusCode: 409 });
});

test('métricas: DEVUELTO y RESERVADO no cuentan como ingreso de merch', async () => {
  const db = crearDb({ productos });
  db.estado.items.push(
    { id: 1, merch_id: 1, estado_item: 'POSEE', monto_pagado: 50 },
    { id: 2, merch_id: 1, estado_item: 'PERDIDO', monto_pagado: 50 },
    { id: 3, merch_id: 1, estado_item: 'DEVUELTO', monto_pagado: 50 },
    { id: 4, merch_id: 2, estado_item: 'RESERVADO', monto_pagado: 33.33 }
  );
  // El fake solo entiende filtros de igualdad/in/gte, que es lo que usa este método.
  db.alumno_merch.findMany = async ({ where }) =>
    db.estado.items.filter((i) => where.estado_item.in.includes(i.estado_item));

  assert.equal(await merchService.sumarIngresosMerch(db), 100);
});
