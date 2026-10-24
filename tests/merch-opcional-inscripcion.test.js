import test from 'node:test';
import assert from 'node:assert/strict';
import { merchService } from '../src/features/merch/merch.service.js';
import { CODIGO_MERCH_AGOTADO, construirLineas } from '../src/features/merch/logic/merch.logic.js';

/**
 * El merch de la inscripción es OPCIONAL y, si se agota entre que el alumno lo elige y
 * confirma, el error lleva un código estable para que el front ofrezca seguir solo con
 * la matrícula. BD mínima: solo lo que toca reservarParaCuenta.
 */
const crearDb = ({ productos = [], carrera = false } = {}) => {
  const estado = { merch: productos.map((p) => ({ estado: 'ACTIVO', ...p })), items: [] };
  return {
    estado,
    sedes: { findUnique: async ({ where }) => (where.id === 1 ? { id: 1, nombre: 'Miraflores', activo: true } : null) },
    merch: {
      findMany: async () => estado.merch,
      // `carrera` simula que otro alumno se llevó el último producto después del findMany.
      updateMany: async () => ({ count: carrera ? 0 : 1 }),
    },
    alumno_merch: {
      createMany: async ({ data }) => {
        estado.items.push(...data);
        return { count: data.length };
      },
    },
  };
};

const productos = [{ id: 1, nombre: 'Camiseta', precio: 50, stock: 2 }];

for (const merch_ids of [undefined, null, []]) {
  test(`merch opcional: merch_ids ${JSON.stringify(merch_ids)} no exige sede ni toca el stock`, async () => {
    const db = crearDb({ productos });
    const r = await merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids });
    assert.equal(r.total, 0);
    assert.deepEqual(r.lineas, []);
    assert.equal(db.estado.items.length, 0);
  });
}

test('stock agotado en el catálogo: 409 con código MERCH_STOCK_AGOTADO', () => {
  assert.throws(
    () => construirLineas([{ merch_id: 1, cantidad: 3 }], [{ id: 1, nombre: 'Camiseta', precio: 50, stock: 2, estado: 'ACTIVO' }]),
    (e) => e.statusCode === 409 && e.details?.code === CODIGO_MERCH_AGOTADO
  );
});

test('producto desactivado o borrado también lleva el código (el front ofrece seguir sin merch)', () => {
  assert.throws(
    () => construirLineas([{ merch_id: 1, cantidad: 1 }], [{ id: 1, nombre: 'Camiseta', precio: 50, stock: 5, estado: 'INACTIVO' }]),
    (e) => e.statusCode === 409 && e.details?.code === CODIGO_MERCH_AGOTADO
  );
  assert.throws(
    () => construirLineas([{ merch_id: 9, cantidad: 1 }], []),
    (e) => e.statusCode === 404 && e.details?.code === CODIGO_MERCH_AGOTADO
  );
});

test('carrera: el último producto se vende entre la lectura y el descuento = 409 con código y sin ítems', async () => {
  const db = crearDb({ productos, carrera: true });
  await assert.rejects(
    merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, sede_recojo_id: 1, merch_ids: [1] }),
    (e) => e.statusCode === 409 && e.details?.code === CODIGO_MERCH_AGOTADO
  );
  assert.equal(db.estado.items.length, 0);
});

test('errores de sede NO llevan el código de agotado (no es un problema de stock)', async () => {
  const db = crearDb({ productos });
  await assert.rejects(
    merchService.reservarParaCuenta(db, { alumno_id: 7, cuenta_id: 1, merch_ids: [1] }),
    (e) => e.statusCode === 400 && !e.details?.code
  );
});
