import { merchService } from './merch.service.js';
import { apiResponse } from '../../shared/utils/response.util.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { ApiError } from '../../shared/utils/error.util.js';

export const merchController = {
  listar: catchAsync(async (req, res) => {
    const pideInactivos = req.query.incluir_inactivos === true;
    if (pideInactivos && req.user?.rol_nombre !== 'Administrador') {
      throw new ApiError('Solo un Administrador puede ver productos inactivos.', 403);
    }
    const data = await merchService.listarCatalogo({ incluirInactivos: pideInactivos });
    return apiResponse.success(res, { data, message: 'Catálogo de merch' });
  }),

  crear: catchAsync(async (req, res) => {
    const data = await merchService.crear(req.body);
    return apiResponse.created(res, { data, message: 'Producto creado exitosamente' });
  }),

  actualizar: catchAsync(async (req, res) => {
    const data = await merchService.actualizar(req.params.id, req.body);
    return apiResponse.success(res, { data, message: 'Producto actualizado exitosamente' });
  }),

  coleccionAlumno: catchAsync(async (req, res) => {
    // Un Alumno solo puede ver su propia colección.
    if (req.user?.rol_nombre === 'Alumno' && req.params.id !== req.user.id) {
      throw new ApiError('No puedes ver la colección de otro alumno.', 403);
    }
    const data = await merchService.obtenerColeccion(req.params.id);
    return apiResponse.success(res, { data, message: 'Colección del alumno' });
  }),

  comprar: catchAsync(async (req, res) => {
    const data = await merchService.comprarIndependiente(req.body, req.user.id);
    return apiResponse.created(res, { data, message: data.mensaje });
  }),

  // Orden generada por el alumno: devuelve cuenta_id para abrir el modal de pagos estándar.
  crearOrden: catchAsync(async (req, res) => {
    if (req.user?.rol_nombre === 'Alumno' && req.body.alumno_id !== req.user.id) {
      throw new ApiError('No puedes generar una orden a nombre de otro alumno.', 403);
    }
    const data = await merchService.crearOrden(req.body);
    return apiResponse.created(res, { data, message: data.mensaje });
  }),

  // Arrepentimiento: el alumno cancela su orden PENDIENTE (:id = cuenta_id de la orden).
  cancelarOrden: catchAsync(async (req, res) => {
    const data = await merchService.cancelarOrden(req.params.id, {
      id: req.user.id,
      rol: req.user.rol_nombre,
    });
    return apiResponse.success(res, { data, message: data.mensaje });
  }),

  cambiarEstadoItem: catchAsync(async (req, res) => {
    const data = await merchService.cambiarEstadoItem(req.params.id, req.body.estado_item);
    return apiResponse.success(res, { data, message: 'Estado del ítem actualizado' });
  }),

  metricas: catchAsync(async (req, res) => {
    const data = await merchService.obtenerMetricas(req.query);
    return apiResponse.success(res, { data, message: 'Métricas de merch' });
  }),
};
