import { Router } from 'express';
import { BeneficiosPendientesController } from './beneficios-pendientes.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { soloPropioAlumno } from '../../shared/middlewares/ownership.middleware.js';

const router = Router();

// 🔒 Un beneficio es un descuento sobre lo que paga el alumno: no es público.
router.use(authenticate);

// POST /api/beneficios-pendientes
// Body: { alumno_id, tipo_beneficio_id, asignado_por, motivo }
// Solo un Administrador asigna beneficios y `asignado_por` es quien está autenticado
// (el valor del body se ignora para que nadie asigne a nombre de otro).
router.post(
  '/',
  authorize('Administrador'),
  (req, res, next) => {
    req.body = { ...req.body, asignado_por: req.user.id };
    next();
  },
  BeneficiosPendientesController.crear
);

// GET /api/beneficios-pendientes/alumno/10 (el alumno solo ve los suyos)
router.get(
  '/alumno/:alumnoId',
  authorize('Alumno', 'Administrador'),
  soloPropioAlumno((req) => Number(req.params.alumnoId)),
  BeneficiosPendientesController.obtenerPorAlumno
);

export default router;
