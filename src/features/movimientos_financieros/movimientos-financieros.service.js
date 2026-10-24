import { PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/utils/error.util.js';
import { merchService } from '../merch/merch.service.js';
import { armarDesgloseIngresos } from './desglose-ingresos.logic.js';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
const prisma = new PrismaClient();

// Las filas INGRESO_MERCH / INGRESO_MATRICULA las genera la validación de un pago:
// editarlas o borrarlas a mano las desalinearía del pago que las originó.
const rechazarSiEsAutomatico = async (id) => {
    const mov = await prisma.movimientos_financieros.findUnique({
        where: { id: parseInt(id) },
        select: { pago_id: true }
    });
    if (mov?.pago_id) {
        throw new ApiError(
            `Este movimiento lo generó el pago #${mov.pago_id} y no se puede modificar desde caja.`,
            409
        );
    }
};

const getMonthLocal = (fecha) => {
    const date = new Date(fecha)
    return Number(
        new Intl.DateTimeFormat("es-PE", {
            timeZone: "America/Lima",
            month: "numeric",
        }).format(date)
    );
}

export const movimientosFinancierosService = {
    // Obtener todos los movimientos (con opción a filtrar por tipo)
    obtenerTodos: async (filtros = {}) => {
        const { tipo_movimiento, fecha_inicio, fecha_fin } = filtros;

        let where = {};

        if (tipo_movimiento) {
            where.tipo_movimiento = tipo_movimiento.toUpperCase();
        }

        if (fecha_inicio || fecha_fin) {
            where.fecha_movimiento = {};
            if (fecha_inicio) where.fecha_movimiento.gte = new Date(fecha_inicio);
            if (fecha_fin) where.fecha_movimiento.lte = new Date(fecha_fin);
        }

        return await prisma.movimientos_financieros.findMany({
            where,
            orderBy: { fecha_movimiento: 'desc' },
            include: {
                metodos_pago: { select: { nombre: true } },
                administrador: {
                    select: {
                        usuarios: { select: { nombres: true, apellidos: true } }
                    }
                }
            }
        });
    },

    // Obtener un movimiento por ID
    obtenerPorId: async (id) => {
        return await prisma.movimientos_financieros.findUnique({
            where: { id: parseInt(id) },
            include: {
                metodos_pago: { select: { nombre: true } },
                administrador: {
                    select: {
                        usuarios: { select: { nombres: true, apellidos: true } }
                    }
                }
            }
        });
    },

    // Crear un nuevo movimiento (Ingreso o Egreso)
    crear: async (data, usuario_id) => {
        const mesHoy = getMonthLocal(new Date());
        const mesData = getMonthLocal(data.fecha_movimiento);
        if (mesData > mesHoy) throw new ApiError('Debe registrar el ingreso/egreso en el mes actual.', 400)
        return await prisma.movimientos_financieros.create({
            data: {
                tipo_movimiento: data.tipo_movimiento.toUpperCase(),
                monto: data.monto,
                concepto: data.concepto,
                metodo_pago_id: data.metodo_pago_id,
                fecha_movimiento: data.fecha_movimiento ? new Date(data.fecha_movimiento) : new Date(),
                comprobante_url: data.comprobante_url,
                registrado_por: usuario_id,
                notas: data.notas,
                sede_id: data.sede_id,
            }
        });
    },

    // Actualizar un movimiento (Ej: si se equivocaron en el monto o concepto)
    actualizar: async (id, data) => {
        const mesHoy = getMonthLocal(new Date());
        const mesData = getMonthLocal(data.fecha_movimiento);
        if (mesData > mesHoy) throw new ApiError('Debe actualizar el ingreso/egreso en el mes actual.', 400);
        await rechazarSiEsAutomatico(id);
        return await prisma.movimientos_financieros.update({
            where: { id: parseInt(id) },
            data: {
                tipo_movimiento: data.tipo_movimiento ? data.tipo_movimiento.toUpperCase() : undefined,
                monto: data.monto,
                concepto: data.concepto,
                metodo_pago_id: data.metodo_pago_id,
                comprobante_url: data.comprobante_url,
                notas: data.notas,
                sede_id: data.sede_id,
                fecha_movimiento: data.fecha_movimiento,
            }
        });
    },

    /**
     * Desglose "Merch vs Matrícula" de lo COBRADO en un mes (por fecha de pago), para auditoría.
     *
     * Es un endpoint aparte (y no una llave más de `obtenerResumenMensual`) porque ese resumen es
     * un mapa indexado por sede: cualquier llave extra se leería como una sede y rompería la
     * tabla y el Excel.
     *
     *   - merch      = suma de las filas INGRESO_MERCH del mes (ventas de taquilla, órdenes de
     *                  alumno y la parte de merch de los pagos MIXTO).
     *   - matricula  = todo lo cobrado en el mes menos el merch. Las filas INGRESO_MATRICULA solo
     *                  existen en pagos MIXTO, así que no sirven como total de matrícula.
     *   - movimientos = las filas automáticas del mes (concepto, monto, alumno y pago de origen)
     *                  para poder cuadrar cada sol contra su pago.
     */
    obtenerDesgloseIngresos: async (mes, anio) => {
        const mesInt = parseInt(mes);
        const anioInt = parseInt(anio);
        if (!Number.isInteger(mesInt) || mesInt < 1 || mesInt > 12 || !Number.isInteger(anioInt)) {
            throw new ApiError("Parámetros 'mes' (1-12) y 'anio' inválidos", 400);
        }
        // Mismo rango que obtenerResumenMensual.
        const fechaInicio = new Date(anioInt, mesInt - 1, 1);
        const fechaFin = new Date(anioInt, mesInt, 0, 23, 59, 59);

        const [cobrado, filas] = await Promise.all([
            prisma.pagos.aggregate({
                _sum: { monto_pagado: true },
                where: { estado_validacion: 'APROBADO', fecha_pago: { gte: fechaInicio, lte: fechaFin } }
            }),
            prisma.movimientos_financieros.findMany({
                where: { pago_id: { not: null }, fecha_movimiento: { gte: fechaInicio, lte: fechaFin } },
                orderBy: [{ fecha_movimiento: 'asc' }, { id: 'asc' }],
                include: {
                    pagos: {
                        select: {
                            id: true,
                            tipo_transaccion: true,
                            cuentas_por_cobrar: {
                                select: { alumnos: { select: { usuarios: { select: { nombres: true, apellidos: true } } } } }
                            }
                        }
                    }
                }
            })
        ]);

        return armarDesgloseIngresos({
            mes: mesInt,
            anio: anioInt,
            totalCobrado: cobrado._sum.monto_pagado,
            filas
        });
    },

    obtenerResumenMensual: async (mes, anio) => {
        const mesInt = parseInt(mes);
        const anioInt = parseInt(anio);
        const fechaInicio = new Date(anioInt, mesInt - 1, 1);
        const fechaFin = new Date(anioInt, mesInt, 0, 23, 59, 59);

        // 1. Consulta desde el origen: PAGOS (Automáticos)
        // Filtramos por fecha_inicio_ciclo del LINK (fecha real de inicio de clases),
        // no por fecha_inscripcion_original de la inscripción (que se pisa en cada renovación).
        // Esto decide SI el pago tiene actividad este mes.
        const ingresos = await prisma.pagos.findMany({
            where: {
                estado_validacion: 'APROBADO',
                cuentas_por_cobrar: {
                    inscripciones_deudas_link: {
                        some: {
                            fecha_inicio_ciclo: { gte: fechaInicio, lte: fechaFin }
                        }
                    }
                }
            },
            include: {
                cuentas_por_cobrar: {
                    include: {
                        alumnos: { include: { usuarios: true } },
                        // 🚩 FIX: traemos TODOS los links de la cuenta, SIN filtrar por mes.
                        // Antes solo se traían los del mes consultado, lo que hacía que el
                        // divisor del split (links.length) fuera distinto según el mes que
                        // consultes -> un mismo pago se contaba completo en cada mes donde
                        // tuviera al menos un link, duplicando ingresos cuando una cuenta
                        // tiene ciclos en meses distintos (confirmado con datos reales:
                        // varias cuentas con links repartidos en 2 meses).
                        inscripciones_deudas_link: {
                            include: {
                                inscripciones: {
                                    include: {
                                        horarios_clases: {
                                            include: {
                                                canchas: { include: { sedes: true } },
                                                niveles_entrenamiento: true
                                            }
                                        }
                                    }
                                }
                            },
                            orderBy: {
                                id: "desc",
                            }
                        }
                    }
                }
            }
        });

        const reporte = {};

        // 2. Procesamiento de PAGOS
        ingresos.forEach(pago => {
            const todosLosLinks = pago.cuentas_por_cobrar?.inscripciones_deudas_link || [];
            if (todosLosLinks.length === 0) return;

            // 🚩 FIX: el divisor usa el TOTAL de links de la cuenta (todos sus ciclos,
            // sin importar el mes), así el monto del pago se reparte de forma consistente
            // sin importar en qué mes lo estés consultando. La suma de este monto a través
            // de TODOS los meses siempre da exactamente pago.monto_pagado, ni más ni menos.
            const montoPorLink = Number(pago.monto_pagado) / todosLosLinks.length;

            // De esos links, solo nos interesan (mostramos) los que caen en ESTE mes.
            const linksDeEsteMes = todosLosLinks.filter(link => {
                if (!link.fecha_inicio_ciclo) return false;
                const f = new Date(link.fecha_inicio_ciclo);
                return f >= fechaInicio && f <= fechaFin;
            });
            if (linksDeEsteMes.length === 0) return; // seguridad: si no hay link de este mes, no se cuenta

            const detalleAdicional = pago.cuentas_por_cobrar?.detalle_adicional || '';
            const esPlanIndividual = detalleAdicional.toLowerCase().includes('plan individual');
            const fteAsignado = esPlanIndividual ? 0 : 0.5;

            linksDeEsteMes.forEach(link => {
                const insc = link.inscripciones;
                const sede = insc?.horarios_clases?.canchas?.sedes?.nombre || 'GENERAL';
                const nivel = insc?.horarios_clases?.niveles_entrenamiento?.nombre || 'GENERAL';

                if (!reporte[sede]) reporte[sede] = { niveles: {}, egresos: [], ingresosManuales: [] };
                if (!reporte[sede].niveles[nivel]) reporte[sede].niveles[nivel] = { ingresos: [] };

                reporte[sede].niveles[nivel].ingresos.push({
                    id: pago.id,
                    concepto: `PAGO - ${nivel} | ${fteAsignado} FTE`,
                    monto: montoPorLink.toString(), // 🚩 FIX: ya no se divide por links.length del mes
                    fecha: link.fecha_inicio_ciclo, // mostramos la fecha real del ciclo, no la fecha de pago
                    alumno: pago.cuentas_por_cobrar?.alumnos?.usuarios
                        ? `${pago.cuentas_por_cobrar.alumnos.usuarios.nombres} ${pago.cuentas_por_cobrar.alumnos.usuarios.apellidos}`
                        : 'N/A',
                    es_plan_individual: esPlanIndividual,
                    detalle_adicional: detalleAdicional
                });
            });
        });

        // 3. Consulta de MOVIMIENTOS FINANCIEROS (Ingresos/Egresos Manuales)
        // Sin cambios: usan fecha_movimiento, no dependen de ciclos.
        const movimientos = await prisma.movimientos_financieros.findMany({
            where: {
                fecha_movimiento: { gte: fechaInicio, lte: fechaFin },
                // Las filas con pago_id (INGRESO_MERCH/INGRESO_MATRICULA) ya viajan en los pagos de arriba.
                pago_id: null
            },
            include: { sedes: true }
        });

        movimientos.forEach(mov => {
            const sede = mov.sedes?.nombre || 'GENERAL';

            if (!reporte[sede]) reporte[sede] = { niveles: {}, egresos: [], ingresosManuales: [] };
            if (!reporte[sede].egresos) reporte[sede].egresos = [];
            if (!reporte[sede].ingresosManuales) reporte[sede].ingresosManuales = [];

            if (mov.tipo_movimiento === 'INGRESO') {
                reporte[sede].ingresosManuales.push({
                    id: mov.id,
                    concepto: mov.concepto,
                    monto: mov.monto.toString(),
                    fecha: mov.fecha_movimiento,
                    registrado_por: mov.registrado_por
                });
            } else if (mov.tipo_movimiento === 'EGRESO') {
                reporte[sede].egresos.push({
                    id: mov.id,
                    concepto: mov.concepto,
                    monto: mov.monto.toString(),
                    fecha: mov.fecha_movimiento
                });
            }
        });

        return reporte;
    },

    // Eliminar un movimiento
    eliminar: async (id) => {
        await rechazarSiEsAutomatico(id);
        try {
            return await prisma.movimientos_financieros.delete({
                where: { id: parseInt(id) }
            });
        } catch (e) {
            if (e instanceof PrismaClientKnownRequestError) throw new ApiError(e.message, 400, { prismaCode: e.code, meta: e.meta });
            throw new ApiError(e instanceof Error ? e.message : 'Error Interno', 500);
        }
    },

  
    obtenerBalance: async () => {
        // =========================================================
        // 1. INGRESOS AUTOMÁTICOS (pagos de alumnos)
        // 🚩 FIX: antes esta función NO incluía los pagos de alumnos,
        // solo los movimientos manuales. Ahora sí se suman, y la regla
        // de validez es la misma que usa el resumen mensual: el pago
        // debe tener al menos un ciclo real en inscripciones_deudas_link
        // (fuente de verdad de "esto sí corresponde a una clase real").
        // Como este balance es un TOTAL (sin rango de fechas), no filtramos
        // por fecha_inicio_ciclo — solo exigimos que el link exista.
        // =========================================================
        const pagosAprobados = await prisma.pagos.findMany({
            where: {
                estado_validacion: 'APROBADO',
                cuentas_por_cobrar: {
                    inscripciones_deudas_link: { some: {} } // 👈 debe tener al menos un ciclo asociado
                }
            },
            select: { monto_pagado: true }
        });

        const totalIngresosAutomaticos = pagosAprobados.reduce(
            (acc, p) => acc + Number(p.monto_pagado || 0),
            0
        );

        // =========================================================
        // 2. INGRESOS Y EGRESOS MANUALES (movimientos_financieros)
        // Sin cambios: se quedan tal cual estaban, usando fecha_movimiento
        // (si registras algo en agosto, se queda en agosto, no se mueve).
        // =========================================================
        const ingresosManualesAgg = await prisma.movimientos_financieros.aggregate({
            _sum: { monto: true },
            // pago_id: null -> solo manuales. Las filas automáticas del split de pagos ya están
            // contadas en los ingresos automáticos / merch suelto de arriba.
            where: { tipo_movimiento: 'INGRESO', pago_id: null }
        });

        const egresosAgg = await prisma.movimientos_financieros.aggregate({
            _sum: { monto: true },
            where: { tipo_movimiento: 'EGRESO', pago_id: null }
        });

        const totalIngresosManuales = Number(ingresosManualesAgg._sum.monto || 0);
        const totalEgresos = Number(egresosAgg._sum.monto || 0);

        // =========================================================
        // 3. MERCH: las ventas sueltas (tipo_transaccion = 'MERCH') no tienen
        // link de matrícula, así que el filtro del punto 1 las deja fuera. Se
        // suman aparte para que cuenten en las ganancias totales. El merch
        // vendido dentro de una matrícula ya viaja en ingresosAutomaticos.
        // =========================================================
        const totalMerchSuelto = await merchService.sumarPagosMerchSueltos(prisma);
        const totalIngresos = totalIngresosAutomaticos + totalIngresosManuales + totalMerchSuelto;
        const totalMerch = await merchService.sumarIngresosMerch(prisma);

        return {
            ingresos: totalIngresos,
            // 🛍️ NUEVO (aditivo): métricas de merch aisladas.
            ingresosMerch: totalMerch,          // todo el merch (suelto + dentro de matrículas)
            ingresosMerchSuelto: totalMerchSuelto, // la parte que se sumó arriba
            // 🚩 NUEVO: desglose para que el frontend (o tú mismo debuggeando)
            // pueda ver de dónde viene cada sol, sin tener que adivinar.
            ingresosAutomaticos: totalIngresosAutomaticos,
            ingresosManuales: totalIngresosManuales,
            egresos: totalEgresos,
            balance: totalIngresos - totalEgresos
        };
    },

      obtenerResumenAnual: async (anio) => {
        const anioInt = parseInt(anio);
        const fechaInicio = new Date(anioInt, 0, 1);
        const fechaFin = new Date(anioInt, 11, 31, 23, 59, 59);
 
        // Ingresos automáticos (pagos), agrupados por mes del CICLO
        // (fecha_inicio_ciclo), no por fecha de pago — misma regla que
        // obtenerResumenMensual: el monto se reparte entre todos los
        // ciclos de la cuenta, no solo los del mes.
        const filasPagos = await prisma.$queryRaw`
            WITH links_totales AS (
                SELECT cuenta_id, COUNT(*)::int AS total_links
                FROM inscripciones_deudas_link
                GROUP BY cuenta_id
            )
            SELECT
                EXTRACT(MONTH FROM idl.fecha_inicio_ciclo)::int AS mes,
                SUM(p.monto_pagado / lt.total_links) AS total
            FROM pagos p
            JOIN cuentas_por_cobrar cpc        ON cpc.id = p.cuenta_id
            JOIN links_totales lt              ON lt.cuenta_id = cpc.id
            JOIN inscripciones_deudas_link idl ON idl.cuenta_id = cpc.id
            WHERE p.estado_validacion = 'APROBADO'
              AND idl.fecha_inicio_ciclo BETWEEN ${fechaInicio} AND ${fechaFin}
            GROUP BY EXTRACT(MONTH FROM idl.fecha_inicio_ciclo)
            ORDER BY mes;
        `;
 
        // Ventas sueltas de merch (sin link de matrícula), agrupadas por mes de pago
        const filasMerch = await prisma.$queryRaw`
            SELECT
                EXTRACT(MONTH FROM p.fecha_pago)::int AS mes,
                SUM(p.monto_pagado) AS total
            FROM pagos p
            WHERE p.estado_validacion = 'APROBADO'
              AND p.tipo_transaccion = 'MERCH'
              AND p.fecha_pago BETWEEN ${fechaInicio} AND ${fechaFin}
            GROUP BY EXTRACT(MONTH FROM p.fecha_pago)
            ORDER BY mes;
        `;

        // Movimientos manuales (ingreso/egreso), agrupados por mes y tipo
        const filasMovimientos = await prisma.$queryRaw`
            SELECT
                EXTRACT(MONTH FROM mf.fecha_movimiento)::int AS mes,
                mf.tipo_movimiento AS tipo,
                SUM(mf.monto) AS total
            FROM movimientos_financieros mf
            WHERE mf.fecha_movimiento BETWEEN ${fechaInicio} AND ${fechaFin}
              AND mf.pago_id IS NULL
            GROUP BY EXTRACT(MONTH FROM mf.fecha_movimiento), mf.tipo_movimiento
            ORDER BY mes;
        `;
 
        // Armamos los 12 meses siempre (aunque no haya datos), para que
        // el frontend no tenga que rellenar huecos al graficar.
        const meses = Array.from({ length: 12 }, (_, i) => ({
            mes: i + 1,
            anio: anioInt,
            ingresosPagos: 0,      // ingresos automáticos (pagos de alumnos)
            ingresosManuales: 0,   // movimientos manuales tipo INGRESO
            egresos: 0,            // movimientos manuales tipo EGRESO
            ingresosMerch: 0,      // 🛍️ ventas sueltas de merch (tipo_transaccion 'MERCH')
            totalIngresos: 0,      // ingresosPagos + ingresosManuales + ingresosMerch
            balance: 0             // totalIngresos - egresos
        }));
 
        filasPagos.forEach(fila => {
            meses[Number(fila.mes) - 1].ingresosPagos = Number(fila.total);
        });
 
        filasMerch.forEach(fila => {
            meses[Number(fila.mes) - 1].ingresosMerch = Number(fila.total);
        });

        filasMovimientos.forEach(fila => {
            const idx = Number(fila.mes) - 1;
            if (fila.tipo === 'INGRESO') meses[idx].ingresosManuales = Number(fila.total);
            else if (fila.tipo === 'EGRESO') meses[idx].egresos = Number(fila.total);
        });
 
        meses.forEach(m => {
            m.totalIngresos = m.ingresosPagos + m.ingresosManuales + m.ingresosMerch;
            m.balance = m.totalIngresos - m.egresos;
        });
 
        return meses;
    },
};