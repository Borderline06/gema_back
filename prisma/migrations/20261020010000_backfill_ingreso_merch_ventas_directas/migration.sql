-- Regulariza la caja de auditoría: las ventas de merch ya aprobadas (taquilla y órdenes de
-- alumno, tipo_transaccion = 'MERCH') no dejaron fila en movimientos_financieros porque
-- ese registro se agregó después. Solo INSERTA; no toca pagos ni filas existentes.
--
-- Todo el monto de un pago MERCH es merch, así que la fila lleva el monto completo. Las filas
-- llevan pago_id, por lo que el balance las excluye y no se cuentan dos veces. Es idempotente:
-- NOT EXISTS evita duplicar un pago que ya tenga su INGRESO_MERCH.
-- (Los pagos MIXTO históricos no se regularizan aquí: su reparto merch/matrícula depende de
-- los abonos de cada cuenta y se calcula desde la aplicación.)
INSERT INTO "movimientos_financieros"
  ("tipo_movimiento", "monto", "concepto", "metodo_pago_id", "fecha_movimiento", "registrado_por", "notas", "pago_id")
SELECT
  'INGRESO',
  p."monto_pagado",
  'INGRESO_MERCH',
  p."metodo_pago_id",
  COALESCE(p."fecha_pago", NOW()),
  p."revisado_por",
  'Pago #' || p."id" || ' · cuenta #' || p."cuenta_id" || ' (MERCH) · regularizado',
  p."id"
FROM "pagos" p
WHERE p."estado_validacion" = 'APROBADO'
  AND p."tipo_transaccion" = 'MERCH'
  AND p."monto_pagado" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "movimientos_financieros" m
    WHERE m."pago_id" = p."id" AND m."concepto" = 'INGRESO_MERCH'
  );
