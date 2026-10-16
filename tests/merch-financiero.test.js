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

  const cuentaCoincide = (c, where = {}) => {
    const { alumno_merch, inscripciones_deudas_link, estado: est, fecha_vencimiento, ...simples } = where;
    if (!coincide(c, simples)) return false;
    if (est && !(est.in ? est.in.includes(c.estado) : c.estado === est)) return false;
    if (fecha_vencimiento?.lt && !(c.fecha_vencimiento < fecha_vencimiento.lt)) return false;
    if (alumno_merch && !estado.items.some((i) => i.cuenta_id === c.id)) return false;
    if (inscripciones_deudas_link && estado.links.some((l) => l.cuenta_id === c.id)) return false;
    return true;
  };

  const db = {
    estado,
    $transaction: async (fn) => fn(db),
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
      findUnique: async ({ where }) => estado.cuentas.find((c) => c.id === where.id) ?? null,
      // Entiende los filtros que usa el módulo: id/alumno_id/estado/fecha y los dos
      // de relación (alumno_merch some, inscripciones_deudas_link none), calculados a mano.
      findMany: async ({ where }) => estado.cuentas.filter((c) => cuentaCoincide(c, where)),
      count: async ({ where }) => estado.cuentas.filter((c) => cuentaCoincide(c, where)).length,
      delete: async ({ where }) => {
        const i = estado.cuentas.findIndex((c) => c.id === where.id);
        return estado.cuentas.splice(i, 1)[0];
      },
    },
    pagos: {
      create: async ({ data }) => {
        const p = { id: ++seq, ...data };
        estado.pagos.push(p);
        return p;
      },
      count: async ({ where }) => estado.pagos.filter((p) => p.cuenta_id === where.cuenta_id).length,
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
      count: async ({ where }) => estado.links.filter((l) => l.cuenta_id === where.cuenta_id).length,
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

// ------------------------------------------------------- orden del alumno
test('orden del alumno: cuenta PENDIENTE por el total, ítems RESERVADO y stock reservado', async () => {
  const db = crearDb({ productos });
  const r = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 2, 2, 2] }, db);

  assert.equal(r.total_a_pagar, 149.99);
  assert.ok(Number.isInteger(r.cuenta_id)); // el front abre el modal de pagos con esto

  const [cuenta] = db.estado.cuentas;
  assert.equal(cuenta.id, r.cuenta_id);
  assert.equal(cuenta.estado, 'PENDIENTE');
  assert.equal(cuenta.monto_final, 149.99);
  assert.equal(cuenta.alumno_id, 7);

  assert.equal(db.estado.items.length, 4);
  assert.ok(db.estado.items.every((i) => i.estado_item === 'RESERVADO' && i.cuenta_id === cuenta.id));
  assert.equal(sumarMontos(db.estado.items.map((i) => i.monto_pagado)), cuenta.monto_final);

  // Reservar no cobra: ningún pago hasta que el alumno suba el voucher.
  assert.equal(db.estado.pagos.length, 0);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 9);
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 2);
});

test('orden del alumno: sin stock = 409 y no deja nada reservado', async () => {
  const db = crearDb({ productos });
  await assert.rejects(
    merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 2, 2, 2, 2, 2, 2] }, db),
    { statusCode: 409 }
  );
  assert.equal(db.estado.cuentas.length, 0);
  assert.equal(db.estado.items.length, 0);
});

test('orden del alumno: una sola orden abierta por alumno (anti-acaparamiento)', async () => {
  const db = crearDb({ productos });
  await merchService.crearOrden({ alumno_id: 7, merch_ids: [1] }, db);
  await assert.rejects(merchService.crearOrden({ alumno_id: 7, merch_ids: [2] }, db), {
    statusCode: 409,
  });
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 5);
});

test('orden del alumno: alumno inexistente = 404', async () => {
  const db = crearDb({ productos });
  await assert.rejects(merchService.crearOrden({ alumno_id: 555, merch_ids: [1] }, db), {
    statusCode: 404,
  });
});

test('orden del alumno: el pago se etiqueta MERCH (no MIXTO) y es una cuenta solo-merch', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1] }, db);

  assert.equal(await merchService.tipoTransaccionDeCuenta(db, cuenta_id), 'MERCH');
  assert.equal(await merchService.esCuentaSoloMerch(db, cuenta_id), true);

  // Una matrícula con merch NO es solo-merch y se etiqueta MIXTO.
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [2] });
  assert.equal(await merchService.tipoTransaccionDeCuenta(db, 1), 'MIXTO');
  assert.equal(await merchService.esCuentaSoloMerch(db, 1), false);
});

test('orden del alumno: aprobar el voucher la convierte en POSEE; rechazarlo repone el stock', async () => {
  const aprobada = crearDb({ productos });
  const a = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 1] }, aprobada);
  await merchService.confirmarMerchDeCuenta(aprobada, a.cuenta_id, 321);
  assert.ok(aprobada.estado.items.every((i) => i.estado_item === 'POSEE' && i.pago_id === 321));
  assert.equal(aprobada.estado.merch.find((m) => m.id === 1).stock, 8);

  const rechazada = crearDb({ productos });
  const r = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 1] }, rechazada);
  await merchService.liberarMerchDeCuenta(rechazada, r.cuenta_id);
  assert.equal(rechazada.estado.items.length, 0);
  assert.equal(rechazada.estado.merch.find((m) => m.id === 1).stock, 10);
});

test('cron: la orden vencida sin pago se borra y devuelve el stock; la vigente y la POR_VALIDAR no se tocan', async () => {
  const db = crearDb({ productos });
  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - 24 * 3600 * 1000);

  // Tres órdenes de tres alumnos distintos (el fake no valida alumnos en reservarParaCuenta).
  for (const [id, estado, vence] of [
    [201, 'PENDIENTE', ayer], // vencida -> se libera
    [202, 'PENDIENTE', new Date(hoy.getTime() + 24 * 3600 * 1000)], // vigente
    [203, 'POR_VALIDAR', ayer], // ya tiene voucher esperando al admin
  ]) {
    db.estado.cuentas.push({ id, alumno_id: 7, monto_final: 50, estado, fecha_vencimiento: vence });
    await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: id, merch_ids: [1] });
  }
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 7);

  const liberadas = await merchService.limpiarOrdenesVencidas(db);

  assert.equal(liberadas, 1);
  assert.deepEqual(db.estado.cuentas.map((c) => c.id), [202, 203]);
  assert.equal(db.estado.items.length, 2);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 8);
});

// ------------------------------------------- pago completo (vital) y cancelación
test('pago PARCIAL aprobado NO entrega la mercancía; el pago que completa la deuda sí', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 2] }, db);

  // Abono parcial aprobado: deuda aún > 0, cuenta queda PARCIAL.
  const parcial = await merchService.procesarPagoValidado(db, {
    cuentaId: cuenta_id, pagoId: 1, esAprobado: true, esPagoCompleto: false, nuevoEstadoDeuda: 'PARCIAL',
  });
  assert.deepEqual(parcial, { confirmados: 0, liberados: 0 });
  assert.ok(db.estado.items.every((i) => i.estado_item === 'RESERVADO'));

  // Segundo abono deja la deuda en 0: ahora sí POSEE, ligado al pago que la cerró.
  const total = await merchService.procesarPagoValidado(db, {
    cuentaId: cuenta_id, pagoId: 2, esAprobado: true, esPagoCompleto: true, nuevoEstadoDeuda: 'PAGADA',
  });
  assert.equal(total.confirmados, 2);
  assert.ok(db.estado.items.every((i) => i.estado_item === 'POSEE' && i.pago_id === 2));
});

test('pago único completo: la orden pasa directo a POSEE', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1] }, db);
  const r = await merchService.procesarPagoValidado(db, {
    cuentaId: cuenta_id, pagoId: 5, esAprobado: true, esPagoCompleto: true, nuevoEstadoDeuda: 'PAGADA',
  });
  assert.equal(r.confirmados, 1);
});

test('rechazo sin abonos previos libera la reserva; con un abono previo la conserva', async () => {
  const sinAbonos = crearDb({ productos });
  const a = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 1] }, sinAbonos);
  const r1 = await merchService.procesarPagoValidado(sinAbonos, {
    cuentaId: a.cuenta_id, pagoId: 1, esAprobado: false, esPagoCompleto: false, nuevoEstadoDeuda: 'RECHAZADO',
  });
  assert.equal(r1.liberados, 2);
  assert.equal(sinAbonos.estado.items.length, 0);
  assert.equal(sinAbonos.estado.merch.find((m) => m.id === 1).stock, 10);

  const conAbono = crearDb({ productos });
  const b = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 1] }, conAbono);
  const r2 = await merchService.procesarPagoValidado(conAbono, {
    cuentaId: b.cuenta_id, pagoId: 2, esAprobado: false, esPagoCompleto: false, nuevoEstadoDeuda: 'PARCIAL',
  });
  assert.equal(r2.liberados, 0);
  assert.equal(conAbono.estado.items.length, 2); // ya hay plata pagada sobre estos ítems
  assert.equal(conAbono.estado.merch.find((m) => m.id === 1).stock, 8);
});

test('combo matrícula+merch: un abono parcial tampoco entrega el merch', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [2] });
  await merchService.procesarPagoValidado(db, {
    cuentaId: 1, pagoId: 1, esAprobado: true, esPagoCompleto: false, nuevoEstadoDeuda: 'PARCIAL',
  });
  assert.equal(db.estado.items[0].estado_item, 'RESERVADO');
});

test('cancelar orden: borra los RESERVADO, repone el stock al instante y elimina la cuenta', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 2, 2] }, db);
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 3);

  const r = await merchService.cancelarOrden(cuenta_id, { id: 7, rol: 'Alumno' }, db);

  assert.equal(r.items_liberados, 3);
  assert.equal(db.estado.cuentas.length, 0);
  assert.equal(db.estado.items.length, 0);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 10);
  assert.equal(db.estado.merch.find((m) => m.id === 2).stock, 5);

  // Tras cancelar puede crear otra orden (ya no hay una abierta).
  await merchService.crearOrden({ alumno_id: 7, merch_ids: [1] }, db);
});

test('cancelar orden: otro alumno = 403; inexistente = 404; el Administrador sí puede', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1] }, db);

  await assert.rejects(merchService.cancelarOrden(cuenta_id, { id: 8, rol: 'Alumno' }, db), { statusCode: 403 });
  await assert.rejects(merchService.cancelarOrden(9999, { id: 7, rol: 'Alumno' }, db), { statusCode: 404 });
  assert.equal(db.estado.items.length, 1); // intacta

  await merchService.cancelarOrden(cuenta_id, { id: 1, rol: 'Administrador' }, db);
  assert.equal(db.estado.items.length, 0);
});

test('cancelar orden: solo PENDIENTE, solo-merch y sin pagos registrados', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [1] }, db);
  const solicitante = { id: 7, rol: 'Alumno' };

  // Ya envió voucher -> POR_VALIDAR: espera al admin.
  db.estado.cuentas[0].estado = 'POR_VALIDAR';
  await assert.rejects(merchService.cancelarOrden(cuenta_id, solicitante, db), { statusCode: 409 });

  // PENDIENTE pero con un pago colgando (no debería existir): tampoco se borra.
  db.estado.cuentas[0].estado = 'PENDIENTE';
  db.estado.pagos.push({ id: 1, cuenta_id });
  await assert.rejects(merchService.cancelarOrden(cuenta_id, solicitante, db), { statusCode: 409 });
  assert.equal(db.estado.items.length, 1);
  assert.equal(db.estado.merch.find((m) => m.id === 1).stock, 9);

  // Una matrícula (con links) no es una orden de merch: no se cancela por acá.
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [2] });
  await assert.rejects(merchService.cancelarOrden(1, solicitante, db), { statusCode: 409 });
});

// ------------------------------------------ detalle_adicional que lee el admin
test('orden del alumno: detalle_adicional lista lo pedido para que el admin sepa qué entregar', async () => {
  const db = crearDb({
    productos: [
      { id: 1, nombre: 'Camiseta Oficial GEMA', precio: 50, stock: 10 },
      { id: 2, nombre: 'Gorra', precio: 30, stock: 10 },
    ],
  });
  await merchService.crearOrden({ alumno_id: 7, merch_ids: [1, 2, 2] }, db);

  assert.equal(db.estado.cuentas[0].detalle_adicional, 'Orden Merch: Camiseta Oficial GEMA x1, Gorra x2');
});

test('el detalle de la orden sobrevive al ciclo de pago (no lo pisa nadie)', async () => {
  const db = crearDb({ productos });
  const { cuenta_id } = await merchService.crearOrden({ alumno_id: 7, merch_ids: [2, 2] }, db);
  await merchService.procesarPagoValidado(db, {
    cuentaId: cuenta_id, pagoId: 1, esAprobado: true, esPagoCompleto: true, nuevoEstadoDeuda: 'PAGADA',
  });
  assert.equal(db.estado.cuentas[0].detalle_adicional, 'Orden Merch: Gorra x2');
});

test('quitarDetalleMerch: un producto "Camiseta" no se confunde con el recargo legacy', async () => {
  const { quitarDetalleMerch } = await import('../src/features/merch/logic/merch.logic.js');
  const detalle = 'Plan 2 clases/semana | Merch: Camiseta Oficial GEMA x1 | Plan Actualizado';
  assert.equal(quitarDetalleMerch(detalle), 'Plan 2 clases/semana | Plan Actualizado');
  assert.equal(quitarDetalleMerch('Orden Merch: Camiseta x1'), '');
  // El recargo legacy sigue detectándose.
  assert.ok(quitarDetalleMerch('Plan 2 clases/semana | Camiseta Oficial Gema').toLowerCase().includes('camiseta'));
  assert.equal(quitarDetalleMerch(null), '');
});

test('sumarMerchDeCuenta: separarYFinalizar conserva el merch al recalcular el plan', async () => {
  const db = crearDb({ productos });
  cuentaDeMatricula(db);
  await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [2, 2, 2] });
  assert.equal(await merchService.sumarMerchDeCuenta(db, 1), 99.99);
  // Una unidad devuelta/perdida de otra cuenta no se mezcla.
  db.estado.items.push({ id: 700, cuenta_id: 2, estado_item: 'POSEE', monto_pagado: 50 });
  assert.equal(await merchService.sumarMerchDeCuenta(db, 1), 99.99);
});
