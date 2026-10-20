import { Router } from 'express';
import { publicacionController } from './publicacion.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import {
  validate,
  validateParams,
  validateQuery,
} from '../../shared/middlewares/validate.middleware.js';
import { subirImagen } from '../../shared/middlewares/upload.middleware.js';
import { publicacionSchema } from './publicacion.schema.js';

const router = Router();

// Rutas públicas
router.get(
  '/',
  validateQuery(publicacionSchema.querySchema),
  publicacionController.getAllPublicaciones
);
router.get(
  '/:id',
  validateParams(publicacionSchema.idParamSchema),
  publicacionController.getPublicacionById
);

// Rutas protegidas — solo Administrador
router.use(authenticate);
router.use(authorize('Administrador'));

router.post(
  '/',
  subirImagen('imagen'),
  validate(publicacionSchema.createSchema),
  publicacionController.createPublicacion
);

router.put(
  '/:id',
  validateParams(publicacionSchema.idParamSchema),
  subirImagen('imagen'),
  validate(publicacionSchema.updateSchema),
  publicacionController.updatePublicacion
);

router.patch(
  '/:id/desactivar',
  validateParams(publicacionSchema.idParamSchema),
  publicacionController.updateDefusePublicacion
);

router.patch(
  '/:id/activar',
  validateParams(publicacionSchema.idParamSchema),
  publicacionController.updateActivePublicacion
);

router.delete(
  '/:id',
  validateParams(publicacionSchema.idParamSchema),
  publicacionController.deletePublicacion
);

export default router;
