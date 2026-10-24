import { inscripcionService } from './inscripcion.service.js';
import { apiResponse } from '../../shared/utils/response.util.js';
import { inscripcionReporteService } from './inscripcion-reporte.service.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { ajusteFechaService } from './ajuste-fecha.service.js';
import { renovacionHistoricaService } from './renovacion-historica.service.js';
import { ApiError } from '../../shared/utils/error.util.js';
// BL-004: valida alumnoId y que un Alumno solo opere sobre sí mismo.
const verificarAlumnoRenovacion = (req) => {
  const { alumnoId } = req.params;
  if (!alumnoId || !/^[0-9]+$/.test(String(alumnoId).trim())) {
    throw new ApiError('El ID de alumno debe ser un entero válido', 400);
  }
  if (req.user?.rol_nombre === 'Alumno' && Number(alumnoId) !== req.user.id) {
    throw new ApiError('No puedes operar sobre otro alumno.', 403);
  }
  return alumnoId;
};



export const inscripcionController = {

  // 🚀 MOTOR DE INSCRIPCIÓN / UPGRADE (Consolidado)
  inscribir: async (req, res) => {
    try {
      // req.body esperado: { "alumno_id": 16, "horario_ids": [1, 2] }
      const nuevaInscripcion = await inscripcionService.inscribirPaquete(req.body);

      res.status(201).json({
        status: 'success',
        message: '¡Inscripción de paquete exitosa!',
        data: nuevaInscripcion,
      });

    } catch (error) {
      // 1. Error de duplicado de Prisma (P2002)
      if (error.code === 'P2002') {
        return res.status(400).json({
          status: 'error',
          message: '⛔ El alumno ya está inscrito en uno de los horarios seleccionados.',
        });
      }

      // 2. 🛡️ CAPTURA DE MUROS DE NEGOCIO (Validaciones del Service)
      // Captura: Límite superado, Muro de Deuda, Bloqueo de Ciclo, etc.
      if (
        error.message.includes('⛔') ||
        error.message.includes('LÍMITE') ||
        error.message.includes('deuda')
      ) {
        return res.status(400).json({ // 400 Bad Request para lógica de negocio
          status: 'error',
          message: error.message,
        });
      }

      // 3. Errores de Conflicto (Agotado o Planes inexistentes)
      if (error.message.includes('AGOTADO') || error.message.includes('No existe un plan')) {
        return res.status(409).json({ // 409 Conflict
          status: 'error',
          message: error.message,
        });
      }

      // 4. Error si un horario no existe
      if (error.message.includes('no existe')) {
        return res.status(404).json({
          status: 'error',
          message: error.message,
        });
      }

      // 5. Error genérico (Fallo real del servidor)
      console.error('💥 Error crítico en inscribir:', error);
      res.status(500).json({
        status: 'error',
        message: 'Error interno al procesar la inscripción',
        detail: error.message
      });
    }
  },

  // Listar todas las inscripciones (Admin)
  listarInscripciones: async (req, res) => {
    try {
      const lista = await inscripcionService.getAllInscripciones();
      res.json({
        status: 'success',
        data: lista,
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'Error al obtener inscripciones',
        detail: error.message
      });
    }
  },

  // Listar inscripciones por ID de alumno (Dashboard)
  listarPorAlumno: async (req, res) => {
    try {
      const { alumnoId } = req.params;
      const data = await inscripcionService.obtenerPorAlumno(alumnoId);

      res.status(200).json({
        status: 'success',
        data
      });
    } catch (error) {
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },

  // Obtener detalle de una sola inscripción
  obtenerDetalle: async (req, res) => {
    try {
      const { id } = req.params;
      const inscripcion = await inscripcionService.getInscripcionById(id);
      if (!inscripcion) {
        return res.status(404).json({ status: 'error', message: 'Inscripción no encontrada' });
      }
      res.json({ status: 'success', data: inscripcion });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  },

  // Eliminar o cancelar inscripción (Soft delete o físico según tu service)
  eliminar: async (req, res) => {
    try {
      const { id } = req.params;
      await inscripcionService.eliminarInscripcion(id);
      res.json({
        status: 'success',
        message: 'Inscripción eliminada o cancelada correctamente'
      });
    } catch (error) {
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },


  // Finalización voluntaria solicitada por el alumno
  finalizarVoluntaria: async (req, res) => {
    try {
      const { id } = req.params;
      const resultado = await inscripcionService.finalizarInscripcionVoluntaria(id);

      res.status(200).json({
        status: 'success',
        message: resultado.mensaje,
        data: {
          nuevo_estado: resultado.nuevo_estado
        }
      });
    } catch (error) {
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },

  // 🔥 CORRECCIÓN: Método estandarizado para cancelar reservas pendientes
  cancelarReserva: async (req, res) => {
    try {
      const { id } = req.params;

      // Llamamos al servicio que limpia inscripción + deuda + beneficios
      const resultado = await inscripcionService.cancelarReservaPendiente(id);

      res.status(200).json({
        status: 'success',
        message: resultado.mensaje,
        data: resultado
      });
    } catch (error) {
      // Manejo de errores consistente con el resto del controlador
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },

  listarNoFinalizadasPorAlumno: async (req, res) => {
    try {
      const { alumnoId } = req.params;
      const data = await inscripcionService.obtenerNoFinalizadasPorAlumno(alumnoId);

      res.status(200).json({
        status: 'success',
        data
      });
    } catch (error) {
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },

  // inscripcion.controller.js
  cancelarPaquetePorDeuda: async (req, res) => {
    try {
      const { cuentaId } = req.params;

      // Llamamos al servicio radical que limpia todo usando la tabla puente
      const resultado = await inscripcionService.eliminarPaqueteCompleto(cuentaId);

      res.status(200).json({
        status: 'success',
        message: "Reserva eliminada y deuda anulada correctamente",
        data: resultado
      });
    } catch (error) {
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },

  updateInscripcion: async (req, res) => {
    try {
      const data = req.body;
      const updateInsc = await inscripcionService.updateInscripcion(data);
      return apiResponse.success(res, {
        data: updateInsc,
        message: 'Horario de inscripción actualizado correctamente.'
      })
    } catch (e) {
      console.error(e)
      // 🤝 BL-010: se reenvía `details` (choque con recuperación → 409 con
      // fecha/hora). `details` es undefined en el resto de errores, así que su
      // JSON no cambia.
      return apiResponse.error(res, {
        message: e.message || 'Error interno',
        status: e.statusCode || 500,
        details: e.details,
      })
    }
  },
  separarYFinalizar: async (req, res) => {
    try {
      const { id } = req.params; // Viene de la URL /1031/separar-finalizar
      const resultado = await inscripcionService.separarFinalizarVoluntaria(id);

      return apiResponse.success(res, {
        data: resultado,
        message: resultado.mensaje
      });
    } catch (e) {
      // Si entra aquí, devuelve el 400 o 500
      console.error("❌ ERROR EN SEPARAR_Y_FINALIZAR:", e.message);
      return apiResponse.error(res, e.message, e.statusCode || 400);
    }
  },
  // ... dentro de inscripcionController

  actualizarFechaInicio: async (req, res) => {
    try {
      const { cuentaId } = req.params;
      const { nuevaFecha } = req.body;

      if (!nuevaFecha) {
        return res.status(400).json({
          status: 'error',
          message: '⛔ La nueva fecha de inicio es requerida.'
        });
      }

      // Llamamos al servicio que creamos anteriormente
      const resultado = await inscripcionService.actualizarFechaInicioPorPago(cuentaId, nuevaFecha);

      res.status(200).json({
        status: 'success',
        message: '📅 Fecha de inicio actualizada correctamente para todas las inscripciones del paquete.',
        data: resultado
      });

    } catch (error) {
      console.error('💥 Error en actualizarFechaInicio:', error);
      res.status(error.statusCode || 500).json({
        status: 'error',
        message: error.message || 'Error interno al actualizar la fecha'
      });
    }
  },

  inscribirIndividual: async (req, res) => {
    try {
      const resultado = await inscripcionService.inscribirIndividual(req.body);
      return apiResponse.success(res, { data: resultado, message: resultado.mensaje });
    } catch (e) {
      return apiResponse.error(res, { message: e.message || 'Error Interno del Servidor', status: e.statusCode || 500 });
    }
  },

  inscribirIndividualByAdmin: async (req, res) => {
    try {
      const resultado = await inscripcionService.inscribirIndividualByAdmin(req.body);
      return apiResponse.success(res, { data: resultado, message: 'Inscripción individual realizada correctamente' });
    } catch (e) {
      return apiResponse.error(res, { message: e.message || 'Error Interno del Servidor', status: e.statusCode || 500 });
    }
  },
  getHistorialCiclos: async (req, res, next) => {
    try {
      const { alumnoId } = req.params;

      if (!alumnoId) {
        return res.status(400).json({ success: false, message: 'ID de alumno requerido' });
      }

      // 🆕 BL-012: mes/anio son OPCIONALES. Sin ellos la respuesta es el
      // histórico completo, idéntico al de siempre.
      const { mes, anio } = req.query;

      const historial = await inscripcionService.obtenerHistorialCiclosAlumno(alumnoId, { mes, anio });

      // ⚠️ REGLA DE ORO: se mantiene este envelope a mano (no apiResponse),
      // porque es el que ya consume el frontend.
      return res.status(200).json({
        success: true,
        data: historial,
        message: 'Historial de ciclos obtenido correctamente'
      });
    } catch (error) {
      next(error); // Pásalo a tu middleware de manejo de errores
    }
  },

  // 🆕 BL-012: historial filtrado por mes con desglose de clases/asistencias.
  getHistorialCiclosPorMes: async (req, res, next) => {
    try {
      const { alumnoId } = req.params;

      if (!alumnoId) {
        return res.status(400).json({ success: false, message: 'ID de alumno requerido' });
      }

      const { mes, anio } = req.query;

      const resultado = await inscripcionService.obtenerHistorialCiclosPorMes(alumnoId, { mes, anio });

      return res.status(200).json({
        success: true,
        data: resultado,
        message: 'Historial de ciclos del mes obtenido correctamente'
      });
    } catch (error) {
      next(error);
    }
  },
  // 🆕 BL-004: último plan del alumno para pre-llenar la reinscripción.
  getUltimoPlan: async (req, res, next) => {
    try {
      const { alumnoId } = req.params;

      // Regex de entero estricto en vez de parseInt (que aceptaría "12abc"),
      // misma convención que parsearMesAnio y el validador de sede_id.
      if (!alumnoId || !/^[0-9]+$/.test(String(alumnoId).trim())) {
        return res.status(400).json({
          success: false,
          message: 'El ID de alumno debe ser un entero válido',
        });
      }

      const ultimoPlan = await inscripcionService.obtenerUltimoPlanAlumno(alumnoId);

      return res.status(200).json({
        success: true,
        data: ultimoPlan,
        message: ultimoPlan.tiene_plan_previo
          ? 'Último plan obtenido correctamente'
          : 'El alumno no tiene un plan previo para reinscribir',
      });
    } catch (error) {
      next(error);
    }
  },

  // BL-004: planes finalizados renovables (expediente histórico).
  getPlanesHistoricos: async (req, res, next) => {
    try {
      const alumnoId = verificarAlumnoRenovacion(req);
      const data = await renovacionHistoricaService.listarPlanesHistoricos(alumnoId);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  },

  // BL-004: renovar un paquete finalizado.
  renovarHistorico: async (req, res, next) => {
    try {
      const alumnoId = verificarAlumnoRenovacion(req);
      const { cuentaId } = req.params;
      if (!/^[0-9]+$/.test(String(cuentaId).trim())) throw new ApiError('El ID de cuenta debe ser un entero válido', 400);
      const data = await renovacionHistoricaService.renovar(alumnoId, cuentaId, req.body);
      return res.status(201).json({ success: true, message: 'Renovación generada. Pendiente de pago.', data });
    } catch (error) {
      next(error);
    }
  },

  getReporteIndividualesExcel: catchAsync(async (req, res) => {
    // 1. Llamamos al servicio
    const dataReporte = await inscripcionReporteService.getReporteIndividuales();
    
    // 2. Respondemos con la estructura que tu frontend espera (success + data)
    return res.status(200).json({
      success: true, // <--- ESTO ES LO QUE EL FRONTEND ESTÁ BUSCANDO
      message: 'Reporte generado con éxito',
      data: dataReporte
    });
  }),


  // BL-006: ajuste de fecha de inicio de un paquete pagado
  getAjusteFecha: async (req, res) => {
    try {
      const data = await ajusteFechaService.obtenerEstado(req.params.cuentaId);
      return apiResponse.success(res, { data, message: 'Estado del ajuste de fecha' });
    } catch (e) {
      return apiResponse.error(res, { message: e.message || 'Error Interno del Servidor', status: e.statusCode || 500 });
    }
  },

  ajustarFechaPaquete: async (req, res) => {
    try {
      const data = await ajusteFechaService.ajustarFecha(req.params.cuentaId, req.body, req.user.id);
      return apiResponse.success(res, { data, message: 'Fecha de inicio ajustada y clases regeneradas correctamente' });
    } catch (e) {
      return apiResponse.error(res, { message: e.message || 'Error Interno del Servidor', status: e.statusCode || 500 });
    }
  },
};