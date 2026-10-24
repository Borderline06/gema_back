import { z } from 'zod';

export const asistenciaSchema = {
  alumnoIdParamSchema: z.object({
    alumnoId: z
      .string()
      .regex(/^\d+$/, 'El ID del alumno debe ser un número')
      .transform((val) => parseInt(val, 10))
      .refine((val) => val > 0, 'El ID del alumno debe ser mayor a 0'),
  }),

  agendaQuerySchema: z.object({
    fecha: z
      .string()
      .datetime()
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .optional(),
  }),

  // 🤝 BL-010: query de la alerta previa de choques con recuperaciones.
  // `fecha_inicio` es opcional: sin ella se simula el ciclo desde la
  // fecha_inscripcion actual; con ella, desde la que el admin va a confirmar al
  // validar el pago (BL-006). El formato final lo revalida
  // parsearFechaInicioCiclo en el service (que además rechaza fechas imposibles
  // como 2026-02-30, que este regex sí dejaría pasar).
  choquesRecuperacionQuerySchema: z.object({
    inscripcion_id: z
      .string()
      .regex(/^\d+$/, 'El ID de la inscripción debe ser un número')
      .transform((val) => parseInt(val, 10))
      .refine((val) => val > 0, 'El ID de la inscripción debe ser mayor a 0'),
    fecha_inicio: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha_inicio debe tener formato YYYY-MM-DD')
      .optional(),
  }),

  masivaSchema: z.object({
    asistencias: z
      .array(
        z.object({
          id: z.union([z.number(), z.string().regex(/^reg-asis-recu-\d+$/)]),
          estado: z.enum(['PRESENTE', 'FALTA', 'PROGRAMADA', 'JUSTIFICADO_LESION', 'SIN_REGISTRO',]),
          comentario: z.string().max(255).optional().nullable(),
        })
      )
      .min(1, 'El listado de asistencias no puede estar vacío'),
  }),
};
