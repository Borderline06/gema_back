import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { merchService } from '../src/features/merch/merch.service.js';
import { calcularSplitIngresos, CONCEPTO_INGRESO } from '../src/features/merch/logic/merch.logic.js';
import { sumarMontos } from '../src/shared/utils/dinero.util.js';

// ----------------------------------------------------------- split de ingresos (puro)
test('split: pago único MIXTO separa merch y matrícula exactos', () => {
  const r = calcularSplitIngresos({
    montoPago: 450,
    montoCuenta: 450,
    merchTotal: 50,
    esPagoCompleto: true,
  });
  assert.deepEqual(r, { merch: 50, matricula: 400 });
});

test('split: sin merch todo es matrícula; solo merch todo es merch', () => {
  assert.deepEqual(
    calcularSplitIngresos({ montoPago: 400, montoCuenta: 400, merchTotal: 0, esPagoCompleto: true }),
    { merch: 0, matricula: 400 }
  );
  assert.deepEqual(
    calcularSplitIngresos({ montoPago: 83.33, montoCuenta: 83.33, merchTotal: 83.33, esPagoCompleto: true }),
    { merch: 83.33, matricula: 0 }
  );
});

test('split: abonos parciales son proporcionales y el que completa cierra el merch al céntimo', () => {
  const montoCuenta = 450;
  const merchTotal = 50;

  const p1 = calcularSplitIngresos({ montoPago: 100, montoCuenta, merchTotal, esPagoCompleto: false });
  assert.deepEqual(p1, { merch: 11.11, matricula: 88.89 });

  const p2 = calcularSplitIngresos({
    montoPago: 150,
    montoCuenta,
    merchTotal,
    merchYaRegistrado: p1.merch,
    esPagoCompleto: false,
  });
  assert.deepEqual(p2, { merch: 16.67, matricula: 133.33 });

  const p3 = calcularSplitIngresos({
    montoPago: 200,
    montoCuenta,
    merchTotal,
    merchYaRegistrado: sumarMontos([p1.merch, p2.merch]),
    esPagoCompleto: true,
  });
  assert.equal(sumarMontos([p1.merch, p2.merch, p3.merch]), merchTotal);
  assert.equal(sumarMontos([p1.matricula, p2.matricula, p3.matricula]), 400);
});

test('split: la parte de merch nunca supera el pago ni lo que falta por registrar', () => {
  const r = calcularSplitIngresos({
    montoPago: 20,
    montoCuenta: 450,
    merchTotal: 50,
    merchYaRegistrado: 50,
    esPagoCompleto: true,
  });
  assert.deepEqual(r, { merch: 0, matricula: 20 });

  const chico = calcularSplitIngresos({ montoPago: 10, montoCuenta: 60, merchTotal: 50, esPagoCompleto: true });
  assert.equal(chico.merch, 10);
  assert.equal(chico.matricula, 0);
});

// ------------------------------------------------- registrarSplitIngresos (con BD en memoria)
const crearTx = ({ items = [], links = [], cuenta, pagos = [] }) => {
  const estado = { items, links, cuenta, pagos, movimientos: [] };
  let seq = 500;
  return {
    estado,
    alumno_merch: {
      count: async ({ where }) => estado.items.filter((i) => i.cuenta_id === where.cuenta_id).length,
      findMany: async ({ where }) =>
        estado.items.filter(
          (i) => i.cuenta_id === where.cuenta_id && where.estado_item.in.includes(i.estado_item)
        ),
    },
    inscripciones_deudas_link: {
      count: async ({ where }) => estado.links.filter((l) => l.cuenta_id === where.cuenta_id).length,
    },
    cuentas_por_cobrar: { findUnique: async () => estado.cuenta },
    pagos: {
      findMany: async () => estado.pagos.map((p) => ({ id: p.id })),
      aggregate: async () => ({
        _sum: {
          monto_pagado: sumarMontos(
            estado.pagos.filter((p) => p.estado_validacion === 'APROBADO').map((p) => p.monto_pagado)
          ),
        },
      }),
    },
    movimientos_financieros: {
      findMany: async ({ where }) =>
        estado.movimientos.filter((m) => m.concepto === where.concepto && where.pago_id.in.includes(m.pago_id)),
      findFirst: async ({ where }) =>
        estado.movimientos.find((m) => m.pago_id === where.pago_id && m.concepto === where.concepto) ?? null,
      create: async ({ data }) => {
        const m = { id: ++seq, ...data };
        estado.movimientos.push(m);
        return m;
      },
    },
  };
};

const itemsMerch = (cuentaId, n, estado = 'POR_ENTREGAR') =>
  Array.from({ length: n }, () => ({ cuenta_id: cuentaId, estado_item: estado, monto_pagado: 25 }));

test('pago MIXTO aprobado: dos filas separadas (merch + matrícula) ligadas al pago', async () => {
  const pago = { id: 9, cuenta_id: 1, metodo_pago_id: 2, monto_pagado: 450, estado_validacion: 'APROBADO' };
  const tx = crearTx({
    items: itemsMerch(1, 2),
    links: [{ cuenta_id: 1 }],
    cuenta: { monto_final: 450 },
    pagos: [pago],
  });

  const filas = await merchService.registrarSplitIngresos(tx, { pago, usuarioAdminId: '3' });

  assert.equal(filas.length, 2);
  const porConcepto = Object.fromEntries(filas.map((f) => [f.concepto, f]));
  assert.equal(porConcepto[CONCEPTO_INGRESO.MERCH].monto, 50);
  assert.equal(porConcepto[CONCEPTO_INGRESO.MATRICULA].monto, 400);
  for (const f of filas) {
    assert.equal(f.tipo_movimiento, 'INGRESO');
    assert.equal(f.pago_id, 9);
    assert.equal(f.registrado_por, 3);
  }
  assert.equal(sumarMontos(filas.map((f) => f.monto)), pago.monto_pagado);
});

test('pago MERCH puro aprobado: una sola fila INGRESO_MERCH por el total', async () => {
  const pago = { id: 10, cuenta_id: 2, metodo_pago_id: 1, monto_pagado: 50, estado_validacion: 'APROBADO' };
  const tx = crearTx({ items: itemsMerch(2, 2), cuenta: { monto_final: 50 }, pagos: [pago] });

  const filas = await merchService.registrarSplitIngresos(tx, { pago, usuarioAdminId: 3 });
  assert.equal(filas.length, 1);
  assert.equal(filas[0].concepto, CONCEPTO_INGRESO.MERCH);
  assert.equal(filas[0].monto, 50);
});

test('pago de matrícula sin merch: no escribe nada en caja', async () => {
  const pago = { id: 11, cuenta_id: 3, metodo_pago_id: 1, monto_pagado: 400, estado_validacion: 'APROBADO' };
  const tx = crearTx({ links: [{ cuenta_id: 3 }], cuenta: { monto_final: 400 }, pagos: [pago] });

  assert.deepEqual(await merchService.registrarSplitIngresos(tx, { pago, usuarioAdminId: 3 }), []);
  assert.equal(tx.estado.movimientos.length, 0);
});

test('registrar el split dos veces para el mismo pago no duplica filas', async () => {
  const pago = { id: 12, cuenta_id: 1, metodo_pago_id: 1, monto_pagado: 450, estado_validacion: 'APROBADO' };
  const tx = crearTx({
    items: itemsMerch(1, 2),
    links: [{ cuenta_id: 1 }],
    cuenta: { monto_final: 450 },
    pagos: [pago],
  });

  await merchService.registrarSplitIngresos(tx, { pago, usuarioAdminId: 3 });
  const segunda = await merchService.registrarSplitIngresos(tx, { pago, usuarioAdminId: 3 });
  assert.equal(segunda.length, 0);
  assert.equal(tx.estado.movimientos.length, 2);
});

test('abonos de una cuenta MIXTO: el merch acumulado cierra exacto en el último pago', async () => {
  const pagos = [
    { id: 20, cuenta_id: 1, metodo_pago_id: 1, monto_pagado: 100, estado_validacion: 'APROBADO' },
    { id: 21, cuenta_id: 1, metodo_pago_id: 1, monto_pagado: 350, estado_validacion: 'PENDIENTE' },
  ];
  const tx = crearTx({
    items: itemsMerch(1, 2),
    links: [{ cuenta_id: 1 }],
    cuenta: { monto_final: 450 },
    pagos,
  });

  await merchService.registrarSplitIngresos(tx, { pago: pagos[0], usuarioAdminId: 3 });
  pagos[1].estado_validacion = 'APROBADO';
  await merchService.registrarSplitIngresos(tx, { pago: pagos[1], usuarioAdminId: 3 });

  const sumaPor = (concepto) =>
    sumarMontos(tx.estado.movimientos.filter((m) => m.concepto === concepto).map((m) => m.monto));
  assert.equal(sumaPor(CONCEPTO_INGRESO.MERCH), 50);
  assert.equal(sumaPor(CONCEPTO_INGRESO.MATRICULA), 400);
});

// ------------------------------------------------------------ imágenes en Cloudinary
const crearNube = () => {
  const llamadas = { upload: [], destroy: [] };
  let n = 0;
  return {
    llamadas,
    upload: async (archivo, carpeta, opciones) => {
      llamadas.upload.push({ archivo, carpeta, opciones });
      n += 1;
      return { url: `https://res.cloudinary.com/demo/${carpeta}/nueva${n}.jpg`, publicId: `${carpeta}/nueva${n}` };
    },
    destroy: async (publicId) => {
      llamadas.destroy.push(publicId);
      return true;
    },
  };
};

const crearDbProductos = (filas, { fallaEscritura = false } = {}) => {
  const estado = { merch: filas.map((f) => ({ ...f })), ventas: [] };
  return {
    estado,
    merch: {
      // Copia, como Prisma: una lectura previa no debe cambiar cuando se actualiza la fila.
      findUnique: async ({ where }) => {
        const m = estado.merch.find((x) => x.id === where.id);
        return m ? { ...m } : null;
      },
      create: async ({ data }) => {
        if (fallaEscritura) throw new Error('BD caída');
        const m = { id: 50, ...data };
        estado.merch.push(m);
        return m;
      },
      update: async ({ where, data }) => {
        if (fallaEscritura) throw new Error('BD caída');
        return Object.assign(estado.merch.find((m) => m.id === where.id), data);
      },
      delete: async ({ where }) => {
        const i = estado.merch.findIndex((m) => m.id === where.id);
        return estado.merch.splice(i, 1)[0];
      },
    },
    alumno_merch: { count: async ({ where }) => estado.ventas.filter((v) => v.merch_id === where.merch_id).length },
  };
};

const archivo = { originalname: 'polo.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg' };

test('crear con archivo: sube a Cloudinary y guarda secure_url + public_id', async () => {
  const nube = crearNube();
  const db = crearDbProductos([]);
  const r = await merchService.crear({ nombre: 'Polo', precio: 40, stock: 3, estado: 'ACTIVO' }, archivo, { db, nube });

  assert.equal(nube.llamadas.upload[0].carpeta, 'merch');
  // Se guarda reducido (800 px máx., calidad auto) y se sirve con formato/calidad automáticos.
  assert.deepEqual(nube.llamadas.upload[0].opciones, {
    transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    entrega: 'f_auto,q_auto',
  });
  assert.equal(r.imagen_url, 'https://res.cloudinary.com/demo/merch/nueva1.jpg');
  assert.equal(r.imagen_public_id, 'merch/nueva1');
});

test('crear: si la BD falla se borra el asset recién subido (sin basura en la nube)', async () => {
  const nube = crearNube();
  const db = crearDbProductos([], { fallaEscritura: true });
  await assert.rejects(
    merchService.crear({ nombre: 'Polo', precio: 40, stock: 3, estado: 'ACTIVO' }, archivo, { db, nube }),
    /BD caída/
  );
  assert.deepEqual(nube.llamadas.destroy, ['merch/nueva1']);
});

test('crear por JSON (Base64 legacy): sigue funcionando y no toca Cloudinary', async () => {
  const nube = crearNube();
  const db = crearDbProductos([]);
  const r = await merchService.crear(
    { nombre: 'Gorra', precio: 20, stock: 1, estado: 'ACTIVO', imagen_url: 'data:image/jpeg;base64,AAAA' },
    undefined,
    { db, nube }
  );
  assert.equal(r.imagen_url, 'data:image/jpeg;base64,AAAA');
  assert.equal(r.imagen_public_id, null);
  assert.equal(nube.llamadas.upload.length, 0);
});

test('actualizar con foto nueva: guarda la nueva y borra la anterior de Cloudinary', async () => {
  const nube = crearNube();
  const db = crearDbProductos([{ id: 1, nombre: 'Polo', imagen_url: 'https://x/vieja.jpg', imagen_public_id: 'merch/vieja' }]);
  const r = await merchService.actualizar(1, { nombre: 'Polo 2' }, archivo, { db, nube });

  assert.equal(r.imagen_public_id, 'merch/nueva1');
  assert.deepEqual(nube.llamadas.destroy, ['merch/vieja']);
});

test('actualizar sin tocar la foto no llama a Cloudinary', async () => {
  const nube = crearNube();
  const db = crearDbProductos([{ id: 1, nombre: 'Polo', imagen_url: 'https://x/a.jpg', imagen_public_id: 'merch/a' }]);
  await merchService.actualizar(1, { precio: 45 }, undefined, { db, nube });

  assert.equal(nube.llamadas.upload.length, 0);
  assert.equal(nube.llamadas.destroy.length, 0);
  assert.equal(db.estado.merch[0].imagen_public_id, 'merch/a');
});

test('actualizar: eliminar_imagen quita la foto y borra el asset; un Base64 legacy no tiene asset que borrar', async () => {
  const nube = crearNube();
  const db = crearDbProductos([
    { id: 1, nombre: 'Polo', imagen_url: 'https://x/a.jpg', imagen_public_id: 'merch/a' },
    { id: 2, nombre: 'Gorra', imagen_url: 'data:image/jpeg;base64,AAAA', imagen_public_id: null },
  ]);

  await merchService.actualizar(1, { eliminar_imagen: true }, undefined, { db, nube });
  assert.equal(db.estado.merch[0].imagen_url, null);
  assert.equal(db.estado.merch[0].imagen_public_id, null);
  assert.deepEqual(nube.llamadas.destroy, ['merch/a']);

  await merchService.actualizar(2, {}, archivo, { db, nube });
  assert.equal(db.estado.merch[1].imagen_public_id, 'merch/nueva1');
  assert.deepEqual(nube.llamadas.destroy, ['merch/a']); // el Base64 no generó destroy
});

test('actualizar: si la BD falla se descarta el asset nuevo y se conserva el anterior', async () => {
  const nube = crearNube();
  const db = crearDbProductos([{ id: 1, nombre: 'Polo', imagen_public_id: 'merch/vieja' }], { fallaEscritura: true });
  await assert.rejects(merchService.actualizar(1, { nombre: 'X' }, archivo, { db, nube }), /BD caída/);
  assert.deepEqual(nube.llamadas.destroy, ['merch/nueva1']);
});

test('actualizar: sin campos ni archivo = 400; producto inexistente = 404', async () => {
  const nube = crearNube();
  const db = crearDbProductos([{ id: 1, nombre: 'Polo' }]);
  await assert.rejects(merchService.actualizar(1, {}, undefined, { db, nube }), { statusCode: 400 });
  await assert.rejects(merchService.actualizar(99, { nombre: 'X' }, undefined, { db, nube }), { statusCode: 404 });
});

test('eliminar: borra el producto y su asset; con ventas = 409 y no borra nada', async () => {
  const nube = crearNube();
  const db = crearDbProductos([
    { id: 1, nombre: 'Polo', imagen_public_id: 'merch/a' },
    { id: 2, nombre: 'Gorra', imagen_public_id: 'merch/b' },
  ]);
  db.estado.ventas.push({ merch_id: 2 });

  await merchService.eliminar(1, { db, nube });
  assert.equal(db.estado.merch.length, 1);
  assert.deepEqual(nube.llamadas.destroy, ['merch/a']);

  await assert.rejects(merchService.eliminar(2, { db, nube }), { statusCode: 409 });
  assert.equal(db.estado.merch.length, 1);
  assert.deepEqual(nube.llamadas.destroy, ['merch/a']);

  await assert.rejects(merchService.eliminar(77, { db, nube }), { statusCode: 404 });
});

// ------------------------------------------------------- merch fuera de las renovaciones
// Contrato de código (no hay Postgres en los tests): las rutas que generan la cuenta de una
// renovación solo cobran el plan del catálogo. Si alguien les agrega merch, este test avisa.
const leer = (ruta) => readFileSync(new URL(ruta, import.meta.url), 'utf8');

test('renovación histórica: inscribirPaquete se llama sin merch_ids ni sede_recojo_id', () => {
  const fuente = leer('../src/features/inscripciones/renovacion-historica.service.js');
  const llamada = fuente.slice(fuente.indexOf('inscribirPaquete({'));
  const argumentos = llamada.slice(0, llamada.indexOf('});'));
  assert.doesNotMatch(argumentos, /merch_ids|sede_recojo_id/);
});

test('renovación de paquete: la cuenta nueva sale del catálogo, sin lógica de merch', () => {
  const fuente = leer('../src/features/cuenta_por_cobrar/cuentas_por_cobrar.service.js');
  for (const nombre of ['async generarRenovacionPaquete(', 'async generarRenovacionPaqueteValidado(']) {
    const inicio = fuente.indexOf(nombre);
    assert.ok(inicio >= 0, `no se encontró ${nombre}`);
    const cuerpo = fuente.slice(inicio, fuente.indexOf('detalle_adicional', inicio));
    assert.match(cuerpo, /monto_final: montoTotal/);
    assert.match(cuerpo, /redondear2\(conceptoPaquete\.precio_base\)/);
    assert.doesNotMatch(cuerpo.replace(/\/\/.*$/gm, ''), /merch|alumno_merch/i);
  }
});
