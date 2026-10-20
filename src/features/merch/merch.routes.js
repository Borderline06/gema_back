import { Router } from 'express';
import { merchController } from './merch.controller.js';
import { merchSchema } from './merch.schema.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { subirImagen } from '../../shared/middlewares/upload.middleware.js';
import {
  validate,
  validateParams,
  validateQuery,
} from '../../shared/middlewares/validate.middleware.js';

const router = Router();

// Foto opcional del producto (campo multipart `imagen`, solo JPG/PNG/WEBP verificados por su
// contenido). Si la petición es JSON (clientes viejos con Base64) el body pasa intacto.
const subirImagenMerch = subirImagen('imagen');

router.use(authenticate);

// Catálogo disponible (?incluir_inactivos=true solo Administrador).
router.get('/', validateQuery(merchSchema.catalogoQuerySchema), merchController.listar);

// Métricas aisladas de merch (antes de /:id para no chocar).
router.get(
  '/metricas',
  authorize('Administrador'),
  validateQuery(merchSchema.metricasQuerySchema),
  merchController.metricas
);

// Colección del alumno (un Alumno solo ve la suya).
router.get('/alumno/:id', validateParams(merchSchema.idParamSchema), merchController.coleccionAlumno);

// Compra independiente (nace cobrada, la registra un Administrador).
router.post(
  '/comprar',
  authorize('Administrador'),
  validate(merchSchema.comprarSchema),
  merchController.comprar
);

// Orden del alumno: reserva stock y deja una cuenta PENDIENTE para pagar con el flujo estándar.
router.post(
  '/orden',
  authorize('Alumno', 'Administrador'),
  validate(merchSchema.ordenSchema),
  merchController.crearOrden
);

// Arrepentimiento: cancela la orden PENDIENTE (:id = cuenta_id) y devuelve el stock.
router.delete(
  '/orden/:id',
  authorize('Alumno', 'Administrador'),
  validateParams(merchSchema.idParamSchema),
  merchController.cancelarOrden
);

// Gestión del catálogo.
router.post(
  '/',
  authorize('Administrador'),
  subirImagenMerch,
  validate(merchSchema.createMerchSchema),
  merchController.crear
);
router.put(
  '/:id',
  authorize('Administrador'),
  validateParams(merchSchema.idParamSchema),
  subirImagenMerch,
  validate(merchSchema.updateMerchSchema),
  merchController.actualizar
);
// Elimina el producto y su foto en Cloudinary (409 si ya tiene ventas: se desactiva).
router.delete(
  '/:id',
  authorize('Administrador'),
  validateParams(merchSchema.idParamSchema),
  merchController.eliminar
);

// --- Logística física: preparar, enviar a la sede, avisar y entregar en mano ---
// La operan Administrador y Coordinador (suelen estar en recepción).
const recepcion = authorize('Administrador', 'Coordinador');

// Bandeja: qué hay que entregar y dónde (?estado=&sede_id=&busqueda=nombre o DNI).
router.get(
  '/logistica',
  recepcion,
  validateQuery(merchSchema.logisticaQuerySchema),
  merchController.listarLogistica
);
// POR_ENTREGAR -> LISTO_PARA_RECOJO. Avisa al alumno UNA sola vez, aunque se marquen
// varias unidades (body opcional: { item_ids: [..], incluir_orden: true }).
router.patch(
  '/logistica/:id/listo',
  recepcion,
  validateParams(merchSchema.idParamSchema),
  validate(merchSchema.listoBodySchema),
  merchController.marcarListo
);
// POR_ENTREGAR / LISTO_PARA_RECOJO -> ENTREGADO (el recepcionista se lo dio en mano).
router.patch(
  '/logistica/:id/entregar',
  recepcion,
  validateParams(merchSchema.idParamSchema),
  merchController.marcarEntregado
);
// ENTREGADO -> POR_ENTREGAR (el recepcionista se equivocó).
router.patch(
  '/logistica/:id/revertir',
  recepcion,
  validateParams(merchSchema.idParamSchema),
  merchController.revertirEntrega
);

// ENTREGADO / PERDIDO / DEVUELTO de una unidad de la colección (correcciones).
router.patch(
  '/items/:id/estado',
  authorize('Administrador'),
  validateParams(merchSchema.idParamSchema),
  validate(merchSchema.estadoItemSchema),
  merchController.cambiarEstadoItem
);

export default router;
