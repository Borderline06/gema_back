-- Quien marca un ítem listo / entregado / revertido puede ser un Coordinador de recepción,
-- que no existe en la tabla "administrador": la FK debe apuntar a "usuarios".
ALTER TABLE "alumno_merch" DROP CONSTRAINT "alumno_merch_gestionado_por_fkey";

ALTER TABLE "alumno_merch" ADD CONSTRAINT "alumno_merch_gestionado_por_fkey" FOREIGN KEY ("gestionado_por") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
