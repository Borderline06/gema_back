import { historialAcademicoService } from './historial_academico.service.js';

export const historialAcademicoController = {
  getHistorialPorAlumno: async (req, res, next) => {
    try {
      const { alumnoId } = req.params;
      const data = await historialAcademicoService.obtenerHistorialPorAlumno(alumnoId);

      return res.status(200).json({
        success: true,
        data,
        message: 'Historial académico obtenido correctamente'
      });
    } catch (error) {
      next(error);
    }
  },

  // 🆕 Resumen liviano para la tabla principal de Gestión de Alumnos
  getResumenTablaAlumnos: async (req, res, next) => {
    try {
      const { sede_id } = req.query;
      const data = await historialAcademicoService.obtenerResumenTablaAlumnos(sede_id || null);

      return res.status(200).json({
        success: true,
        data,
        message: 'Resumen de alumnos obtenido correctamente'
      });
    } catch (error) {
      next(error);
    }
  },

  // 📤 BL-013: reporte exportable de alumnos (10 columnas para el Excel)
  exportarReporteAlumnos: async (req, res, next) => {
    try {
      const { sede_id } = req.query;
      const data = await historialAcademicoService.exportarReporteAlumnos(sede_id || null);

      return res.status(200).json({
        success: true,
        data,
        message: 'Reporte de alumnos generado correctamente'
      });
    } catch (error) {
      next(error);
    }
  },

  // Se mantiene por compatibilidad, aunque la tabla ya no lo necesite aparte
  getFlagsIndividualPorSede: async (req, res, next) => {
    try {
      const { sede_id } = req.query;
      const data = await historialAcademicoService.obtenerFlagsIndividualPorSede(sede_id || null);

      return res.status(200).json({
        success: true,
        data,
        message: 'Resumen de planes individuales obtenido correctamente'
      });
    } catch (error) {
      next(error);
    }
  },
    // 🆕 Detalle completo para el Expediente de un alumno
  getDetalleAlumno: async (req, res, next) => {
    try {
      const { alumnoId } = req.params;
      const data = await historialAcademicoService.obtenerDetalleAlumno(alumnoId);

      return res.status(200).json({
        success: true,
        data,
        message: 'Detalle de alumno obtenido correctamente'
      });
    } catch (error) {
      next(error);
    }
  },

};