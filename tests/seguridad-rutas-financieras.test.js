import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pagosRoutes from '../src/features/pagos/pagos.routes.js';
import cuentasRoutes from '../src/features/cuenta_por_cobrar/cuentas_por_cobrar.routes.js';
import beneficiosPendientesRoutes from '../src/features/beneficios_pendientes/beneficios-pendientes.routes.js';
import tiposBeneficioRoutes from '../src/features/tipos_beneficio/tipos_beneficio.routes.js';
import { soloPropioAlumno } from '../src/shared/middlewares/ownership.middleware.js';

/**
 * Los endpoints que mueven o descuentan dinero NO pueden ser públicos. Se montan los routers
 * reales en una app y se llama a CADA ruta sin credenciales: todas deben responder 401 antes
 * de tocar la base de datos. Si alguien agrega una ruta nueva sin `authenticate`, falla aquí.
 */
const ROUTERS = {
  '/api/pagos': pagosRoutes,
  '/api/cuentas-por-cobrar': cuentasRoutes,
  '/api/beneficios-pendientes': beneficiosPendientesRoutes,
  '/api/tipos-beneficio': tiposBeneficioRoutes,
};

const rutasDe = (router) =>
  router.stack
    .filter((capa) => capa.route)
    .flatMap((capa) =>
      Object.keys(capa.route.methods).map((metodo) => ({
        metodo: metodo.toUpperCase(),
        ruta: capa.route.path.replace(/:[A-Za-z_]+/g, '1'),
      }))
    );

const levantar = async () => {
  const app = express();
  app.use(express.json());
  for (const [base, router] of Object.entries(ROUTERS)) app.use(base, router);
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
};

test('toda ruta de pagos, cuentas por cobrar y beneficios exige sesión (401 sin token)', async () => {
  const { servidor, url } = await levantar();
  try {
    let probadas = 0;
    for (const [base, router] of Object.entries(ROUTERS)) {
      for (const { metodo, ruta } of rutasDe(router)) {
        const res = await fetch(`${url}${base}${ruta === '/' ? '' : ruta}`, {
          method: metodo,
          headers: { 'Content-Type': 'application/json' },
          body: metodo === 'GET' || metodo === 'DELETE' ? undefined : '{}',
        });
        assert.equal(res.status, 401, `${metodo} ${base}${ruta} debería exigir autenticación`);
        probadas += 1;
      }
    }
    assert.ok(probadas >= 20, `se esperaban >= 20 rutas, se probaron ${probadas}`);
  } finally {
    servidor.close();
  }
});

test('un token falso también se rechaza (401) y no llega al controlador', async () => {
  const { servidor, url } = await levantar();
  try {
    const res = await fetch(`${url}/api/pagos/validar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token.falso.xyz' },
      body: JSON.stringify({ pago_id: 1, accion: 'APROBAR', usuario_admin_id: 1 }),
    });
    assert.equal(res.status, 401);
  } finally {
    servidor.close();
  }
});

// --------------------------------------------- solo el propio alumno (soloPropioAlumno)
const ejecutar = async (middleware, req) => {
  const res = {
    code: null,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let siguio = false;
  let error = null;
  await middleware(req, res, (e) => { siguio = true; error = e ?? null; });
  return { res, siguio, error };
};

test('soloPropioAlumno: el alumno pasa con su recurso y se bloquea con el de otro', async () => {
  const mw = soloPropioAlumno((req) => Number(req.params.id));

  const propio = await ejecutar(mw, { user: { id: 7, rol_nombre: 'Alumno' }, params: { id: '7' } });
  assert.equal(propio.siguio, true);

  const ajeno = await ejecutar(mw, { user: { id: 7, rol_nombre: 'Alumno' }, params: { id: '8' } });
  assert.equal(ajeno.siguio, false);
  assert.equal(ajeno.res.code, 403);
});

test('soloPropioAlumno: recurso inexistente = 404; el Administrador no se restringe', async () => {
  const resolver = async () => null;
  const inexistente = await ejecutar(soloPropioAlumno(resolver), { user: { id: 7, rol_nombre: 'Alumno' } });
  assert.equal(inexistente.res.code, 404);

  let consultado = false;
  const admin = await ejecutar(
    soloPropioAlumno(async () => { consultado = true; return 99; }),
    { user: { id: 1, rol_nombre: 'Administrador' } }
  );
  assert.equal(admin.siguio, true);
  assert.equal(consultado, false); // ni siquiera consulta la BD
});

test('soloPropioAlumno: si el resolvedor falla, delega al manejador de errores (no deja pasar)', async () => {
  const falla = new Error('BD caída');
  const r = await ejecutar(
    soloPropioAlumno(async () => { throw falla; }),
    { user: { id: 7, rol_nombre: 'Alumno' } }
  );
  assert.equal(r.siguio, true);
  assert.equal(r.error, falla);
  assert.equal(r.res.code, null); // no respondió 200 ni autorizó
});
