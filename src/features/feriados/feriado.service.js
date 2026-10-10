import { prisma } from '../../config/database.config.js';
import {
  buscarFeriado,
  cargarFeriadosActivos,
  claveDiaDesdeFecha,
} from '../../shared/utils/feriado.util.js';

export const feriadoService = {
    listarTodos: async () => {
        return await prisma.feriados.findMany({
            orderBy: { fecha: 'asc' }
        });
    },

    crear: async (data) => {
        return await prisma.feriados.create({
            data: {
                fecha: new Date(data.fecha),
                descripcion: data.descripcion,
                activo: data.activo ?? true
            }
        });
    },

    actualizar: async (id, data) => {
        return await prisma.feriados.update({
            where: { id: parseInt(id) },
            data: {
                ...data,
                fecha: data.fecha ? new Date(data.fecha) : undefined
            }
        });
    },

    eliminar: async (id) => {
        // En feriados solemos hacer eliminación física o desactivación
        return await prisma.feriados.delete({
            where: { id: parseInt(id) }
        });
    },

    /**
     * Devuelve la fila del feriado activo que aplica a esa fecha, o null.
     *
     * 🔧 BL-003: el `verificarSiEsFeriado` original hacía
     * `findUnique({ where: { fecha: new Date(fecha) } })` sobre una columna
     * `fecha @unique @db.Date`. Con el string '2026-07-28' funciona (medianoche
     * UTC), pero con un Date a mediodía — que es el formato en que el proyecto
     * guarda fecha_inscripcion y el que produce clase-fecha.util.js — NO
     * matchea nunca. De ahí la normalización por clave de día.
     *
     * @param {Date|string} fecha
     * @param {{tx?: object, recurrente?: boolean}} opciones
     *   `recurrente: true` compara solo día+mes (la semántica de
     *   clase.service.js). Por defecto se usa fecha exacta CON AÑO, que es lo
     *   que modela la tabla.
     */
    obtenerFeriado: async (fecha, { tx = prisma, recurrente = false } = {}) => {
        const indice = await cargarFeriadosActivos(tx);
        return buscarFeriado(claveDiaDesdeFecha(fecha), indice, { recurrente });
    },

    // Función extra útil para la lógica de Gema
    verificarSiEsFeriado: async (fecha, opciones = {}) => {
        const feriado = await feriadoService.obtenerFeriado(fecha, opciones);
        return !!feriado;
    }
};