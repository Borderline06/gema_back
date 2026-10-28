import { prisma } from '../../config/database.config.js';

export const notificacionesService = {
  // Para que los Crons usen esta función
  crear: async (data) => {
    return await prisma.notificaciones.create({
      data: {
        alumno_id: data.alumnoId || null,
        titulo: data.titulo,
        mensaje: data.mensaje,
        tipo: data.tipo || 'INFO',
        categoria: data.categoria || 'SISTEMA'
      }
    });
  },

  // Para el Dashboard (Frontend)
  obtenerTodas: async () => {
    return await prisma.notificaciones.findMany({
      include: {
        alumnos: {
          include: { usuarios: { select: { nombres: true, apellidos: true } } }
        }
      },
      orderBy: { creado_en: 'desc' },
      take: 50 // Para no saturar el front, traemos las últimas 50
    });
  },

  marcarComoLeida: async (id) => {
    return await prisma.notificaciones.update({
      where: { id: Number.parseInt(id) },
      data: { leido: true }
    });
  },

  // El receptor de un aviso es el alumno (alumno_id); el id del usuario autenticado coincide con el del alumno
  obtenerPorUsuario: async (usuarioId) => {
    return await prisma.notificaciones.findMany({
      where: { alumno_id: usuarioId },
      include: {
        alumnos: {
          include: { usuarios: { select: { nombres: true, apellidos: true } } }
        }
      },
      orderBy: { creado_en: 'desc' },
      take: 50
    });
  },

  // Contador de la campanita (mismo criterio que obtenerPorUsuario)
  obtenerConteoNoLeidas: async (usuarioId) => {
    return await prisma.notificaciones.count({
      where: { alumno_id: usuarioId, leido: false }
    });
  },
};