import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { formatFechaEs } from '../../shared/utils/date.util.js';
// 🎯 BL-005: el ciclo de deuda tiene que seguir a la clase real. La aritmética
// vive en shared/ porque la comparten el masivo, su reversión y el cron que
// sincroniza a los inscritos tardíos.
import {
  cargarCiclosVigentes,
  resolverCorrimientoDeCiclo,
  aplicarCorrimientoDeCiclo,
  resolverReversionDeCiclo,
} from '../../shared/utils/reprogramacion-ciclo.util.js';

// ============================================================================
// FUNCIONES PRIVADAS DE APOYO
// ============================================================================

// La lógica de validación de colisiones ha sido simplificada y movida dentro de
// reprogramarMasivamente para permitir el flujo dinámico por cada alumno.

export const claseService = {
  reprogramarMasivamente: async ({ horario_origen_id, fecha_origen, motivo, usuario_admin_id }) => {
    const horarioOrigen = await prisma.horarios_clases.findUnique({
      where: { id: horario_origen_id },
      select: {
        hora_inicio: true,
        hora_fin: true,
        cancha_id: true,
        inscripciones: {
          where: { estado: 'ACTIVO' },
          select: { id: true, alumno_id: true, id_grupo_transaccion: true, fecha_inscripcion: true },
        },
      },
    });

    if (!horarioOrigen) throw new ApiError('Horario no encontrado', 404);
    const inscripcionesGrupo = horarioOrigen.inscripciones;
    if (inscripcionesGrupo.length === 0)
      throw new ApiError('No hay alumnos activos en este horario', 400);

    const fechaOrigenDate = new Date(fecha_origen);
    fechaOrigenDate.setUTCHours(12, 0, 0, 0);
    const dateOrigenStr = formatFechaEs(fechaOrigenDate);

    const reprogramacionPrevia = await prisma.reprogramaciones_clases.findFirst({
      where: {
        horario_id: horario_origen_id,
        fecha_origen: fechaOrigenDate,
        estado: 'ACTIVO'
      }
    });

    if (reprogramacionPrevia) {
      throw new ApiError(`El bloque del ${dateOrigenStr} ya fue reprogramado previamente.`, 400);
    }

    const importUUID = await import('node:crypto');
    const grupo_uuid = importUUID.randomUUID();

    const calcularSiguienteDia = (desdeFecha, diasValidos) => {
      const next = new Date(desdeFecha);
      next.setUTCHours(12, 0, 0, 0);

      for (let i = 1; i <= 31; i++) {
        // Max 1 mes de busqueda
        next.setUTCDate(next.getUTCDate() + 1);
        const diaSemana = next.getUTCDay() === 0 ? 7 : next.getUTCDay();
        if (diasValidos.includes(diaSemana)) return next;
      }
      return next;
    };

    return await prisma.$transaction(
      async (tx) => {
        const inscripcionIds = inscripcionesGrupo.map((i) => i.id);

        const todosLosFeriados = await tx.feriados.findMany({ where: { activo: true } });
        const esFeriado = todosLosFeriados.some(
          (f) =>
            f.fecha.getUTCDate() === fechaOrigenDate.getUTCDate() &&
            f.fecha.getUTCMonth() === fechaOrigenDate.getUTCMonth()
        );

        if (esFeriado) {
          await tx.registros_asistencia.updateMany({
            where: { inscripcion_id: { in: inscripcionIds }, fecha: fechaOrigenDate },
            data: {
              estado: 'CANCELADO',
              comentario: `Clase cancelada por feriado oficial: ${motivo}`,
            },
          });
          return {
            total_procesados: inscripcionesGrupo.length,
            mensaje: `Feriado detectado (${dateOrigenStr}). Se cancelaron las clases.`,
            es_feriado: true,
          };
        }

        const reprogramacion = await tx.reprogramaciones_clases.create({
          data: {
            horario_id: horario_origen_id,
            fecha_origen: fechaOrigenDate,
            fecha_destino: fechaOrigenDate,
            hora_inicio_destino:
              horarioOrigen.hora_inicio.getUTCHours().toString().padStart(2, '0') +
              ':' +
              horarioOrigen.hora_inicio.getUTCMinutes().toString().padStart(2, '0'),
            hora_fin_destino:
              horarioOrigen.hora_fin.getUTCHours().toString().padStart(2, '0') +
              ':' +
              horarioOrigen.hora_fin.getUTCMinutes().toString().padStart(2, '0'),
            motivo: motivo,
            creado_por: usuario_admin_id,
            es_masiva: true,
            estado: 'ACTIVO',
            grupo_uuid: grupo_uuid,
          },
        });

        // =================================================================
        // 🎯 BL-005: PRE-PASS, OBLIGATORIAMENTE ANTES DE MARCAR EL ORIGEN.
        //
        // Hay que saber si la clase que se mueve era la PRIMERA del ciclo de
        // cada alumno. En cuanto el updateMany de abajo la deja en
        // 'REPROGRAMADO' deja de contar como clase del ciclo y la respuesta se
        // pierde. Son DOS consultas para todo el lote, no N+1.
        // =================================================================
        const ciclos = await cargarCiclosVigentes(tx, inscripcionIds);
        const corrimientos = new Map(
          inscripcionesGrupo.map((ins) => [
            ins.id,
            resolverCorrimientoDeCiclo(ciclos.get(ins.id), fechaOrigenDate),
          ])
        );
        let ciclosAjustados = 0;

        await tx.registros_asistencia.updateMany({
          where: { inscripcion_id: { in: inscripcionIds }, fecha: fechaOrigenDate },
          data: {
            estado: 'REPROGRAMADO',
            reprogramacion_clase_id: reprogramacion.id,
            comentario: `Movido al final del ciclo por ${motivo}`,
          },
        });

        for (const ins of inscripcionesGrupo) {
          const susInscripciones = await tx.inscripciones.findMany({
            where: { alumno_id: ins.alumno_id, estado: 'ACTIVO' },
            select: { horario_id: true, horarios_clases: { select: { dia_semana: true } }, registros_asistencia: true },
          });
          const diasDelAlumno = [
            ...new Set(susInscripciones.map((s) => s.horarios_clases.dia_semana)),
          ];

          const registrosAsist = susInscripciones.flatMap(i => i.registros_asistencia.map(r => r.fecha))
          const ultimaClase = new Date(Math.max(...registrosAsist));

          const fechaFinOriginal = new Date(ultimaClase);
          const fechaReposicion = calcularSiguienteDia(fechaFinOriginal, diasDelAlumno);
          const dateReposicionStr = formatFechaEs(fechaReposicion);

          await tx.registros_asistencia.create({
            data: {
              inscripcion_id: ins.id,
              fecha: fechaReposicion,
              fecha_original: fechaOrigenDate,
              estado: 'PENDIENTE',
              reprogramacion_clase_id: reprogramacion.id,
              comentario: `Reposición de clase (${dateOrigenStr}) [NO_RECUPERABLE]. Motivo: ${motivo}`,
            },
          });

          // =================================================================
          // 🎯 BL-005: si la clase movida era la PRIMERA del ciclo, el ciclo
          // arranca ahora en la siguiente clase real del alumno.
          //
          // ⚠️ Esta rama es EXCLUYENTE con el bloque de fecha_inscripcion de
          // más abajo. Si corrieran las dos, el corte se movería dos veces: ese
          // bloque extiende la facturación para cubrir la reposición
          // (≈ fin_anterior + 7) y nuevo_inicio + 30 da EXACTAMENTE el mismo
          // cierre. Por eso acá se notifica y se hace `continue`.
          //
          // 🚩 Corrige POR INSCRIPCIÓN y no por id_grupo_transaccion: el cron
          // VERDUGO también cierra por inscripción (fecha_inscripcion + 30 y su
          // propio link, inscripcion-cron.service.js:133-164), y la hermana del
          // paquete que entrena otro día NO perdió su primera clase, así que su
          // ciclo no tiene por qué moverse.
          // =================================================================
          const corrimiento = corrimientos.get(ins.id);
          if (corrimiento?.eraPrimeraClase && corrimiento.dias) {
            await aplicarCorrimientoDeCiclo(tx, {
              link: ciclos.get(ins.id).link,
              inscripcionId: ins.id,
              dias: corrimiento.dias,
            });
            ciclosAjustados += 1;

            await tx.notificaciones.create({
              data: {
                alumno_id: ins.alumno_id,
                titulo: '🚨 Clase Reprogramada',
                mensaje: `Tu sesión del ${dateOrigenStr} se movió al ${dateReposicionStr}. Tu ciclo ahora inicia el ${formatFechaEs(corrimiento.siguienteClase)} y tu fecha de corte se ajustó igual.`,
                tipo: 'ALERTA',
                categoria: 'CLASES',
              },
            });
            continue;
          }

          if (!ins.id_grupo_transaccion) {
            await tx.notificaciones.create({
              data: {
                alumno_id: ins.alumno_id,
                titulo: '🚨 Clase Reprogramada',
                mensaje: `Tu sesión del ${dateOrigenStr} se movió al ${dateReposicionStr}.`,
                tipo: 'ALERTA',
                categoria: 'CLASES',
              },
            });
            continue;
          }

          const fechaCorte = new Date(ins.fecha_inscripcion);
          fechaCorte.setUTCDate(fechaCorte.getUTCDate() + 29);

          const inicioStr = fechaCorte.toISOString().split('T')[0];
          const finStr = fechaReposicion.toISOString().split('T')[0];

          const inicio = new Date(inicioStr);
          const fin = new Date(finStr);
          const diffDays = Math.round((fin - inicio) / (1000 * 60 * 60 * 24));

          const inscripcionActual = await tx.inscripciones.findUnique({
            where: { id: ins.id },
            select: { fecha_inscripcion: true },
          });

          const nuevaFechaInscripcion = new Date(inscripcionActual.fecha_inscripcion);
          nuevaFechaInscripcion.setDate(nuevaFechaInscripcion.getDate() + diffDays);

          await tx.inscripciones.updateMany({
            where: { id_grupo_transaccion: ins.id_grupo_transaccion },
            data: { fecha_inscripcion: nuevaFechaInscripcion },
          });

          await tx.notificaciones.create({
            data: {
              alumno_id: ins.alumno_id,
              titulo: '🚨 Clase Reprogramada',
              mensaje: `Tu sesión del ${dateOrigenStr} se movió al ${dateReposicionStr}, al igual que tu fecha de corte.`,
              tipo: 'ALERTA',
              categoria: 'CLASES',
            },
          });
        }

        // 🚩 REGLA DE ORO: las llaves de este objeto NO cambian (el frontend ya
        // las consume). El dato de BL-005 viaja DENTRO del string `mensaje`.
        return {
          total_procesados: inscripcionesGrupo.length,
          reprogramacion_id: reprogramacion.id,
          grupo_uuid: grupo_uuid,
          mensaje:
            ciclosAjustados > 0
              ? `Reprogramación dinámica exitosa basada en el horario de cada alumno. Se ajustó el inicio de ciclo de ${ciclosAjustados} alumno(s) cuya primera clase fue reprogramada.`
              : 'Reprogramación dinámica exitosa basada en el horario de cada alumno.',
        };
      },
      {
        timeout: 60000,
      }
    );
  },

  /**
   * Revierte una reprogramación masiva previa utilizando el grupo_uuid
   */
  revertirReprogramacionMasiva: async (grupo_uuid) => {
    return await prisma.$transaction(async (tx) => {
      // 1. Buscar la reprogramación masiva
      const reprogramaciones = await tx.reprogramaciones_clases.findMany({
        where: { grupo_uuid: grupo_uuid, estado: 'ACTIVO' },
      });

      if (!reprogramaciones || reprogramaciones.length === 0) {
        throw new ApiError(
          'No se encontró una reprogramación masiva activa con ese identificador.',
          404
        );
      }

      const reprogramacionesIds = reprogramaciones.map((r) => r.id);

      // 2. Buscar todas las asistencias afectadas
      const asistencias = await tx.registros_asistencia.findMany({
        where: { reprogramacion_clase_id: { in: reprogramacionesIds } },
      });

      if (asistencias.length === 0) {
        throw new ApiError(
          'No se encontraron registros de asistencia asociados a esta reprogramación.',
          404
        );
      }

      // 3. Reversión de la asistencia y facturación
      const asistenciasNuevas = await tx.registros_asistencia.findMany({
        where: {
          reprogramacion_clase_id: { in: reprogramacionesIds },
          fecha_original: { not: null },
        },
      });

      // =================================================================
      // 🎯 BL-005: estado de los ciclos ANTES de restaurar nada.
      //
      // Se excluyen las reposiciones de esta reprogramación para que
      // `clases[0]` sea la clase que pasó a ser primera cuando se aplicó el
      // corrimiento. La clase origen ya está en 'REPROGRAMADO', que
      // ESTADOS_CLASE_VIGENTE no cuenta.
      // =================================================================
      const ciclosReversion = await cargarCiclosVigentes(
        tx,
        asistenciasNuevas.map((an) => an.inscripcion_id),
        { excluirReprogramacionIds: reprogramacionesIds }
      );

      for (const an of asistenciasNuevas) {
        // Encontramos la clase que quedó como REPROGRAMADA para calcular el desfase original
        const claseOriginal = await tx.registros_asistencia.findFirst({
          where: {
            inscripcion_id: an.inscripcion_id,
            reprogramacion_clase_id: { in: reprogramacionesIds },
            estado: 'REPROGRAMADO',
          },
          orderBy: { fecha: 'desc' },
        });

        // Si no la encontramos por estado (quizás ya se movió), buscamos la inmediata anterior
        const refFecha = claseOriginal ? claseOriginal.fecha : an.fecha_original;

        // =================================================================
        // 🎯 BL-005: si la ida corrió el ciclo, la vuelta lo devuelve con el
        // MISMO delta en negativo — y entonces NO se ejecuta la reversión de
        // fecha_inscripcion de más abajo, porque la ida tampoco la ejecutó.
        // Las dos ramas son excluyentes en los dos sentidos.
        // =================================================================
        const cicloRev = ciclosReversion.get(an.inscripcion_id);
        const reversion = resolverReversionDeCiclo(cicloRev, an.fecha_original);

        if (reversion.debeRevertir) {
          await aplicarCorrimientoDeCiclo(tx, {
            link: cicloRev.link,
            inscripcionId: an.inscripcion_id,
            dias: -reversion.dias,
          });
          continue;
        }

        if (refFecha) {
          const diffMs = an.fecha.getTime() - refFecha.getTime();
          const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

          // Reversión de facturación usando lógica nativa de Prisma
          const inscripcionActual = await tx.inscripciones.findUnique({
            where: { id: an.inscripcion_id },
            select: { fecha_inscripcion: true },
          });

          const nuevaFechaInscripcion = new Date(inscripcionActual.fecha_inscripcion);
          nuevaFechaInscripcion.setDate(nuevaFechaInscripcion.getDate() - diffDays);

          await tx.inscripciones.update({
            where: { id: an.inscripcion_id },
            data: { fecha_inscripcion: nuevaFechaInscripcion },
          });
        }
      }

      // A) Borramos los registros "NUEVOS" creados en la fecha destino
      await tx.registros_asistencia.deleteMany({
        where: {
          reprogramacion_clase_id: { in: reprogramacionesIds },
          fecha_original: { not: null },
        },
      });

      // B) Restauramos los registros originales
      await tx.registros_asistencia.updateMany({
        where: { reprogramacion_clase_id: { in: reprogramacionesIds }, estado: 'REPROGRAMADO' },
        data: {
          estado: 'PENDIENTE',
          reprogramacion_clase_id: null,
          comentario: null,
          fecha_original: null,
        },
      });

      // 4. Marcar reprogramación como REVERTIDO
      await tx.reprogramaciones_clases.updateMany({
        where: { id: { in: reprogramacionesIds } },
        data: { estado: 'REVERTIDO' },
      });

      return { mensaje: 'Reprogramación revertida exitosamente.' };
    },
    {
      // 🎯 BL-005: esta transacción ya hacía N+1 por alumno con el default de
      // 5 s y ahora además deshace el ciclo. Se alinea con el timeout de
      // reprogramarMasivamente para que un lote grande no muera por P2028 a
      // mitad de la reversión.
      timeout: 60000,
    });
  },

  /**
   * Obtiene la lista de reprogramaciones masivas activas
   */
  obtenerMasivasActivas: async () => {
    const data = await prisma.reprogramaciones_clases.findMany({
      where: { es_masiva: true, estado: 'ACTIVO' },
      orderBy: { creado_en: 'desc' },
      include: {
        horarios_clases: {
          include: {
            canchas: { select: { nombre: true, sedes: { select: { nombre: true } } } },
            niveles_entrenamiento: { select: { nombre: true } },
          },
        },
        usuarios: { select: { nombres: true, apellidos: true } },
        _count: { select: { registros_asistencia: true } },
      },
    });

    // Dividimos entre 2 porque ahora guardamos el original (REPROGRAMADO) y el nuevo (PENDIENTE)
    return data.map((item) => ({
      ...item,
      _count: {
        ...item._count,
        registros_asistencia: Math.round(item._count.registros_asistencia / 2),
      },
    }));
  },

  /**
   * Obtiene el detalle de una clase específica (horario)
   */
  obtenerDetalleClase: async (horario_id) => {
    const horario = await prisma.horarios_clases.findUnique({
      where: { id: Number(horario_id) },
      select: {
        id: true,
        dia_semana: true,
        hora_inicio: true,
        hora_fin: true,
        capacidad_max: true,
        canchas: {
          select: { nombre: true, sedes: { select: { nombre: true } } },
        },
        coordinadores: {
          select: {
            usuarios: { select: { nombres: true, apellidos: true } },
          },
        },
        niveles_entrenamiento: { select: { nombre: true } },
        inscripciones: {
          where: { estado: 'ACTIVO' },
          select: {
            id: true,
            alumnos: {
              select: {
                usuario_id: true,
                usuarios: { select: { id: true, nombres: true, apellidos: true, email: true } },
              },
            },
          },
        },
      },
    });

    if (!horario) throw new ApiError('Horario no encontrado', 404);

    return {
      id: horario.id,
      dia_semana: horario.dia_semana,
      hora_inicio: horario.hora_inicio.toISOString().substring(11, 16),
      hora_fin: horario.hora_fin.toISOString().substring(11, 16),
      cancha: `${horario.canchas.nombre} - ${horario.canchas.sedes.nombre}`,
      coordinador: horario.coordinadores
        ? `${horario.coordinadores.usuarios.nombres} ${horario.coordinadores.usuarios.apellidos}`
        : 'Sin asignar',
      nivel: horario.niveles_entrenamiento.nombre,
      total_inscritos: horario.inscripciones.length,
      capacidad_maxima: horario.capacidad_max,
      alumnos_inscritos: horario.inscripciones.map((ins) => ({
        inscripcion_id: ins.id,
        alumno_id: ins.alumnos.usuario_id,
        nombre_completo: `${ins.alumnos.usuarios.nombres} ${ins.alumnos.usuarios.apellidos}`,
        email: ins.alumnos.usuarios.email,
      })),
    };
  },

  /**
   * Obtiene las fechas únicas disponibles (ya generadas en registros_asistencia) para un horario específico,
   * excluyendo aquellas fechas que ya hayan sido reprogramadas masivamente.
   */
  obtenerFechasDisponibles: async (horario_id) => {
    const horario = await prisma.horarios_clases.findUnique({
      where: { id: Number(horario_id) },
    });

    if (!horario) return [];

    const diasPermitidos = [horario.dia_semana];
    const fechasDisponibles = [];

    const hoy = new Date();
    let fechaActual = new Date();
    fechaActual.setHours(0, 0, 0, 0);

    const fechaLimite = new Date();
    fechaLimite.setMonth(hoy.getMonth() + 3);

    while (fechaActual <= fechaLimite) {
      let diaSemanaJS = fechaActual.getDay();

      if (diaSemanaJS === 0) diaSemanaJS = 7;

      if (diasPermitidos.includes(diaSemanaJS)) {
        const año = fechaActual.getFullYear();
        const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
        const dia = String(fechaActual.getDate()).padStart(2, '0');

        fechasDisponibles.push(`${año}-${mes}-${dia}`);
      }

      fechaActual.setDate(fechaActual.getDate() + 1);
    }

    return fechasDisponibles;
  },
  obtenerFechasPasadas: async (horario_id) => {
    const horario = await prisma.horarios_clases.findUnique({
      where: { id: Number(horario_id) },
    });

    if (!horario) return [];

    const diasPermitidos = [horario.dia_semana];
    const fechasDisponibles = [];

    // 1. El límite es el final del día de HOY
    const fechaLimite = new Date();
    fechaLimite.setHours(23, 59, 59, 999);

    // 2. El punto de inicio es hace EXACTAMENTE 2 MESES atrás
    let fechaActual = new Date();
    fechaActual.setMonth(fechaActual.getMonth() - 2);
    fechaActual.setHours(0, 0, 0, 0);

    // 3. El bucle que recorre día por día desde hace 2 meses hasta hoy
    while (fechaActual <= fechaLimite) {
      let diaSemanaJS = fechaActual.getDay();
      if (diaSemanaJS === 0) diaSemanaJS = 7; // Convertir domingo a 7

      if (diasPermitidos.includes(diaSemanaJS)) {
        const año = fechaActual.getFullYear();
        const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
        const dia = String(fechaActual.getDate()).padStart(2, '0');

        // 🔥 TRUCO: Usamos unshift() en lugar de push()
        // Esto hace que las fechas se agreguen al inicio del arreglo.
        // Así, el select en tu frontend mostrará el martes pasado arriba del todo, 
        // y el martes de hace 2 meses hasta abajo.
        fechasDisponibles.unshift(`${año}-${mes}-${dia}`);
      }

      // Avanzar un día
      fechaActual.setDate(fechaActual.getDate() + 1);
    }

    return fechasDisponibles;
  },

  /**
   * Obtiene la lista de horarios que tienen al menos un registro de asistencia generado,
   * para filtrar el selector de la reprogramación masiva.
   */
  obtenerHorariosConAsistencia: async () => {
    const horarios = await prisma.horarios_clases.findMany({
      where: {
        activo: true,
        inscripciones: {
          some: {
            estado: 'ACTIVO',
            registros_asistencia: {
              some: {
                estado: { not: 'REPROGRAMADO' },
              },
            },
          },
        },
      },
      select: {
        id: true,
        dia_semana: true,
        hora_inicio: true,
        hora_fin: true,
        canchas: {
          select: {
            nombre: true,
            sedes: { select: { nombre: true } },
          },
        },
        niveles_entrenamiento: { select: { nombre: true } },
      },
      orderBy: [{ dia_semana: 'asc' }, { hora_inicio: 'asc' }],
    });

    return horarios.map((h) => ({
      id: h.id,
      dia_semana: h.dia_semana,
      hora_inicio:
        h.hora_inicio.getUTCHours().toString().padStart(2, '0') +
        ':' +
        h.hora_inicio.getUTCMinutes().toString().padStart(2, '0'),
      hora_fin:
        h.hora_fin.getUTCHours().toString().padStart(2, '0') +
        ':' +
        h.hora_fin.getUTCMinutes().toString().padStart(2, '0'),
      nivel: { nombre: h.niveles_entrenamiento.nombre },
      cancha: {
        nombre: h.canchas.nombre,
        sede: { nombre: h.canchas.sedes.nombre },
      },
    }));
  },
};
