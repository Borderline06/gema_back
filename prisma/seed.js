import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed maestro de la Academia GEMA...');

  // =================================================================
  // 1. ROLES Y DOCUMENTOS 🏗️
  // =================================================================
  console.log('📝 Configurando Roles y Documentos...');

  const roles = await Promise.all([
    prisma.roles.upsert({
      where: { nombre: 'Alumno' },
      update: {},
      create: { nombre: 'Alumno', descripcion: 'Estudiante' },
    }),
    prisma.roles.upsert({
      where: { nombre: 'Coordinador' },
      update: {},
      create: { nombre: 'Coordinador', descripcion: 'Coordinador' },
    }),
    prisma.roles.upsert({
      where: { nombre: 'Administrador' },
      update: {},
      create: { nombre: 'Administrador', descripcion: 'Admin total' },
    }),
  ]);

  const rolAlumno = roles.find((r) => r.nombre === 'Alumno');
  const rolCoordinador = roles.find((r) => r.nombre === 'Coordinador');
  const rolAdmin = roles.find((r) => r.nombre === 'Administrador');

  await Promise.all([
    prisma.tipos_documento.upsert({
      where: { id: 'DNI' },
      update: {},
      create: { id: 'DNI', descripcion: 'Documento Nacional de Identidad' },
    }),
    prisma.tipos_documento.upsert({
      where: { id: 'CE' },
      update: {},
      create: { id: 'CE', descripcion: 'Carnet de Extranjería' },
    }),
    prisma.tipos_documento.upsert({
      where: { id: 'PAS' },
      update: {},
      create: { id: 'PAS', descripcion: 'Pasaporte' },
    }),
  ]);

  // =================================================================
  // 2. USUARIOS ADMINISTRATIVOS (Admin y Coordinador) 👮
  // =================================================================
  console.log('👮 Creando Admin y Coordinador...');

  const admin = await prisma.usuarios.upsert({
    where: { username: 'admin.gema' },
    update: {},
    create: {
      username: 'admin.gema',
      nombres: 'Super',
      apellidos: 'Admin',
      email: 'admin@gema.com',
      rol_id: rolAdmin.id,
      tipo_documento_id: 'DNI',
      numero_documento: '00000001',
      activo: true,
    },
  });

  await prisma.administrador.upsert({
    where: { usuario_id: admin.id },
    update: {},
    create: { usuario_id: admin.id, cargo: 'Director General', area: 'Administración' },
  });

  const usuarioCoordinador = await prisma.usuarios.upsert({
    where: { username: 'carlos.coordinator' },
    update: {},
    create: {
      username: 'carlos.coordinator',
      nombres: 'Carlos',
      apellidos: 'Coordinator',
      email: 'coordinator@gema.com',
      rol_id: rolCoordinador.id,
      tipo_documento_id: 'DNI',
      numero_documento: '10203040',
      activo: true,
    },
  });

  const coordinador = await prisma.coordinadores.upsert({
    where: { usuario_id: usuarioCoordinador.id },
    update: {},
    create: { usuario_id: usuarioCoordinador.id, especializacion: 'Voley Alto Rendimiento' },
  });

  // =================================================================
  // 3. INFRAESTRUCTURA 🏢
  // =================================================================
  console.log('🏢 Configurando Sede, Cancha y Niveles...');

  // Usamos create porque las sedes y canchas suelen ser registros únicos en esta etapa
  const direccion = await prisma.direcciones.create({
    data: { direccion_completa: 'Av. del Deporte 123', distrito: 'San Borja', ciudad: 'Lima' },
  });

  const sede = await prisma.sedes.create({
    data: { nombre: 'Sede Central Gema', direccion_id: direccion.id, tipo_instalacion: 'Coliseo' },
  });

  const cancha = await prisma.canchas.create({
    data: {
      sede_id: sede.id,
      nombre: 'Cancha A (Principal)',
      descripcion: 'Piso flotante profesional',
    },
  });

  const nivel = await prisma.niveles_entrenamiento.upsert({
    where: { id: 1 },
    update: {},
    create: { nombre: 'Formativo', precio_referencial: 150.0 },
  });

  // =================================================================
  // 4. PARÁMETROS DEL SISTEMA (SEGÚN DBEAVER) 🧠
  // =================================================================
  console.log('🧠 Inyectando Parámetros del Sistema...');

  const parametrosSistema = [
    {
      clave: 'DIAS_TOLERANCIA_PAGO',
      valor: '3',
      descripcion: 'Días extra que tiene un alumno para regularizar su pago antes de suspender',
    },
    {
      clave: 'DIAS_TOLERANCIA_VENCIMIENTO',
      valor: '5',
      descripcion:
        'Días de gracia después de los 30 días del ciclo para el vencimiento de la deuda',
    },
    {
      clave: 'DIAS_ANTICIPACION_RENOVACION',
      valor: '5',
      descripcion: 'Días antes del vencimiento para generar la nueva cuenta por cobrar',
    },
    {
      clave: 'TIEMPO_LIMITE_RESERVA_MIN',
      valor: '20',
      descripcion: 'Minutos que tiene un alumno nuevo para pagar su reserva antes de liberarse',
    },
  ];

  for (const param of parametrosSistema) {
    await prisma.parametros_sistema.upsert({
      where: { clave: param.clave },
      update: { valor: param.valor, descripcion: param.descripcion },
      create: param,
    });
  }

  // =================================================================
  // 5. CATÁLOGO DE PRECIOS (NUEVOS Y LEGACY) 💰
  // =================================================================
  console.log('💰 Configurando Catálogo de Precios...');

  const conceptos = [
    // PLANES ACTUALES 2026 (Vigentes)
    {
      codigo: 'MENSUAL_1_DIA_2026',
      nombre: 'Mensualidad Básica (1 vez x semana)',
      precio: 150.0,
      clases: 1,
      vigente: true,
    },
    {
      codigo: 'MENSUAL_2_DIA_2026',
      nombre: 'Plan Estándar (2 veces x semana)',
      precio: 280.0,
      clases: 2,
      vigente: true,
    },
    {
      codigo: 'MENSUAL_3_DIA_2026',
      nombre: 'Plan Intensivo (3 veces x semana)',
      precio: 400.0,
      clases: 3,
      vigente: true,
    },
    {
      codigo: 'MENSUAL_4_DIA_2026',
      nombre: 'Plan Atleta (4 veces x semana)',
      precio: 500.0,
      clases: 4,
      vigente: true,
    },
    {
      codigo: 'CLASE_UNITARIA_2026',
      nombre: 'Costo por Clase Unitaria (Referencial)',
      precio: 37.5,
      clases: 0,
      vigente: true,
    },

    // PLANES LEGACY (No vigentes)
    {
      codigo: 'M_LEGACY_1_DIA',
      nombre: 'Mensualidad Antigua (1 vez x semana)',
      precio: 100.0,
      clases: 1,
      vigente: false,
    },
    {
      codigo: 'M_LEGACY_2_DIA',
      nombre: 'Plan Estándar Antiguo (2 veces x semana)',
      precio: 190.0,
      clases: 2,
      vigente: false,
    },
    {
      codigo: 'M_LEGACY_3_DIA',
      nombre: 'Plan Intensivo Antiguo (3 veces x semana)',
      precio: 270.0,
      clases: 3,
      vigente: false,
    },
    {
      codigo: 'M_LEGACY_4_DIA',
      nombre: 'Plan Atleta Antiguo (4 veces x semana)',
      precio: 340.0,
      clases: 4,
      vigente: false,
    },
    {
      codigo: 'CLASE_UNI_LEGACY',
      nombre: 'Costo por Clase Unitaria (Legacy)',
      precio: 25.0,
      clases: 0,
      vigente: false,
    },
  ];

  for (const c of conceptos) {
    await prisma.catalogo_conceptos.upsert({
      where: { codigo_interno: c.codigo },
      update: {
        nombre: c.nombre,
        precio_base: c.precio,
        cantidad_clases_semanal: c.clases,
        es_vigente: c.vigente,
        activo: true,
      },
      create: {
        codigo_interno: c.codigo,
        nombre: c.nombre,
        precio_base: c.precio,
        cantidad_clases_semanal: c.clases,
        es_vigente: c.vigente,
        activo: true,
      },
    });
  }

  // Métodos de pago base
  for (const m of ['YAPE', 'PLIN', 'TRANSFERENCIA', 'EFECTIVO']) {
    await prisma.metodos_pago.upsert({
      where: { nombre: m },
      update: {},
      create: { nombre: m, activo: true },
    });
  }

  // Catálogo base de Merch (reemplaza el antiguo flag "incluye_camiseta")
  const merchBase = [
    { nombre: 'Camiseta Oficial Gema', descripcion: 'Camiseta oficial de la academia', precio: 50, stock: 50 },
    { nombre: 'Gorra Gema', descripcion: 'Gorra con logo bordado', precio: 30, stock: 30 },
  ];
  for (const m of merchBase) {
    const existe = await prisma.merch.findFirst({ where: { nombre: m.nombre } });
    if (!existe) await prisma.merch.create({ data: m });
  }

  // =================================================================
  // 6. ALUMNO DE PRUEBA Y HORARIO 🧪
  // =================================================================
  console.log('🧪 Creando Alumno e Inscripción de prueba...');

  const horario1 = await prisma.horarios_clases.upsert({
    where: { id: 1 },
    update: {},
    create: {
      cancha_id: cancha.id,
      coordinador_id: coordinador.usuario_id,
      nivel_id: nivel.id,
      dia_semana: 1, // Lunes
      hora_inicio: new Date(2026, 1, 1, 16, 0), // 16:00
      hora_fin: new Date(2026, 1, 1, 18, 0),
      capacidad_max: 20,
    },
  });

  const usuarioJavier = await prisma.usuarios.upsert({
    where: { username: 'javier.prueba' },
    update: {},
    create: {
      username: 'javier.prueba',
      nombres: 'Javier',
      apellidos: 'Prueba',
      email: 'javier@prueba.com',
      rol_id: rolAlumno.id,
      tipo_documento_id: 'DNI',
      numero_documento: '88888888',
      activo: true,
    },
  });

  const alumno = await prisma.alumnos.upsert({
    where: { usuario_id: usuarioJavier.id },
    update: {},
    create: { usuario_id: usuarioJavier.id, condiciones_medicas: 'Ninguna' },
  });

  const inscripcionExistente = await prisma.inscripciones.findFirst({
    where: {
      alumno_id: alumno.usuario_id,
      horario_id: horario1.id,
    },
  });

  if (!inscripcionExistente) {
    await prisma.inscripciones.create({
      data: {
        alumno_id: alumno.usuario_id,
        horario_id: horario1.id,
        estado: 'ACTIVO',
      },
    });
  }

  console.log('✅✅ SEED MAESTRO COMPLETADO.');
}

main()
  .catch((e) => {
    console.error('❌ Error fatal en el Seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
