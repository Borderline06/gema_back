import { Router } from 'express';
import { merchController } from './merch.controller.js';
import { merchSchema } from './merch.schema.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import {
  validate,
  validateParams,
  validateQuery,
} from '../../shared/middlewares/validate.middleware.js';

const router = Router();

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

// Gestión del catálogo.
router.post(
  '/',
  authorize('Administrador'),
  validate(merchSchema.createMerchSchema),
  merchController.crear
);
router.put(
  '/:id',
  authorize('Administrador'),
  validateParams(merchSchema.idParamSchema),
  validate(merchSchema.updateMerchSchema),
  merchController.actualizar
);

// POSEE / PERDIDO / DEVUELTO de una unidad de la colección.
router.patch(
  '/items/:id/estado',
  authorize('Administrador'),
  validateParams(merchSchema.idParamSchema),
  validate(merchSchema.estadoItemSchema),
  merchController.cambiarEstadoItem
);

export default router;
