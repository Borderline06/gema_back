import { Router } from 'express';
import { TiposBeneficioController } from './tipos_beneficio.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';

const router = Router();

// 🔒 El catálogo de descuentos lo administra solo un Administrador; leerlo exige sesión.
router.use(authenticate);

router.post('/', authorize('Administrador'), TiposBeneficioController.crear);
router.get('/', TiposBeneficioController.listar);
router.put('/:id', authorize('Administrador'), TiposBeneficioController.actualizar);   // Nueva ruta
router.delete('/:id', authorize('Administrador'), TiposBeneficioController.eliminar); // Nueva ruta
export default router;
