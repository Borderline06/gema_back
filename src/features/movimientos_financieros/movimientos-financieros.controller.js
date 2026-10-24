import { movimientosFinancierosService } from './movimientos-financieros.service.js';

export const movimientosFinancierosController = {
    listar: async (req, res) => {
        try {
            // Permite filtrar por query params: ?tipo_movimiento=INGRESO&fecha_inicio=2026-06-01
            const filtros = req.query; 
            const data = await movimientosFinancierosService.obtenerTodos(filtros);
            res.json({ success: true, data });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    },

    obtenerPorId: async (req, res) => {
        try {
            const { id } = req.params;
            const data = await movimientosFinancierosService.obtenerPorId(id);
            if (!data) return res.status(404).json({ success: false, message: "Movimiento no encontrado" });
            res.json({ success: true, data });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    },

    crear: async (req, res) => {
        try {
            // Asume que el middleware 'authenticate' inyecta el req.user con el id del usuario logueado
            const usuario_id = req.user.id; 
            const data = await movimientosFinancierosService.crear(req.body, usuario_id);
            res.status(201).json({ success: true, message: "Movimiento financiero registrado", data });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    },

    actualizar: async (req, res) => {
        try {
            const data = await movimientosFinancierosService.actualizar(req.params.id, req.body);
            res.json({ success: true, message: "Movimiento financiero actualizado", data });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    },

    eliminar: async (req, res) => {
        try {
            await movimientosFinancierosService.eliminar(req.params.id);
            res.json({ success: true, message: "Movimiento financiero eliminado" });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    },
    obtenerResumen: async (req, res) => {
        try {
            const { mes, anio } = req.query;
            // Validamos que los parámetros lleguen
            if (!mes || !anio) {
                return res.status(400).json({ success: false, message: "Parámetros 'mes' y 'anio' son obligatorios" });
            }
            const data = await movimientosFinancierosService.obtenerResumenMensual(mes, anio);
            res.json({ success: true, data });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    },

    // Merch vs Matrícula de lo cobrado en el mes (endpoint hermano de /resumen: no toca su forma).
    obtenerDesgloseIngresos: async (req, res) => {
        try {
            const { mes, anio } = req.query;
            if (!mes || !anio) {
                return res.status(400).json({ success: false, message: "Parámetros 'mes' y 'anio' son obligatorios" });
            }
            const data = await movimientosFinancierosService.obtenerDesgloseIngresos(mes, anio);
            res.json({ success: true, data });
        } catch (error) {
            res.status(error.statusCode || 500).json({ success: false, message: error.message });
        }
    },

    obtenerResumenBalance: async (req, res) => {
        try {
            const data = await movimientosFinancierosService.obtenerBalance();
            res.json({ success: true, data });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    },
    obtenerResumenAnual: async (req, res) => {
        try {
            const { anio } = req.query;
            if (!anio) {
                return res.status(400).json({ success: false, message: "Parámetro 'anio' es obligatorio" });
            }
            const data = await movimientosFinancierosService.obtenerResumenAnual(anio);
            res.json({ success: true, data });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    },
};