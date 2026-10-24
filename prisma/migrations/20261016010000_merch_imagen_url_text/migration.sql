-- AlterTable: el frontend envía las imágenes de merch en Base64, que excede VARCHAR(255)
ALTER TABLE "merch" ALTER COLUMN "imagen_url" SET DATA TYPE TEXT;
