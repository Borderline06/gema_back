import { Router } from 'express';
import { CuentasPorCobrarController } from './cuentas_por_cobrar.controller.js';
import { prisma } from '../../config/database.config.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { soloPropioAlumno } from '../../shared/middlewares/ownership.middleware.js';

const router = Router();

// 🔒 Cuentas por cobrar es dinero del club: nada es público. El rol sale del token.
router.use(authenticate);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dueño de un paquete (grupo de inscripciones): el alumno solo renueva el suyo.
// Un id que no es UUID no existe (y evita que Prisma reviente con la columna @db.Uuid).
const duenoDelPaquete = async (req) => {
  const { grupoUuid } = req.params;
  if (!UUID.test(grupoUuid)) return null;
  const inscripcion = await prisma.inscripciones.findFirst({
    where: { id_grupo_transaccion: grupoUuid },
    select: { alumno_id: true },
  });
  return inscripcion?.alumno_id;
};

// CRUD administrativo de cuentas: solo Administrador (el front de alumno no lo usa).
router.post('/', authorize('Administrador'), CuentasPorCobrarController.crear);
router.get('/', authorize('Administrador'), CuentasPorCobrarController.listar);
// 3. Renovación con validación de aforo (usado para reactivar paquetes FINALIZADOS)
router.post(
  '/generar-adelantado-validado/:grupoUuid',
  authorize('Alumno', 'Administrador'),
  soloPropioAlumno(duenoDelPaquete),
  CuentasPorCobrarController.generarAdelantadoValidado
);
router.get('/:id', authorize('Administrador'), CuentasPorCobrarController.obtenerUno);
router.put('/:id', authorize('Administrador'), CuentasPorCobrarController.actualizar);
router.delete('/:id', authorize('Administrador'), CuentasPorCobrarController.eliminar);
// GET /api/cuentas/historial/16 -> Trae todo lo del alumno con ID 16
router.get(
  '/historial/:alumnoId',
  authorize('Alumno', 'Administrador'),
  soloPropioAlumno((req) => Number(req.params.alumnoId)),
  CuentasPorCobrarController.obtenerHistorialAlumno
);
// 1. Ruta para que el Front consulte la fecha sugerida (Cerebro)
router.get(
  '/renovacion-sugerida/:grupoUuid',
  authorize('Alumno', 'Administrador'),
  soloPropioAlumno(duenoDelPaquete),
  CuentasPorCobrarController.previsualizarFechaRenovacion
);

// 2. Ruta para ejecutar la renovación de todo el paquete
router.post(
  '/generar-adelantado/:grupoUuid',
  authorize('Alumno', 'Administrador'),
  soloPropioAlumno(duenoDelPaquete),
  CuentasPorCobrarController.generarAdelantado
);
export default router;
