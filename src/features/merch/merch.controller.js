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
    const data = await merchService.crear(req.body, req.file);
    return apiResponse.created(res, { data, message: 'Producto creado exitosamente' });
  }),

  actualizar: catchAsync(async (req, res) => {
    const data = await merchService.actualizar(req.params.id, req.body, req.file);
    return apiResponse.success(res, { data, message: 'Producto actualizado exitosamente' });
  }),

  eliminar: catchAsync(async (req, res) => {
    const data = await merchService.eliminar(req.params.id);
    return apiResponse.success(res, { data, message: 'Producto eliminado exitosamente' });
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
    const data = await merchService.cambiarEstadoItem(
      req.params.id,
      req.body.estado_item,
      req.user.id
    );
    return apiResponse.success(res, { data, message: 'Estado del ítem actualizado' });
  }),

  // --- Logística física ---------------------------------------------------
  listarLogistica: catchAsync(async (req, res) => {
    const data = await merchService.listarLogistica({
      estados: req.query.estado,
      sede_id: req.query.sede_id,
      busqueda: req.query.busqueda,
    });
    return apiResponse.success(res, { data, message: 'Bandeja de logística de merch' });
  }),

  marcarListo: catchAsync(async (req, res) => {
    const data = await merchService.marcarListoParaRecojo(req.params.id, req.user.id, req.body);
    const message =
      data.items_actualizados === 0
        ? 'El pedido ya estaba marcado como listo para recojo'
        : 'Pedido listo para recojo. Se avisó al alumno.';
    return apiResponse.success(res, { data, message });
  }),

  // Error del recepcionista: el ítem ENTREGADO vuelve a POR_ENTREGAR.
  revertirEntrega: catchAsync(async (req, res) => {
    const data = await merchService.revertirEntrega(req.params.id, req.user.id);
    const message = data.sin_cambios
      ? 'El ítem ya estaba pendiente de entrega'
      : 'Entrega revertida: el ítem vuelve a POR_ENTREGAR';
    return apiResponse.success(res, { data, message });
  }),

  marcarEntregado: catchAsync(async (req, res) => {
    const data = await merchService.marcarEntregado(req.params.id, req.user.id);
    const message = data.sin_cambios ? 'El pedido ya estaba entregado' : 'Pedido entregado al alumno';
    return apiResponse.success(res, { data, message });
  }),

  metricas: catchAsync(async (req, res) => {
    const data = await merchService.obtenerMetricas(req.query);
    return apiResponse.success(res, { data, message: 'Métricas de merch' });
  }),
};
