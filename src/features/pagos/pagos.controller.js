import { pagosService } from './pagos.service.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { apiResponse } from '../../shared/utils/response.util.js';

export const pagosController = {
  // 1. REPORTAR PAGO (Con soporte para subida de imagen a Cloudinary)
  reportarPago: async (req, res) => {
    try {
      console.log('📝 [DEBUG] Datos recibidos en reportarPago:', req.body);
      console.log('📁 [DEBUG] Archivo recibido:', req.file ? req.file.originalname : 'Ninguno');

      // Pasar tanto los datos del body como el archivo (si existe)
      const resultado = await pagosService.registrarPago({
        ...req.body,
        voucherFile: req.file, // El archivo subido desde el frontend
      });

      res.status(201).json({
        status: 'success',
        message: '¡Pago reportado! Tus cupos están en validación por el administrador.',
        data: resultado,
      });
    } catch (error) {
      console.error('❌ [ERROR AL REPORTAR PAGO]:', error.message);
      // Diferenciamos errores de "no encontrado" vs errores de lógica
      const statusCode = error.message.includes('no existe') ? 404 : 400;

      res.status(statusCode).json({
        status: 'error',
        message: error.message,
      });
    }
  },
  // =================================================================
  // 🎟️ NUEVO: VENTA EXPRESS (Taquilla)
  // =================================================================
  registrarVentaExpress: catchAsync(async (req, res) => {
    // El admin sale SIEMPRE del token (la ruta exige authenticate + Administrador): un id
    // enviado en el body ya no se acepta, así nadie puede registrar ventas a nombre de otro.
    const adminId = req.user.id;

    const resultado = await pagosService.registrarVentaExpress(req.body, adminId);

    return apiResponse.success(res, {
      message: resultado.mensaje,
      data: resultado,
    });
  }),

  // 2. VALIDAR PAGO (Actualizado con "La Verdad del Admin" 👮‍♂️)
  validarPagoAdmin: async (req, res) => {
    try {
      // Recibimos los datos del Body.
      // 🆕 AGREGADO: 'monto_real_confirmado' por si el Admin necesita corregir.
      // 🆕 BL-006: 'fecha_inicio_ciclo' (opcional, 'YYYY-MM-DD') por si el Admin
      // necesita que el ciclo arranque otro día (pagó hoy, empieza el lunes).
      const {
        pago_id,
        accion,
        notas,
        monto_real_confirmado,
        fecha_inicio_ciclo,
      } = req.body;

      // 🔒 El revisor es quien está autenticado (la ruta exige Administrador). El
      // `usuario_admin_id` del body ya no se usa: el front lo sigue mandando y se ignora,
      // así nadie puede aprobar pagos a nombre de otro administrador.
      const usuario_admin_id = req.user.id;

      // Preparamos el objeto completo para el servicio
      // ⚠️ Esta lista blanca descarta cualquier llave que no esté acá, así que
      // todo campo nuevo del body tiene que sumarse también en este objeto.
      const data = {
        pago_id,
        accion,
        notas,
        usuario_admin_id,
        monto_real_confirmado, // <--- Aquí pasamos el dato nuevo
        fecha_inicio_ciclo, // <--- 🆕 BL-006
      };

      const resultado = await pagosService.validarPago(data);

      res.status(200).json({
        status: 'success',
        message: resultado.resultado,
        data: resultado,
      });
    } catch (error) {
      // 🤝 BL-010: un choque con una recuperación PROGRAMADA responde 409 con
      // `details` ({codigo, fecha, hora, choques}) para que el front muestre la
      // alerta. Es deliberadamente el ÚNICO error que deja de ser 400: el resto
      // conserva el 400 y las llaves de siempre (regla de oro).
      if (error.statusCode === 409 && error.details?.codigo === 'CHOQUE_RECUPERACION') {
        return res.status(409).json({
          status: 'error',
          message: error.message,
          details: error.details,
        });
      }

      res.status(400).json({
        status: 'error',
        message: error.message,
      });
    }
  },
  // 3. LISTAR PAGOS
  listarPagos: async (req, res) => {
    try {
      const pagos = await pagosService.obtenerTodos();
      res.status(200).json({ status: 'success', data: pagos });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  },

  // 4. OBTENER UN PAGO
  obtenerPago: async (req, res) => {
    try {
      const pago = await pagosService.obtenerPorId(req.params.id);
      res.status(200).json({ status: 'success', data: pago });
    } catch (error) {
      res.status(404).json({ status: 'error', message: error.message });
    }
  },

  obtenerPagosPorAlumno: async (req, res) => {
    try {
      const { alumno_id } = req.params;

      if (!alumno_id) {
        throw new Error('Se requiere el ID del alumno.');
      }

      const pagos = await pagosService.obtenerPorAlumno(alumno_id);

      res.status(200).json({
        status: 'success',
        data: pagos,
      });
    } catch (error) {
      res.status(400).json({
        status: 'error',
        message: error.message,
      });
    }
  },
  listarPagosAdmin: async (req, res) => {
    try {
      // Llamada al nuevo método del service
      const pagos = await pagosService.obtenerTodosParaAdmin();
      
      res.status(200).json({ 
        status: 'success', 
        data: pagos 
      });
    } catch (error) {
      console.error('❌ [ERROR LISTAR PAGOS ADMIN]:', error.message);
      res.status(500).json({ 
        status: 'error', 
        message: 'Error al recuperar el listado administrativo.' 
      });
    }
  },

  // 5. ELIMINAR PAGO
  eliminarPago: async (req, res) => {
    try {
      await pagosService.eliminarPago(req.params.id);
      res.status(200).json({ status: 'success', message: 'Registro de pago eliminado.' });
    } catch (error) {
      res.status(400).json({ status: 'error', message: error.message });
    }
  },
  obtenerDetalle: async (req, res) => {
    try {
      const { id } = req.params;
      const detalle = await pagosService.obtenerDetalleCompleto(id);
      
      res.status(200).json({
        status: 'success',
        data: detalle
      });
    } catch (error) {
      res.status(404).json({
        status: 'error',
        message: error.message
      });
    }
  },
};
