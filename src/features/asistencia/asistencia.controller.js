import { asistenciaService } from './asistencia.service.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { apiResponse } from '../../shared/utils/response.util.js';

// NO SE USA
// // 1. Marcar o actualizar una asistencia específica
// const marcarAsistencia = catchAsync(async (req, res) => {
//     const { id } = req.params;
//     const { estado, comentario } = req.body;

//     if (!id) {
//         throw new ApiError('El ID de la asistencia es requerido.', 400);
//     }

//     const estadosValidos = ['PRESENTE', 'FALTA', 'PROGRAMADA'];
//     if (estado && !estadosValidos.includes(estado)) {
//         throw new ApiError(`Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}`, 400);
//     }

//     const asistenciaActualizada = await asistenciaService.marcarAsistencia(
//         id,
//         estado,
//         comentario
//     );

//     return apiResponse(
//         res,
//         asistenciaActualizada,
//         `Asistencia marcada como ${estado} correctamente.`,
//         200
//     );
// });

// ======================================================
// 🆕 TUS FUNCIONES CORREGIDAS (Usando apiResponse.success)
// ======================================================

const listarPorAlumno = catchAsync(async (req, res) => {
  const { alumnoId } = req.params; // Viene validado y como entero desde Zod

  const asistencias = await asistenciaService.obtenerPorAlumno(alumnoId);

  // ✅ Llamada correcta a tu clase estática
  return apiResponse.success(res, {
    data: asistencias,
    message: 'Asistencias del alumno recuperadas.',
  });
});

const listarTodas = catchAsync(async (req, res) => {
  const asistencias = await asistenciaService.obtenerTodas();

  // ✅ Llamada correcta a tu clase estática
  return apiResponse.success(res, {
    data: asistencias,
    message: 'Listado general de asistencias.',
  });
});
const listarAgenda = catchAsync(async (req, res) => {
  const coordinadorId = req.user.id;
  const { fecha } = req.query;

  // Si no viene fecha en el query, pasamos null para traer toda la data del coordinador
  const fechaConsulta = fecha ? new Date(fecha) : null;

  const clases = await asistenciaService.obtenerAgendaCoordinador(coordinadorId, fechaConsulta);

  return apiResponse.success(res, {
    message: 'Agenda de entrenamiento recuperada exitosamente.',
    data: clases,
  });
});
const marcarAsistenciaMasiva = catchAsync(async (req, res) => {
  const { asistencias } = req.body; // Ya validados por Zod

  const resultado = await asistenciaService.procesarAsistenciaMasiva(asistencias);

  return apiResponse.success(res, {
    data: resultado,
    message: 'Asistencia grupal actualizada correctamente.',
  });
});
const listarClasesHoy = catchAsync(async (req, res) => {
  // Extraemos el ID del coordinador desde el middleware authenticate
  const coordinadorId = req.user.id;

  // Podemos permitir que envíen una fecha específica, o usar HOY por defecto
  const { fecha } = req.query;
  const fechaConsulta = fecha ? new Date(fecha) : new Date();

  const clases = await asistenciaService.obtenerClasesDelDiaPorCoordinador(
    coordinadorId,
    fechaConsulta
  );

  return apiResponse.success(res, {
    message: 'Agenda del día recuperada exitosamente.',
    data: clases,
  });

});

const obtenerEstadisticasAlumno = catchAsync(async (req, res) => {
  const { alumnoId } = req.params; // Viene validado desde tu ruta

  const estadisticas = await asistenciaService.obtenerEstadisticasAlumno(alumnoId);

  // ✅ Llamada correcta a tu utilidad de respuestas
  return apiResponse.success(res, {
    data: estadisticas,
    message: 'Estadísticas de rendimiento del alumno calculadas.',
  });
});

const previsualizarClasesFuturas = catchAsync(async (req, res) => {
  // ✅ AHORA: Le pasamos TODO el req.body al service. 
  // El frontend envía { alumno_id, horario_ids }, y el service lo recibe completito.
  const fechas = await asistenciaService.previsualizarfechasFuturas(req.body);

  return apiResponse.success(res, {
    data: fechas,
    message: 'Fechas inteligentes de previsualización obtenidas.',
  });
});


// 🤝 BL-010: alerta previa de choques con recuperaciones ya agendadas.
// Solo lectura: el admin la consulta ANTES de validar el pago para saber si la
// generación va a tener que correr alguna clase de semana.
const previsualizarChoquesRecuperacion = catchAsync(async (req, res) => {
  const { inscripcion_id, fecha_inicio } = req.query; // validado por Zod

  const resultado = await asistenciaService.previsualizarChoquesRecuperacion({
    inscripcion_id,
    fecha_inicio,
  });

  return apiResponse.success(res, {
    data: resultado,
    message: resultado.hay_choques
      ? `Se detectaron ${resultado.total_choques} choque(s) con clases de recuperación.`
      : 'Sin choques con clases de recuperación.',
  });
});

export const asistenciaController = {
  //marcarAsistencia,
  listarPorAlumno,
  listarTodas,
  listarClasesHoy,
  listarAgenda,
  marcarAsistenciaMasiva,
  obtenerEstadisticasAlumno,
  previsualizarClasesFuturas,
  previsualizarChoquesRecuperacion,
};
