import { Router } from 'express';
import { asistenciaController } from './asistencia.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import {
  validate,
  validateParams,
  validateQuery,
} from '../../shared/middlewares/validate.middleware.js';
import { asistenciaSchema } from './asistencia.schema.js';

const router = Router();

// ======================================================
// 🔒 RUTAS PROTEGIDAS
// ======================================================
router.use(authenticate);


// ======================================================
// 📊 RUTAS DE ESTADÍSTICAS
// ======================================================
router.get(
  '/alumno/:alumnoId/estadisticas',
  authorize('Administrador', 'Coordinador', 'Alumno'),
  validateParams(asistenciaSchema.alumnoIdParamSchema),
  asistenciaController.obtenerEstadisticasAlumno
);
// Listado general de asistencias (Solo Admin/Coordinador)
router.get('/', authorize('Administrador', 'Coordinador'), asistenciaController.listarTodas);

// Buscar asistencias por ID de alumno (Admin, Coordinador, Alumno)
router.get(
  '/alumno/:alumnoId',
  authorize('Administrador', 'Coordinador', 'Alumno'),
  validateParams(asistenciaSchema.alumnoIdParamSchema),
  asistenciaController.listarPorAlumno
);

router.get(
  '/agenda/hoy',
  authorize('Coordinador'),
  validateQuery(asistenciaSchema.agendaQuerySchema),
  asistenciaController.listarClasesHoy
);

router.get(
  '/agenda',
  authorize('Coordinador'),
  validateQuery(asistenciaSchema.agendaQuerySchema),
  asistenciaController.listarAgenda
);

// 🤝 BL-010: alerta previa de choques con clases de recuperación.
// Solo lectura y HTTP 200 (es una consulta, no un conflicto): el front la usa
// para avisar al admin antes de validar el pago. Endpoint NUEVO a propósito —
// así la alerta estructurada no obliga a tocar las llaves de ningún JSON ya
// consumido por el frontend.
router.get(
  '/choques-recuperacion',
  authorize('Administrador', 'Coordinador'),
  validateQuery(asistenciaSchema.choquesRecuperacionQuerySchema),
  asistenciaController.previsualizarChoquesRecuperacion
);

router.post(
  '/masiva',
  authorize('Coordinador'),
  validate(asistenciaSchema.masivaSchema),
  asistenciaController.marcarAsistenciaMasiva
);

router.post(
  '/previsualizar-fechas',
  authorize('Administrador', 'Coordinador', 'Alumno'),
  asistenciaController.previsualizarClasesFuturas
)

export default router;
