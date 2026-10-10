// =================================================================
// 🎯 BL-001: fuente única de verdad de "¿qué tipo de inscripción es esta?"
//
// inscripciones.tipo_inscripcion es `String? @default("REGULAR")`: es NULLABLE
// y no tiene enum en Prisma (el comentario del schema dice 'REGULAR' o
// 'INDIVIDUAL'). Todas las filas creadas antes de la migración
// 20260625031213_feature_clases_sueltas_caja lo tienen en NULL.
//
// 🚩 REGLA DE NEGOCIO (BL-001): NULL se asume REGULAR.
//
// Antes de este archivo, el único punto del backend que ramificaba por el campo
// era pagos.service.js (comparación estricta contra el string 'INDIVIDUAL'), y
// horario.service.js lo filtraba con una igualdad estricta a 'REGULAR' que
// dejaba fuera a todas las filas legacy en NULL.
//
// ⚠️ Este módulo NO importa NADA a propósito. inscripcion.service.js y
// pagos.service.js se importan mutuamente, así que cualquier helper que ambos
// necesiten tiene que vivir en un módulo sin dependencias de dominio para no
// cerrar el ciclo de imports.
// =================================================================

export const TIPO_INSCRIPCION = Object.freeze({
  REGULAR: 'REGULAR',
  INDIVIDUAL: 'INDIVIDUAL',
});

/**
 * Normaliza a uno de los dos tipos válidos.
 *
 * Acepta un string, un objeto inscripción completo, null o undefined. Cualquier
 * valor que no sea exactamente INDIVIDUAL (incluidos NULL, '', minúsculas y
 * typos) cae a REGULAR, que es la regla de negocio de BL-001.
 *
 * @param {string|{tipo_inscripcion?: string|null}|null|undefined} valor
 * @returns {'REGULAR'|'INDIVIDUAL'}
 */
export const normalizarTipoInscripcion = (valor) => {
  const bruto = typeof valor === 'string' ? valor : valor?.tipo_inscripcion;
  if (typeof bruto !== 'string') return TIPO_INSCRIPCION.REGULAR;

  return bruto.trim().toUpperCase() === TIPO_INSCRIPCION.INDIVIDUAL
    ? TIPO_INSCRIPCION.INDIVIDUAL
    : TIPO_INSCRIPCION.REGULAR;
};

/**
 * ¿Es una clase suelta? Acepta el objeto inscripción completo o el string.
 */
export const esIndividual = (inscripcionOTipo) =>
  normalizarTipoInscripcion(inscripcionOTipo) === TIPO_INSCRIPCION.INDIVIDUAL;

/**
 * ¿Es una membresía mensual? NULL cuenta como REGULAR.
 */
export const esRegular = (inscripcionOTipo) => !esIndividual(inscripcionOTipo);

/**
 * Fragmento de `where` de Prisma, pensado para spread dentro de un where
 * existente:
 *
 *   where: { estado: 'ACTIVO', ...whereTipoInscripcion(TIPO_INSCRIPCION.REGULAR) }
 *
 * ⚠️ NO usar `{ tipo_inscripcion: { not: 'INDIVIDUAL' } }` a secas: en SQL
 * `NULL <> 'INDIVIDUAL'` evalúa a NULL (no a TRUE), así que ese filtro
 * descartaría en silencio TODAS las filas legacy sin tipo — justo las que
 * BL-001 manda tratar como REGULAR. De ahí el OR explícito con `null`.
 *
 * ⚠️ El fragmento de REGULAR ocupa la clave `OR`. Si algún día hay que
 * aplicarlo sobre un `where` que YA trae un `OR` propio, hay que envolver ambos
 * en `AND: [...]` o uno sobrescribirá al otro. Verificado al introducirlo:
 * ninguno de los call sites actuales tiene `OR` previo.
 */
export const whereTipoInscripcion = (tipo) => {
  if (normalizarTipoInscripcion(tipo) === TIPO_INSCRIPCION.INDIVIDUAL) {
    return { tipo_inscripcion: TIPO_INSCRIPCION.INDIVIDUAL };
  }

  return {
    OR: [
      { tipo_inscripcion: null },
      { tipo_inscripcion: { not: TIPO_INSCRIPCION.INDIVIDUAL } },
    ],
  };
};
