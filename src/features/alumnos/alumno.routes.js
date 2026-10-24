import { Router } from 'express';
import { alumnoController } from './alumno.controller.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { validate, validateParams } from '../../shared/middlewares/validate.middleware.js';
import {
  actualizarPerfilSchema,
  crearContactoSchema,
  actualizarContactoSchema,
  actualizarContactoEmergenciaSchema,
} from './alumno.schema.js';
// 🆕 BL-007: reusamos el validador de :id que ya existe en usuarios.
import { commonUsuarioSchemas } from '../usuarios/schemas/common.schema.js';

const router = Router();

router.use(authenticate);

router.get('/mi-perfil/contactos', alumnoController.listarMisContactos);

router.post(
  '/mi-perfil/contactos',
  validate(crearContactoSchema),
  alumnoController.crearContacto
);

router.patch(
  '/mi-perfil/contactos/:contactoId',
  validate(actualizarContactoSchema),
  alumnoController.actualizarContacto
);

router.delete(
  '/mi-perfil/contactos/:contactoId',
  alumnoController.eliminarContacto
);

router.get('/mi-perfil', alumnoController.obtenerMiPerfil);
// PATCH /api/alumno/mi-perfil
router.patch('/mi-perfil', validate(actualizarPerfilSchema), alumnoController.actualizarMiPerfil);

router.get(
    '/gestion/resumen-cortes',
    authorize('Administrador', 'Coordinador'),
    alumnoController.listarAlumnosResumen
);

router.get(
    '/gestion/cortes-alumnos',
    authorize('Administrador', 'Coordinador'),
    alumnoController.listarAlumnosResumenPorCoordinador
);

router.post(
    '/gestion/cambiar-historial',
    authorize('Administrador'),
    alumnoController.cambiarHistorialAlumno
)

// ==========================================================================
// 🆕 BL-007: PATCH /api/alumnos/:id/contacto-emergencia
//
// Declarada AL FINAL, después de todas las rutas literales (/mi-perfil*,
// /gestion/*), para que un segmento dinámico no pueda capturarlas.
//
// El rol Alumno entra en authorize y el filtro fino (solo su propio :id) lo
// hace el controller.
// ==========================================================================
router.patch(
    '/:id/contacto-emergencia',
    authorize('Administrador', 'Coordinador', 'Alumno'),
    validateParams(commonUsuarioSchemas.idParamSchema),
    validate(actualizarContactoEmergenciaSchema),
    alumnoController.actualizarContactoEmergencia
);

export default router;