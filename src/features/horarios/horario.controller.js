import { horarioService } from './horario.service.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { apiResponse } from '../../shared/utils/response.util.js';

export const horarioController = {
  getHorarios: catchAsync(async (req, res) => {
    const horarios = await horarioService.getAllHorarios();
    return apiResponse.success(res, {
      message: 'Horarios obtenidos exitosamente',
      data: horarios,
    });
  }),

  createHorario: catchAsync(async (req, res) => {
    const horario = await horarioService.createHorario(req.body);
    return apiResponse.created(res, {
      message: 'Horario creado exitosamente',
      data: horario,
    });
  }),

  updateHorario: catchAsync(async (req, res) => {
    const horario = await horarioService.updateHorario(req.params.id, req.body);
    return apiResponse.success(res, {
      message: 'Horario actualizado exitosamente',
      data: horario,
    });
  }),

  deleteHorario: catchAsync(async (req, res) => {
    await horarioService.deleteHorario(req.params.id);
    return apiResponse.noContent(res);
  }),

  getHorariosBySede: catchAsync(async (req, res) => {
    const { sedeId } = req.params;
    const horarios = await horarioService.getHorariosBySede(sedeId);
    return apiResponse.success(res, {
      message: 'Horarios por sede obtenidos.',
      data: horarios,
    });
  }),

  getHorariosByLevel: catchAsync(async (req, res) => {
    const { id: alumnoId } = req.user;
    const horarios = await horarioService.getHorariosByLevel(alumnoId);
    return apiResponse.success(res, {
      message: 'Horarios por nivel obtenidos.',
      data: horarios,
    })
  }),

  getDisponibilidad: catchAsync(async (req, res) => {
    const { desde, hasta } = req.query;
    const disponibilidad = await horarioService.getDisponibilidad(req.params.id, desde, hasta);
    return apiResponse.success(res, {
      message: 'Disponibilidad obtenida exitosamente',
      data: disponibilidad,
    });
  })
};
