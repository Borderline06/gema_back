-- AlterTable: 'LISTO_PARA_RECOJO' (17 caracteres) no cabe en VARCHAR(15); además un ítem
-- sin pagar nace RESERVADO (antes el default era POSEE).
ALTER TABLE "alumno_merch" ALTER COLUMN "estado_item" SET DATA TYPE VARCHAR(20);
ALTER TABLE "alumno_merch" ALTER COLUMN "estado_item" SET DEFAULT 'RESERVADO';

-- AlterTable: logística física (sede de recojo + trazabilidad de quién lo movió y cuándo)
ALTER TABLE "alumno_merch" ADD COLUMN "sede_recojo_id" INTEGER;
ALTER TABLE "alumno_merch" ADD COLUMN "fecha_listo" TIMESTAMP(6);
ALTER TABLE "alumno_merch" ADD COLUMN "fecha_entrega" TIMESTAMP(6);
ALTER TABLE "alumno_merch" ADD COLUMN "gestionado_por" INTEGER;

-- POSEE significaba "lo tiene el alumno" antes de existir la logística: equivale a ENTREGADO.
UPDATE "alumno_merch"
SET "estado_item" = 'ENTREGADO', "fecha_entrega" = "fecha_adquisicion"
WHERE "estado_item" = 'POSEE';

-- CreateIndex
CREATE INDEX "alumno_merch_estado_item_sede_recojo_id_idx" ON "alumno_merch"("estado_item", "sede_recojo_id");

-- AddForeignKey
ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_sede_recojo_id_fkey" FOREIGN KEY ("sede_recojo_id") REFERENCES "sedes"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_gestionado_por_fkey" FOREIGN KEY ("gestionado_por") REFERENCES "administrador"("usuario_id") ON DELETE SET NULL ON UPDATE NO ACTION;
