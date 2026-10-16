// BL-004: helpers puros de la renovación desde el expediente histórico.

/** Estados que ocupan lugar o están en curso (no terminales). */
export const ESTADOS_EN_CURSO = ['ACTIVO', 'PENDIENTE_PAGO', 'POR_VALIDAR', 'VENCIDO'];

/** Un paquete está finalizado si TIENE inscripciones y TODAS están FINALIZADO. */
export const esPaqueteFinalizado = (estados) =>
  Array.isArray(estados) && estados.length > 0 && estados.every((e) => e === 'FINALIZADO');

/**
 * Hay inscripción activa equivalente si el alumno ya tiene en curso (no
 * terminal) TODOS los horarios del paquete histórico.
 */
export const existeInscripcionEquivalente = (horarioIdsHistoricos, inscripcionesEnCurso) => {
  if (!horarioIdsHistoricos?.length) return false;
  const enCurso = new Set(
    (inscripcionesEnCurso ?? []).filter((i) => ESTADOS_EN_CURSO.includes(i.estado)).map((i) => i.horario_id)
  );
  return horarioIdsHistoricos.every((id) => enCurso.has(id));
};

/**
 * Concepto vigente equivalente: entre los candidatos (activo + es_vigente) con
 * la misma cantidad de clases/semana, prefiere el mismo codigo_interno.
 */
export const elegirConceptoVigente = (candidatos, conceptoHistorico, cantidadClases) => {
  const cantidad = cantidadClases ?? conceptoHistorico?.cantidad_clases_semanal;
  const validos = (candidatos ?? []).filter(
    (c) => c.activo && c.es_vigente && c.cantidad_clases_semanal === cantidad
  );
  if (validos.length === 0) return null;
  return validos.find((c) => conceptoHistorico && c.codigo_interno === conceptoHistorico.codigo_interno) ?? validos[0];
};

/** Alternativas: mismo nivel, activas y con cupo; las del mismo día primero. */
export const ordenarAlternativas = (candidatos, diaSemanaOriginal) =>
  [...candidatos].sort(
    (a, b) => Number(b.dia_semana === diaSemanaOriginal) - Number(a.dia_semana === diaSemanaOriginal)
  );
