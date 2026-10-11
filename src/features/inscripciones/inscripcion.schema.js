import { z } from 'zod';

/**
 * 💰 BL-002: POST /api/inscripciones/individual-admin no tenía NINGUNA
 * validación — el body entraba crudo al service. Un `idHorario` vacío o un
 * `alumno_id` ausente terminaban en un 500 de Prisma, y el viejo `montoTotal`
 * sin validar producía `monto_asignado = NaN` en la tabla puente.
 *
 * El body es un ARRAY de clases a inscribir (una cuenta por clase).
 *
 * ⚠️ `.passthrough()` es DELIBERADO, no un descuido: el frontend sigue
 * enviando `montoTotal` y `.strict()` lo rechazaría con un 400, rompiendo el
 * formulario en producción. El campo se acepta y se IGNORA: el precio lo pone
 * `catalogo_conceptos.precio_base` (CLASE_UNITARIA_2026).
 */
export const inscribirIndividualAdminSchema = z
  .array(
    z
      .object({
        alumno_id: z.coerce
          .number({ invalid_type_error: 'alumno_id debe ser numérico' })
          .int('alumno_id debe ser un entero')
          .positive('alumno_id debe ser mayor a 0'),

        idHorario: z.coerce
          .number({ invalid_type_error: 'idHorario debe ser numérico' })
          .int('idHorario debe ser un entero')
          .positive('idHorario debe ser mayor a 0'),

        fecha_inicio_electiva: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)')
          .optional(),

        metodo_pago: z.coerce
          .number({ invalid_type_error: 'metodo_pago debe ser numérico' })
          .int('metodo_pago debe ser un entero')
          .positive('metodo_pago debe ser mayor a 0'),

        usuario_admin_id: z.coerce
          .number({ invalid_type_error: 'usuario_admin_id debe ser numérico' })
          .int('usuario_admin_id debe ser un entero')
          .positive('usuario_admin_id debe ser mayor a 0'),
      })
      .passthrough()
  )
  .min(1, 'Se requiere al menos una clase para inscribir');
