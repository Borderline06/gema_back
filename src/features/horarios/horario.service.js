import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
// 🎯 BL-001: NULL se asume REGULAR.
import { TIPO_INSCRIPCION, whereTipoInscripcion } from '../../shared/utils/tipo-inscripcion.util.js';
// 🎯 BL-003: /disponibilidad reusa las MISMAS reglas que la venta de clase suelta.
import { ESTADOS_VALIDOS_PARA_CICLO, sumarDiasUTC } from '../../shared/utils/ciclo.util.js';
import {
  buscarFeriado,
  cargarFeriadosActivos,
  claveDiaDesdeFecha,
} from '../../shared/utils/feriado.util.js';

// §3.2 Prisma Selectivo — solo traemos los campos necesarios
// 🆕 BL-004: exportado para que el pre-llenado de reinscripción devuelva los
// horarios con la MISMA forma que GET /api/horarios/nivel, que el front ya
// renderiza. Exportarlo es aditivo: no cambia ninguna respuesta existente.
export const HORARIO_SELECT = {
  id: true,
  dia_semana: true,
  hora_inicio: true,
  hora_fin: true,
  capacidad_max: true,
  activo: true,
  minutos_reserva_especifico: true,
  canchas: {
    select: {
      id: true,
      nombre: true,
      sedes: { select: { id: true, nombre: true } },
    },
  },
  niveles_entrenamiento: { select: { id: true, nombre: true } },
  coordinadores: {
    select: {
      usuario_id: true,
      especializacion: true,
      usuarios: { select: { nombres: true, apellidos: true } },
    },
  },
};

/**
 * Convierte strings "HH:MM" a objetos Date (base 1970-01-01).
 */
const parsearHoras = (horaInicio, horaFin) => {
  const fechaBase = '1970-01-01T';
  const inicio = new Date(`${fechaBase}${horaInicio}:00Z`);
  const fin = new Date(`${fechaBase}${horaFin}:00Z`);

  if (fin <= inicio) {
    throw new ApiError('La hora de fin debe ser posterior a la hora de inicio', 400);
  }

  return { horaInicioDate: inicio, horaFinDate: fin };
};

/**
 * Construye el `where` para detectar solapamientos de horarios.
 * Reutilizado por create y update.
 */
const buildSolapamientoWhere = ({ filtroId, dia_semana, horaInicio, horaFin, excludeId }) => ({
  ...(filtroId && filtroId),
  dia_semana,
  activo: true,
  ...(excludeId && { id: { not: excludeId } }),
  OR: [
    { AND: [{ hora_inicio: { lte: horaInicio } }, { hora_fin: { gt: horaInicio } }] },
    { AND: [{ hora_inicio: { lt: horaFin } }, { hora_fin: { gte: horaFin } }] },
    { AND: [{ hora_inicio: { gte: horaInicio } }, { hora_fin: { lte: horaFin } }] },
  ],
});

/**
 * Verifica solapamiento de cancha y coordinador.
 */
const verificarSolapamientos = async (params) => {
  const { cancha_id, coordinador_id, dia_semana, horaInicio, horaFin, excludeId } = params;

  const queries = [
    prisma.horarios_clases.findFirst({
      where: buildSolapamientoWhere({
        filtroId: { cancha_id },
        dia_semana,
        horaInicio,
        horaFin,
        excludeId,
      }),
      select: { id: true },
    })
  ];

  if (coordinador_id) {
    queries.push(
      prisma.horarios_clases.findFirst({
        where: buildSolapamientoWhere({
          filtroId: { coordinador_id },
          dia_semana,
          horaInicio,
          horaFin,
          excludeId,
        }),
        select: { id: true },
      })
    );
  } else {
    queries.push(Promise.resolve(null));
  }

  const [solapamientoCancha, solapamientoCoordinador] = await Promise.all(queries);

  if (solapamientoCancha) {
    console.error(`ERROR OVERLAP CANCHA. Details -> params:`, params, `| Found ID:`, solapamientoCancha.id);
    throw new ApiError('Ya existe un horario que se solapa en esta cancha', 400);
  }
  if (solapamientoCoordinador) {
    console.error(`ERROR OVERLAP COORD. Details -> params:`, params, `| Found ID:`, solapamientoCoordinador.id);
    throw new ApiError(
      'El coordinador ya tiene un horario asignado que se solapa con este rango',
      400
    );
  }
};

/**
 * Formatea un horario desde el resultado de Prisma al formato de la API.
 */
// 🆕 BL-004: exportado junto con HORARIO_SELECT (ver nota de arriba).
export const formatearHorario = (h) => ({
  id: h.id,
  dia_semana: h.dia_semana,
  hora_inicio: h.hora_inicio.toISOString().substring(11, 16),
  hora_fin: h.hora_fin.toISOString().substring(11, 16),
  capacidad_max: h.capacidad_max,
  activo: h.activo,
  minutos_reserva_especifico: h.minutos_reserva_especifico,
  cancha: {
    id: h.canchas.id,
    nombre: h.canchas.nombre,
    sede: {
      id: h.canchas.sedes.id,
      nombre: h.canchas.sedes.nombre,
    },
  },
  nivel: {
    id: h.niveles_entrenamiento.id,
    nombre: h.niveles_entrenamiento.nombre,
  },
  coordinador: h.coordinadores ? {
    id: h.coordinadores.usuario_id,
    nombre_completo: `${h.coordinadores.usuarios.nombres} ${h.coordinadores.usuarios.apellidos}`,
    especializacion: h.coordinadores.especializacion,
  } : {
    id: null,
    nombre_completo: 'Sin asignar',
    especializacion: null
  },
});

/**
 * 🎯 BL-003: arma la disponibilidad por fecha. Puro y sincrónico (sin BD) para
 * poder testearlo.
 *
 * Solo emite las fechas cuyo día de semana es el del horario (las únicas donde
 * hay clase). Recorre en UTC: `desde`/`hasta` son días calendario, no instantes.
 *
 * `capacidad_max || 20` es el mismo fallback de `validarAforoFechaClase`, y
 * `disponible` es su misma condición (`ocupados < capacidad`), más el feriado
 * que `validarFechaNoFeriado` también rechaza.
 *
 * @param {{dia_semana:number, capacidad_max:number|null}} horario
 * @param {string} desde 'YYYY-MM-DD'
 * @param {string} hasta 'YYYY-MM-DD'
 * @param {Map<string, number>} conteos 'YYYY-MM-DD' -> ocupados
 * @param {object|null} indiceFeriados de `cargarFeriadosActivos`
 */
export const construirDisponibilidad = ({ horario, desde, hasta, conteos, indiceFeriados }) => {
  const capacidad = horario.capacidad_max || 20;
  const fin = new Date(`${hasta}T00:00:00.000Z`);
  const resultado = [];

  for (
    let dia = new Date(`${desde}T00:00:00.000Z`);
    dia <= fin;
    dia = sumarDiasUTC(dia, 1)
  ) {
    // dia_semana: 1 (lunes) .. 7 (domingo); getUTCDay: 0 (domingo) .. 6.
    const diaSemana = dia.getUTCDay() === 0 ? 7 : dia.getUTCDay();
    if (diaSemana !== horario.dia_semana) continue;

    const clave = claveDiaDesdeFecha(dia);
    const ocupados = conteos.get(clave) ?? 0;
    const esFeriado = !!buscarFeriado(clave, indiceFeriados);

    resultado.push({
      fecha: clave,
      ocupados,
      capacidad_max: capacidad,
      disponible: ocupados < capacidad && !esFeriado,
      es_feriado: esFeriado,
    });
  }

  return resultado;
};

export const horarioService = {
  getAllHorarios: async () => {
    const horarios = await prisma.horarios_clases.findMany({
      where: {
        canchas: {
          sedes: { activo: true }
        }
      },
      select: HORARIO_SELECT,
    });
    return horarios.map(formatearHorario);
  },

  createHorario: async (data) => {
    const { cancha_id, coordinador_id, nivel_id, dia_semana } = data;

    const validaciones = [
      prisma.canchas.findUnique({ where: { id: cancha_id }, select: { id: true } }),
      prisma.niveles_entrenamiento.findUnique({ where: { id: nivel_id }, select: { id: true } })
    ];

    if (coordinador_id) {
      validaciones.push(prisma.coordinadores.findUnique({
        where: { usuario_id: coordinador_id },
        select: { usuario_id: true }
      }));
    }

    const resultados = await Promise.all(validaciones);
    const cancha = resultados[0];
    const nivel = resultados[1];
    const coordinador = coordinador_id ? resultados[2] : true;

    if (!cancha) throw new ApiError('La cancha especificada no existe', 404);
    if (!coordinador) throw new ApiError('El coordinador especificado no existe', 404);
    if (!nivel) throw new ApiError('El nivel de entrenamiento especificado no existe', 404);

    const { horaInicioDate, horaFinDate } = parsearHoras(data.hora_inicio, data.hora_fin);

    // Verificar solapamientos (cancha + coordinador en paralelo)
    await verificarSolapamientos({
      cancha_id,
      coordinador_id,
      dia_semana,
      horaInicio: horaInicioDate,
      horaFin: horaFinDate,
    });

    return await prisma.horarios_clases.create({
      data: {
        cancha_id,
        coordinador_id,
        nivel_id,
        dia_semana,
        hora_inicio: horaInicioDate,
        hora_fin: horaFinDate,
        capacidad_max: data.capacidad_max ?? 20,
        minutos_reserva_especifico: data.minutos_reserva_especifico ?? null,
        activo: true,
      },
      select: HORARIO_SELECT,
    });
  },

  updateHorario: async (id, data) => {
    const horarioExistente = await prisma.horarios_clases.findUnique({
      where: { id },
      select: {
        id: true,
        cancha_id: true,
        coordinador_id: true,
        nivel_id: true,
        dia_semana: true,
        hora_inicio: true,
        hora_fin: true,
        capacidad_max: true,
        minutos_reserva_especifico: true,
        activo: true,
      },
    });

    if (!horarioExistente) throw new ApiError('El horario especificado no existe', 404);

    // Merge: usar valor nuevo si viene, si no, conservar el existente
    const cancha_id = data.cancha_id ?? horarioExistente.cancha_id;
    const coordinador_id = data.coordinador_id === undefined
      ? horarioExistente.coordinador_id
      : data.coordinador_id;
    const nivel_id = data.nivel_id ?? horarioExistente.nivel_id;
    const dia_semana = data.dia_semana ?? horarioExistente.dia_semana;
    const nuevoActivo = data.activo ?? horarioExistente.activo;
    const capacidad_max = data.capacidad_max ?? horarioExistente.capacidad_max;
    const minutos_reserva_especifico =
      data.minutos_reserva_especifico === undefined
        ? horarioExistente.minutos_reserva_especifico
        : data.minutos_reserva_especifico;

    // Parsear horas (nuevas o existentes)
    const horaInicioStr =
      data.hora_inicio || horarioExistente.hora_inicio.toISOString().substring(11, 16);
    const horaFinStr = data.hora_fin || horarioExistente.hora_fin.toISOString().substring(11, 16);
    const { horaInicioDate, horaFinDate } = parsearHoras(horaInicioStr, horaFinStr);

    // Validar existencia de entidades referenciadas (solo si cambiaron)
    const validaciones = [];
    if (data.cancha_id)
      validaciones.push(
        prisma.canchas.findUnique({ where: { id: cancha_id }, select: { id: true } }).then((r) => {
          if (!r) throw new ApiError('La cancha especificada no existe', 404);
        })
      );
    if (data.coordinador_id) {
      const r = await prisma.coordinadores.findUnique({
        where: { usuario_id: coordinador_id },
        select: { usuario_id: true }
      });
      if (!r) throw new ApiError('El coordinador especificado no existe', 404);
    }
    if (data.nivel_id)
      validaciones.push(
        prisma.niveles_entrenamiento
          .findUnique({ where: { id: nivel_id }, select: { id: true } })
          .then((r) => {
            if (!r) throw new ApiError('El nivel de entrenamiento especificado no existe', 404);
          })
      );

    if (validaciones.length > 0) await Promise.all(validaciones);

    // Verificar solapamientos solo si el horario estará activo
    if (nuevoActivo) {
      await verificarSolapamientos({
        cancha_id,
        coordinador_id,
        dia_semana,
        horaInicio: horaInicioDate,
        horaFin: horaFinDate,
        excludeId: id,
      });
    }

    return await prisma.horarios_clases.update({
      where: { id },
      data: {
        cancha_id,
        coordinador_id,
        nivel_id,
        dia_semana,
        hora_inicio: horaInicioDate,
        hora_fin: horaFinDate,
        capacidad_max,
        minutos_reserva_especifico,
        activo: nuevoActivo,
      },
      select: HORARIO_SELECT,
    });
  },

  deleteHorario: async (id) => {
    const horario = await prisma.horarios_clases.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!horario) throw new ApiError('El horario especificado no existe', 404);

    try {
      return await prisma.horarios_clases.delete({
        where: { id },
      });
    } catch (error) {
      if (error.code === 'P2003') {
        throw new ApiError(
          'No se puede eliminar el horario porque tiene inscripciones asociadas.',
          409
        );
      }
      throw error;
    }
  },

  getHorariosBySede: async (sedeId) => {
    const horarios = await prisma.horarios_clases.findMany({
      where: {
        activo: true,
        canchas: {
          sede_id: Number(sedeId),
        }
      },
      include: {
        canchas: {
          select: {
            sedes: {
              select: {
                nombre: true,
              }
            }
          }
        },
        niveles_entrenamiento: {
          select: { nombre: true }
        }
      },
    });

    if (horarios.length === 0) throw new ApiError('Esta sede no existe o no hay horarios en dicha sede', 404);

    return horarios;
  },

  getHorariosByLevel: async (alumnoId) => {
    // 🚩 BL-001: antes era `tipo_inscripcion: 'REGULAR'` estricto, que NO
    // matchea las filas legacy con tipo_inscripcion = NULL (las previas a la
    // migración del campo). Para esos alumnos esto devolvía un 404 "no cuenta
    // con ninguna inscripción" aunque tuvieran su membresía activa.
    const insc = await prisma.inscripciones.findFirst({
      where: {
        alumno_id: alumnoId,
        ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR),
      },
      orderBy: {
        id: 'desc'
      },
      include: {
        horarios_clases: {
          select: {
            nivel_id: true,
          }
        }
      }
    })
    if (!insc) throw new ApiError('El alumno no cuenta con ninguna inscripción en la base de datos.', 404);

    const horarios = await prisma.horarios_clases.findMany({
      where: {
        nivel_id: insc.horarios_clases.nivel_id,
        canchas: {
          sedes: {
            activo: true,
          }
        }
      },
      select: HORARIO_SELECT,
    });
    return horarios.map(formatearHorario);
  },

  getDisponibilidad: async (id, desde, hasta) => {
    const horario = await prisma.horarios_clases.findUnique({
      where: { id: Number(id) },
      select: { id: true, dia_semana: true, capacidad_max: true },
    });

    if (!horario) throw new ApiError('El horario especificado no existe', 404);

    // Mismo conteo que `validarAforoFechaClase`, pero agrupado por fecha para
    // resolver todo el rango en una sola consulta.
    const [grupos, indiceFeriados] = await Promise.all([
      prisma.registros_asistencia.groupBy({
        by: ['fecha'],
        where: {
          fecha: {
            gte: new Date(`${desde}T00:00:00.000Z`),
            lte: new Date(`${hasta}T00:00:00.000Z`),
          },
          estado: { in: ESTADOS_VALIDOS_PARA_CICLO },
          inscripciones: { horario_id: horario.id },
        },
        _count: { _all: true },
      }),
      cargarFeriadosActivos(prisma),
    ]);

    const conteos = new Map(grupos.map((g) => [claveDiaDesdeFecha(g.fecha), g._count._all]));

    return construirDisponibilidad({ horario, desde, hasta, conteos, indiceFeriados });
  }
};
