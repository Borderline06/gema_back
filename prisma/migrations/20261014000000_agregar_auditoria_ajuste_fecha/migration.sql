-- CreateTable
CREATE TABLE "auditoria_ajuste_fecha" (
    "id" SERIAL NOT NULL,
    "cuenta_id" INTEGER NOT NULL,
    "fecha_anterior" DATE NOT NULL,
    "fecha_nueva" DATE NOT NULL,
    "clases_eliminadas" INTEGER NOT NULL,
    "clases_generadas" INTEGER NOT NULL,
    "motivo" TEXT,
    "realizado_por" INTEGER NOT NULL,
    "realizado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_ajuste_fecha_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auditoria_ajuste_fecha_cuenta_id_idx" ON "auditoria_ajuste_fecha"("cuenta_id");

-- AddForeignKey
ALTER TABLE "auditoria_ajuste_fecha" ADD CONSTRAINT "auditoria_ajuste_fecha_cuenta_id_fkey" FOREIGN KEY ("cuenta_id") REFERENCES "cuentas_por_cobrar"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auditoria_ajuste_fecha" ADD CONSTRAINT "auditoria_ajuste_fecha_realizado_por_fkey" FOREIGN KEY ("realizado_por") REFERENCES "usuarios"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
