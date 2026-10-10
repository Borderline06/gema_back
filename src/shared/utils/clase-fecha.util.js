// =================================================================
// 📅 BL-003: aritmética de las fechas en que cae una clase.
//
// `calcularProximasFechas` vivía como `const` privado en
// asistencia.service.js y era la ÚNICA definición de "¿en qué día cae
// realmente la clase?". BL-003 necesita esa respuesta ANTES de crear la
// inscripción (para validar feriado y aforo de esa fecha puntual), así que
// tenía que salir de ahí. Se mueve tal cual, sin duplicarla: una segunda copia
// divergiría y la fecha validada dejaría de ser la fecha generada, que es el
// peor fallo posible acá (cobrar por un día y agendar otro).
//
// ⚠️ Deliberadamente NO vive en ciclo.util.js: ese archivo declara en su
// cabecera el invariante "acá todo se hace en UTC", y esta aritmética es
// intencionalmente en hora LOCAL del server (`setHours`, no `setUTCHours`).
//
// ⚠️ NO reescribir a UTC. registros_asistencia.fecha es @db.Date y todas las
// filas históricas se escribieron con esta aritmética local; cambiarla puede
// desplazar un día las fechas generadas según la TZ del server, lo que tocaría
// el @@unique([inscripcion_id, fecha]), las recuperaciones y las
// reprogramaciones. El ancla a mediodía ya tolera ±12h de offset.
// =================================================================

/**
 * Ventana de la clase suelta: 7 días.
 *
 * Es el `+6` inclusivo que ya usaba `generarClaseUnica`, elegido para que haya
 * exactamente UNA ocurrencia del día de semana pedido dentro del rango.
 */
export const DIAS_VENTANA_INDIVIDUAL = 7;

/**
 * Función auxiliar para calcular fechas DENTRO DE UN RANGO (Dinámico) 📅
 * Garantiza que la primera clase sea IGUAL o POSTERIOR a la fecha de inicio.
 */
export const calcularProximasFechas = (fechaInicio, diaSemanaClase, fechaLimite) => {
  const fechas = [];
  const fechaActual = new Date(fechaInicio);
  const diaSemanaNormalizado = diaSemanaClase === 7 ? 0 : Number(diaSemanaClase);

  if (!Number.isInteger(diaSemanaNormalizado) || diaSemanaNormalizado < 0 || diaSemanaNormalizado > 6) {
    throw new Error(`Dia de semana invalido para generar clases: ${diaSemanaClase}`);
  }

  // 🔥 CORRECCIÓN DE ZONA HORARIA (Mediodía para evitar saltos de día)
  fechaActual.setHours(12, 0, 0, 0);

  const limiteFijo = new Date(fechaLimite);
  limiteFijo.setHours(12, 0, 0, 0);

  // 1. Buscamos el primer día de clase válido que sea >= fechaInicio
  // Si la fechaInicio ya coincide con diaSemanaClase, se queda ahí.
  const diasHastaPrimeraClase = (diaSemanaNormalizado - fechaActual.getDay() + 7) % 7;
  fechaActual.setDate(fechaActual.getDate() + diasHastaPrimeraClase);

  // 2. Generamos fechas MIENTRAS no superemos el límite de los 30 días
  // Importante: Si la primera fecha encontrada ya se pasó del límite, no agrega nada.
  while (fechaActual <= limiteFijo) {
    fechas.push(new Date(fechaActual));
    fechaActual.setDate(fechaActual.getDate() + 7);
  }

  return fechas;
};

/**
 * 🎯 BL-003: resuelve la ÚNICA fecha de una clase suelta, o null si no hay
 * ninguna dentro de la ventana.
 *
 * 🔒 Se implementa reusando `calcularProximasFechas` con la MISMA ventana que
 * `generarClaseUnica`, para que la fecha que `inscribirIndividual` valida
 * (feriado + aforo) sea POR CONSTRUCCIÓN la misma que se insertará después,
 * cuando `validarPago` llame a `generarClaseUnica` con
 * `fecha_inicio: insc.fecha_inscripcion`. Si se calculara con otra ventana,
 * validación y generación podrían discrepar.
 *
 * @returns {Date|null}
 */
export const calcularPrimeraFechaClase = (fechaInicio, diaSemanaClase) => {
  const inicio = new Date(fechaInicio);
  if (Number.isNaN(inicio.getTime())) return null;

  const limite = new Date(inicio);
  limite.setDate(limite.getDate() + (DIAS_VENTANA_INDIVIDUAL - 1));

  return calcularProximasFechas(inicio, diaSemanaClase, limite)[0] ?? null;
};
