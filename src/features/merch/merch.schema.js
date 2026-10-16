import z from 'zod';

const idPositivo = (nombre) =>
  z.coerce
    .number({ invalid_type_error: `${nombre} debe ser numérico` })
    .int(`${nombre} debe ser un entero`)
    .positive(`${nombre} debe ser mayor a 0`);

const productoBase = {
  nombre: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(150),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  precio: z.coerce
    .number({ invalid_type_error: 'El precio debe ser numérico' })
    .nonnegative('El precio no puede ser negativo')
    .max(99999999, 'Precio fuera de rango'),
  imagen_url: z.string().trim().max(255).nullable().optional(),
  stock: z.coerce.number().int('El stock debe ser un entero').nonnegative('El stock no puede ser negativo'),
  estado: z.enum(['ACTIVO', 'INACTIVO']),
};

export const merchSchema = {
  createMerchSchema: z.object({
    ...productoBase,
    stock: productoBase.stock.default(0),
    estado: productoBase.estado.default('ACTIVO'),
  }),

  updateMerchSchema: z
    .object({
      nombre: productoBase.nombre.optional(),
      descripcion: productoBase.descripcion,
      precio: productoBase.precio.optional(),
      imagen_url: productoBase.imagen_url,
      stock: productoBase.stock.optional(),
      estado: productoBase.estado.optional(),
    })
    .refine((d) => Object.keys(d).length > 0, {
      message: 'Debe proporcionar al menos un campo para actualizar',
    }),

  comprarSchema: z.object({
    alumno_id: idPositivo('alumno_id'),
    merch_ids: z
      .array(idPositivo('merch_ids'), { required_error: 'merch_ids es requerido' })
      .min(1, 'Debes indicar al menos un producto')
      .max(50, 'Demasiadas unidades en una sola compra'),
    metodo_pago_id: idPositivo('metodo_pago_id'),
    codigo_operacion: z.string().trim().max(50).optional(),
    notas: z.string().trim().max(200).optional(),
  }),

  estadoItemSchema: z.object({
    estado_item: z.enum(['POSEE', 'PERDIDO', 'DEVUELTO'], {
      errorMap: () => ({ message: 'estado_item debe ser POSEE, PERDIDO o DEVUELTO' }),
    }),
  }),

  idParamSchema: z.object({
    id: z
      .string()
      .regex(/^\d+$/, 'El ID debe ser un número')
      .transform((v) => parseInt(v, 10))
      .refine((v) => v > 0, 'El ID debe ser mayor a 0'),
  }),

  catalogoQuerySchema: z.object({
    incluir_inactivos: z.preprocess(
      (v) => v === 'true' || v === true,
      z.boolean().optional()
    ),
  }),

  metricasQuerySchema: z.object({
    desde: z.coerce.date().optional(),
    hasta: z.coerce.date().optional(),
  }),
};
