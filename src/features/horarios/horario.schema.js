import { z } from 'zod';

const coercePositiveInt = (label) =>
  z.coerce
    .number({ invalid_type_error: `${label} debe ser numérico` })
    .int(`${label} debe ser entero`)
    .positive(`${label} debe ser positivo`);

const nullableCoercePositiveInt = (label) =>
  z.preprocess(
    (val) => (val === null || val === "" || val === undefined ? null : val),
    z.coerce
      .number({ invalid_type_error: `${label} debe ser numérico` })
      .int(`${label} debe ser entero`)
      .positive(`${label} debe ser positivo`)
      .nullable() // Permite NULL al final
  );

const horaRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

// 🎯 BL-003: tope del rango consultable en /disponibilidad (evita barridos).
export const MAX_DIAS_DISPONIBILIDAD = 92;
const MS_POR_DIA = 86400000;

// 'YYYY-MM-DD' real. El round-trip rechaza fechas imposibles ('2026-02-30'),
// que `new Date` desbordaría en silencio al mes siguiente.
const fechaISO = (label) =>
  z
    .string({ required_error: `${label} es obligatorio` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} debe tener formato YYYY-MM-DD`)
    .refine((v) => {
      const d = new Date(`${v}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }, `${label} no es una fecha válida`);

export const horarioSchema = {
  createHorarioSchema: z.object({
    cancha_id: coercePositiveInt('ID de cancha'),
    coordinador_id: nullableCoercePositiveInt('ID de coordinador').optional(),
    nivel_id: coercePositiveInt('ID de nivel'),
    dia_semana: z.coerce
      .number({ invalid_type_error: 'Día de la semana debe ser numérico' })
      .int()
      .min(1, 'Día de la semana debe estar entre 1 (Lunes) y 7 (Domingo)')
      .max(7, 'Día de la semana debe estar entre 1 (Lunes) y 7 (Domingo)'),
    hora_inicio: z.string().regex(horaRegex, 'Formato de hora de inicio inválido (HH:MM)'),
    hora_fin: z.string().regex(horaRegex, 'Formato de hora de fin inválido (HH:MM)'),
    capacidad_max: coercePositiveInt('Capacidad máxima').optional().default(20),
    minutos_reserva_especifico: z.coerce
      .number()
      .int()
      .nonnegative('Minutos de reserva no pueden ser negativos')
      .nullable()
      .optional(),
  }),

  updateHorarioSchema: z
    .object({
      cancha_id: coercePositiveInt('ID de cancha').optional(),
      coordinador_id: nullableCoercePositiveInt('ID de coordinador').optional(),
      nivel_id: coercePositiveInt('ID de nivel').optional(),
      dia_semana: z.coerce.number().int().min(1).max(7).optional(),
      hora_inicio: z.string().regex(horaRegex, 'Formato inválido (HH:MM)').optional(),
      hora_fin: z.string().regex(horaRegex, 'Formato inválido (HH:MM)').optional(),
      capacidad_max: coercePositiveInt('Capacidad máxima').optional(),
      minutos_reserva_especifico: z.coerce.number().int().nonnegative().nullable().optional(),
      activo: z.boolean().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'Debe proporcionar al menos un campo para actualizar',
    }),

  disponibilidadQuerySchema: z
    .object({
      desde: fechaISO('desde'),
      hasta: fechaISO('hasta'),
    })
    .superRefine((q, ctx) => {
      // Solo se compara si ambas pasaron su validación individual.
      const ini = new Date(`${q.desde}T00:00:00.000Z`).getTime();
      const fin = new Date(`${q.hasta}T00:00:00.000Z`).getTime();
      if (fin < ini) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hasta'],
          message: 'hasta debe ser igual o posterior a desde',
        });
      } else if ((fin - ini) / MS_POR_DIA + 1 > MAX_DIAS_DISPONIBILIDAD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hasta'],
          message: `El rango no puede superar ${MAX_DIAS_DISPONIBILIDAD} días`,
        });
      }
    }),

  idParamSchema: z.object({
    id: z
      .string()
      .regex(/^\d+$/, 'El ID debe ser un número')
      .transform((val) => parseInt(val, 10))
      .refine((val) => val > 0, 'El ID debe ser mayor a 0'),
  }),
};
