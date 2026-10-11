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
  calcularProximasFechas,
  siguienteOcurrenciaSemanal,
} from '../../shared/utils/clase-fecha.util.js';
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

// 🤝 BL-010: cuántas ocurrencias semanales se prueban cuando la fecha choca con
// una recuperación ya agendada.
//
// Es MÁS que MAX_SALTOS_POR_FERIADO a propósito: una clase que choca tiene que
// poder saltar por encima de TODAS las demás fechas del propio ciclo (un ciclo
// de 30 días tiene 4-5 ocurrencias) para aterrizar libre al final, que es la
// misma semántica de "reposición al final del ciclo" que ya usa la
// reprogramación masiva. Con 4 no alcanzaba para un ciclo de 5 clases.
const MAX_SALTOS_POR_CHOQUE = 6;

/**
 * 🤝 BL-010: reubica las fechas de un ciclo que choquen con una recuperación.
 *
 * Una recuperación ocupa el slot del alumno (mismo día + misma hora). Si se
 * generara la clase regular ahí pasaría una de dos cosas, ambas malas:
 *   · el alumno aparece DOS veces en el turno de la agenda del coordinador, o
 *   · si la recuperación ya se marcó PRESENTE existe una fila física
 *     `[RECUPERACION]` en esa fecha, el @@unique([inscripcion_id, fecha]) la
 *     bloquea y `skipDuplicates` se come la clase regular sin avisar.
 *
 * Regla de negocio: la clase NO se pierde, se corre a la siguiente ocurrencia
 * semanal LIBRE — libre significa sin choque y sin pisar otra fecha del mismo
 * ciclo, así que en la práctica aterriza al final, detrás de la última clase.
 *
 * ⚠️ PURA Y NO LANZA NUNCA. El llamador real corre dentro de la $transaction de
 * `validarPago`: un throw haría rollback del pago (dinero recibido, cuenta en
 * PENDIENTE). Si no encuentra hueco, omite la fecha y lo deja en el reporte.
 *
 * @returns {{fechas: Date[], choques: object[], omitidas: object[]}}
 */
// 🧪 Se exporta ADEMÁS de usarse internamente: es la aritmética más delicada de
// BL-010 y el repo no tenía un solo test. No forma parte de `asistenciaService`,
// así que no toca ninguna superficie HTTP.
export const reubicarFechasConChoque = ({ fechas, horaInicio, indiceRecuperaciones }) => {
  const choques = [];
  const omitidas = [];

  // Sin hora no hay slot que comparar (horario sin hora_inicio) y sin índice no
  // hay nada que esquivar: se devuelve el plan original intacto.
  if (!horaInicio || !indiceRecuperaciones || indiceRecuperaciones.porSlot.size === 0) {
    return { fechas, choques, omitidas };
  }

  // Todas las fechas planificadas del ciclo: una fecha corrida no puede
  // aterrizar sobre otra clase del mismo ciclo (el @@unique la descartaría).
  const planificadas = new Set(fechas.map((f) => claveDiaDesdeFecha(f)));
  const ocupadas = new Set();
  const fechasFinales = [];

  for (const fecha of fechas) {
    const claveOriginal = claveDiaDesdeFecha(fecha);
    planificadas.delete(claveOriginal);

    let candidata = fecha;
    let saltos = 0;
    let choque = buscarChoqueRecuperacion(claveSlot(candidata, horaInicio), indiceRecuperaciones);

    while (choque && saltos < MAX_SALTOS_POR_CHOQUE) {
      if (saltos === 0) {
        choques.push({
          fecha: claveOriginal,
          hora: formatHoraUTC(horaInicio),
          recuperacion_id: choque.id,
          estado_recuperacion: choque.estado,
        });
      }

      candidata = siguienteOcurrenciaSemanal(candidata);
      saltos += 1;

      const claveCandidata = claveDiaDesdeFecha(candidata);
      const pisaOtraClase = planificadas.has(claveCandidata) || ocupadas.has(claveCandidata);

      choque = pisaOtraClase
        ? // Marcador de "sigue buscando": no es un choque con recuperación, pero
          // tampoco es un hueco válido.
          { id: null, estado: 'OCUPADO_POR_CICLO' }
        : buscarChoqueRecuperacion(claveSlot(candidata, horaInicio), indiceRecuperaciones);
    }

    if (choque) {
      // No se halló hueco en 6 semanas. Se omite la fecha (jamás se lanza) y
      // queda en el reporte para que el admin lo resuelva a mano.
      omitidas.push({
        fecha: claveOriginal,
        hora: formatHoraUTC(horaInicio),
        motivo: 'SIN_HUECO_LIBRE',
      });
      continue;
    }

    const claveFinal = claveDiaDesdeFecha(candidata);
    ocupadas.add(claveFinal);
    if (saltos > 0) {
      choques[choques.length - 1].fecha_reubicada = claveFinal;
    }
    fechasFinales.push(candidata);
  }

  // Orden cronológico: una fecha reubicada al final del ciclo conservaba la
  // posición de la original dentro del array, y eso dejaba la lista
  // desordenada para cualquiera que la lea (el reporte de la previsualización,
  // o un futuro llamador que asuma orden).
  fechasFinales.sort((a, b) => a.getTime() - b.getTime());

  return { fechas: fechasFinales, choques, omitidas };
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
        // 🤝 BL-010: se propagan para que la clase suelta también esquive el
        // choque sin repetir la consulta.
        alumno_id: alumnoId,
        hora_inicio: horaInicio,
        choques: params.choques,
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
    // 🤝 BL-010: esquivar los slots que el alumno ya tiene ocupados por una
    // recuperación agendada. Una sola consulta para las ~5 fechas del ciclo.
    // =================================================================
    const indiceRecuperaciones = alumnoId ? await cargarSlotsRecuperacion(tx, alumnoId) : null;

    const { fechas: fechasClases, choques, omitidas } = reubicarFechasConChoque({
      fechas: fechasPlanificadas,
      horaInicio,
      indiceRecuperaciones,
    });

    for (const choque of choques) {
      console.warn(
        `🤝 BL-010: inscripción ${inscripcion_id} choca con la recuperación ${choque.recuperacion_id} el ${choque.fecha} ${choque.hora}. Clase corrida al ${choque.fecha_reubicada ?? 'N/A'}.`
      );
    }
    for (const omitida of omitidas) {
      console.warn(
        `⚠️ BL-010: inscripción ${inscripcion_id}: no se halló slot libre para la clase del ${omitida.fecha} en ${MAX_SALTOS_POR_CHOQUE} semanas. Se omite esa fecha para NO romper la transacción del pago.`
      );
    }

    // 🚩 Reporte OPCIONAL por out-param: si el llamador pasó un array, se le
    // empujan los choques. Así ningún llamador actual cambia y ninguna respuesta
    // JSON existente gana llaves nuevas (regla de oro). `validarPago` NO lo pasa
    // a propósito: ahí el choque solo se loguea.
    if (Array.isArray(params.choques)) {
      params.choques.push(...choques.map((c) => ({ ...c, inscripcion_id })));
    }

    // 3. Preparamos los objetos para insertar
    const datosAsistencia = fechasClases.map((fecha) => ({
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
    // agendada. Se resuelve DESPUÉS del feriado (primero el día no laborable,
    // después el slot ocupado) y con la misma garantía: nunca lanza.
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
        const resultado = reubicarFechasConChoque({
          fechas: fechasClases,
          horaInicio,
          indiceRecuperaciones,
        });

        for (const choque of resultado.choques) {
          console.warn(
            `🤝 BL-010: la clase suelta de la inscripción ${inscripcion_id} choca con la recuperación ${choque.recuperacion_id} el ${choque.fecha} ${choque.hora}. Corrida al ${choque.fecha_reubicada ?? 'N/A'}.`
          );
        }

        if (Array.isArray(params.choques)) {
          params.choques.push(...resultado.choques.map((c) => ({ ...c, inscripcion_id })));
        }

        // ⚠️ Si no hubo hueco en 6 semanas, `reubicarFechasConChoque` devuelve
        // la lista VACÍA. Para una clase suelta eso significaría un pago
        // aprobado sin ninguna clase, así que se conserva la fecha original
        // (mismo criterio que el fallback del feriado: es preferible el
        // duplicado visible en la agenda a la clase inexistente).
        if (resultado.fechas.length > 0) {
          fechasClases = resultado.fechas;
        } else {
          console.warn(
            `⚠️ BL-010: inscripción ${inscripcion_id}: clase suelta sin slot libre en ${MAX_SALTOS_POR_CHOQUE} semanas. Se deja la fecha original para NO dejar al alumno sin clase.`
          );
        }
      }
    }

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
   * (`calcularProximasFechas` + `reubicarFechasConChoque`), así que lo que
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

    const { choques, omitidas } = reubicarFechasConChoque({
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
      omitidas,
    };
  }
};
