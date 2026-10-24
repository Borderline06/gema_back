import { Router } from 'express';
import { movimientosFinancierosController } from './movimientos-financieros.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
// Si tienes un schema de validación para caja, agrégalo aquí:
// import { validate } from '../../shared/middlewares/validate.middleware.js';
// import { crearMovimientoSchema } from './movimientos-financieros.schema.js';

const router = Router();

// Todas las rutas de caja requieren estar autenticado
router.use(authenticate);

// Solo el Administrador puede gestionar la caja
router.use(authorize('Administrador'));

// Endpoint especial para ver el balance general
router.get('/balance', movimientosFinancierosController.obtenerResumenBalance);
router.get('/resumen', movimientosFinancierosController.obtenerResumen);
router.get('/resumen-anual', movimientosFinancierosController.obtenerResumenAnual);
// Merch vs Matrícula del mes (antes de '/:id' para que no lo capture).
router.get('/desglose-ingresos', movimientosFinancierosController.obtenerDesgloseIngresos);
// CRUD estándar
router.get('/', movimientosFinancierosController.listar);
router.get('/:id', movimientosFinancierosController.obtenerPorId);

// Si usas un validador (Zod/Joi), lo pondrías así:
// router.post('/', validate(crearMovimientoSchema), movimientosFinancierosController.crear);
router.post('/', movimientosFinancierosController.crear);
router.put('/:id', movimientosFinancierosController.actualizar);
router.delete('/:id', movimientosFinancierosController.eliminar);


export default router;