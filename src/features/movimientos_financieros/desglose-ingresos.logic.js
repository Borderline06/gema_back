import { CONCEPTO_INGRESO } from '../merch/logic/merch.logic.js';

const centimos = (v) => Math.round(Number(v || 0) * 100);

/**
 * Arma el desglose "Merch vs Matrícula" de un mes a partir de lo cobrado y de las filas
 * automáticas de caja (las que llevan pago_id). Función pura: la consulta vive en el servicio.
 *
 *   merch     = suma de las filas INGRESO_MERCH.
 *   matricula = lo cobrado menos el merch (las filas INGRESO_MATRICULA solo existen para los
 *               pagos MIXTO, así que no sirven como total de matrícula).
 *
 * @param {{ mes: number, anio: number, totalCobrado: number|string, filas: Array }} datos
 *   `filas`: movimientos con `pagos.cuentas_por_cobrar.alumnos.usuarios` incluido.
 */
export const armarDesgloseIngresos = ({ mes, anio, totalCobrado, filas }) => {
  const cobrado = centimos(totalCobrado);
  const merch = filas
    .filter((f) => f.concepto === CONCEPTO_INGRESO.MERCH)
    .reduce((acc, f) => acc + centimos(f.monto), 0);

  return {
    periodo: { mes, anio },
    base: 'fecha_pago',
    total_cobrado: cobrado / 100,
    ingresos_merch: merch / 100,
    ingresos_matricula: Math.max(0, cobrado - merch) / 100,
    movimientos: filas.map((f) => {
      const u = f.pagos?.cuentas_por_cobrar?.alumnos?.usuarios;
      return {
        id: f.id,
        concepto: f.concepto,
        monto: Number(f.monto),
        fecha: f.fecha_movimiento,
        pago_id: f.pago_id,
        tipo_transaccion: f.pagos?.tipo_transaccion ?? null,
        alumno: u ? `${u.nombres} ${u.apellidos}` : 'N/A',
      };
    }),
  };
};
