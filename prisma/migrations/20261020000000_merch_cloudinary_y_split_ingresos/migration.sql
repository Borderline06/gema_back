-- Imágenes de merch en Cloudinary: se guarda el public_id para poder borrar el asset
-- cuando el producto se elimina o cambia de foto. Las filas existentes (Base64) quedan en NULL.
ALTER TABLE "merch" ADD COLUMN "imagen_public_id" VARCHAR(255);

-- Split de ingresos: las filas INGRESO_MERCH / INGRESO_MATRICULA que genera la aprobación de
-- un pago apuntan a ese pago. NULL = movimiento manual de caja (todas las filas existentes).
-- Si el pago se borra, caen sus filas automáticas (no deben quedar como si fueran manuales).
ALTER TABLE "movimientos_financieros" ADD COLUMN "pago_id" INTEGER;

ALTER TABLE "movimientos_financieros" ADD CONSTRAINT "movimientos_financieros_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "movimientos_financieros_pago_id_idx" ON "movimientos_financieros"("pago_id");

-- Un pago no puede registrar dos veces el mismo concepto (NULL no choca: los manuales no cuentan).
CREATE UNIQUE INDEX "movimientos_financieros_pago_id_concepto_key" ON "movimientos_financieros"("pago_id", "concepto");
