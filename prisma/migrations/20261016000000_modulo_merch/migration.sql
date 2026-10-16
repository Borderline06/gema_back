-- AlterTable: etiqueta de la transacción para aislar métricas (aditivo; los pagos existentes quedan como MATRICULA)
ALTER TABLE "pagos" ADD COLUMN "tipo_transaccion" VARCHAR(20) NOT NULL DEFAULT 'MATRICULA';

-- CreateTable
CREATE TABLE "merch" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "descripcion" TEXT,
    "precio" DECIMAL(10,2) NOT NULL,
    "imagen_url" VARCHAR(255),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "estado" VARCHAR(10) NOT NULL DEFAULT 'ACTIVO',
    "creado_en" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alumno_merch" (
    "id" SERIAL NOT NULL,
    "alumno_id" INTEGER NOT NULL,
    "merch_id" INTEGER NOT NULL,
    "cuenta_id" INTEGER,
    "pago_id" INTEGER,
    "fecha_adquisicion" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monto_pagado" DECIMAL(10,2) NOT NULL,
    "estado_item" VARCHAR(15) NOT NULL DEFAULT 'POSEE',

    CONSTRAINT "alumno_merch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pagos_tipo_transaccion_idx" ON "pagos"("tipo_transaccion");

-- CreateIndex
CREATE INDEX "alumno_merch_alumno_id_idx" ON "alumno_merch"("alumno_id");

-- CreateIndex
CREATE INDEX "alumno_merch_cuenta_id_idx" ON "alumno_merch"("cuenta_id");

-- AddForeignKey
ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_alumno_id_fkey" FOREIGN KEY ("alumno_id") REFERENCES "alumnos"("usuario_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_merch_id_fkey" FOREIGN KEY ("merch_id") REFERENCES "merch"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_cuenta_id_fkey" FOREIGN KEY ("cuenta_id") REFERENCES "cuentas_por_cobrar"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
