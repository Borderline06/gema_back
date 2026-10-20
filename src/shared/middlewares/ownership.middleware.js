import { apiResponse } from '../utils/response.util.js';

/**
 * Un Alumno solo puede operar sobre SUS propios recursos; el resto de roles (Administrador,
 * Coordinador) ya pasaron por `authorize` y no se restringen aquí.
 *
 * `resolverAlumnoId(req)` devuelve el id del alumno dueño del recurso que pide la petición
 * (o null/undefined si el recurso no existe). Va después de `authenticate` y `authorize`, y
 * después de multer cuando la ruta recibe multipart (el body aún no está parseado antes).
 */
export const soloPropioAlumno = (resolverAlumnoId) => async (req, res, next) => {
  if (req.user?.rol_nombre !== 'Alumno') return next();

  try {
    const duenoId = await resolverAlumnoId(req);
    if (duenoId === null || duenoId === undefined) {
      return apiResponse.error(res, 'El recurso solicitado no existe.', 404);
    }
    if (Number(duenoId) !== Number(req.user.id)) {
      return apiResponse.error(res, 'No puedes acceder a información de otro alumno.', 403);
    }
    return next();
  } catch (error) {
    return next(error);
  }
};
