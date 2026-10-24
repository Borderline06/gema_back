import z from 'zod';

const idPositivo = (nombre) =>
  z.coerce
    .number({ invalid_type_error: `${nombre} debe ser numérico` })
    .int(`${nombre} debe ser un entero`)
    .positive(`${nombre} debe ser mayor a 0`);

// imagen_url admite una URL o una imagen en Base64 (data URI): columna TEXT, sin tope de 255.
// El techo es solo un guardarraíl (~7.5 MB de imagen) que va por debajo del límite del body.
// El camino normal es el archivo multipart (campo `imagen`), que se sube a Cloudinary; el
// Base64 por JSON se conserva como fallback para clientes viejos.
const MAX_IMAGEN_CHARS = 10_000_000;

// En multipart todo llega como string: un campo vacío significa "sin valor".
const vacioANull = (v) => (v === '' ? null : v);

// "true"/"false" de multipart (o un booleano de JSON); ausente sigue siendo ausente.
const booleanoOpcional = (v) => (v === undefined ? undefined : v === true || v === 'true');

const productoBase = {
  nombre: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(150),
  descripcion: z.preprocess(vacioANull, z.string().trim().max(2000).nullable().optional()),
  precio: z.coerce
    .number({ invalid_type_error: 'El precio debe ser numérico' })
    .nonnegative('El precio no puede ser negativo')
    .max(99999999, 'Precio fuera de rango'),
  imagen_url: z.preprocess(
    vacioANull,
    z.string().trim().max(MAX_IMAGEN_CHARS, 'La imagen es demasiado grande').nullable().optional()
  ),
  stock: z.coerce.number().int('El stock debe ser un entero').nonnegative('El stock no puede ser negativo'),
  estado: z.enum(['ACTIVO', 'INACTIVO']),
};

export const merchSchema = {
  createMerchSchema: z.object({
    ...productoBase,
    stock: productoBase.stock.default(0),
    estado: productoBase.estado.default('ACTIVO'),
  }),

  // Sin `.refine` de "al menos un campo": una petición con solo la foto trae el archivo en
  // `req.file` y el body vacío. El servicio rechaza (400) si no llega ni campos ni archivo.
  updateMerchSchema: z.object({
    nombre: productoBase.nombre.optional(),
    descripcion: productoBase.descripcion,
    precio: productoBase.precio.optional(),
    imagen_url: productoBase.imagen_url,
    stock: productoBase.stock.optional(),
    estado: productoBase.estado.optional(),
    // Quita la foto actual (y la borra de Cloudinary) sin subir otra.
    eliminar_imagen: z.preprocess(booleanoOpcional, z.boolean().optional()),
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
    // Opcional en taquilla (se puede entregar en el acto); si viene, se valida la sede.
    sede_recojo_id: idPositivo('sede_recojo_id').optional(),
  }),

  ordenSchema: z.object({
    alumno_id: idPositivo('alumno_id'),
    merch_ids: z
      .array(idPositivo('merch_ids'), { required_error: 'merch_ids es requerido' })
      .min(1, 'Debes indicar al menos un producto')
      .max(50, 'Demasiadas unidades en una sola orden'),
    // Dónde recogerá el pedido: la academia lo prepara y lo envía a esa sede.
    sede_recojo_id: idPositivo('sede_recojo_id'),
  }),

  // Correcciones manuales. Listo/entregado tienen sus propios endpoints de logística;
  // POSEE es el nombre viejo de ENTREGADO y se sigue aceptando.
  estadoItemSchema: z.object({
    estado_item: z.enum(['ENTREGADO', 'POSEE', 'PERDIDO', 'DEVUELTO'], {
      errorMap: () => ({ message: 'estado_item debe ser ENTREGADO, PERDIDO o DEVUELTO' }),
    }),
  }),

  logisticaQuerySchema: z.object({
    // "POR_ENTREGAR,LISTO_PARA_RECOJO" (por defecto lo pendiente de entregar)
    estado: z
      .string()
      .transform((v) => v.split(',').map((e) => e.trim().toUpperCase()).filter(Boolean))
      .pipe(
        z.array(
          z.enum(['POR_ENTREGAR', 'LISTO_PARA_RECOJO', 'ENTREGADO', 'PERDIDO', 'DEVUELTO'], {
            errorMap: () => ({ message: 'estado inválido' }),
          })
        )
      )
      .optional(),
    sede_id: idPositivo('sede_id').optional(),
    // Nombre, apellido o DNI del alumno (cada palabra debe coincidir).
    busqueda: z.string().trim().max(100).optional(),
  }),

  // Cuerpo opcional de /logistica/:id/listo: marcar varias unidades con UN solo aviso.
  listoBodySchema: z
    .object({
      item_ids: z.array(idPositivo('item_ids')).max(50).optional(),
      incluir_orden: z.boolean().optional(),
    })
    .default({}),

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
