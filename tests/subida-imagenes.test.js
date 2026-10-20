import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
  detectarFormatoImagen,
  subirImagen,
  MAX_BYTES_IMAGEN,
} from '../src/shared/middlewares/upload.middleware.js';
import { errorHandler } from '../src/shared/middlewares/error.middleware.js';
import { aplicarEntrega } from '../src/features/cloudinaryImg/cloudinary.service.js';

// Cabeceras reales de cada formato (+ relleno): lo que mira el servidor, no la etiqueta.
const relleno = Buffer.alloc(32, 1);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), relleno]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), relleno]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP'), relleno]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), relleno]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test('detectarFormatoImagen: reconoce JPG, PNG y WEBP por sus bytes', () => {
  assert.equal(detectarFormatoImagen(JPEG), 'image/jpeg');
  assert.equal(detectarFormatoImagen(PNG), 'image/png');
  assert.equal(detectarFormatoImagen(WEBP), 'image/webp');
});

test('detectarFormatoImagen: rechaza SVG, GIF, texto, vacío y buffers truncados', () => {
  for (const malo of [SVG, GIF, Buffer.from('hola mundo, esto no es una imagen'), Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) {
    assert.equal(detectarFormatoImagen(malo), null);
  }
  assert.equal(detectarFormatoImagen(null), null);
  assert.equal(detectarFormatoImagen('texto'), null);
});

// ------------------------------------------------------ middleware real sobre HTTP
const levantar = async () => {
  const app = express();
  app.use(express.json());
  app.post('/subir', subirImagen('imagen'), (req, res) =>
    res.json({
      archivo: req.file ? { mimetype: req.file.mimetype, bytes: req.file.size } : null,
      nombre: req.body?.nombre ?? null,
    })
  );
  app.use(errorHandler);
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { servidor, url: `http://127.0.0.1:${servidor.address().port}/subir` };
};

const enviar = (url, buffer, tipoDeclarado, nombreArchivo = 'foto.bin') => {
  const form = new FormData();
  form.append('nombre', 'Polo');
  form.append('imagen', new Blob([buffer], { type: tipoDeclarado }), nombreArchivo);
  return fetch(url, { method: 'POST', body: form });
};

test('subirImagen: acepta JPG, PNG y WEBP legítimos', async () => {
  const { servidor, url } = await levantar();
  try {
    for (const [buf, tipo] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']]) {
      const res = await enviar(url, buf, tipo);
      assert.equal(res.status, 200, `${tipo} debería aceptarse`);
      const cuerpo = await res.json();
      assert.equal(cuerpo.archivo.mimetype, tipo);
      assert.equal(cuerpo.nombre, 'Polo');
    }
  } finally {
    servidor.close();
  }
});

test('subirImagen: rechaza SVG y GIF con 400 aunque sean "image/*"', async () => {
  const { servidor, url } = await levantar();
  try {
    for (const [buf, tipo] of [[SVG, 'image/svg+xml'], [GIF, 'image/gif']]) {
      const res = await enviar(url, buf, tipo);
      assert.equal(res.status, 400, `${tipo} debería rechazarse`);
      assert.match((await res.json()).message, /JPG, PNG o WEBP/);
    }
  } finally {
    servidor.close();
  }
});

test('subirImagen: un SVG disfrazado de PNG se detecta por su contenido (400)', async () => {
  const { servidor, url } = await levantar();
  try {
    const res = await enviar(url, SVG, 'image/png', 'logo.png');
    assert.equal(res.status, 400);
  } finally {
    servidor.close();
  }
});

test('subirImagen: manda el formato real del contenido, no la etiqueta del cliente', async () => {
  const { servidor, url } = await levantar();
  try {
    const res = await enviar(url, PNG, 'image/jpeg', 'foto.jpg'); // dice JPEG pero es PNG
    assert.equal(res.status, 200);
    assert.equal((await res.json()).archivo.mimetype, 'image/png');
  } finally {
    servidor.close();
  }
});

test('subirImagen: supera el máximo = 400 con mensaje claro (no 500)', async () => {
  const { servidor, url } = await levantar();
  try {
    const enorme = Buffer.concat([JPEG, Buffer.alloc(MAX_BYTES_IMAGEN + 1024)]);
    const res = await enviar(url, enorme, 'image/jpeg');
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /5 MB/);
  } finally {
    servidor.close();
  }
});

test('subirImagen: sin archivo o con JSON el body pasa intacto (fallback de clientes viejos)', async () => {
  const { servidor, url } = await levantar();
  try {
    const json = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Gorra' }),
    });
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { archivo: null, nombre: 'Gorra' });

    const form = new FormData();
    form.append('nombre', 'Balón');
    const sinArchivo = await fetch(url, { method: 'POST', body: form });
    assert.equal(sinArchivo.status, 200);
    assert.deepEqual(await sinArchivo.json(), { archivo: null, nombre: 'Balón' });
  } finally {
    servidor.close();
  }
});

// ------------------------------------------------------ transformación de Cloudinary
test('aplicarEntrega: inserta f_auto,q_auto en la URL de entrega', () => {
  assert.equal(
    aplicarEntrega('https://res.cloudinary.com/demo/image/upload/v1700000000/merch/a.jpg', 'f_auto,q_auto'),
    'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/v1700000000/merch/a.jpg'
  );
});

test('aplicarEntrega: es idempotente y no toca URLs ajenas ni vacías', () => {
  const ya = 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/v1/merch/a.jpg';
  assert.equal(aplicarEntrega(ya, 'f_auto,q_auto'), ya);

  const ajena = 'https://cdn.ejemplo.com/foto.jpg';
  assert.equal(aplicarEntrega(ajena, 'f_auto,q_auto'), ajena);

  const sinTransformacion = 'https://res.cloudinary.com/demo/image/upload/v1/merch/a.jpg';
  assert.equal(aplicarEntrega(sinTransformacion, undefined), sinTransformacion);
  assert.equal(aplicarEntrega(undefined, 'f_auto,q_auto'), undefined);
});
