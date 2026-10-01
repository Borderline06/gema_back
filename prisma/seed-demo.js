// Datos de demo para probar el frontend contra el backend.
// Uso: npm run db:seed:demo   (solo bases LOCALES; aborta si DATABASE_URL no es localhost)
// Idempotente: se puede ejecutar varias veces sin duplicar registros.
// Todos los usuarios tienen la contraseña PASSWORD (ver abajo).
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();
const PASSWORD = 'Gema1234!';

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  console.error('❌ DATABASE_URL no apunta a localhost. Abortando para no ensuciar una base real.');
  process.exit(1);
}

// ---------- helpers ----------
const hora = (h, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m)); // columnas @db.Time
const hoy = new Date();
const dia = (offset) => {
  // fecha a medianoche UTC, hoy + offset días (columnas @db.Date)
  const d = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};
const findOrCreate = async (model, where, data) =>
  (await prisma[model].findFirst({ where })) ?? prisma[model].create({ data: { ...where, ...data } });

async function crearUsuario({ username, rol, nombres, apellidos, doc, telefono, genero, nacimiento }, hash) {
  const usuario = await prisma.usuarios.upsert({
    where: { username },
    update: {},
    create: {
      username,
      rol_id: rol.id,
      nombres,
      apellidos,
      email: `${username}@demo.gema.com`,
      tipo_documento_id: 'DNI',
      numero_documento: doc,
      telefono_personal: telefono,
      genero,
      fecha_nacimiento: nacimiento ? new Date(nacimiento) : null,
      activo: true,
    },
  });
  await prisma.credenciales_usuario.upsert({
    where: { usuario_id: usuario.id },
    update: { hash_contrasena: hash, bloqueado: false },
    create: { usuario_id: usuario.id, hash_contrasena: hash },
  });
  return usuario;
}

async function main() {
  console.log('🌱 Sembrando datos de demo...');
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ---------- base: roles, documentos, métodos de pago ----------
  const rol = {};
  for (const nombre of ['Alumno', 'Coordinador', 'Administrador']) {
    rol[nombre] = await prisma.roles.upsert({ where: { nombre }, update: {}, create: { nombre, descripcion: nombre } });
  }
  for (const [id, descripcion] of [['DNI', 'Documento Nacional de Identidad'], ['CE', 'Carnet de Extranjería'], ['PAS', 'Pasaporte']]) {
    await prisma.tipos_documento.upsert({ where: { id }, update: {}, create: { id, descripcion } });
  }
  const metodo = {};
  for (const nombre of ['YAPE', 'PLIN', 'TRANSFERENCIA', 'EFECTIVO']) {
    metodo[nombre] = await prisma.metodos_pago.upsert({ where: { nombre }, update: {}, create: { nombre, activo: true } });
  }
  for (const [clave, valor, descripcion] of [
    ['DIAS_TOLERANCIA_PAGO', '3', 'Días extra para regularizar pago'],
    ['DIAS_TOLERANCIA_VENCIMIENTO', '5', 'Días de gracia tras el ciclo'],
    ['DIAS_ANTICIPACION_RENOVACION', '5', 'Días antes del vencimiento para generar deuda'],
    ['TIEMPO_LIMITE_RESERVA_MIN', '20', 'Minutos para pagar una reserva'],
  ]) {
    await prisma.parametros_sistema.upsert({ where: { clave }, update: {}, create: { clave, valor, descripcion } });
  }
  const concepto = {};
  for (const [codigo, nombre, precio, clases, vigente] of [
    ['MENSUAL_1_DIA_2026', 'Mensualidad Básica (1 vez x semana)', 150, 1, true],
    ['MENSUAL_2_DIA_2026', 'Plan Estándar (2 veces x semana)', 280, 2, true],
    ['MENSUAL_3_DIA_2026', 'Plan Intensivo (3 veces x semana)', 400, 3, true],
    ['MENSUAL_4_DIA_2026', 'Plan Atleta (4 veces x semana)', 500, 4, true],
    ['CLASE_UNITARIA_2026', 'Costo por Clase Unitaria (Referencial)', 37.5, 0, true],
    ['M_LEGACY_2_DIA', 'Plan Estándar Antiguo (2 veces x semana)', 190, 2, false],
  ]) {
    concepto[codigo] = await prisma.catalogo_conceptos.upsert({
      where: { codigo_interno: codigo },
      update: {},
      create: { codigo_interno: codigo, nombre, precio_base: precio, cantidad_clases_semanal: clases, es_vigente: vigente, activo: true },
    });
  }
  const beneficio = await prisma.tipos_beneficio.upsert({
    where: { nombre: 'Trae a un amigo' },
    update: {},
    create: { nombre: 'Trae a un amigo', es_porcentaje: false, valor_por_defecto: 30, activo: true },
  });
  await prisma.tipos_beneficio.upsert({
    where: { nombre: 'Descuento 10%' },
    update: {},
    create: { nombre: 'Descuento 10%', es_porcentaje: true, valor_por_defecto: 10, activo: true },
  });

  // ---------- infraestructura ----------
  const dirCentral = await findOrCreate('direcciones', { direccion_completa: 'Av. del Deporte 123' }, { distrito: 'San Borja', ciudad: 'Lima' });
  const dirNorte = await findOrCreate('direcciones', { direccion_completa: 'Av. Universitaria 4500' }, { distrito: 'Los Olivos', ciudad: 'Lima' });
  const sedeCentral = await findOrCreate('sedes', { nombre: 'Sede Central Gema' }, { direccion_id: dirCentral.id, tipo_instalacion: 'Coliseo', telefono_contacto: '999111222' });
  const sedeNorte = await findOrCreate('sedes', { nombre: 'Sede Norte Gema' }, { direccion_id: dirNorte.id, tipo_instalacion: 'Losa deportiva', telefono_contacto: '999333444' });
  const canchaA = await findOrCreate('canchas', { sede_id: sedeCentral.id, nombre: 'Cancha A (Principal)' }, { descripcion: 'Piso flotante profesional' });
  const canchaB = await findOrCreate('canchas', { sede_id: sedeCentral.id, nombre: 'Cancha B' }, { descripcion: 'Cancha auxiliar' });
  const canchaN = await findOrCreate('canchas', { sede_id: sedeNorte.id, nombre: 'Cancha Norte 1' }, { descripcion: 'Losa techada' });
  const nivelFormativo = await findOrCreate('niveles_entrenamiento', { nombre: 'Formativo' }, { precio_referencial: 150 });
  const nivelIntermedio = await findOrCreate('niveles_entrenamiento', { nombre: 'Intermedio' }, { precio_referencial: 280 });
  const nivelAvanzado = await findOrCreate('niveles_entrenamiento', { nombre: 'Avanzado' }, { precio_referencial: 400 });

  // ---------- staff ----------
  const admin = await crearUsuario({ username: 'admin.demo', rol: rol.Administrador, nombres: 'Ana', apellidos: 'Administradora', doc: '70000001', telefono: '900000001', genero: 'F' }, hash);
  await prisma.administrador.upsert({
    where: { usuario_id: admin.id },
    update: {},
    create: { usuario_id: admin.id, cargo: 'Directora', area: 'Administración', sede_id: sedeCentral.id },
  });
  const coordUsuarios = [];
  for (const c of [
    { username: 'coord.demo', nombres: 'Carlos', apellidos: 'Coordinador', doc: '70000002', telefono: '900000002', genero: 'M' },
    { username: 'coord2.demo', nombres: 'Lucía', apellidos: 'Vega', doc: '70000003', telefono: '900000003', genero: 'F' },
  ]) {
    const u = await crearUsuario({ ...c, rol: rol.Coordinador }, hash);
    await prisma.coordinadores.upsert({ where: { usuario_id: u.id }, update: {}, create: { usuario_id: u.id, especializacion: 'Voley' } });
    coordUsuarios.push(u);
  }
  const [coord1, coord2] = coordUsuarios;

  // ---------- horarios (cancha, día 1=Lun..6=Sáb, hora) ----------
  const horarioDefs = [
    [canchaA, coord1, nivelFormativo, 1, 16, 18],
    [canchaA, coord1, nivelFormativo, 3, 16, 18],
    [canchaA, coord1, nivelIntermedio, 2, 18, 20],
    [canchaA, coord1, nivelIntermedio, 4, 18, 20],
    [canchaB, coord2, nivelAvanzado, 1, 19, 21],
    [canchaB, coord2, nivelAvanzado, 5, 19, 21],
    [canchaN, coord2, nivelFormativo, 6, 9, 11],
    [canchaN, coord2, nivelIntermedio, 6, 11, 13],
  ];
  const horarios = [];
  for (const [cancha, coord, nivel, dia_semana, hi, hf] of horarioDefs) {
    horarios.push(
      await prisma.horarios_clases.upsert({
        where: { cancha_id_dia_semana_hora_inicio: { cancha_id: cancha.id, dia_semana, hora_inicio: hora(hi) } },
        update: {},
        create: {
          cancha_id: cancha.id,
          coordinador_id: coord.id,
          nivel_id: nivel.id,
          dia_semana,
          hora_inicio: hora(hi),
          hora_fin: hora(hf),
          capacidad_max: 12,
          activo: true,
        },
      })
    );
  }

  // ---------- alumnos y escenarios ----------
  // estadoInsc / estadoCuenta cubren los casos que el frontend debe pintar distinto.
  const escenarios = [
    { u: 'alumno.activo', n: 'Valeria', a: 'Ríos', doc: '71000001', h: [0, 1], insc: 'ACTIVO', concepto: 'MENSUAL_2_DIA_2026', cuenta: 'PAGADA', venc: 20, pago: 'APROBADO' },
    { u: 'alumno.pendiente', n: 'Mateo', a: 'Salas', doc: '71000002', h: [2], insc: 'PENDIENTE_PAGO', concepto: 'MENSUAL_1_DIA_2026', cuenta: 'PENDIENTE', venc: 3 },
    { u: 'alumno.parcial', n: 'Camila', a: 'Torres', doc: '71000003', h: [3], insc: 'ACTIVO', concepto: 'MENSUAL_1_DIA_2026', cuenta: 'PARCIAL', venc: 4, pago: 'APROBADO', pagado: 75 },
    { u: 'alumno.porvalidar', n: 'Diego', a: 'Paredes', doc: '71000004', h: [4, 5], insc: 'ACTIVO', concepto: 'MENSUAL_2_DIA_2026', cuenta: 'POR_VALIDAR', venc: 2, pago: 'PENDIENTE' },
    { u: 'alumno.moroso', n: 'Sofía', a: 'Mendoza', doc: '71000005', h: [6], insc: 'ACTIVO', concepto: 'MENSUAL_1_DIA_2026', cuenta: 'VENCIDA', venc: -8 },
    { u: 'alumno.individual', n: 'Andrés', a: 'Quispe', doc: '71000006', h: [7], insc: 'ACTIVO', tipo: 'INDIVIDUAL', concepto: 'CLASE_UNITARIA_2026', cuenta: 'PAGADA', venc: 10, pago: 'APROBADO' },
    { u: 'alumno.finalizado', n: 'Renata', a: 'Campos', doc: '71000007', h: [0], insc: 'FINALIZADO', concepto: 'M_LEGACY_2_DIA', cuenta: 'PAGADA', venc: -40, pago: 'APROBADO' },
    { u: 'alumno.lesion', n: 'Bruno', a: 'Huamán', doc: '71000008', h: [1], insc: 'ACTIVO', concepto: 'MENSUAL_1_DIA_2026', cuenta: 'PAGADA', venc: 15, pago: 'APROBADO', lesion: true },
    { u: 'alumno.recupera', n: 'Elena', a: 'Farfán', doc: '71000009', h: [2], insc: 'ACTIVO', concepto: 'MENSUAL_1_DIA_2026', cuenta: 'PAGADA', venc: 12, pago: 'APROBADO', recupera: true },
    { u: 'alumno.nuevo', n: 'Tomás', a: 'León', doc: '71000010', h: [], sinInscripcion: true },
  ];

  let n = 0;
  for (const e of escenarios) {
    n++;
    const usuario = await crearUsuario(
      { username: e.u, rol: rol.Alumno, nombres: e.n, apellidos: e.a, doc: e.doc, telefono: `98000${String(n).padStart(4, '0')}`, genero: n % 2 ? 'F' : 'M', nacimiento: `2010-0${(n % 9) + 1}-15` },
      hash
    );
    const alumno = await prisma.alumnos.upsert({
      where: { usuario_id: usuario.id },
      update: {},
      create: { usuario_id: usuario.id, direccion_id: dirCentral.id, condiciones_medicas: n % 3 === 0 ? 'Asma leve' : 'Ninguna', grupo_sanguineo: 'O+', seguro_medico: 'Pacífico' },
    });
    if (!(await prisma.alumnos_contactos.findFirst({ where: { alumno_id: alumno.usuario_id } }))) {
      await prisma.alumnos_contactos.create({
        data: { alumno_id: alumno.usuario_id, nombre_completo: `Apoderado de ${e.n}`, relacion: 'Padre/Madre', telefono: `97000${String(n).padStart(4, '0')}`, es_principal: true },
      });
    }
    if (e.sinInscripcion) continue;

    // Idempotencia: si el alumno ya tiene inscripciones, no se recrea su historia.
    if (await prisma.inscripciones.findFirst({ where: { alumno_id: alumno.usuario_id } })) continue;

    const inscs = [];
    for (const idx of e.h) {
      inscs.push(
        await prisma.inscripciones.create({
          data: {
            alumno_id: alumno.usuario_id,
            horario_id: horarios[idx].id,
            estado: e.insc,
            tipo_inscripcion: e.tipo ?? 'REGULAR',
            fecha_inscripcion: dia(-25),
            fecha_inscripcion_original: dia(-25),
          },
        })
      );
    }

    const cat = concepto[e.concepto];
    const cuenta = await prisma.cuentas_por_cobrar.create({
      data: {
        alumno_id: alumno.usuario_id,
        concepto_id: cat.id,
        detalle_adicional: `${cat.nombre} - demo`,
        monto_final: cat.precio_base,
        fecha_vencimiento: dia(e.venc),
        estado: e.cuenta,
      },
    });
    for (const insc of inscs) {
      await prisma.inscripciones_deudas_link.create({
        data: {
          inscripcion_id: insc.id,
          cuenta_id: cuenta.id,
          monto_asignado: Number(cat.precio_base) / inscs.length,
          fecha_inicio_ciclo: dia(-25),
          fecha_fin_ciclo: null,
        },
      });
    }
    if (e.pago) {
      await prisma.pagos.create({
        data: {
          cuenta_id: cuenta.id,
          metodo_pago_id: metodo.YAPE.id,
          monto_pagado: e.pagado ?? cat.precio_base,
          codigo_operacion: `DEMO${String(n).padStart(6, '0')}`,
          estado_validacion: e.pago,
          revisado_por: e.pago === 'APROBADO' ? admin.id : null,
          comprobante_enviado: true,
          fecha_pago: dia(-5),
        },
      });
    }

    // asistencia de las últimas clases (hoy y ayer no, para no chocar con tomas de asistencia en vivo)
    if (e.insc === 'ACTIVO') {
      const estados = ['PRESENTE', 'PRESENTE', 'FALTA', 'PRESENTE'];
      for (const insc of inscs) {
        for (let i = 0; i < estados.length; i++) {
          await prisma.registros_asistencia.create({
            data: { inscripcion_id: insc.id, fecha: dia(-7 * (i + 1) - 2), estado: estados[i], registrado_por: coord1.id },
          });
        }
      }
    }

    if (e.lesion) {
      const sol = await prisma.solicitudes_lesion.create({
        data: {
          alumno_id: alumno.usuario_id,
          descripcion_lesion: 'Esguince de tobillo',
          url_evidencia_medica: 'https://example.com/evidencia-demo.pdf',
          estado: 'APROBADA',
          revisado_por: admin.id,
          notas_admin: 'Aprobada por certificado médico',
        },
      });
      await prisma.congelamientos.create({
        data: { inscripcion_id: inscs[0].id, solicitud_lesion_id: sol.id, fecha_inicio: dia(-3), fecha_fin: dia(11), dias_reconocidos: 14, estado: 'ACTIVO' },
      });
    }

    if (e.recupera) {
      const falta = dia(-9);
      await prisma.registros_asistencia.upsert({
        where: { inscripcion_id_fecha: { inscripcion_id: inscs[0].id, fecha: falta } },
        update: {},
        create: { inscripcion_id: inscs[0].id, fecha: falta, estado: 'FALTA', registrado_por: coord1.id },
      });
      await prisma.recuperaciones.create({
        data: { alumno_id: alumno.usuario_id, fecha_falta: falta, motivo_falta: 'PERSONAL', horario_destino_id: horarios[3].id, fecha_programada: dia(4), estado: 'PROGRAMADA' },
      });
    }
  }

  // ---------- beneficio pendiente, lesión pendiente, notificaciones, publicaciones, feriados, caja ----------
  const alumnoActivo = await prisma.usuarios.findUnique({ where: { username: 'alumno.activo' } });
  if (!(await prisma.beneficios_pendientes.findFirst({ where: { alumno_id: alumnoActivo.id } }))) {
    await prisma.beneficios_pendientes.create({
      data: { alumno_id: alumnoActivo.id, tipo_beneficio_id: beneficio.id, asignado_por: admin.id, motivo: 'Refirió a un amigo' },
    });
  }
  const alumnoMoroso = await prisma.usuarios.findUnique({ where: { username: 'alumno.moroso' } });
  if (!(await prisma.notificaciones.findFirst({ where: { alumno_id: alumnoMoroso.id } }))) {
    await prisma.notificaciones.createMany({
      data: [
        { usuario_id: admin.id, alumno_id: alumnoMoroso.id, titulo: 'Deuda vencida', mensaje: 'Sofía Mendoza tiene una deuda vencida.', tipo: 'ALERTA', categoria: 'PAGOS' },
        { usuario_id: alumnoActivo.id, titulo: 'Bienvenida', mensaje: 'Bienvenida a Gema Academy.', tipo: 'INFO', categoria: 'SISTEMA', leido: true },
      ],
    });
  }
  if (!(await prisma.publicaciones.findFirst({ where: { autor_id: admin.id } }))) {
    await prisma.publicaciones.createMany({
      data: [
        { titulo: 'Torneo interno de octubre', contenido: 'Inscríbete con tu coordinador hasta el viernes.', autor_id: admin.id, activo: true },
        { titulo: 'Cambio de horario (borrador)', contenido: 'Publicación inactiva de prueba.', autor_id: admin.id, activo: false },
      ],
    });
  }
  if (!(await prisma.anuncios_beneficios.findFirst())) {
    await prisma.anuncios_beneficios.createMany({
      data: [
        { tipo: 'REFERIDOS', titulo: 'Trae a un amigo: -S/ 30', descripcion: 'Por cada amigo que se inscriba.', icono: 'Users', badge: 'PROMO', orden: 1 },
        { tipo: 'RECUPERACIÓN', titulo: 'Recupera tus clases', descripcion: 'Reprograma tus faltas justificadas.', icono: 'RefreshCcw', badge: 'FLEXIBILIDAD', orden: 2 },
      ],
    });
  }
  for (const [offset, descripcion] of [[6, 'Feriado demo 1'], [20, 'Feriado demo 2']]) {
    await prisma.feriados.upsert({ where: { fecha: dia(offset) }, update: {}, create: { fecha: dia(offset), descripcion, activo: true } });
  }
  if (!(await prisma.movimientos_financieros.findFirst({ where: { registrado_por: admin.id } }))) {
    await prisma.movimientos_financieros.createMany({
      data: [
        { tipo_movimiento: 'INGRESO', monto: 60, concepto: 'Venta de camisetas', metodo_pago_id: metodo.EFECTIVO.id, sede_id: sedeCentral.id, registrado_por: admin.id },
        { tipo_movimiento: 'EGRESO', monto: 120, concepto: 'Pago de luz', metodo_pago_id: metodo.TRANSFERENCIA.id, sede_id: sedeCentral.id, registrado_por: admin.id },
        { tipo_movimiento: 'INGRESO', monto: 37.5, concepto: 'Clase suelta', metodo_pago_id: metodo.YAPE.id, sede_id: sedeNorte.id, registrado_por: admin.id },
      ],
    });
  }

  console.log('\n✅ Demo lista. Contraseña de TODOS los usuarios:', PASSWORD);
  console.log('   Admin:        admin.demo');
  console.log('   Coordinador:  coord.demo, coord2.demo');
  console.log('   Alumnos:      ' + escenarios.map((e) => e.u).join(', '));
}

main()
  .catch((e) => {
    console.error('❌ Error en seed-demo:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
