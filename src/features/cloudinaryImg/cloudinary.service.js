import { cloudinary } from '../../config/cloudinary.config.js';
import { ApiError } from '../../shared/utils/error.util.js';

/**
 * Inserta una transformación de entrega en una URL de Cloudinary:
 *   .../image/upload/v123/merch/a.jpg  ->  .../image/upload/f_auto,q_auto/v123/merch/a.jpg
 * `f_auto` sirve WebP/AVIF a los navegadores que lo soportan y `q_auto` ajusta la calidad, sin
 * tocar el archivo guardado. Una URL que no sea de Cloudinary o que ya traiga transformación
 * se devuelve igual.
 */
export const aplicarEntrega = (url, transformacion) => {
  if (!url || !transformacion) return url;
  const marca = '/image/upload/';
  const i = url.indexOf(marca);
  if (i === -1) return url;
  const resto = url.slice(i + marca.length);
  // Si lo siguiente no es la versión (v123/) ni la carpeta, ya hay una transformación puesta.
  if (resto.startsWith(`${transformacion}/`)) return url;
  return `${url.slice(0, i + marca.length)}${transformacion}/${resto}`;
};

export const cloudinaryService = {
  /**
   * @param {object} fileObject archivo de multer (en memoria)
   * @param {string} folderName carpeta en Cloudinary
   * @param {object} [opciones]
   * @param {object|object[]} [opciones.transformation] transformación al SUBIR: lo que se guarda
   *   ya viene reducido (se descarta el original pesado).
   * @param {string} [opciones.entrega] transformación al SERVIR (p. ej. 'f_auto,q_auto'): se
   *   incluye en la URL devuelta.
   */
  upload: async (fileObject, folderName, { transformation, entrega } = {}) => {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: folderName,
          public_id: `${Date.now()}_${fileObject.originalname.replace(/\.[^/.]+$/, '')}`,
          ...(transformation && { transformation }),
        },
        (error, result) => {
          if (error) {
            reject(new ApiError('Error al subir imagen a Cloudinary', 500));
          } else {
            resolve({
              url: aplicarEntrega(result.secure_url, entrega),
              publicId: result.public_id,
              format: result.format,
              width: result.width,
              height: result.height,
              bytes: result.bytes,
            });
          }
        }
      );

      uploadStream.end(fileObject.buffer);
    });
  },

  /**
   * Borra un asset por su public_id. Es "mejor esfuerzo": un asset que no se pudo borrar
   * es basura en la nube, no un motivo para fallar la operación de negocio que ya se hizo.
   * Devuelve true si Cloudinary lo borró (o ya no existía).
   */
  destroy: async (publicId) => {
    if (!publicId) return false;
    try {
      const { result } = await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
        invalidate: true,
      });
      return result === 'ok' || result === 'not found';
    } catch (error) {
      console.error(`[cloudinary] No se pudo borrar "${publicId}":`, error?.message ?? error);
      return false;
    }
  },
};
