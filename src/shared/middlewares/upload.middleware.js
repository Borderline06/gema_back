import multer from 'multer';
import { ApiError } from '../utils/error.util.js';

// Único conjunto de formatos aceptados para imágenes subidas por usuarios. SVG queda fuera a
// propósito (puede llevar scripts) y GIF/HEIC/etc. tampoco se aceptan.
export const FORMATOS_IMAGEN_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_BYTES_IMAGEN = 5 * 1024 * 1024; // 5 MB por foto

const MENSAJE_FORMATO = 'Formato no válido. Solo se permiten imágenes JPG, PNG o WEBP.';

/**
 * Formato real de una imagen según los primeros bytes (el `mimetype` que declara el cliente
 * es solo una etiqueta y se puede falsificar). Devuelve el mimetype o null si no es JPG/PNG/WEBP.
 */
export const detectarFormatoImagen = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

// Le decimos a Multer que guarde el archivo en la memoria RAM temporalmente (Buffer)
const storage = multer.memoryStorage();

export const uploadMemory = multer({
  storage: storage,
  limits: {
    fileSize: MAX_BYTES_IMAGEN,
  },
  fileFilter: (req, file, cb) => {
    // Primer filtro, barato: la etiqueta declarada. La firma real se verifica en `subirImagen`.
    if (FORMATOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError(MENSAJE_FORMATO, 400), false);
    }
  },
});

/**
 * Middleware de subida de UNA imagen opcional (campo multipart `campo`).
 *  1. multer en memoria, con tope de tamaño y solo JPG/PNG/WEBP por etiqueta.
 *  2. verifica que el CONTENIDO sea de verdad uno de esos formatos (firma de bytes).
 * Todo rechazo es un 400 con mensaje claro (nunca el 500 genérico de un error de multer).
 * Si la petición no es multipart o no trae archivo, el body pasa intacto (p. ej. clientes
 * que aún envían JSON).
 */
export const subirImagen = (campo = 'imagen') => (req, res, next) => {
  uploadMemory.single(campo)(req, res, (err) => {
    if (err) {
      if (err instanceof ApiError) return next(err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(`La imagen supera el máximo de ${MAX_BYTES_IMAGEN / 1024 / 1024} MB.`, 400));
      }
      if (err.name === 'MulterError') return next(new ApiError(`Archivo inválido: ${err.message}`, 400));
      return next(err);
    }

    if (req.file) {
      const real = detectarFormatoImagen(req.file.buffer);
      if (!real) return next(new ApiError(MENSAJE_FORMATO, 400));
      req.file.mimetype = real; // lo que se sube es lo que el contenido dice, no la etiqueta
    }
    return next();
  });
};
