import { Router } from 'express';
import { historialAcademicoController } from './historial_academico.controller.js';

const router = Router();

// GET /api/historial-academico/resumen-tabla?sede_id=...
router.get('/resumen-tabla', historialAcademicoController.getResumenTablaAlumnos);

// 📤 BL-013: GET /api/historial-academico/exportar-alumnos?sede_id=...
// Debe ir antes de las rutas con /:param para que no las capture.
router.get('/exportar-alumnos', historialAcademicoController.exportarReporteAlumnos);

// GET /api/historial-academico/resumen-individual?sede_id=...
router.get('/resumen-individual', historialAcademicoController.getFlagsIndividualPorSede);

// GET /api/historial-academico/alumno-detalle/:alumnoId
router.get('/alumno-detalle/:alumnoId', historialAcademicoController.getDetalleAlumno);

// GET /api/historial-academico/alumno/:alumnoId
router.get('/alumno/:alumnoId', historialAcademicoController.getHistorialPorAlumno);

export default router;