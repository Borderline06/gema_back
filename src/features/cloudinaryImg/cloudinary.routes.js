import { Router } from 'express';
import { cloudinaryController } from './cloudinary.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { validate } from '../../shared/middlewares/validate.middleware.js';
import { subirImagen } from '../../shared/middlewares/upload.middleware.js';
import { cloudinarySchema } from './cloudinary.schema.js';

const router = Router();

router.post(
  '/upload',
  authenticate,
  authorize('Administrador', 'Alumno'),
  subirImagen('imagen'),
  validate(cloudinarySchema.uploadSchema),
  cloudinaryController.upload
);

export default router;
