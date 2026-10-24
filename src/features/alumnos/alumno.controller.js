import { alumnoService } from './alumno.service.js';
import { apiResponse } from '../../shared/utils/response.util.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { ApiError } from '../../shared/utils/error.util.js';

export const alumnoController = {
  actualizarMiPerfil: catchAsync(async (req, res) => {
    const resultado = await alumnoService.actualizarMiPerfil(req.user.id, req.body);
    return apiResponse.success(res, {
      message: '¡Perfil actualizado correctamente!',
      data: resultado,
    });
  }),
  obtenerMiPerfil: catchAsync(async (req, res) => {
    const perfil = await alumnoService.obtenerMiPerfil(req.user.id);
    return apiResponse.success(res, {
      message: 'Perfil cargado',
      data: perfil,
    });
  }),

  listarAlumnosResumen: catchAsync(async (req, res) => {
    const data = await alumnoService.listarAlumnosResumen();
    return apiResponse.success(res, {
      message: 'Lista de alumnos para gestión de cortes cargada',
      data: data,
    });
  }),
  listarAlumnosResumenPorCoordinador: catchAsync(async (req, res) => {
    const { id: usuarioId, role } = req.user;

    let data;

    if (role === 'Administrador') {
      data = await alumnoService.listarAlumnosResumen();
    } else {
      data = await alumnoService.listarAlumnosResumenPorCoordinador(usuarioId);
    }

    return apiResponse.success(res, {
      message: 'Resumen de cortes para gestión de alumnos cargado con éxito',
      data: data,
    });
  }),
  cambiarHistorialAlumno: catchAsync(async (req, res) => {
    const { estado, alumnoId } = req.body;
    await alumnoService.cambiarHistorialAlumno(alumnoId, estado);
    return apiResponse.success(res, { message: `Historial deportivo cambiado a ${estado}` })
  }),

  // 🔥 Contactos de emergencia — usan alumnoService (todo mergeado en un solo archivo)
  listarMisContactos: catchAsync(async (req, res) => {
    const data = await alumnoService.listarMisContactos(req.user.id);
    return apiResponse.success(res, {
      message: 'Contactos de emergencia cargados',
      data,
    });
  }),

  crearContacto: catchAsync(async (req, res) => {
    const data = await alumnoService.crearContacto(req.user.id, req.body);
    return apiResponse.success(res, {
      message: 'Contacto agregado correctamente',
      data,
    });
  }),

  actualizarContacto: catchAsync(async (req, res) => {
    const contactoId = Number(req.params.contactoId);
    if (Number.isNaN(contactoId)) throw new ApiError('ID de contacto inválido', 400);

    const data = await alumnoService.actualizarContacto(req.user.id, contactoId, req.body);
    return apiResponse.success(res, {
      message: 'Contacto actualizado correctamente',
      data,
    });
  }),

  // 🆕 BL-007: PATCH /api/alumnos/:id/contacto-emergencia
  actualizarContactoEmergencia: catchAsync(async (req, res) => {
    // validateParams ya lo transformó a Number con idParamSchema.
    const alumnoId = req.params.id;
    // ⚠️ rol_nombre, NO role: es lo que expone auth.middleware.js.
    const { id: usuarioId, rol_nombre } = req.user;

    // 🔒 Blindaje de propiedad: Administrador y Coordinador editan a cualquier
    // alumno; un Alumno solo su propio contacto. Mismo criterio que el resto
    // del CRUD de contactos.
    if (rol_nombre === 'Alumno' && usuarioId !== alumnoId) {
      throw new ApiError('No tienes permiso sobre este contacto', 403);
    }

    const data = await alumnoService.actualizarContactoEmergencia(alumnoId, req.body);
    return apiResponse.success(res, {
      message: 'Contacto de emergencia actualizado correctamente',
      data,
    });
  }),

  eliminarContacto: catchAsync(async (req, res) => {
    const contactoId = Number(req.params.contactoId);
    if (Number.isNaN(contactoId)) throw new ApiError('ID de contacto inválido', 400);

    await alumnoService.eliminarContacto(req.user.id, contactoId);
    return apiResponse.success(res, { message: 'Contacto eliminado correctamente' });
  }),
};