import { Router } from 'express';
import multer from 'multer';
import { pagosController } from './pagos.controller.js';
import { prisma } from '../../config/database.config.js';
import { authenticate } from '../../shared/middlewares/auth.middleware.js';
import { authorize } from '../../shared/middlewares/authorize.middleware.js';
import { soloPropioAlumno } from '../../shared/middlewares/ownership.middleware.js';

const router = Router();

// Configuración de Multer para manejar archivos en memoria
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('¡Solo se permiten imágenes!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
});

// 🔒 Todo lo de pagos mueve dinero: nada es público. El rol sale del token, no del body.
router.use(authenticate);

// El alumno solo ve y reporta pagos de SUS cuentas.
const duenoDeLaCuenta = async (req) => {
  const cuentaId = Number(req.body?.deuda_id);
  if (!Number.isInteger(cuentaId) || cuentaId <= 0) return null;
  const cuenta = await prisma.cuentas_por_cobrar.findUnique({
    where: { id: cuentaId },
    select: { alumno_id: true },
  });
  return cuenta?.alumno_id;
};

// GET: Pagos de un alumno específico (Vista de Dashboard Estudiante)
// Esta es la ruta que acabamos de crear: http://localhost:3000/api/pagos/alumno/12
router.get(
  '/alumno/:alumno_id',
  authorize('Alumno', 'Administrador'),
  soloPropioAlumno((req) => Number(req.params.alumno_id)),
  pagosController.obtenerPagosPorAlumno
);

// Taquilla: la registra un Administrador (el adminId sale del token).
router.post('/venta-express', authorize('Administrador'), pagosController.registrarVentaExpress);

// POST http://localhost:3000/api/pagos/reportar
// Ahora acepta tanto datos JSON como archivo de imagen. El ownership va DESPUÉS de multer
// porque `deuda_id` llega en el body multipart.
router.post(
  '/reportar',
  authorize('Alumno', 'Administrador'),
  upload.single('voucher'),
  soloPropioAlumno(duenoDeLaCuenta),
  pagosController.reportarPago
);

// Solo un Administrador valida: el revisor queda registrado con SU id del token.
router.post('/validar', authorize('Administrador'), pagosController.validarPagoAdmin);

// GET: Listar todos los pagos (Para la tabla de Admin)
router.get('/', authorize('Administrador'), pagosController.listarPagos);
// Ahora: Endpoint específico para la gestión administrativa
router.get('/gestion-admin', authorize('Administrador'), pagosController.listarPagosAdmin);

// GET: Ver detalle de un pago específico
router.get('/:id', authorize('Administrador'), pagosController.obtenerPago);

// DELETE: Borrar un registro (Cuidado: afecta auditoría)
router.delete('/:id', authorize('Administrador'), pagosController.eliminarPago);
// --- NUEVO ENDPOINT PARA EL MODAL (Búsqueda Profunda) ---
// Ponlo arriba para que no choque con el de /:id genérico
router.get('/detalle-maestro/:id', authorize('Administrador'), pagosController.obtenerDetalle);

export default router;
