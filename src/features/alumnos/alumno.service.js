import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { prisma } from '../../config/database.config.js';
import { ApiError } from '../../shared/utils/error.util.js';
import { alumnoLogic } from './logic/alumno.logic.js';

export const alumnoService = {
  actualizarMiPerfil: async (usuarioId, datos) => {
    return await prisma.$transaction(async (tx) => {
      await alumnoLogic.actualizarDatosBaseUsuario(tx, usuarioId, datos);

      const alumnoActual = await tx.alumnos.findUnique({
        where: { usuario_id: usuarioId },
        select: { usuario_id: true, direccion_id: true },
      });

      if (!alumnoActual) {
        throw new ApiError('Alumno no encontrado', 404);
      }

      const direccionId = await alumnoLogic.gestionarDireccion(
        tx,
        alumnoActual.direccion_id,
        datos
      );

      return await alumnoLogic.actualizarPerfilMedico(tx, usuarioId, direccionId, datos);
    });
  },
  obtenerMiPerfil: async (usuarioId) => {
    // Realizamos una consulta anidada para traer todo el expediente
    const perfil = await prisma.usuarios.findUnique({
      where: { id: usuarioId },
      include: {
        alumnos: {
          include: {
            direcciones: true, // Traemos calle, distrito y referencia
          },
        },
      },
    });

    if (!perfil) throw new ApiError('Alumno no encontrado', 404);
    return perfil;
  },

  listarAlumnosResumen: async () => {
    const alumnos = await prisma.alumnos.findMany({
      include: {
        usuarios: {
          select: {
            nombres: true,
            apellidos: true,
            numero_documento: true,
          }
        },
        inscripciones: {
          where: { estado: 'ACTIVO' }, // Solo jalamos lo que está pagado/activo
          select: {
            id: true,
            fecha_inscripcion: true,
          }
        }
      }
    });

    // Mapeamos para darte el formato exacto que necesitas
    return alumnos.map(alumno => {
      // Si tiene varias inscripciones, tomamos la más reciente para el "Día de Corte"
      // o puedes devolver un array de fechas si lo prefieres.
      const inscripcionesProcesadas = alumno.inscripciones.map(ins => {
        const fechaCorte = new Date(ins.fecha_inscripcion);
        fechaCorte.setDate(fechaCorte.getDate() + 3); // 🚨 REGLA: +3 días para el corte

        return {
          inscripcion_id: ins.id,
          fecha_inicio: ins.fecha_inscripcion,
          fecha_corte: fechaCorte
        };
      });

      return {
        id: alumno.usuario_id,
        nombre_completo: `${alumno.usuarios.nombres} ${alumno.usuarios.apellidos}`,
        dni: alumno.usuarios.numero_documento,
        // Enviamos todas sus inscripciones activas con sus respectivos cortes
        contratos: inscripcionesProcesadas,
        // Resumen rápido de la fecha de corte más cercana (opcional)
        fecha_corte_principal: inscripcionesProcesadas.length > 0
          ? inscripcionesProcesadas[0].fecha_corte
          : null
      };
    });
  },
  // alumno.service.js

  listarAlumnosResumenPorCoordinador: async (coordinadorId) => {
    const diasMapa = { 1: 'LUN', 2: 'MAR', 3: 'MIE', 4: 'JUE', 5: 'VIE', 6: 'SAB', 7: 'DOM' };

    // Función interna para limpiar las horas y evitar el error de 1970
    const formatearHora = (hora) => {
      if (!hora) return "--:--";
      if (hora instanceof Date) {
        return hora.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
      }
      // Si viene como string ISO o similar, extraemos solo HH:mm
      return hora.toString().includes('T') ? hora.toISOString().substring(11, 16) : hora.toString().substring(0, 5);
    };

    const alumnos = await prisma.alumnos.findMany({
      where: {
        inscripciones: {
          some: {
            estado: { in: ['ACTIVO', 'FINALIZADO'] },
            horarios_clases: { coordinador_id: coordinadorId }
          }
        }
      },
      include: {
        usuarios: {
          select: { nombres: true, apellidos: true, numero_documento: true }
        },
        inscripciones: {
          where: {
            estado: { in: ['ACTIVO', 'FINALIZADO'] },
            horarios_clases: { coordinador_id: coordinadorId }
          },
          include: {
            horarios_clases: {
              include: {
                canchas: { include: { sedes: true } }
              }
            }
          }
        }
      }
    });

    return alumnos.map(alumno => {
      // Ordenar por la inscripción más reciente
      const inscripcionesOrdenadas = [...alumno.inscripciones].sort(
        (a, b) => new Date(b.fecha_inscripcion) - new Date(a.fecha_inscripcion)
      );

      const inscripcionesProcesadas = inscripcionesOrdenadas.map(ins => {
        const h = ins.horarios_clases;
        const fechaCorte = new Date(ins.fecha_inscripcion);
        fechaCorte.setDate(fechaCorte.getDate() + 29);

        return {
          inscripcion_id: ins.id,
          fecha_inicio: ins.fecha_inscripcion,
          fecha_corte: fechaCorte,
          sede: h.canchas?.sedes?.nombre || h.canchas?.nombre || "CALLAO",
          // ✅ Formato: LUN 20:30 - 22:00
          horario: `${diasMapa[h.dia_semana] || h.dia_semana} ${formatearHora(h.hora_inicio)} - ${formatearHora(h.hora_fin)}`,
          esIndividual: ins.tipo_inscripcion === "INDIVIDUAL" ? true : false,
        };
      });

      return {
        id: alumno.usuario_id,
        nombre_completo: `${alumno.usuarios.nombres} ${alumno.usuarios.apellidos}`,
        dni: alumno.usuarios.numero_documento,
        contratos: inscripcionesProcesadas,
        fecha_corte_principal: inscripcionesProcesadas[0]?.fecha_corte || null,
      };
    });
  },

  cambiarHistorialAlumno: async (alumnoId, estado) => {
    try {
      const estadosPermitidos = ['Antiguo', 'Nuevo'];
      if (!estadosPermitidos.includes(estado)) throw new ApiError('Estado de historial no permitido.')
      await prisma.alumnos.update({
        where: { usuario_id: alumnoId },
        data: { historial: estado }
      })
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError) {
        throw new ApiError(e.message, 400, { prismaCode: e.code, meta: e.meta })
      }
      throw new ApiError(e instanceof Error ? e.message : 'Error Interno', 500)
    }
  },
  listarMisContactos: async (usuarioId) => {
    return await prisma.alumnos_contactos.findMany({
      where: { alumno_id: usuarioId },
      orderBy: [{ es_principal: 'desc' }, { id: 'asc' }],
    });
  },

  // ➕ Crea un contacto para el alumno de la sesión
  crearContacto: async (usuarioId, datos) => {
    return await prisma.$transaction(async (tx) => {
      // Verificamos que el alumno exista (evita contactos huérfanos)
      const alumno = await tx.alumnos.findUnique({
        where: { usuario_id: usuarioId },
        select: { usuario_id: true },
      });
      if (!alumno) throw new ApiError('Alumno no encontrado', 404);

      // 🚨 REGLA: si este contacto viene marcado como principal,
      // desmarcamos cualquier otro principal existente antes de crear
      if (datos.es_principal) {
        await tx.alumnos_contactos.updateMany({
          where: { alumno_id: usuarioId, es_principal: true },
          data: { es_principal: false },
        });
      }

      return await tx.alumnos_contactos.create({
        data: {
          alumno_id: usuarioId,
          nombre_completo: datos.nombre_completo,
          relacion: datos.relacion,
          telefono: datos.telefono,
          es_principal: !!datos.es_principal,
        },
      });
    });
  },

  // ✏️ Actualiza un contacto — SOLO si pertenece al alumno de la sesión
  actualizarContacto: async (usuarioId, contactoId, datos) => {
    return await prisma.$transaction(async (tx) => {
      const contacto = await tx.alumnos_contactos.findUnique({
        where: { id: contactoId },
      });

      if (!contacto) throw new ApiError('Contacto no encontrado', 404);
      // 🔒 Blindaje de propiedad: este contacto tiene que ser del alumno logueado
      if (contacto.alumno_id !== usuarioId) {
        throw new ApiError('No tienes permiso sobre este contacto', 403);
      }

      if (datos.es_principal) {
        await tx.alumnos_contactos.updateMany({
          where: { alumno_id: usuarioId, es_principal: true, id: { not: contactoId } },
          data: { es_principal: false },
        });
      }

      return await tx.alumnos_contactos.update({
        where: { id: contactoId },
        data: {
          nombre_completo: datos.nombre_completo,
          relacion: datos.relacion,
          telefono: datos.telefono,
          es_principal: datos.es_principal,
        },
      });
    });
  },

  // ==================================================================
  // 🆕 BL-007: upsert del CONTACTO DE EMERGENCIA (el principal del alumno).
  //
  // El formulario del frontend trata el contacto de emergencia como uno solo,
  // pero alumnos_contactos es 1:N con bandera es_principal. Este método resuelve
  // las dos operaciones del formulario en una: actualiza el principal si existe
  // y lo crea si el alumno todavía no tiene ninguno.
  //
  // ⚠️ No hay índice único sobre (alumno_id, es_principal) en la BD, así que la
  // unicidad del principal se garantiza a mano con updateMany, igual que ya
  // hacen crearContacto y actualizarContacto.
  // ==================================================================
  actualizarContactoEmergencia: async (alumnoId, datos) => {
    return await prisma.$transaction(async (tx) => {
      // Mismo blindaje que crearContacto: nada de contactos huérfanos.
      const alumno = await tx.alumnos.findUnique({
        where: { usuario_id: alumnoId },
        select: { usuario_id: true },
      });
      if (!alumno) throw new ApiError('Alumno no encontrado', 404);

      const principal = await tx.alumnos_contactos.findFirst({
        where: { alumno_id: alumnoId, es_principal: true },
        orderBy: { id: 'asc' },
      });

      if (!principal) {
        // Sin principal: limpiamos cualquier residuo (datos sucios con varios
        // marcados) y creamos el contacto como principal.
        await tx.alumnos_contactos.updateMany({
          where: { alumno_id: alumnoId, es_principal: true },
          data: { es_principal: false },
        });

        return await tx.alumnos_contactos.create({
          data: {
            alumno_id: alumnoId,
            nombre_completo: datos.nombre_completo,
            relacion: datos.relacion,
            telefono: datos.telefono,
            es_principal: true,
          },
        });
      }

      // Hay principal: nos aseguramos de que sea el ÚNICO y lo actualizamos.
      await tx.alumnos_contactos.updateMany({
        where: { alumno_id: alumnoId, es_principal: true, id: { not: principal.id } },
        data: { es_principal: false },
      });

      return await tx.alumnos_contactos.update({
        where: { id: principal.id },
        data: {
          nombre_completo: datos.nombre_completo,
          relacion: datos.relacion,
          telefono: datos.telefono,
        },
      });
    });
  },

  // 🗑️ Elimina un contacto — SOLO si pertenece al alumno de la sesión
  eliminarContacto: async (usuarioId, contactoId) => {
    const contacto = await prisma.alumnos_contactos.findUnique({
      where: { id: contactoId },
    });

    if (!contacto) throw new ApiError('Contacto no encontrado', 404);
    if (contacto.alumno_id !== usuarioId) {
      throw new ApiError('No tienes permiso sobre este contacto', 403);
    }

    await prisma.alumnos_contactos.delete({ where: { id: contactoId } });
  },

};
