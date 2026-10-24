import { prisma } from '../../config/database.config.js';
import { recuperacionService } from '../recuperaciones/recuperacion.service.js';
import dayjs from 'dayjs';

// 🔧 BL-003: `calcularProximasFechas` vivía acá como const privado y era la
// única definición de "¿en qué día cae la clase?". BL-003 necesita esa
// respuesta ANTES de crear la inscripción (para validar feriado y aforo de esa
// fecha), así que se movió a shared/utils/clase-fecha.util.js tal cual, sin
// duplicarla. Ver la cabecera de ese archivo: NO reescribir su aritmética a UTC.
import {
  DIAS_VENTANA_INDIVIDUAL,
  calcularFechasPorConteo,
  calcularProximasFechas,
  siguienteOcurrenciaSemanal,
} from '../../shared/utils/clase-fecha.util.js';
import { separarClasesParaCambio } from '../../shared/utils/cambio-horario.util.js';
// 🔧 BL-001: el 30 estaba hardcodeado acá como cuarta copia de la constante.
import { DIAS_CICLO, parsearFechaInicioCiclo } from '../../shared/utils/ciclo.util.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { esIndividual } from '../../shared/utils/tipo-inscripcion.util.js';
import {
  cargarFeriadosActivos,
  claveDiaDesdeFecha,
  buscarFeriado,
} from '../../shared/utils/feriado.util.js';
// 🤝 BL-010: slots que el alumno ya tiene ocupados por una recuperación.
import {
  cargarSlotsRecuperacion,
  buscarChoqueRecuperacion,
  claveSlot,
} from '../../shared/utils/recuperacion-slot.util.js';
import { formatHoraUTC } from '../../shared/utils/date.util.js';

// 🎉 BL-003: cuántas veces se intenta correr una clase suelta hacia adelante
// (+7 días cada vez) cuando cae en feriado, antes de rendirse y dejarla en su
// fecha original. 4 intentos = casi un mes de margen.
const MAX_SALTOS_POR_FERIADO = 4;

/**
 * 🤝 BL-010: detecta las fechas de un bloque de clases que coinciden EXACTAMENTE
 * (mismo día + misma hora de inicio) con una recuperación PROGRAMADA del alumno.
 *
 * Regla de negocio: el backend NO reubica ni omite nada. Un choque aborta la
 * generación con un 409 (ver `lanzarSiHayChoques`) y el administrador decide.
 *
 * Pura y sincrónica: nunca consulta ni lanza. El índice sale de
 * `cargarSlotsRecuperacion`, que ya filtra por estado PROGRAMADA.
 *
 * @returns {{fecha: string, hora: string, recuperacion_id: number, estado_recuperacion: string}[]}
 *   en orden cronológico
 */
// 🧪 Se exporta para testearla sin base de datos. No forma parte de
// `asistenciaService`, así que no toca ninguna superficie HTTP.
export const detectarChoquesCiclo = ({ fechas, horaInicio, indiceRecuperaciones }) => {
  // Sin hora no hay slot que comparar (horario sin hora_inicio) y sin índice no
  // hay nada contra lo que chocar.
  if (!horaInicio || !indiceRecuperaciones || indiceRecuperaciones.porSlot.size === 0) {
    return [];
  }

  const choques = [];

  for (const fecha of fechas) {
    const choque = buscarChoqueRecuperacion(claveSlot(fecha, horaInicio), indiceRecuperaciones);
    if (!choque) continue;

    choques.push({
      fecha: claveDiaDesdeFecha(fecha),
      hora: formatHoraUTC(horaInicio),
      recuperacion_id: choque.id,
      estado_recuperacion: choque.estado,
    });
  }

  return choques.sort((a, b) => a.fecha.localeCompare(b.fecha));
};

/**
 * 🤝 BL-010: convierte los choques en un 409 Conflict.
 *
 * Se lanza ANTES de insertar nada. Como los llamadores reales corren dentro de
 * una `$transaction` (validarPago, updateInscripcion), el throw la revierte
 * completa: el pago queda pendiente / el horario anterior se conserva.
 *
 * Forma del JSON (la arma error.middleware con ApiError):
 *   { success: 'error', message,
 *     details: { codigo, fecha, hora, inscripcion_id, choques: [...] } }
 * `fecha`/`hora` son las del primer choque; `choques` los trae todos.
 */
export const lanzarSiHayChoques = (choques, inscripcionId) => {
  if (!choques || choques.length === 0) return;

  const [primero] = choques;
  const [anio, mes, dia] = primero.fecha.split('-');
  const resto = choques.length > 1 ? ` (+${choques.length - 1} choque(s) más)` : '';

  throw new ApiError(
    `Choque con una clase de recuperación ya programada: el ${dia}/${mes}/${anio} a las ${primero.hora}${resto}.`,
    409,
    {
      codigo: 'CHOQUE_RECUPERACION',
      fecha: primero.fecha,
      hora: primero.hora,
      inscripcion_id: inscripcionId ?? null,
      choques,
    }
  );
};

export const asistenciaService = {
  /**
   * Genera masivamente las clases futuras respetando el CICLO DE 30 DÍAS.
   * Ahora prioriza el parámetro 'fecha_inicio' para evitar solapamientos.
   */
  generarClasesFuturas: async (tx, params) => {
    // 🔥 Desestructuramos incluyendo el nuevo parámetro fecha_inicio
    const { inscripcion_id, dia_semana, usuario_admin_id, coordinador_id, fecha_inicio } = params;

    // =================================================================
    // 🛡️ BL-001: GUARDIA DE TIPO (REGULAR vs INDIVIDUAL)
    //
    // Una inscripción INDIVIDUAL es una clase suelta: nunca debe recibir el
    // ciclo de 30 días. Esa bifurcación ya la hacía pagos.service.js, pero era
    // el ÚNICO sitio del backend que la hacía — updateInscripcion (cambio de
    // horario) llamaba acá directo y le generaba 30 clases a una clase suelta.
    // Esta guardia blinda a cualquier llamador, presente o futuro.
    //
    // `tipo_inscripcion` se puede pasar por params para ahorrar la consulta
    // cuando el llamador ya tiene la fila en mano (extensión retrocompatible:
    // si no viene, se lee).
    // =================================================================
    // 🤝 BL-010: `alumno_id` y `hora_inicio` se leen en la MISMA consulta que el
    // tipo (hacen falta para detectar el choque con recuperaciones). Igual que
    // `tipo_inscripcion` en BL-001, se pueden pasar por params cuando el
    // llamador ya tiene la fila en mano, y entonces no se consulta nada.
    let tipo = params.tipo_inscripcion;
    let alumnoId = params.alumno_id;
    let horaInicio = params.hora_inicio;

    if (tipo === undefined || alumnoId === undefined || horaInicio === undefined) {
      const inscripcion = await tx.inscripciones.findUnique({
        where: { id: inscripcion_id },
        select: {
          tipo_inscripcion: true,
          alumno_id: true,
          horarios_clases: { select: { hora_inicio: true } },
        },
      });
      if (tipo === undefined) tipo = inscripcion?.tipo_inscripcion ?? null;
      if (alumnoId === undefined) alumnoId = inscripcion?.alumno_id ?? null;
      if (horaInicio === undefined) horaInicio = inscripcion?.horarios_clases?.hora_inicio ?? null;
    }

    if (esIndividual(tipo)) {
      console.log(
        `🎟️ Inscripción ${inscripcion_id} es INDIVIDUAL: se genera 1 clase suelta, no un ciclo de ${DIAS_CICLO} días.`
      );
      return await asistenciaService.generarClaseUnica(tx, {
        inscripcion_id,
        dia_semana,
        coordinador_id,
        fecha_inicio,
        // 🤝 BL-010: se propagan para que la clase suelta también se valide
        // contra las recuperaciones sin repetir la consulta.
        alumno_id: alumnoId,
        hora_inicio: horaInicio,
        dryRun: params.dryRun,
      });
    }

    // =================================================================
    // 🧠 LÓGICA DE PUNTO DE PARTIDA (Prioridad de Negocio)
    // =================================================================
    let fechaInicioCalculo;

    if (fecha_inicio) {
      // 🌟 REGLA DE ORO: Si el pago ya definió cuándo empieza el ciclo (ej. 05/03), mandamos esa.
      fechaInicioCalculo = new Date(fecha_inicio);
      console.log(
        `🚀 Generando clases desde FECHA PROGRAMADA: ${fechaInicioCalculo.toLocaleDateString()}`
      );
    } else {
      // 🔄 FALLBACK: Lógica de empalme automática si se llama sin fecha_inicio
      const ultimaClase = await tx.registros_asistencia.findFirst({
        where: { inscripcion_id: inscripcion_id },
        orderBy: { fecha: 'desc' },
      });

      fechaInicioCalculo = new Date(); // Por defecto: HOY

      if (ultimaClase) {
        const fechaUltima = new Date(ultimaClase.fecha);
        if (fechaUltima > fechaInicioCalculo) {
          console.log(
            `📅 Detectada continuidad. Empalmando tras última clase: ${fechaUltima.toLocaleDateString()}`
          );
          fechaUltima.setDate(fechaUltima.getDate() + 1);
          fechaInicioCalculo = fechaUltima;
        }
      }
    }

    // =================================================================
    // 🧠 LÓGICA DE CÁLCULO DE LÍMITE (El "Hasta Cuándo")
    // =================================================================
    const fechaLimite = new Date(fechaInicioCalculo);
    fechaLimite.setDate(fechaLimite.getDate() + (DIAS_CICLO - 1));

    // 2. Calculamos las fechas reales de clase dentro de este ciclo
    const fechasPlanificadas = calcularProximasFechas(fechaInicioCalculo, dia_semana, fechaLimite);

    // =================================================================
    // 🤝 BL-010: si alguna fecha del ciclo coincide con una recuperación
    // PROGRAMADA del alumno, se aborta con 409 ANTES de insertar nada. Una sola
    // consulta para las ~5 fechas del ciclo.
    // =================================================================
    const indiceRecuperaciones = alumnoId ? await cargarSlotsRecuperacion(tx, alumnoId) : null;

    lanzarSiHayChoques(
      detectarChoquesCiclo({ fechas: fechasPlanificadas, horaInicio, indiceRecuperaciones }),
      inscripcion_id
    );

    // 🔍 `dryRun`: solo validar (ver `validarChoquesCiclo`). No inserta.
    if (params.dryRun) return fechasPlanificadas.length;

    // 3. Preparamos los objetos para insertar
    const datosAsistencia = fechasPlanificadas.map((fecha) => ({
      inscripcion_id: inscripcion_id,
      fecha: fecha,
      estado: 'PROGRAMADA',
      registrado_por: coordinador_id,
      comentario: `Generado auto (Ciclo 30 días) - Admin ID: ${usuario_admin_id}`,
    }));

    // 4. Insertamos usando skipDuplicates para blindar la base de datos
    if (datosAsistencia.length > 0) {
      await tx.registros_asistencia.createMany({
        data: datosAsistencia,
        skipDuplicates: true,
      });
    }

    console.log(
      `✅ Ciclo generado: ${datosAsistencia.length} clases para ID ${inscripcion_id} (Hasta: ${fechaLimite.toLocaleDateString()})`
    );

    return datosAsistencia.length;
  },

  /**
   * 🔢 Genera EXACTAMENTE `cantidad` clases, una por semana desde `fecha_inicio`,
   * saltando feriados sin consumir cupo. Es la generación del cambio de horario
   * (ver cambio-horario.util.js): el recurso son clases, no días calendario.
   *
   * No aplica la guardia INDIVIDUAL a propósito: el llamador (updateInscripcion)
   * ya bifurca por tipo.
   *
   * 🤝 BL-010: lanza 409 ANTES de insertar si alguna fecha choca con una
   * recuperación PROGRAMADA (la $transaction del llamador lo revierte todo).
   *
   * @returns {Promise<Date[]>} las fechas generadas, en orden. La última es el
   *   fin real del ciclo.
   */
  generarClasesPorConteo: async (tx, params) => {
    const { inscripcion_id, dia_semana, usuario_admin_id, coordinador_id, fecha_inicio, cantidad } =
      params;

    if (!Number.isInteger(cantidad) || cantidad <= 0) return [];
    if (!fecha_inicio) {
      throw new ApiError('Se requiere fecha_inicio para generar clases por conteo.', 400);
    }

    let alumnoId = params.alumno_id;
    let horaInicio = params.hora_inicio;
    if (alumnoId === undefined || horaInicio === undefined) {
      const inscripcion = await tx.inscripciones.findUnique({
        where: { id: inscripcion_id },
        select: { alumno_id: true, horarios_clases: { select: { hora_inicio: true } } },
      });
      if (alumnoId === undefined) alumnoId = inscripcion?.alumno_id ?? null;
      if (horaInicio === undefined) horaInicio = inscripcion?.horarios_clases?.hora_inicio ?? null;
    }

    const feriados = params.feriados ?? (await cargarFeriadosActivos(tx));
    const fechas = calcularFechasPorConteo(fecha_inicio, dia_semana, cantidad, {
      esFeriado: (fecha) => !!buscarFeriado(claveDiaDesdeFecha(fecha), feriados),
    });

    const indiceRecuperaciones = alumnoId ? await cargarSlotsRecuperacion(tx, alumnoId) : null;
    lanzarSiHayChoques(
      detectarChoquesCiclo({ fechas, horaInicio, indiceRecuperaciones }),
      inscripcion_id
    );

    if (params.dryRun) return fechas;

    await tx.registros_asistencia.createMany({
      data: fechas.map((fecha) => ({
        inscripcion_id,
        fecha,
        estado: 'PROGRAMADA',
        registrado_por: coordinador_id,
        comentario: `Generado auto (Cambio de horario, ${cantidad} clases) - Admin ID: ${usuario_admin_id}`,
      })),
      skipDuplicates: true,
    });

    console.log(
      `✅ Cambio de horario: ${fechas.length} clases para ID ${inscripcion_id} (última: ${fechas[fechas.length - 1].toLocaleDateString()})`
    );

    return fechas;
  },

  /**
   * 🔢 Primera mitad del cambio de horario REGULAR: separa las clases del ciclo
   * actual en conservadas y a eliminar (ver `separarClasesParaCambio`), borra
   * las segundas y devuelve cuántas clases ya consumió el alumno.
   *
   * `inicioCiclo` acota por abajo: las clases de ciclos anteriores de la misma
   * inscripción no se tocan ni cuentan.
   *
   * @returns {Promise<{consumidas: number, eliminadas: number}>}
   */
  depurarClasesParaCambioHorario: async (tx, { inscripcion_id, inicioCiclo, claveEfectiva }) => {
    const clases = await tx.registros_asistencia.findMany({
      where: { inscripcion_id, fecha: { gte: inicioCiclo } },
      select: { id: true, fecha: true, estado: true },
    });

    const { idsAEliminar, consumidas } = separarClasesParaCambio(clases, claveEfectiva);

    if (idsAEliminar.length > 0) {
      await tx.registros_asistencia.deleteMany({ where: { id: { in: idsAEliminar } } });
    }

    return { consumidas, eliminadas: idsAEliminar.length };
  },

  /**
   * 🔢 Segunda mitad: las clases conservadas pasan a la inscripción nueva, que es
   * la dueña del link del ciclo. Sin esto el ciclo vigente quedaría con las
   * clases ya dictadas colgando de una inscripción FINALIZADA.
   *
   * Seguro contra @@unique([inscripcion_id, fecha]): se llama antes de generar
   * las clases nuevas, así que la inscripción destino está vacía.
   */
  trasladarClasesDelCiclo: async (tx, { desde, hacia, inicioCiclo }) => {
    const { count } = await tx.registros_asistencia.updateMany({
      where: { inscripcion_id: desde, fecha: { gte: inicioCiclo } },
      data: { inscripcion_id: hacia },
    });
    return count;
  },

  /**
   * 🤝 BL-010: pre-validación SIN efectos. Calcula exactamente las fechas que
   * generaría `generarClasesFuturas` (misma ruta de código, vía `dryRun`) y
   * lanza el 409 si alguna choca con una recuperación PROGRAMADA. No inserta.
   *
   * Existe para que `validarPago` falle ANTES de mutar nada (inscripción,
   * ciclo, link), en vez de depender solo del rollback.
   *
   * @returns {Promise<number>} cantidad de clases que se generarían
   */
  validarChoquesCiclo: async (tx, params) =>
    asistenciaService.generarClasesFuturas(tx, { ...params, dryRun: true }),

  obtenerHistorial: async (inscripcionId) => {
    return await prisma.registros_asistencia.findMany({
      where: { inscripcion_id: parseInt(inscripcionId) },
      orderBy: { fecha: 'asc' },
    });
  },
  obtenerPorAlumno: async (alumnoId) => {
    return await prisma.registros_asistencia.findMany({
      where: {
        inscripciones: {
          alumno_id: parseInt(alumnoId),
        },
      },
      include: {
        reprogramaciones_clases: true,
        inscripciones: {
          include: {
            horarios_clases: {
              include: {
                canchas: { include: { sedes: true } },
                coordinadores: {
                  select: {
                    usuarios: {
                      select: {
                        nombres: true,
                        apellidos: true,
                      },
                    },
                  },
                },
                niveles_entrenamiento: true,
              },
            },
          },
        },
      },
      orderBy: { fecha: 'asc' }, // Recomendado 'asc' para ver cronológicamente
    });
  },

  /**
   * 🆕 Obtener todas las asistencias (Vista Admin)
   */
  obtenerTodas: async () => {
    return await prisma.registros_asistencia.findMany({
      include: {
        inscripciones: {
          include: {
            alumnos: {
              select: {
                usuarios: {
                  select: {
                    nombres: true,
                    apellidos: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { fecha: 'desc' },
    });
  },

  obtenerClasesDelDiaPorCoordinador: async (coordinadorId, fecha) => {
    const fechaConsulta = new Date(fecha);
    fechaConsulta.setHours(0, 0, 0, 0);
    const diaSemana = fechaConsulta.getDay();

    return await prisma.horarios_clases.findMany({
      where: {
        coordinador_id: coordinadorId,
        activo: true,
        OR: [
          { dia_semana: diaSemana },
          {
            inscripciones: {
              some: {
                registros_asistencia: {
                  some: {
                    fecha: fechaConsulta,
                    reprogramacion_clase_id: { not: null }
                  }
                }
              }
            }
          }
        ]
      },
      include: {
        niveles_entrenamiento: true,
        canchas: { include: { sedes: true } },
        inscripciones: {
          where: { estado: { in: ['ACTIVO'] } },
          include: {
            alumnos: {
              include: {
                usuarios: {
                  select: { id: true, nombres: true, apellidos: true },
                },
              },
            },
            // IMPORTANTE: Buscamos el registro de asistencia específico para este día
            registros_asistencia: {
              where: { fecha: fechaConsulta },
              select: {
                id: true, // Este es el ID que usará el coordinador para marcar
                estado: true, // Saldrá "PROGRAMADA" inicialmente
                comentario: true,
                reprogramaciones_clases: {
                  select: {
                    hora_inicio_destino: true,
                    hora_fin_destino: true
                  }
                },
              },
            },
          },
        },
      },
      orderBy: { hora_inicio: 'asc' },
    });
  },
  // En asistencia.service.js
  obtenerAgendaCoordinador: async (coordinadorId, fecha = null) => {
    const whereCondition = {
      coordinador_id: coordinadorId,
      activo: true,
    };

    if (fecha) {
      const fechaConsulta = new Date(fecha);
      fechaConsulta.setHours(0, 0, 0, 0);
      const diaSemana = fechaConsulta.getDay();

      whereCondition.OR = [
        { dia_semana: diaSemana },
        {
          inscripciones: {
            some: {
              registros_asistencia: {
                some: {
                  fecha: fechaConsulta,
                  reprogramacion_clase_id: { not: null }
                }
              }
            }
          }
        }
      ];
    }

    const horarios = await prisma.horarios_clases.findMany({
      where: whereCondition,
      include: {
        niveles_entrenamiento: true,
        canchas: { include: { sedes: true } },
        inscripciones: {
          where: { estado: { in: ['ACTIVO', 'FINALIZADO'] } },
          include: {
            alumnos: {
              include: {
                usuarios: {
                  select: { id: true, nombres: true, apellidos: true, numero_documento: true, fecha_nacimiento: true },
                },
              },
            },
            registros_asistencia: {
              where: fecha
                ? {
                  OR: [
                    { fecha: new Date(fecha) },
                    { reprogramacion_clase_id: { not: null } }
                  ],
                  estado: { not: 'SIN_REGISTRO' },
                }
                : { estado: { not: 'SIN_REGISTRO' }, },
              orderBy: { fecha: 'asc' },
              select: {
                id: true,
                fecha: true,
                estado: true,
                comentario: true,
                fecha_original: true,
                reprogramacion_clase_id: true,
                reprogramaciones_clases: {
                  select: {
                    hora_inicio_destino: true,
                    hora_fin_destino: true
                  }
                },
              },
            },
          },
        },
      },
      orderBy: { hora_inicio: 'asc' },
    });

    // 🛡️ 2. SOLUCIÓN AL ERROR 500: Creamos un nuevo arreglo para NO mutar la data original de Prisma
    const horariosProcesados = [];

    // Lógica para sumar a los alumnos que recuperarán clases ese dia.
    for (let horario of horarios) {
      const alumnosRecuperadores = await prisma.recuperaciones.findMany({
        where: {
          horario_destino_id: horario.id,
          estado: { in: ['PROGRAMADA', 'COMPLETADA_PRESENTE', 'COMPLETADA_FALTA'] },
        },
        include: {
          alumnos: {
            include: {
              usuarios: {
                select: { id: true, nombres: true, apellidos: true, numero_documento: true },
              },
            },
          },
        },
      });

      // Damos format a los alumnos para el front
      const recuperadoresFormat = alumnosRecuperadores.map((rec) => {
        let estadoFormat = 'PROGRAMADA';
        if (rec.estado === 'COMPLETADA_PRESENTE') estadoFormat = 'PRESENTE';
        else if (rec.estado === 'COMPLETADA_FALTA') estadoFormat = 'FALTA';

        return {
          id: `insc-recu-${rec.id}`,
          alumno_id: rec.alumnos.usuario_id,
          estado: 'RECUPERACION',
          tipo_sesion: 'RECUPERACION',
          alumnos: rec.alumnos,
          registros_asistencia: [
            {
              id: `reg-asis-recu-${rec.id}`,
              fecha: rec.fecha_programada,
              estado: estadoFormat,
              comentario: 'Alumno en clase de recuperación',
              tipo_sesion: 'RECUPERACION'
            },
          ],
        };
      });

      // 🌟 Combinamos las inscripciones de forma segura en un NUEVO objeto
      horariosProcesados.push({
        ...horario,
        inscripciones: [
          ...horario.inscripciones.map(ins => {
            const reg = ins.registros_asistencia[0];
            const tipo = reg?.estado === 'REPROGRAMADO'
              ? 'REPROGRAMADO'
              : reg?.fecha_original
                ? 'REPOSICION'
                : 'REGULAR';

            return {
              ...ins,
              tipo_sesion: tipo,
              registros_asistencia: ins.registros_asistencia.map(r => ({
                ...r,
                tipo_sesion: r.estado === 'REPROGRAMADO'
                  ? 'REPROGRAMADO'
                  : r.fecha_original
                    ? 'REPOSICION'
                    : 'REGULAR'
              }))
            };
          }),
          ...recuperadoresFormat
        ],
      });
    }

    // TRANSFORMACIÓN: Limpiamos la data usando el nuevo arreglo procesado
    return horariosProcesados.map((h) => {
      // Filtramos los registros "Fantasma" de las inscripciones regulares
      h.inscripciones.forEach((insc) => {
        if (insc.estado !== 'RECUPERACION') {
          insc.registros_asistencia = insc.registros_asistencia.filter(
            (reg) => !reg.comentario?.includes('[RECUPERACION]')
          );
        }
      });

      // Función interna para extraer solo HH:mm y evitar el bug de 1970
      const formatTime = (timeField) => {
        if (!timeField) return '--:--';
        const d = new Date(timeField);
        // transformamos a string la hora y minutos para evitar el cambio de zona horario en el front.
        const horas = d.getUTCHours().toString().padStart(2, '0');
        const minutos = d.getUTCMinutes().toString().padStart(2, '0');
        return `${horas}:${minutos}`;
      };

      return {
        ...h,
        hora_inicio: formatTime(h.hora_inicio),
        hora_fin: formatTime(h.hora_fin),
      };
    });
  },
  previsualizarfechasFuturas: async (data) => {
    const { alumno_id, horario_ids } = data;

    try {
      const hoy = dayjs().startOf('day');
      let resultados = [];

      // 1. Buscamos los detalles de los horarios solicitados
      const horarios = await prisma.horarios_clases.findMany({
        where: { id: { in: horario_ids } }
      });

      for (const horario of horarios) {
        let fechasEsteDia = [];

        // 🚩 AJUSTE CRÍTICO PARA FORMATO 1-7: Dayjs necesita 0-6
        const diaMapeado = horario.dia_semana === 7 ? 0 : horario.dia_semana;
        let fechaBase = hoy.day(diaMapeado);

        // Si ya pasó en la semana actual, saltamos a la próxima
        if (fechaBase.isBefore(hoy, 'day')) {
          fechaBase = fechaBase.add(7, 'day');
        }

        // 🕵️‍♂️ LÓGICA INTELIGENTE: Buscar la última clase de ESTE alumno en ESTE horario
        const ultimaClase = await prisma.registros_asistencia.findFirst({
          where: {
            inscripciones: {
              alumno_id: Number(alumno_id),
              horario_id: horario.id
            }
          },
          orderBy: { fecha: 'desc' }
        });

        // 🛡️ REGLA DE ENGANCHE (Vacunada contra Timezones)
        if (ultimaClase) {
          // ✅ FIX: Extraemos solo el "YYYY-MM-DD" en UTC puro antes de que Node/Dayjs lo conviertan a hora local y le resten 5 horas
          const fechaStringPura = ultimaClase.fecha.toISOString().split('T')[0];
          const fechaUltima = dayjs(fechaStringPura).startOf('day');

          // Si su última clase es hoy, mañana o en el futuro, enganchamos 7 días después
          if (fechaUltima.isAfter(hoy.subtract(1, 'day'))) {
            fechaBase = fechaUltima.add(7, 'day');
          }
        }

        // Opción A: Inicio Inmediato (o fecha de enganche segura)
        fechasEsteDia.push(fechaBase.format('YYYY-MM-DD'));

        // Opción B: Próximo Turno (+7 días sobre la base calculada)
        fechasEsteDia.push(fechaBase.add(7, 'day').format('YYYY-MM-DD'));

        resultados.push(fechasEsteDia);
      }

      return resultados;
    } catch (error) {
      console.error("Error en previsualizarfechasFuturas:", error);
      throw error;
    }
  },

  procesarAsistenciaMasiva: async (asistencias) => {

    const esFechaFutura = (fechaClase) => {
      const hoy = new Date();
      const hoyUTC = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());

      const fecha = new Date(fechaClase);
      const fechaUTC = Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());

      return fechaUTC > hoyUTC;
    };

    return await prisma.$transaction(async (tx) => {
      for (const a of asistencias) {
        // Por si el alumno es de recuperación
        if (typeof a.id === 'string' && a.id.startsWith('reg-asis-recu-')) {
          const recuperacionId = parseInt(a.id.split('-')[3]);

          // Marcar el ticket de recuperación
          const recu = await tx.recuperaciones.update({
            where: { id: recuperacionId },
            data: {
              estado: a.estado === 'FALTA'
                ? 'COMPLETADA_FALTA'
                : a.estado === 'PRESENTE'
                  ? 'COMPLETADA_PRESENTE'
                  : a.estado
            }
          });

          if (esFechaFutura(recu.fecha_programada)) {
            throw new Error("No se puede registrar recuperación en una fecha futura.");
          }

          const inscActiva = await tx.inscripciones.findFirst({
            where: { alumno_id: recu.alumno_id, estado: { in: ['ACTIVO'] } },
          });

          if (inscActiva) {
            // Obtenemos el registro si en caso existiera para manejarlo por posible error humano (marcar PRESENTE a un alumno que nunca llegó)
            const registroFisicoExistente = await tx.registros_asistencia.findFirst({
              where: {
                inscripcion_id: inscActiva.id,
                fecha: recu.fecha_programada,
                comentario: { contains: '[RECUPERACION]' }, // Usamos la etiqueta para encontrarlo
              },
            });

            if (a.estado === 'FALTA') {
              // Si se corrigió el registro como FALTA, lo borramos
              if (registroFisicoExistente) {
                await tx.registros_asistencia.delete({
                  where: { id: registroFisicoExistente.id },
                });
              }
            } else {
              if (registroFisicoExistente) {
                // Si es marcado como PRESENTE y el registro ya existia, solo se actualiza el estado.
                await tx.registros_asistencia.update({
                  where: { id: registroFisicoExistente.id },
                  data: {
                    estado: a.estado,
                  },
                });
              } else {
                // Si no existe, lo creamos
                await tx.registros_asistencia.create({
                  data: {
                    inscripcion_id: inscActiva.id,
                    fecha: recu.fecha_programada,
                    estado: a.estado,
                    comentario: `[RECUPERACION] ${a.comentario || ''}`,
                  },
                });
              }
            }
          }
          continue;
        }

        // Si el estado de la asistencia es JUSTIFICADO_LESION, se salta al siguiente alumno.
        const asistencia = await tx.registros_asistencia.findUnique({
          where: { id: Number(a.id) },
        });
        if (!asistencia || asistencia.estado === 'JUSTIFICADO_LESION') {
          continue;
        }

        if (esFechaFutura(asistencia.fecha)) {
          throw new Error("No se puede registrar asistencia en una fecha futura.");
        }

        // Si es un alumno fijo, simplemente se actualiza la asistencia
        const asistenciaRegistrada = await tx.registros_asistencia.update({
          where: { id: Number(a.id) },
          data: {
            estado: a.estado,
            comentario: a.comentario || '',
            registrado_en: new Date(),
          },
          include: {
            inscripciones: true,
          },
        });

        const idAlumnoInscripcion = asistenciaRegistrada.inscripciones.alumno_id;
        const fechaClase = asistenciaRegistrada.fecha;

        // 🔥 REGLA DE NEGOCIO: Si la clase es [NO_RECUPERABLE], saltamos la generación del ticket de falta.
        // Lo verificamos desde el objeto 'asistencia' que cargamos de la BD antes del update.
        const esNoRecuperable = asistencia.comentario?.includes('[NO_RECUPERABLE]');

        // Crea un registro en la tabla recuperaciones con estado PENDIENTE en caso la asistencia sea registrada como FALTA.
        if (asistenciaRegistrada.estado === 'FALTA' && !esNoRecuperable) {
          await recuperacionService.registrarFaltaPendiente(
            tx,
            idAlumnoInscripcion,
            fechaClase,
            asistencia.id
          );
        } else if (asistenciaRegistrada.estado === 'PRESENTE') {
          // En caso el alumno llegue tarde, se elimina la recuperación generada.
          await recuperacionService.anularFaltaPendiente(tx, idAlumnoInscripcion, asistencia.id);
        }

        // Si era no recuperable, nos aseguramos de que el tag persista si el coordinador escribió algo
        if (esNoRecuperable && !asistenciaRegistrada.comentario?.includes('[NO_RECUPERABLE]')) {
          await tx.registros_asistencia.update({
            where: { id: asistenciaRegistrada.id },
            data: { comentario: `[NO_RECUPERABLE] ${asistenciaRegistrada.comentario || ''}` }
          });
        }
      }
    });
  },
  obtenerEstadisticasAlumno: async (alumnoId) => {
    // 1. Traemos TODOS los registros del alumno
    const registros = await prisma.registros_asistencia.findMany({
      where: {
        inscripciones: {
          alumno_id: parseInt(alumnoId),
        }
      }
    });

    // 2. Inicializamos los contadores
    let presente = 0;
    let falta = 0;
    let programada = 0;
    let justificado_lesion = 0;

    // 3. Clasificamos cada clase según tu regla de negocio
    registros.forEach(reg => {
      // Agrupamos también las recuperaciones completadas para ser justos
      if (reg.estado === 'PRESENTE' || reg.estado === 'COMPLETADA_PRESENTE') {
        presente++;
      } else if (reg.estado === 'FALTA' || reg.estado === 'COMPLETADA_FALTA') {
        falta++;
      } else if (reg.estado === 'PROGRAMADA') {
        programada++;
      } else if (reg.estado === 'JUSTIFICADO_LESION') {
        justificado_lesion++;
      }
    });

    // 4. EL NÚCLEO DE LA EVALUACIÓN (Solo Presentes y Faltas)
    const clasesEvaluables = presente + falta;

    // 5. Matemáticas de porcentajes (evitando dividir por cero)
    const porcentajePresente = clasesEvaluables > 0 ? Math.round((presente / clasesEvaluables) * 100) : 0;
    const porcentajeFalta = clasesEvaluables > 0 ? Math.round((falta / clasesEvaluables) * 100) : 0;

    // 6. Armamos la respuesta perfecta para el Frontend
    return {
      porcentaje_asistencia_real: porcentajePresente, // El dato principal
      totales: {
        evaluadas: clasesEvaluables,
        ignoradas: programada + justificado_lesion,
        historico_completo: registros.length
      },
      detalle: {
        PRESENTE: {
          cantidad: presente,
          porcentaje: porcentajePresente
        },
        FALTA: {
          cantidad: falta,
          porcentaje: porcentajeFalta
        },
        PROGRAMADA: {
          cantidad: programada,
          porcentaje: null // Se ignora en el cálculo
        },
        JUSTIFICADO_LESION: {
          cantidad: justificado_lesion,
          porcentaje: null // Se ignora en el cálculo
        }
      }
    };
  },

  eliminarClases: async (tx, inscripcionId, fecha_inscripcion_original) => {
    // const hoy = new Date()
    // hoy.setHours(0, 0, 0, 0)

    const registros = await tx.registros_asistencia.deleteMany({
      where: {
        inscripcion_id: inscripcionId,
        fecha: {
          gte: fecha_inscripcion_original,
        }
      }
    })
    return registros.count;
  },

  /**
   * 🎟️ BL-003: genera la ÚNICA clase de una inscripción INDIVIDUAL.
   *
   * @param {object} params
   * @param {object|null} [params.feriados] índice ya cargado con
   *   `cargarFeriadosActivos` (evita reconsultar si el llamador ya lo tiene).
   * @param {boolean} [params.reprogramarSiFeriado=true]
   * @returns {Promise<number>} cuántos registros se insertaron.
   *
   * ⚠️ ESTA FUNCIÓN NO LANZA NUNCA POR FERIADO, a propósito.
   * El llamador real es pagos.service.js -> validarPago, dentro de una
   * $transaction. Si lanzara, un feriado creado por el admin DESPUÉS de la
   * venta abortaría la transacción del pago: dinero ya recibido, pago sin
   * aprobar y cuenta en PENDIENTE. La validación dura vive en
   * inscribirIndividual (antes de cobrar); acá solo se corre la fecha.
   *
   * 🤝 BL-010: SÍ lanza un 409 (ApiError) si la fecha final coincide con una
   * recuperación PROGRAMADA del alumno. A diferencia del feriado, es un choque
   * que el admin debe resolver, y validarPago lo pre-valida antes de mutar.
   * `params.dryRun` valida sin insertar.
   */
  generarClaseUnica: async (tx, params) => {
    const {
      inscripcion_id,
      dia_semana,
      coordinador_id,
      fecha_inicio,
      feriados = null,
      reprogramarSiFeriado = true,
    } = params;

    // Si el llamador no manda fecha_inicio, arrancamos hoy (antes esto producía
    // un Invalid Date silencioso).
    const fechaInicioCalculo = fecha_inicio ? new Date(fecha_inicio) : new Date();

    const fechaLimite = new Date(fechaInicioCalculo);
    fechaLimite.setDate(fechaLimite.getDate() + (DIAS_VENTANA_INDIVIDUAL - 1));

    let fechasClases = calcularProximasFechas(fechaInicioCalculo, dia_semana, fechaLimite);

    // 🎉 BL-003: si la fecha cayó en feriado, la corremos +7 días (misma
    // ocurrencia semanal) hasta MAX_SALTOS_POR_FERIADO intentos. Si no hay
    // hueco, se deja la fecha original (comportamiento previo) y se loguea.
    if (reprogramarSiFeriado && fechasClases.length > 0) {
      const indiceFeriados = feriados ?? (await cargarFeriadosActivos(tx));

      let fechaCandidata = fechasClases[0];
      let saltos = 0;
      let feriadoDetectado = buscarFeriado(claveDiaDesdeFecha(fechaCandidata), indiceFeriados);

      while (feriadoDetectado && saltos < MAX_SALTOS_POR_FERIADO) {
        console.warn(
          `🎉 Clase individual de inscripción ${inscripcion_id} cae en feriado (${feriadoDetectado.descripcion}). Corriendo +7 días.`
        );
        // 🔧 BL-010: el `+7` inline se movió a clase-fecha.util.js para que el
        // salto por feriado y el salto por choque no puedan divergir.
        fechaCandidata = siguienteOcurrenciaSemanal(fechaCandidata);
        saltos += 1;
        feriadoDetectado = buscarFeriado(claveDiaDesdeFecha(fechaCandidata), indiceFeriados);
      }

      if (feriadoDetectado) {
        console.warn(
          `⚠️ Inscripción ${inscripcion_id}: no se halló fecha libre de feriados en ${MAX_SALTOS_POR_FERIADO} intentos. Se deja la fecha original para NO romper el pago.`
        );
      } else {
        fechasClases = [fechaCandidata];
      }
    }

    // =================================================================
    // 🤝 BL-010: una clase suelta también puede caer sobre una recuperación ya
    // agendada. Se valida DESPUÉS del feriado (primero el día no laborable,
    // después el slot) y, si choca, se aborta con 409 antes de insertar.
    // =================================================================
    if (fechasClases.length > 0) {
      let alumnoId = params.alumno_id;
      let horaInicio = params.hora_inicio;

      if (alumnoId === undefined || horaInicio === undefined) {
        const inscripcion = await tx.inscripciones.findUnique({
          where: { id: inscripcion_id },
          select: { alumno_id: true, horarios_clases: { select: { hora_inicio: true } } },
        });
        if (alumnoId === undefined) alumnoId = inscripcion?.alumno_id ?? null;
        if (horaInicio === undefined) horaInicio = inscripcion?.horarios_clases?.hora_inicio ?? null;
      }

      if (alumnoId) {
        const indiceRecuperaciones = await cargarSlotsRecuperacion(tx, alumnoId);
        lanzarSiHayChoques(
          detectarChoquesCiclo({ fechas: fechasClases, horaInicio, indiceRecuperaciones }),
          inscripcion_id
        );
      }
    }

    // 🔍 `dryRun`: solo validar (ver `validarChoquesCiclo`). No inserta.
    if (params.dryRun) return fechasClases.length;

    const datosAsistencia = fechasClases.map((fecha) => ({
      inscripcion_id: inscripcion_id,
      fecha: fecha,
      estado: 'PROGRAMADA',
      registrado_por: coordinador_id,
      comentario: `Clase Individual`,
    }));

    if (datosAsistencia.length > 0) {
      await tx.registros_asistencia.createMany({
        data: datosAsistencia,
        skipDuplicates: true,
      });
    }

    // 🚩 Antes devolvía undefined. El único llamador (pagos.service.js) ignora
    // el retorno, así que devolver el conteo es retrocompatible y permite que
    // generarClasesFuturas delegue acá y siga devolviendo un número.
    return datosAsistencia.length;
  },

  /**
   * 🤝 BL-010: previsualiza los choques con recuperaciones ANTES de generar.
   *
   * Es la "alerta limpia que el frontend puede manejar" del ticket, resuelta en
   * un endpoint NUEVO y de solo lectura. No se añadió al response de
   * `validarPago` por la regla de oro (no se tocan las llaves de los JSON
   * existentes), y no devuelve 409 porque esto es una consulta previa, no un
   * conflicto: el admin la usa para decidir antes de aprobar el pago.
   *
   * Reusa EXACTAMENTE la misma aritmética que la generación real
   * (`calcularProximasFechas` + `detectarChoquesCiclo`), así que lo que
   * muestra es por construcción lo que va a pasar.
   */
  previsualizarChoquesRecuperacion: async ({ inscripcion_id, fecha_inicio }) => {
    // ⚠️ Fuera de cualquier $transaction: un formato inválido debe dar 400 sin
    // haber tocado la BD (ver la cabecera de parsearFechaInicioCiclo).
    const inicioSolicitado = parsearFechaInicioCiclo(fecha_inicio);

    const inscripcion = await prisma.inscripciones.findUnique({
      where: { id: Number(inscripcion_id) },
      select: {
        id: true,
        alumno_id: true,
        tipo_inscripcion: true,
        fecha_inscripcion: true,
        horarios_clases: { select: { dia_semana: true, hora_inicio: true } },
      },
    });

    if (!inscripcion) {
      throw new ApiError(`Inscripción ${inscripcion_id} no encontrada.`, 404);
    }

    const fechaInicioCalculo = inicioSolicitado ?? new Date(inscripcion.fecha_inscripcion);

    // 🚩 BL-001: una INDIVIDUAL vive en su ventana de 7 días, no en el ciclo de 30.
    const diasVentana = esIndividual(inscripcion) ? DIAS_VENTANA_INDIVIDUAL : DIAS_CICLO;
    const fechaLimite = new Date(fechaInicioCalculo);
    fechaLimite.setDate(fechaLimite.getDate() + (diasVentana - 1));

    const fechasPlanificadas = calcularProximasFechas(
      fechaInicioCalculo,
      inscripcion.horarios_clases.dia_semana,
      fechaLimite
    );

    const indiceRecuperaciones = await cargarSlotsRecuperacion(prisma, inscripcion.alumno_id);

    const choques = detectarChoquesCiclo({
      fechas: fechasPlanificadas,
      horaInicio: inscripcion.horarios_clases.hora_inicio,
      indiceRecuperaciones,
    });

    return {
      inscripcion_id: inscripcion.id,
      alumno_id: inscripcion.alumno_id,
      hora: formatHoraUTC(inscripcion.horarios_clases.hora_inicio),
      total_clases_previstas: fechasPlanificadas.length,
      hay_choques: choques.length > 0,
      total_choques: choques.length,
      choques,
      // Llave conservada (regla de oro): antes listaba fechas sin hueco al
      // reubicar. Ya no se reubica nada, así que siempre va vacía.
      omitidas: [],
    };
  }
};
