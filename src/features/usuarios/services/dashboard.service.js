import { prisma } from '../../../config/database.config.js';
import { merchService } from '../../merch/merch.service.js';

export const dashboardService = {
  async getDashboardStats() {
    try {
      const hoy = new Date();

      const [counts, roles, sedesCount, ingresosSum, deudaSum, ultimosPagos, ultimosAlumnos, todosLosAlumnos, linksActivosHoy] = await Promise.all([
        prisma.usuarios.groupBy({ by: ['rol_id'], where: { activo: true }, _count: { id: true } }),
        prisma.roles.findMany({ select: { id: true, nombre: true } }),
        prisma.sedes.count({ where: { activo: true } }),
        prisma.pagos.aggregate({ _sum: { monto_pagado: true }, where: { estado_validacion: 'APROBADO' } }),
        prisma.cuentas_por_cobrar.aggregate({ _sum: { monto_final: true }, where: { estado: 'PENDIENTE' } }),

        prisma.pagos.findMany({ take: 3, orderBy: { fecha_pago: 'desc' }, where: { estado_validacion: 'APROBADO' } }),
        prisma.usuarios.findMany({ take: 3, where: { roles: { nombre: { equals: 'Alumno', mode: 'insensitive' } }, activo: true }, orderBy: { creado_en: 'desc' } }),

        prisma.usuarios.findMany({
          where: { roles: { nombre: { equals: 'Alumno', mode: 'insensitive' } } },
          select: { id: true, genero: true, fecha_nacimiento: true }
        }),

        prisma.inscripciones_deudas_link.findMany({
          where: {
            fecha_inicio_ciclo: { lte: hoy },
            OR: [{ fecha_fin_ciclo: null }, { fecha_fin_ciclo: { gte: hoy } }],
            inscripciones: {
              estado: 'ACTIVO'   // 🚩 NUEVO: solo cuenta si la clase está realmente corriendo
            }
          },
          include: { inscripciones: { select: { alumno_id: true } } }
        })
      ]);

      const safeGender = (g) => {
        if (!g) return 'NOCONF';
        const upper = g.toUpperCase().trim();
        if (upper === 'M' || upper === 'F') return upper;
        return 'NOCONF';
      };

      // HISTÓRICO
      const ageHistorico = { '0-5': 0, '6-10': 0, '11-15': 0, '16+': 0 };
      const generoHistorico = { F: 0, M: 0, NOCONF: 0 };
      const mapaAlumnos = new Map();

      todosLosAlumnos.forEach(alumno => {
        mapaAlumnos.set(alumno.id, alumno);
        const g = safeGender(alumno.genero);
        generoHistorico[g] = (generoHistorico[g] || 0) + 1;

        if (alumno.fecha_nacimiento) {
          const birth = new Date(alumno.fecha_nacimiento);
          if (!isNaN(birth.getTime())) {
            let age = hoy.getFullYear() - birth.getFullYear();
            if (hoy.getMonth() < birth.getMonth() || (hoy.getMonth() === birth.getMonth() && hoy.getDate() < birth.getDate())) age--;

            if (age <= 5) ageHistorico['0-5']++;
            else if (age <= 10) ageHistorico['6-10']++;
            else if (age <= 15) ageHistorico['11-15']++;
            else ageHistorico['16+']++;
          }
        }
      });

      // 🔥 CÁLCULO ACTIVO (RECUPERAMOS LAS CABEZAS FÍSICAS)
      let totalFteActivos = 0;
      const alumnosUnicosActivos = new Set();
      const generoActivoFte = { F: 0, M: 0, NOCONF: 0 };
      const generoActivoFisico = { F: new Set(), M: new Set(), NOCONF: new Set() };

      linksActivosHoy.forEach(link => {
        const aId = link.inscripciones?.alumno_id;
        if (!aId) return;

        totalFteActivos += 0.5;
        alumnosUnicosActivos.add(aId);

        const infoAlumno = mapaAlumnos.get(aId);
        const g = safeGender(infoAlumno?.genero);

        generoActivoFisico[g].add(aId);
        generoActivoFte[g] += 0.5;
      });

      const roleStats = roles.reduce((acc, rol) => {
        const nombreRol = rol.nombre.toLowerCase();
        if (nombreRol === 'alumno') {
          acc[nombreRol] = totalFteActivos;
        } else {
          const group = counts.find((c) => c.rol_id === rol.id);
          acc[nombreRol] = group ? group._count.id : 0;
        }
        return acc;
      }, {});

      const actividades = ultimosPagos.map(p => ({
        id: `pago_${p.id}`,
        text: `Pago validado por S/ ${Number(p.monto_pagado).toFixed(2)}`,
        date: p.fecha_pago,
        type: 'pago'
      })).concat(ultimosAlumnos.map(a => ({
        id: `alumno_${a.id}`,
        text: `Nuevo alumno: ${a.nombres} ${a.apellidos}`,
        date: a.creado_en,
        type: 'alumno'
      })));

      actividades.sort((a, b) => new Date(b.date) - new Date(a.date));
      const actividadReciente = actividades.slice(0, 5).map(act => {
        const dateObj = new Date(act.date);
        const yesterday = new Date(hoy);
        yesterday.setDate(yesterday.getDate() - 1);

        let dateString = dateObj.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
        if (dateObj.toDateString() === hoy.toDateString()) dateString = 'Hoy';
        else if (dateObj.toDateString() === yesterday.toDateString()) dateString = 'Ayer';

        return { ...act, date: dateString };
      });

      // 🛍️ MERCH: ya está dentro de ingresosTotales (suma todos los pagos aprobados);
      // esta llave nueva lo aísla para poder medirlo por separado.
      const ingresosMerch = await merchService.sumarIngresosMerch(prisma);

      return {
        ...roleStats,
        sedes: sedesCount,
        ingresosTotales: Number(ingresosSum._sum.monto_pagado || 0).toFixed(2),
        ingresosMerch: ingresosMerch.toFixed(2),
        deudaPendiente: Number(deudaSum._sum.monto_final || 0).toFixed(2),
        actividadReciente,
        alumnosFisicosActivos: alumnosUnicosActivos.size,
        alumnosFteActivos: totalFteActivos,
        alumnosEdades: Object.keys(ageHistorico).map(k => ({ range: k, count: ageHistorico[k] })),
        alumnosGenero: {
          historicoFisico: generoHistorico,
          activoFisico: { F: generoActivoFisico.F.size, M: generoActivoFisico.M.size, NOCONF: generoActivoFisico.NOCONF.size },
          activoFte: generoActivoFte
        }
      };

    } catch (error) {
      console.error("❌ Error CRÍTICO en getDashboardStats:", error);
      throw error;
    }
  },

 getGraficosAvanzados: async (yearStr) => {
  const año = yearStr ? parseInt(yearStr) : new Date().getFullYear();
  const hoy = new Date();
  const currentMonth = hoy.getMonth();
  const currentYear = hoy.getFullYear();
  const startOfYear = new Date(año, 0, 1);
  const endOfYear = new Date(año, 11, 31, 23, 59, 59, 999);

  const [historialLinks, pagosDelAño, todosLosAlumnos] = await Promise.all([
    prisma.inscripciones_deudas_link.findMany({
      where: {
        fecha_inicio_ciclo: { not: null },
        // 🚩 FIX A: excluimos reservas que nunca se confirmaron (PENDIENTE_PAGO / POR_VALIDAR).
        // Dejamos pasar ACTIVO y FINALIZADO para no romper el histórico mensual real.
        inscripciones: {
          estado: { notIn: ['PENDIENTE_PAGO', 'POR_VALIDAR'] }
        }
      },
      include: {
        inscripciones: {
          include: {
            horarios_clases: {
              include: {
                niveles_entrenamiento: { select: { nombre: true } },
                canchas: { include: { sedes: { select: { nombre: true } } } }
              }
            }
          }
        }
      }
    }),
    prisma.pagos.findMany({
      where: {
        estado_validacion: 'APROBADO',
        fecha_pago: { gte: startOfYear, lte: endOfYear }
      },
      include: { metodos_pago: { select: { nombre: true } } }
    }),
    prisma.usuarios.findMany({
      where: { roles: { nombre: { equals: 'Alumno', mode: 'insensitive' } } },
      select: { id: true, genero: true }
    })
  ]);

  const safeGender = (g) => {
    if (!g) return 'NOCONF';
    const upper = g.toUpperCase().trim();
    if (upper === 'M' || upper === 'F') return upper;
    return 'NOCONF';
  };

  const mapaGeneros = new Map();
  todosLosAlumnos.forEach(a => mapaGeneros.set(a.id, safeGender(a.genero)));

  // =========================================================
  // 1. GRÁFICO LÍNEA MORADA (FTE y Físicos por mes)
  // =========================================================
  const nombresMeses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const consolidadoMensual = nombresMeses.map((mes, index) => {
    const startOfMonth = new Date(año, index, 1);
    const endOfMonth = new Date(año, index + 1, 0, 23, 59, 59, 999);

    if (año > currentYear || (año === currentYear && index > currentMonth)) {
      return { mes, ftes: 0, fisicos: 0, ingresos: 0 };
    }

    const cabezasSet = new Set();
    const linksActivosMes = historialLinks.filter(link => {
      const inicio = new Date(link.fecha_inicio_ciclo);
      const fin = link.fecha_fin_ciclo ? new Date(link.fecha_fin_ciclo) : null;
      return inicio <= endOfMonth
        && (!fin || fin >= startOfMonth)
        // 🚩 FIX C (nuevo): igual que en el snapshot de "hoy", exigimos que la
        // inscripción siga ACTIVO. Sin esto, ciclos ya finalizados pero con
        // fecha_fin_ciclo sin cerrar se seguían contando en meses pasados,
        // inflando el total mensual (ej: 472 en vez de los 240 reales).
        // ⚠️ Trade-off: esto usa el estado ACTUAL de la inscripción, no el
        // histórico real de cada mes. Un alumno que ya finalizó hoy dejará
        // de aparecer también en los meses pasados donde sí estuvo activo.
        && link.inscripciones?.estado === 'ACTIVO';
    });

    linksActivosMes.forEach(link => {
      if (link.inscripciones?.alumno_id) {
        cabezasSet.add(link.inscripciones.alumno_id);
      }
    });

    const totalFteMes = linksActivosMes.length * 0.5;
    return { mes, ftes: totalFteMes, fisicos: cabezasSet.size };
  });

  // =========================================================
  // 2. RECAUDACIÓN POR MÉTODO DE PAGO
  // =========================================================
  const metodosMap = {};
  pagosDelAño.forEach(p => {
    const nombre = p.metodos_pago?.nombre?.toUpperCase() || 'OTROS';
    metodosMap[nombre] = (metodosMap[nombre] || 0) + Number(p.monto_pagado || 0);
  });
  const recaudacionPorMetodo = Object.keys(metodosMap)
    .map(nombre => ({ nombre, monto: metodosMap[nombre] }))
    .sort((a, b) => b.monto - a.monto);

  // =========================================================
  // 3. OCUPACIÓN, NIVELES Y GÉNERO ACTIVO HOY (Sincronizado)
  // =========================================================
  const linksVigentesHoy = historialLinks.filter(link => {
    const inicio = new Date(link.fecha_inicio_ciclo);
    const fin = link.fecha_fin_ciclo ? new Date(link.fecha_fin_ciclo) : null;
    return inicio <= hoy
      && (!fin || fin >= hoy)
      // 🚩 FIX B: para el snapshot de "hoy" exigimos ACTIVO exacto, no basta con
      // que las fechas del link cuadren (protege contra finalizaciones voluntarias
      // que todavía no cierran fecha_fin_ciclo en el link).
      && link.inscripciones?.estado === 'ACTIVO';
  });

  // 🚩 NUEVO: detectamos alumnos matriculados en más de una sede
  const sedesPorAlumno = {};
  linksVigentesHoy.forEach(link => {
    const alumnoId = link.inscripciones?.alumno_id;
    if (!alumnoId) return;
    const hc = link.inscripciones?.horarios_clases;
    const sede = hc?.canchas?.sedes?.nombre || 'Sin Sede';

    if (!sedesPorAlumno[alumnoId]) sedesPorAlumno[alumnoId] = new Set();
    sedesPorAlumno[alumnoId].add(sede);
  });

  const alumnosMultiSede = Object.values(sedesPorAlumno).filter(set => set.size > 1).length;

  const ocupacionSedesMap = {};
  const nivelesSedeMap = {};

  // Para calcular el género activo de forma idéntica en este endpoint
  const generoActivoFisicoSets = { F: new Set(), M: new Set(), NOCONF: new Set() };
  const generoActivoFteVals = { F: 0, M: 0, NOCONF: 0 };

  linksVigentesHoy.forEach(link => {
    const alumnoId = link.inscripciones?.alumno_id;
    if (!alumnoId) return;

    const hc = link.inscripciones?.horarios_clases;
    const sede = hc?.canchas?.sedes?.nombre || 'Sin Sede';
    const nivel = hc?.niveles_entrenamiento?.nombre || 'Sin Nivel';

    // Sede general
    if (!ocupacionSedesMap[sede]) ocupacionSedesMap[sede] = { sede, cabezasUnicas: new Set(), fteTotal: 0 };
    ocupacionSedesMap[sede].cabezasUnicas.add(alumnoId);
    ocupacionSedesMap[sede].fteTotal += 0.5;

    // Niveles x sede
    if (!nivelesSedeMap[sede]) nivelesSedeMap[sede] = { sede };
    if (!nivelesSedeMap[sede][nivel]) nivelesSedeMap[sede][nivel] = { cabezasUnicas: new Set(), fteTotal: 0 };
    nivelesSedeMap[sede][nivel].cabezasUnicas.add(alumnoId);
    nivelesSedeMap[sede][nivel].fteTotal += 0.5;

    // Género Activo
    const genero = mapaGeneros.get(alumnoId) || 'NOCONF';
    generoActivoFisicoSets[genero].add(alumnoId);
    generoActivoFteVals[genero] += 0.5;
  });

  // Normalizamos para que la suma exacta de las sedes dé los alumnos reales
  const totalSumasFisicas = Object.values(ocupacionSedesMap).reduce((acc, s) => acc + s.cabezasUnicas.size, 0);

  const ocupacionPorSede = Object.values(ocupacionSedesMap).map(s => ({
    sede: s.sede,
    fisicos: s.cabezasUnicas.size,
    ftes: s.fteTotal
  }));

  const nivelesPorSede = Object.values(nivelesSedeMap).map(sedeData => {
    const result = { sede: sedeData.sede };
    Object.keys(sedeData).forEach(key => {
      if (key !== 'sede') {
        result[`${key}_Fisicos`] = sedeData[key].cabezasUnicas.size;
        result[`${key}_FTE`] = sedeData[key].fteTotal;
        result[key] = sedeData[key].fteTotal;
      }
    });
    return result;
  });

  return {
    tendenciaMensual: consolidadoMensual,
    recaudacionMetodos: recaudacionPorMetodo,
    ocupacionSedes: ocupacionPorSede,
    nivelesSedes: nivelesPorSede,
    alumnosMultiSede, // 🚩 NUEVO
    alumnosGeneroActivo: {
      activoFisico: {
        F: generoActivoFisicoSets.F.size,
        M: generoActivoFisicoSets.M.size,
        NOCONF: generoActivoFisicoSets.NOCONF.size
      },
      activoFte: generoActivoFteVals
    }
  };
}
};