-- DropForeignKey
ALTER TABLE "notificaciones" DROP CONSTRAINT "notificaciones_usuario_id_fkey";

-- AlterTable
ALTER TABLE "notificaciones" DROP COLUMN "usuario_id";
