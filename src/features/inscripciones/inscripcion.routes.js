import { Router } from 'express';
import { inscripcionController } from './inscripcion.controller.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { validate } from '../../shared/middlewares/validate.middleware.js';
import { inscribirIndividualAdminSchema, renovarHistoricoSchema, ajusteFechaSchema } from './inscripcion.schema.js';

const router = Router();

// POST http://localhost:3000/api/inscripciones
// ⚠️ CAMBIO AQUÍ: 'crearInscripcion' -> 'inscribir'
router.post('/', inscripcionController.inscribir);

// GET http://localhost:3000/api/inscripciones
router.get('/', inscripcionController.listarInscripciones);

// PATCH: Finalización voluntaria de la inscripción por el alumno
router.patch('/:id/finalizar', inscripcionController.finalizarVoluntaria);

// GET: Listado por alumno (CORREGIDO el nombre del controlador)
router.get('/alumno/:alumnoId', inscripcionController.listarPorAlumno); //

// GET: 🆕 BL-012: Historial de ciclos de un mes con desglose de clases.
// Debe ir ANTES de /historial-ciclos para que no la capture.
// ?mes=1&anio=2026 (ambos obligatorios aquí)
router.get('/alumno/:alumnoId/historial-ciclos/por-mes', inscripcionController.getHistorialCiclosPorMes);

// GET: 🆕 BL-004: último plan del alumno para pre-llenar la reinscripción.
// Solo lectura: devuelve ids de sede/nivel/horario y el front manda el POST /
// de siempre. No colisiona con /:id porque el prefijo es /alumno/.
router.get(
  '/alumno/:alumnoId/ultimo-plan',
  authenticate,
  authorize('Administrador', 'Alumno'),
  inscripcionController.getUltimoPlan
);

// BL-004: renovación desde el expediente histórico.
router.get(
  '/alumno/:alumnoId/planes-historicos',
  authenticate,
  authorize('Administrador', 'Alumno'),
  inscripcionController.getPlanesHistoricos
);
router.post(
  '/alumno/:alumnoId/renovar/:cuentaId',
  authenticate,
  authorize('Administrador', 'Alumno'),
  validate(renovarHistoricoSchema),
  inscripcionController.renovarHistorico
);

// GET: 🚀 NUEVA RUTA: Historial de meses/ciclos del alumno
// 🆕 BL-012: acepta ?mes=&anio= opcionales. Sin ellos devuelve el histórico completo.
router.get('/alumno/:alumnoId/historial-ciclos', inscripcionController.getHistorialCiclos);

// =========================================================================
// 📊 NUEVA RUTA: REPORTE DE EXCEL (Debe ir ANTES de las rutas con /:id)
// =========================================================================
router.get(
  '/reportes/individuales',
  authenticate,
  authorize('Administrador'), // Solo administradores pueden descargar reportes
  inscripcionController.getReporteIndividualesExcel
);


// GET: Detalle de una sola inscripción
router.get('/:id', inscripcionController.obtenerDetalle);

// DELETE: Cancelar inscripción
router.delete('/:id', inscripcionController.eliminar);

router.patch(
  '/:id/cancelar-reserva',
  inscripcionController.cancelarReserva
);

// inscripcion.routes.js
router.delete('/paquete/:cuentaId', inscripcionController.cancelarPaquetePorDeuda);

router.get('/alumno-no-finalizadas/:alumnoId', inscripcionController.listarNoFinalizadasPorAlumno);

router.put(
  '/horario-inscripcion',
  inscripcionController.updateInscripcion
)
// PATCH /api/inscripciones/:id/separar-finalizar
router.patch('/:id/separar-finalizar', inscripcionController.separarYFinalizar);

router.patch('/paquete/fecha/:cuentaId', inscripcionController.actualizarFechaInicio);

// BL-006: ajuste de fecha de inicio de un paquete pagado (solo admin)
router.get('/paquete/:cuentaId/ajuste-fecha', authenticate, authorize('Administrador'), inscripcionController.getAjusteFecha);
router.patch('/paquete/:cuentaId/ajuste-fecha', authenticate, authorize('Administrador'), validate(ajusteFechaSchema), inscripcionController.ajustarFechaPaquete);

router.post('/individual', authenticate, authorize('Alumno'), inscripcionController.inscribirIndividual);

// 💰 BL-002: esta ruta recibía el body crudo. El schema valida el array de
// clases y deja pasar (ignorado) el `montoTotal` que el front sigue enviando.
router.post(
  '/individual-admin',
  authenticate,
  authorize('Administrador'),
  validate(inscribirIndividualAdminSchema),
  inscripcionController.inscribirIndividualByAdmin
);

export default router;