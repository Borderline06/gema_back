import { prisma } from '../../../config/database.config.js';
import { ApiError } from '../../../shared/utils/error.util.js';
import { formatFechaEs } from '../../../shared/utils/date.util.js';
// 🎯 BL-011: la vigencia del ciclo ahora vive en un solo lugar.
import {
  DIAS_CICLO,
  ESTADOS_VALIDOS_PARA_CICLO,
  sumarDiasUTC,
} from '../../../shared/utils/ciclo.util.js';

// 🔥 DAYJS + LIMA: solo para fechas de tipo Timestamp, donde el formateo en
// UTC puede correr un día (Lima es UTC-5). Las columnas @db.Date usan formatFechaEs.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_LIMA = 'America/Lima';


const MAPA_DIAS = { 0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };

const formatTime = (date) => (date ? date.toISOString().substring(11, 16) : null);

// 🔧 FIX: esta función se usaba en obtenerFlagsIndividualPorSede pero nunca
// estaba definida en el archivo — causaba ReferenceError en tiempo de ejecución.
const esConceptoIndividual = (nombreConcepto, detalleAdicional) => {
  const texto = `${nombreConcepto || ''} ${detalleAdicional || ''}`.toLowerCase();
  return texto.includes('plan individual');
};

// 🎯 Misma regla de vigencia que usaba el frontend (addDays 29 + isPast),
// pero calculada en el backend para no duplicar lógica ni mandar de más.
const DIAS_VIGENCIA_INSCRIPCION = 29;

const calcularFechaCorte = (fechaInscripcion) => {
  if (!fechaInscripcion) return null;
  const fecha = new Date(fechaInscripcion);
  fecha.setDate(fecha.getDate() + DIAS_VIGENCIA_INSCRIPCION);
  return fecha;
};

const estaVencida = (fechaCorte) => {
  if (!fechaCorte) return false;
  return fechaCorte.getTime() < Date.now();
};

// 🎯 BL-013 / BL-011: DIAS_CICLO (30) y sumarDiasUTC se movieron a
// shared/utils/ciclo.util.js, que es ahora la única definición del cierre real
// del ciclo. Ojo: NO es el mismo número que DIAS_VIGENCIA_INSCRIPCION (29),
// que es la regla del badge de la tabla.

export const historialAcademicoService = {
  // =================================================================
  // 📊 HISTORIAL REAL DE CICLOS (sin cambios)
  // =================================================================
  obtenerHistorialPorAlumno: async (alumnoId) => {
    const id = parseInt(alumnoId);
    if (!id) throw new ApiError('ID de alumno inválido', 400);

    try {
      const cuentas = await prisma.cuentas_por_cobrar.findMany({
        where: { alumno_id: id },
        include: {
          catalogo_conceptos: { select: { nombre: true } },
          inscripciones_deudas_link: {
            include: {
              inscripciones: {
                include: {
                  horarios_clases: {
                    include: {
                      canchas: { include: { sedes: { select: { nombre: true } } } },
                      niveles_entrenamiento: { select: { nombre: true } },
                      coordinadores: { include: { usuarios: { select: { nombres: true } } } }
                    }
                  },
                  registros_asistencia: {
                    where: { estado: { in: ESTADOS_VALIDOS_PARA_CICLO } },
                    select: { fecha: true, estado: true },
                    orderBy: { fecha: 'asc' }
                  }
                }
              }
            }
          }
        },
        orderBy: { creado_en: 'desc' }
      });

      const historial = cuentas.map((cuenta) => {
        const links = cuenta.inscripciones_deudas_link;

        let todasLasFechas = [];
        const horariosUnicos = new Map();
        const inscripcionesInfo = [];

        for (const link of links) {
          const insc = link.inscripciones;
          const hc = insc.horarios_clases;
          const fechas = insc.registros_asistencia.map((r) => r.fecha);
          todasLasFechas = todasLasFechas.concat(fechas);

          const horarioKey = `${hc?.dia_semana}-${hc?.hora_inicio}`;
          if (hc && !horariosUnicos.has(horarioKey)) {
            horariosUnicos.set(horarioKey, {
              dia: MAPA_DIAS[hc.dia_semana] ?? 'S/D',
              hora_inicio: formatTime(hc.hora_inicio),
              hora_fin: formatTime(hc.hora_fin),
            });
          }

          inscripcionesInfo.push({
            inscripcion_id: insc.id,
            estado: insc.estado,
            tipo_inscripcion: insc.tipo_inscripcion,
            sede: hc?.canchas?.sedes?.nombre || 'S/D',
            nivel: hc?.niveles_entrenamiento?.nombre || 'S/D',
            profesor: hc?.coordinadores?.usuarios?.nombres || 'S/D',
            total_clases: fechas.length,
            clases_asistidas: insc.registros_asistencia.filter((r) => r.estado === 'PRESENTE').length,
            clases_falta: insc.registros_asistencia.filter((r) => r.estado === 'FALTA').length,
            clases_programadas: insc.registros_asistencia.filter((r) => r.estado === 'PROGRAMADA').length,
          });
        }

        todasLasFechas.sort((a, b) => new Date(a) - new Date(b));

        const esIndividual = inscripcionesInfo.some((i) => i.tipo_inscripcion === 'INDIVIDUAL');

        return {
          cuenta_id: cuenta.id,
          concepto: cuenta.catalogo_conceptos?.nombre || cuenta.detalle_adicional,
          estado_pago: cuenta.estado,
          monto_final: Number(cuenta.monto_final),
          fecha_vencimiento_pago: cuenta.fecha_vencimiento,
          fecha_inicio_real: todasLasFechas[0] ?? null,
          fecha_fin_real: todasLasFechas[todasLasFechas.length - 1] ?? null,
          total_clases_paquete: todasLasFechas.length,
          sin_registros: todasLasFechas.length === 0,
          es_individual: esIndividual,
          horarios: Array.from(horariosUnicos.values()),
          inscripciones: inscripcionesInfo,
        };
      });

      historial.sort((a, b) => {
        if (!a.fecha_inicio_real && !b.fecha_inicio_real) return 0;
        if (!a.fecha_inicio_real) return 1;
        if (!b.fecha_inicio_real) return -1;
        return new Date(b.fecha_inicio_real) - new Date(a.fecha_inicio_real);
      });

      return historial;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [ERROR HISTORIAL ACADEMICO] Alumno: ${alumnoId} | ${error.message}`);
      throw new ApiError('Error al obtener el historial académico del alumno', 500);
    }
  },

  // =================================================================
  // 🆕 RESUMEN DE TABLA (reemplaza a usuarioService.getUsersByRol para
  // la vista de Gestión de Alumnos). Trae SOLO lo que la tabla pinta:
  // nombre, dni, teléfono, sede/nivel/estado de la inscripción vigente,
  // deuda pendiente y si el alumno tiene un plan individual.
  //
  // Optimización clave frente al endpoint viejo:
  // - No trae horarios completos (dia/hora/cancha) — la tabla no los pinta.
  // - No trae direcciones/contacto de emergencia/salud — eso vive en
  //   StudentDetails, que pide su propio detalle solo al abrir el expediente.
  // - Calcula vigencia y flag individual EN EL SERVIDOR (una sola pasada),
  //   así el frontend recibe filas casi listas para pintar, sin duplicar
  //   la lógica de fechaCorte/vencida que antes vivía en el componente.
  // =================================================================
  obtenerResumenTablaAlumnos: async (sedeId) => {
    // 🔒 BL-008: un sede_id inválido NO debe degradar silenciosamente a
    // "listar todos los alumnos". Va fuera del try porque el catch de abajo
    // reempaqueta cualquier error como 500 y se comería este 400.
    let sedeIdInt = null;
    if (sedeId !== null && sedeId !== undefined && sedeId !== '') {
      // Regex estricto, no parseInt: parseInt('1.9x') daría 1 y filtraría por
      // la sede equivocada en silencio.
      const bruto = String(sedeId).trim();
      if (!/^[0-9]+$/.test(bruto) || Number(bruto) <= 0) {
        throw new ApiError('El parámetro sede_id debe ser un entero positivo', 400);
      }
      sedeIdInt = Number(bruto);
    }

    try {
      const whereClause = {
        activo: true,
        roles: { nombre: { equals: 'Alumno', mode: 'insensitive' } },
      };

      if (sedeIdInt) {
        // 🎯 BL-008: la pertenencia a una sede se deriva SOLO de inscripciones
        // ACTIVO — el historial de sedes pasadas (PENDIENTE_PAGO/FINALIZADO)
        // queda fuera del filtro.
        // 🎯 BL-009: "some" → subconsulta IN(SELECT…) sobre usuarios ⇒ 1 fila
        // por alumno. Un alumno multi-sede entra por cualquiera de sus sedes y
        // NO se duplica; no hace falta "distinct".
        whereClause.alumnos = {
          inscripciones: {
            some: {
              estado: 'ACTIVO',
              horarios_clases: { canchas: { sede_id: sedeIdInt } },
            },
          },
        };
      }

      const usuarios = await prisma.usuarios.findMany({
        where: whereClause,
        select: {
          id: true,
          nombres: true,
          apellidos: true,
          numero_documento: true,
          telefono_personal: true,
          alumnos: {
            select: {
              cuentas_por_cobrar: {
                select: {
                  estado: true,
                  monto_final: true,
                  detalle_adicional: true,
                  catalogo_conceptos: { select: { nombre: true } },
                },
              },
              inscripciones: {
                // 🎯 BL-009: ya NO recortamos por sede — necesitamos todas las
                // inscripciones para poder listar todas las sedes activas del
                // alumno. El acotado por sede se hace en memoria (ver mapeo).
                orderBy: { fecha_inscripcion: 'desc' },
                select: {
                  estado: true,
                  fecha_inscripcion: true,
                  tipo_inscripcion: true,
                  horarios_clases: {
                    select: {
                      niveles_entrenamiento: { select: { nombre: true } },
                      canchas: {
                        // sede_id es interno: acota el cálculo en memoria y no
                        // se expone en el JSON de respuesta.
                        select: { sede_id: true, sedes: { select: { nombre: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { nombres: 'asc' },
      });

      return usuarios.map((user) => {
        const alumnoData = user.alumnos || {};
        const inscripciones = alumnoData.inscripciones || [];
        const cuentas = alumnoData.cuentas_por_cobrar || [];

        // --- Deuda pendiente ---
        const montoPendiente = cuentas
          .filter((c) => c.estado === 'PENDIENTE')
          .reduce((acc, c) => acc + Number(c.monto_final || 0), 0);

        // 🎯 Vista acotada: con filtro de sede, los indicadores de vigencia y
        // de plan individual se calculan solo con las inscripciones de ESA sede,
        // para que la insignia "vencido" siga siendo accionable por sede.
        const inscripcionesDeSede = sedeIdInt
          ? inscripciones.filter((i) => i.horarios_clases?.canchas?.sede_id === sedeIdInt)
          : inscripciones;

        const esIndividual = inscripcionesDeSede.some((i) =>
          i.tipo_inscripcion === 'INDIVIDUAL' && i.estado === 'ACTIVO'
        );

        // --- Misma prioridad que antes: vigentes > activas-vencidas > última ---
        const inscripcionesActivas = inscripcionesDeSede.filter((i) => i.estado === 'ACTIVO');
        const inscripcionesConCorte = inscripcionesActivas.map((i) => {
          const fechaCorte = calcularFechaCorte(i.fecha_inscripcion);
          return { ...i, __fechaCorte: fechaCorte, __vencida: estaVencida(fechaCorte) };
        });
        const inscripcionesVigentes = inscripcionesConCorte.filter((i) => !i.__vencida);

        let inscripcionesAMostrar = [];
        let estadoVisual = 'SIN INSCRIPCIÓN';

        if (inscripcionesVigentes.length > 0) {
          inscripcionesAMostrar = inscripcionesVigentes;
          estadoVisual = 'ACTIVO';
        } else if (inscripcionesConCorte.length > 0) {
          inscripcionesAMostrar = inscripcionesConCorte;
          estadoVisual = 'ACTIVO';
        } else if (inscripcionesDeSede.length > 0) {
          inscripcionesAMostrar = [inscripcionesDeSede[0]];
          estadoVisual = inscripcionesDeSede[0].estado;
        }

        // 🎯 BL-009: sedes/niveles salen de TODAS las inscripciones ACTIVO del
        // alumno, sin importar el filtro aplicado — un alumno activo en varias
        // sedes las declara todas. Fallback a inscripcionesAMostrar para no
        // dejar sin sede al alumno sin ninguna ACTIVO (listado sin filtro:
        // conserva el comportamiento actual).
        const activasGlobales = inscripciones.filter((i) => i.estado === 'ACTIVO');
        const paraEtiquetas = activasGlobales.length > 0 ? activasGlobales : inscripcionesAMostrar;

        const sedes = [...new Set(
          paraEtiquetas.map((i) => i.horarios_clases?.canchas?.sedes?.nombre).filter(Boolean)
        )];
        const niveles = [...new Set(
          paraEtiquetas.map((i) => i.horarios_clases?.niveles_entrenamiento?.nombre).filter(Boolean)
        )];

        const ultimaInsc = inscripcionesAMostrar[0];
        const fechaCorte = ultimaInsc?.fecha_inscripcion ? calcularFechaCorte(ultimaInsc.fecha_inscripcion) : null;

        return {
          id: user.id,
          nombres: user.nombres,
          apellidos: user.apellidos,
          full_name: `${user.nombres} ${user.apellidos}`,
          dni: user.numero_documento || '---',
          telefono: user.telefono_personal || 'S/N',

          sedes,
          niveles,
          estadoVisual,
          estaVencido: fechaCorte ? estaVencida(fechaCorte) : false,
          fechaCorte,
          multiplesActivas: activasGlobales.length > 1,

          monto_pendiente: montoPendiente,
          esClaseUnica: esIndividual,
        };
      });
    } catch (error) {
      console.error(`❌ [ERROR RESUMEN TABLA ALUMNOS] Sede: ${sedeId} | ${error.message}`);
      throw new ApiError('Error al obtener el resumen de alumnos', 500);
    }
  },

  // =================================================================
  // 🆕 RESUMEN MASIVO de "Plan Individual" (se mantiene por si otra
  // pantalla lo usa suelto, pero ya NO hace falta llamarlo desde la
  // tabla principal — obtenerResumenTablaAlumnos ya trae esClaseUnica).
  // =================================================================
  obtenerFlagsIndividualPorSede: async (sedeId) => {
    try {
      const whereSede = sedeId
        ? {
          inscripciones_deudas_link: {
            some: {
              inscripciones: {
                horarios_clases: {
                  canchas: { sede_id: parseInt(sedeId) },
                },
              },
            },
          },
        }
        : {};

      const cuentas = await prisma.cuentas_por_cobrar.findMany({
        where: whereSede,
        select: {
          alumno_id: true,
          detalle_adicional: true,
          catalogo_conceptos: { select: { nombre: true } },
        },
      });

      const flagsPorAlumno = {};

      for (const cuenta of cuentas) {
        if (flagsPorAlumno[cuenta.alumno_id]) continue;

        const esIndividual = esConceptoIndividual(
          cuenta.catalogo_conceptos?.nombre,
          cuenta.detalle_adicional
        );

        if (esIndividual) {
          flagsPorAlumno[cuenta.alumno_id] = true;
        }
      }

      return flagsPorAlumno;
    } catch (error) {
      console.error(`❌ [ERROR RESUMEN MASIVO INDIVIDUAL] Sede: ${sedeId} | ${error.message}`);
      throw new ApiError('Error al obtener el resumen de planes individuales', 500);
    }
  },
  obtenerDetalleAlumno: async (alumnoId) => {
    const id = parseInt(alumnoId);
    if (!id) throw new ApiError('ID de alumno inválido', 400);

    try {
      const user = await prisma.usuarios.findUnique({
        where: { id },
        select: {
          id: true,
          nombres: true,
          apellidos: true,
          numero_documento: true,
          telefono_personal: true,
          email: true,
          username: true,
          fecha_nacimiento: true,
          alumnos: {
            select: {
              condiciones_medicas: true,
              seguro_medico: true,
              grupo_sanguineo: true,
              historial: true,
              direcciones: {
                select: {
                  direccion_completa: true,
                  distrito: true,
                  referencia: true,
                },
              },
              alumnos_contactos: {
                select: {
                  nombre_completo: true,
                  telefono: true,
                  relacion: true,
                },
                take: 1,
              },
              inscripciones: {
                where: { estado: 'ACTIVO' },
                select: {
                  horarios_clases: {
                    select: { canchas: { select: { sedes: { select: { nombre: true } } } } },
                  },
                },
              },
            },
          },
        },
      });

      if (!user) throw new ApiError('Alumno no encontrado', 404);

      const alumnoData = user.alumnos || {};
      const contacto = alumnoData.alumnos_contactos?.[0] || {};
      const dir = alumnoData.direcciones || {};
      const sedes = [...new Set(
        (alumnoData.inscripciones || [])
          .map((i) => i.horarios_clases?.canchas?.sedes?.nombre)
          .filter(Boolean)
      )];

      return {
        id: user.id,
        nombres: user.nombres,
        apellidos: user.apellidos,
        full_name: `${user.nombres} ${user.apellidos}`,
        dni: user.numero_documento || '---',
        telefono: user.telefono_personal || 'S/N',
        email: user.email || 'S/D',
        username: user.username || '',
        cumpleanos: user.fecha_nacimiento
          ? user.fecha_nacimiento.toISOString().slice(0, 10)
          : null,
        sedes,
        direccion: {
          completa: dir.direccion_completa || 'No registrada',
          distrito: dir.distrito || 'S/D',
          referencia: dir.referencia || '',
        },
        salud: {
          condiciones: alumnoData.condiciones_medicas || 'Ninguna',
          seguro: alumnoData.seguro_medico || 'S/N',
          sangre: alumnoData.grupo_sanguineo || 'S/N',
          historial: alumnoData.historial,
        },
        contactoEmergencia: {
          nombre: contacto.nombre_completo || 'No registrado',
          telefono: contacto.telefono || 'S/N',
          relacion: contacto.relacion || 'No especificada',
        },
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [ERROR DETALLE ALUMNO] ID: ${alumnoId} | ${error.message}`);
      throw new ApiError('Error al obtener el detalle del alumno', 500);
    }
  },

  // =================================================================
  // 📤 BL-013: REPORTE EXPORTABLE DE ALUMNOS — 10 columnas exactas.
  // Las llaves del objeto SON los nombres de columna del Excel: el
  // frontend las genera con Object.keys (mismo contrato que el
  // Reporte Maestro). No agregar llaves técnicas como "id".
  // =================================================================
  exportarReporteAlumnos: async (sedeId) => {
    // 🔒 BL-008: mismo validador estricto que obtenerResumenTablaAlumnos.
    // Fuera del try: el catch de abajo reempaqueta todo como 500 y se
    // comería este 400.
    let sedeIdInt = null;
    if (sedeId !== null && sedeId !== undefined && sedeId !== '') {
      const bruto = String(sedeId).trim();
      if (!/^[0-9]+$/.test(bruto) || Number(bruto) <= 0) {
        throw new ApiError('El parámetro sede_id debe ser un entero positivo', 400);
      }
      sedeIdInt = Number(bruto);
    }

    try {
      const whereClause = {
        activo: true,
        roles: { nombre: { equals: 'Alumno', mode: 'insensitive' } },
      };

      if (sedeIdInt) {
        // 🎯 BL-008: la pertenencia a la sede se deriva SOLO de inscripciones
        // ACTIVO. 🎯 BL-009: "some" sobre usuarios ⇒ el alumno multi-sede
        // entra por cualquiera de sus sedes y NO se duplica.
        whereClause.alumnos = {
          inscripciones: {
            some: {
              estado: 'ACTIVO',
              horarios_clases: { canchas: { sede_id: sedeIdInt } },
            },
          },
        };
      }

      // Una sola consulta: Prisma resuelve cada nivel anidado con un query
      // constante por relación, no uno por alumno (sin N+1).
      const usuarios = await prisma.usuarios.findMany({
        where: whereClause,
        select: {
          nombres: true,
          apellidos: true,
          numero_documento: true,
          fecha_nacimiento: true,
          alumnos: {
            select: {
              inscripciones: {
                // 🎯 BL-009: todas las inscripciones, sin recortar por sede.
                orderBy: { fecha_inscripcion: 'desc' },
                select: {
                  estado: true,
                  creado_en: true,
                  horarios_clases: {
                    select: {
                      niveles_entrenamiento: { select: { nombre: true } },
                      canchas: { select: { sedes: { select: { nombre: true } } } },
                    },
                  },
                  inscripciones_deudas_link: {
                    select: { fecha_inicio_ciclo: true, fecha_fin_ciclo: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { nombres: 'asc' },
      });

      const hoy = new Date();

      return usuarios.map((user) => {
        const inscripciones = user.alumnos?.inscripciones || [];
        const activasGlobales = inscripciones.filter((i) => i.estado === 'ACTIVO');

        // 🎯 BL-009: sede y nivel salen de TODAS las inscripciones ACTIVO.
        // Fallback a la última inscripción para no dejar sin etiqueta al
        // alumno que ya no tiene ninguna activa.
        const paraEtiquetas = activasGlobales.length > 0
          ? activasGlobales
          : inscripciones.slice(0, 1);

        const sedes = [...new Set(
          paraEtiquetas.map((i) => i.horarios_clases?.canchas?.sedes?.nombre).filter(Boolean)
        )];
        const niveles = [...new Set(
          paraEtiquetas.map((i) => i.horarios_clases?.niveles_entrenamiento?.nombre).filter(Boolean)
        )];

        // --- Fecha de inicio: primer ciclo histórico del alumno ---
        // NO se usa fecha_inscripcion: se sobreescribe en cada renovación
        // (ver inscripcion.service.js → actualizarFechaInicioPorPago).
        const iniciosCiclo = inscripciones
          .flatMap((i) => i.inscripciones_deudas_link || [])
          .map((l) => l.fecha_inicio_ciclo)
          .filter(Boolean)
          .map((f) => new Date(f).getTime());

        let fechaInicio = 'N/A';
        if (iniciosCiclo.length > 0) {
          fechaInicio = formatFechaEs(new Date(Math.min(...iniciosCiclo)));
        } else {
          // Fallback: creado_en nunca se pisa. Es Timestamp, se formatea en
          // hora de Lima para no correr un día.
          const altas = inscripciones
            .map((i) => i.creado_en)
            .filter(Boolean)
            .map((f) => new Date(f).getTime());
          if (altas.length > 0) {
            fechaInicio = dayjs(Math.min(...altas)).tz(TZ_LIMA).format('DD/MM/YYYY');
          }
        }

        // --- Fecha de corte: ciclo vigente de las inscripciones ACTIVO ---
        // Base: la definición de "vigente" de dashboard.service.js, pero a
        // propósito MÁS amplia — ver el filtro de abajo.
        // fecha_fin_ciclo es NULL mientras el ciclo está abierto, así que se
        // deriva fecha_inicio_ciclo + 30d: el cierre real del cron VERDUGO.
        const cortesVigentes = activasGlobales
          .flatMap((i) => i.inscripciones_deudas_link || [])
          .filter((l) => {
            if (!l.fecha_inicio_ciclo) return false;
            // 🎯 BL-013: los ciclos FUTUROS ya prepagados cuentan como tiempo
            // vigente para el negocio (una renovación pagada por adelantado), así
            // que NO se excluyen por fecha_inicio_ciclo > hoy. Aquí divergimos de
            // dashboard.service.js, que sí los descarta. Solo se descartan los
            // ciclos ya cerrados en el pasado.
            return l.fecha_fin_ciclo === null || new Date(l.fecha_fin_ciclo) >= hoy;
          })
          .map((l) => (l.fecha_fin_ciclo
            ? new Date(l.fecha_fin_ciclo).getTime()
            : sumarDiasUTC(l.fecha_inicio_ciclo, DIAS_CICLO).getTime()));

        // Multi-sede: el corte más lejano = hasta cuándo está cubierto.
        const fechaCorte = cortesVigentes.length > 0
          ? formatFechaEs(new Date(Math.max(...cortesVigentes)))
          : 'N/A';

        // --- Edad: años cumplidos hoy (hora de Lima) ---
        // fecha_nacimiento es @db.Date ⇒ se lee en UTC, igual que formatFechaEs.
        let edad = 'N/A';
        if (user.fecha_nacimiento) {
          const nac = new Date(user.fecha_nacimiento);
          const ahoraLima = dayjs().tz(TZ_LIMA);
          let anios = ahoraLima.year() - nac.getUTCFullYear();
          const mesDif = (ahoraLima.month() + 1) - (nac.getUTCMonth() + 1);
          if (mesDif < 0 || (mesDif === 0 && ahoraLima.date() < nac.getUTCDate())) anios -= 1;
          if (anios >= 0) edad = anios;
        }

        // --- Estado: misma prioridad que estadoVisual de obtenerResumenTablaAlumnos ---
        // ACTIVO si tiene alguna inscripción activa; si no, el estado de la más
        // reciente (inscripciones viene ordenado por fecha_inscripcion desc).
        let estado = 'SIN INSCRIPCIÓN';
        if (activasGlobales.length > 0) estado = 'ACTIVO';
        else if (inscripciones.length > 0) estado = inscripciones[0].estado || 'SIN INSCRIPCIÓN';

        // --- Sede de origen: sede de la inscripción más antigua ---
        // alumnos no tiene sede propia. creado_en nunca se pisa (a diferencia de
        // fecha_inscripcion), así que ordena el alta real; sin creado_en, la
        // última de la lista (la más antigua por fecha_inscripcion).
        const masAntigua = inscripciones.some((i) => i.creado_en)
          ? [...inscripciones]
              .filter((i) => i.creado_en)
              .sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en))[0]
          : inscripciones[inscripciones.length - 1];
        const sedeOrigen = masAntigua?.horarios_clases?.canchas?.sedes?.nombre || 'N/A';

        return {
          'Nombre': `${user.nombres} ${user.apellidos}`.trim(),
          'DNI': user.numero_documento || 'N/A',
          'Fecha de cumpleaños': formatFechaEs(user.fecha_nacimiento),
          'Fecha de inicio': fechaInicio,
          'Fecha de corte': fechaCorte,
          'Sede': sedes.length > 0 ? sedes.join(', ') : 'N/A',
          'Nivel': niveles.length > 0 ? niveles.join(', ') : 'N/A',
          // 🎯 BL-013: columnas 8-10, añadidas al final (las 7 anteriores no se mueven).
          'Edad': edad,
          'Estado': estado,
          'Sede de origen': sedeOrigen,
        };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [ERROR EXPORT ALUMNOS] Sede: ${sedeId} | ${error.message}`);
      throw new ApiError('Error al generar el reporte de alumnos', 500);
    }
  },

};
