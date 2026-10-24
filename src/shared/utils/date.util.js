/**
 * Formatea una fecha a string en español (DD/MM/YYYY).
 * @param {Date} date - Objeto Date a formatear.
 * @returns {string} Fecha formateada.
 */
export const formatFechaEs = (date) => {
  if (!date || Number.isNaN(new Date(date).getTime())) return 'N/A';
  const d = new Date(date);
  const day = d.getUTCDate().toString().padStart(2, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
};

/**
 * 🕒 Hora 'HH:mm' de una columna @db.Time(6).
 *
 * Prisma entrega un `Time` como Date del 01/01/1970 con la hora en UTC, así que
 * la lectura correcta es con getters UTC: con getters locales la hora se corre
 * 5 h en Lima. Esta aritmética estaba copiada inline en cuatro sitios
 * (clase.service.js:518-520 y :96-102, asistencia.service.js:428-430,
 * clase.controller — formatTime); acá queda una sola definición para el código
 * nuevo. ⚠️ Los cuatro llamadores viejos se dejan intactos a propósito: migrarlos
 * es un refactor aparte y cualquier desfase ahí movería horas ya mostradas.
 *
 * @param {Date|null|undefined} time valor de una columna @db.Time(6)
 * @returns {string} 'HH:mm', o '--:--' si no hay valor válido
 */
export const formatHoraUTC = (time) => {
  if (!time) return '--:--';
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return '--:--';
  const horas = d.getUTCHours().toString().padStart(2, '0');
  const minutos = d.getUTCMinutes().toString().padStart(2, '0');
  return `${horas}:${minutos}`;
};
