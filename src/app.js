import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { logger } from './shared/utils/logger.util.js';

import { CORS_CREDENTIALS, CORS_ORIGIN } from './config/secret.config.js';
import { errorHandler } from './shared/middlewares/error.middleware.js';

import healthRoutes from './features/health/health.routes.js';
import horarioRoutes from './features/horarios/horario.routes.js';
import usuarioRoutes from './features/usuarios/usuario.routes.js';
import authRoutes from './features/auth/auth.routes.js';
import rolesRoutes from './features/roles/roles.routes.js';
import inscripcionRoutes from './features/inscripciones/inscripcion.routes.js';
import pagosRoutes from './features/pagos/pagos.routes.js';
import sedeRoutes from './features/sedes/sede.routes.js';
import recuperacionRoutes from './features/recuperaciones/recuperacion.routes.js';
import canchasRoutes from './features/canchas/cancha.routes.js';
import nivelesRoutes from './features/niveles/niveles.routes.js';
import tiposBeneficioRoutes from './features/tipos_beneficio/tipos_beneficio.routes.js';
import descuentosRoutes from './features/descuentos_aplicados/descuentos_aplicados.routes.js';
import asistenciaRoutes from './features/asistencia/asistencia.routes.js';
import cuentaPorCobrarRoutes from './features/cuenta_por_cobrar/cuentas_por_cobrar.routes.js';
import claseRoutes from './features/clases/clase.routes.js';
import catalogoRoutes from './features/catalogo_de_concepto/catalogo.routes.js';
import parametrosRoutes from './features/parametros_sistema/parametros.routes.js';
import cloudinaryRoutes from './features/cloudinaryImg/cloudinary.routes.js';
import lesionRoutes from './features/lesiones/lesion.routes.js';
import tipoDocumentosRoutes from './features/tipo_documento/tipo_documento.routes.js';
import beneficioPendiente from './features/beneficios_pendientes/beneficios-pendientes.routes.js';
import alumnoRoutes from './features/alumnos/alumno.routes.js';
import publicacionRoutes from './features/publicaciones/publicacion.routes.js';
import notificacionesRoutes from './features/notificaciones/notificaciones.routes.js';
import metodosPago from './features/metodosPago/metodo_pago.routes.js';
import coordinadorRoutes from './features/cordinador/coordinador.routes.js';
import feriadoRoutes from './features/feriados/feriado.routes.js';
import cajaRoutes from './features/movimientos_financieros/movimientos-financieros.route.js';
import historialAcademicoRoutes from './features/VistasEspecificas/historial_academico/historial_academico.routes.js'; // 🆕

import merchRoutes from './features/merch/merch.routes.js';
import anunciosBeneficio from './features/anunciosBeneficios/anunciosBeneficios.routes.js';

const app = express();
app.set('trust proxy', 1);
const morganFormat = ':method :url :status :response-time ms';

// Middlewares
app.use(helmet());

const corsOriginList = Array.isArray(CORS_ORIGIN) ? CORS_ORIGIN : [CORS_ORIGIN].filter(Boolean);
const normalizeOrigin = (origin) => origin.replace(/\/$/, '');

// Healthcheck route BEFORE CORS so it doesn't get blocked by strict origin policies
app.get('/', (req, res) => res.status(200).send('Gema Academy API is alive!'));
app.use('/health', healthRoutes);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const normalized = normalizeOrigin(origin);
      if (corsOriginList.includes(normalized)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(
  morgan(morganFormat, {
    stream: {
      write: (message) => {
        const logObject = {
          method: message.split(' ')[0],
          url: message.split(' ')[1],
          status: message.split(' ')[2],
          responseTime: message.split(' ')[3],
        };
        logger.http(JSON.stringify(logObject));
      },
    },
  })
);
app.use(cookieParser());
// Merch recibe imágenes en Base64: el límite por defecto (100 kb) las rechazaría con 413.
// Va ANTES del parser global; body-parser omite una petición que ya fue parseada.
app.use('/api/merch', express.json({ limit: '12mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/horarios', horarioRoutes);
app.use('/api/usuarios', usuarioRoutes);
app.use('/api/inscripciones', inscripcionRoutes);
app.use('/api/pagos', pagosRoutes);
app.use('/api/sedes', sedeRoutes);
app.use('/api/recuperaciones', recuperacionRoutes);
app.use('/api/canchas', canchasRoutes);
app.use('/api/niveles', nivelesRoutes);
app.use('/api/tipos-beneficio', tiposBeneficioRoutes);
app.use('/api/descuentos', descuentosRoutes);
app.use('/api/asistencias', asistenciaRoutes);
app.use('/api/cuentas-por-cobrar', cuentaPorCobrarRoutes);
app.use('/api/clases', claseRoutes);
app.use('/api/catalogo', catalogoRoutes);
app.use('/api/parametros', parametrosRoutes);
app.use('/api/cloudinary', cloudinaryRoutes);
app.use('/api/lesiones', lesionRoutes);
app.use('/api/tipos-documento', tipoDocumentosRoutes);
app.use('/api/beneficioPendiente', beneficioPendiente);
app.use('/api/alumno', alumnoRoutes);
// 🆕 BL-007: alias en plural para PATCH /api/alumnos/:id/contacto-emergencia.
// El singular sigue montado, así que ninguna ruta existente cambia.
app.use('/api/alumnos', alumnoRoutes);
app.use('/api/publicaciones', publicacionRoutes);
app.use('/api/notificaciones', notificacionesRoutes);
app.use('/api/metodos-pago', metodosPago);
app.use('/api/coordinadores', coordinadorRoutes);
app.use('/api/feriados', feriadoRoutes);
app.use('/api/anuncios-beneficios',anunciosBeneficio)
app.use('/api/caja', cajaRoutes);
app.use('/api/merch', merchRoutes);
app.use('/api/historial-academico', historialAcademicoRoutes); // ya p elmer no me apures xd

app.use(errorHandler);

export default app;
