import { z } from 'zod';

const GRUPOS_SANGUINEOS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

export const actualizarPerfilSchema = z
  .object({
    email: z.string().email('Email inválido').optional(),

    telefono_personal: z
      .string()
      .regex(/^\+?[0-9]{7,15}$/, 'Formato de teléfono inválido')
      .optional(),

    fecha_nacimiento: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)')
      .transform((val) => new Date(val))
      .optional(),
    genero: z
      .enum(['M', 'F'], {
        errorMap: () => ({ message: 'El género debe ser M o F' }),
      })
      .optional(),

    condiciones_medicas: z.string().max(500, 'Máximo 500 caracteres').optional(),

    seguro_medico: z.string().max(100, 'Máximo 100 caracteres').optional(),

    grupo_sanguineo: z
      .enum(GRUPOS_SANGUINEOS, {
        errorMap: () => ({
          message: `Grupo sanguíneo inválido. Permitidos: ${GRUPOS_SANGUINEOS.join(', ')}`,
        }),
      })
      .optional(),

    direccion_completa: z
      .string()
      .min(3, 'La dirección debe tener al menos 3 caracteres')
      .max(255, 'Máximo 255 caracteres')
      .optional(),

    distrito: z
      .string()
      .min(1, 'El distrito no puede estar vacío')
      .max(100, 'Máximo 100 caracteres')
      .optional(),

    ciudad: z.string().max(100, 'Máximo 100 caracteres').optional(),

    referencia: z.string().max(500, 'Máximo 500 caracteres').optional(),

    tipo_documento_id: z.string().max(10, 'Máximo 10 caracteres').optional(),

    numero_documento: z.string().max(20, 'Máximo 20 caracteres').optional(),
  })
  .strict();

// 🔥 NUEVO: contactos de emergencia del alumno (tabla alumnos_contactos)

export const crearContactoSchema = z
  .object({
    nombre_completo: z
      .string()
      .min(3, 'El nombre completo debe tener al menos 3 caracteres')
      .max(150, 'Máximo 150 caracteres'),

    relacion: z
      .string()
      .min(2, 'Indica la relación (ej. Madre, Padre, Tutor)')
      .max(50, 'Máximo 50 caracteres'),

    telefono: z
      .string()
      .regex(/^\+?[0-9]{7,15}$/, 'Formato de teléfono inválido'),

    es_principal: z.boolean().optional(),
  })
  .strict();

/**
 * 🆕 BL-007: formulario de contacto de emergencia (el principal del alumno).
 *
 * nombre_completo y telefono son REQUERIDOS —no opcionales como en
 * actualizarContactoSchema— porque este endpoint también CREA la fila cuando el
 * alumno no tiene contacto principal, y ambas columnas son NOT NULL en BD.
 *
 * es_principal no se acepta a propósito: este endpoint opera por definición
 * sobre el contacto principal. Para gestionar varios contactos están los
 * endpoints de /mi-perfil/contactos.
 */
export const actualizarContactoEmergenciaSchema = z
  .object({
    nombre_completo: z
      .string()
      .min(3, 'El nombre completo debe tener al menos 3 caracteres')
      .max(150, 'Máximo 150 caracteres'),

    relacion: z
      .string()
      .min(2, 'Indica la relación (ej. Madre, Padre, Tutor)')
      .max(50, 'Máximo 50 caracteres')
      .optional(),

    telefono: z
      .string()
      .regex(/^\+?[0-9]{7,15}$/, 'Formato de teléfono inválido'),
  })
  .strict();

export const actualizarContactoSchema = z
  .object({
    nombre_completo: z
      .string()
      .min(3, 'El nombre completo debe tener al menos 3 caracteres')
      .max(150, 'Máximo 150 caracteres')
      .optional(),

    relacion: z
      .string()
      .min(2, 'Indica la relación (ej. Madre, Padre, Tutor)')
      .max(50, 'Máximo 50 caracteres')
      .optional(),

    telefono: z
      .string()
      .regex(/^\+?[0-9]{7,15}$/, 'Formato de teléfono inválido')
      .optional(),

    es_principal: z.boolean().optional(),
  })
  .strict();