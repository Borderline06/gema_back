import { cloudinary } from '../../config/cloudinary.config.js';
import { ApiError } from '../../shared/utils/error.util.js';

export const cloudinaryService = {
  upload: async (fileObject, folderName) => {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: folderName,
          public_id: `${Date.now()}_${fileObject.originalname.replace(/\.[^/.]+$/, '')}`,
        },
        (error, result) => {
          if (error) {
            reject(new ApiError('Error al subir imagen a Cloudinary', 500));
          } else {
            resolve({
              url: result.secure_url,
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
