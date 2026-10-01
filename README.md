# Gema Academy — Backend

API REST para **Gema Academy**, sistema de gestión de una academia deportiva (vóley): alumnos, inscripciones, horarios, asistencia, pagos y cuentas por cobrar, recuperaciones de clases, lesiones y caja.

## Stack

- **Node.js ≥ 18** (ESM) + **Express 5**
- **PostgreSQL 15** con **Prisma 5.10** como ORM
- Autenticación con **JWT** + refresh tokens (cookies), contraseñas con `bcryptjs`
- Validación con **Zod**, seguridad con `helmet` y `cors`
- Tareas programadas con `node-cron`
- Integraciones: **Cloudinary** (imágenes/comprobantes), **Brevo** y Gmail (email), **Twilio** (WhatsApp/SMS)

## Requisitos

- Node.js 18 o superior
- Docker (para PostgreSQL local) o una instancia de PostgreSQL propia

## Puesta en marcha

```bash
# 1. Dependencias
npm install

# 2. Variables de entorno
cp .env.template .env        # y completa los valores (ver más abajo)

# 3. Base de datos local (PostgreSQL en Docker, puerto 5432)
docker compose up -d

# 4. Cliente Prisma + migraciones
npx prisma generate
npx prisma migrate deploy

# 5. Datos iniciales (opcional)
npm run db:seed              # roles, catálogo de precios, parámetros, etc.
npm run db:seed:demo         # datos de demo para probar el frontend (ver abajo)

# 6. Arrancar
npm run dev                  # recarga automática (node --watch)
```

La API queda en `http://localhost:5000` (configurable con `PORT`). En Windows, `iniciar_proyecto.bat` automatiza estos pasos.

Con el `docker-compose.yml` incluido, la cadena de conexión local es:

```
DATABASE_URL=postgresql://postgres:root@localhost:5432/gema_academy_db
```

## Variables de entorno

Ver `.env.template`. Las principales:

| Variable | Descripción |
|---|---|
| `PORT`, `NODE_ENV` | Puerto y entorno del servidor |
| `DATABASE_URL` | Conexión a PostgreSQL (la usa Prisma) |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_EXPIRATION_DAYS` | Tokens de sesión |
| `CORS_ORIGIN`, `CORS_CREDENTIALS`, `COOKIE_CROSS_SITE`, `COOKIE_PARTITIONED` | CORS y cookies (el frontend de desarrollo corre en `http://localhost:5173`) |
| `FRONTEND_URL` | URL del frontend (enlaces en correos/mensajes) |
| `CLOUDINARY_*` | Subida de imágenes y comprobantes |
| `BREVO_*`, `EMAIL_USER`, `EMAIL_PASS` | Envío de correos |
| `TWILIO_*` | Mensajería y plantillas (vencimiento, cumpleaños, pago parcial) |

> Nunca subas `.env` al repositorio (ya está en `.gitignore`).

## Scripts

| Script | Acción |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm start` | `prisma generate` + `migrate deploy` + servidor (producción) |
| `npm run db:migrate` | Crea/aplica migraciones en desarrollo |
| `npm run db:migrate:prod` | Aplica migraciones pendientes |
| `npm run db:push` | Sincroniza el schema sin migración |
| `npm run db:seed` | Seed base (roles, documentos, catálogo, parámetros) |
| `npm run db:seed:demo` | Datos de demo (solo bases locales) |
| `npm run db:studio` | Prisma Studio |
| `npm run db:reset` | Resetea la base y vuelve a migrar |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm test` | Tests con `node --test` |

## Datos de demo

`npm run db:seed:demo` es idempotente y se niega a ejecutarse si `DATABASE_URL` no apunta a `localhost`. Crea sedes, canchas, horarios, un admin, dos coordinadores y alumnos que cubren distintos escenarios (activo, pendiente de pago, pago parcial, por validar, moroso, clase individual, finalizado, lesión con congelamiento, recuperación programada, sin inscripción).

Contraseña de todos los usuarios: `Gema1234!`

| Rol | Usuarios |
|---|---|
| Administrador | `admin.demo` |
| Coordinador | `coord.demo`, `coord2.demo` |
| Alumno | `alumno.activo`, `alumno.pendiente`, `alumno.parcial`, `alumno.porvalidar`, `alumno.moroso`, `alumno.individual`, `alumno.finalizado`, `alumno.lesion`, `alumno.recupera`, `alumno.nuevo` |

## Estructura

```
prisma/
  schema.prisma        Modelo de datos
  migrations/          Migraciones SQL
  seed.js              Seed base
  seed-demo.js         Datos de demo
src/
  index.js             Arranque del servidor
  app.js               Middlewares y montaje de rutas
  config/              Base de datos, cookies, Cloudinary, secretos
  shared/              Middlewares, servicios, utilidades y validaciones comunes
  features/            Un módulo por dominio (routes / controller / service / schema)
    auth, alumnos, inscripciones, horarios, asistencia, pagos,
    cuenta_por_cobrar, recuperaciones, lesiones, congelamientos,
    movimientos_financieros, notificaciones, cron, ...
```

Cada feature sigue el patrón `*.routes.js` → `*.controller.js` → `*.service.js`, con validación Zod en `*.schema.js`. La documentación del flujo de autenticación está en `src/features/auth/AUTH.md`.

## API

Todas las rutas cuelgan de `/api`, salvo `GET /health`.

| Prefijo | Dominio |
|---|---|
| `/auth` | Login, refresh, logout, recuperación y cambio de contraseña |
| `/usuarios`, `/roles`, `/tipos-documento` | Usuarios, roles y documentos |
| `/alumno`, `/coordinadores` | Vistas de alumno y coordinador |
| `/sedes`, `/canchas`, `/niveles`, `/horarios`, `/clases`, `/feriados` | Infraestructura y programación |
| `/inscripciones`, `/asistencias`, `/recuperaciones`, `/lesiones`, `/historial-academico` | Ciclo académico |
| `/cuentas-por-cobrar`, `/pagos`, `/catalogo`, `/metodos-pago`, `/caja` | Cobranza y finanzas |
| `/tipos-beneficio`, `/beneficioPendiente`, `/descuentos`, `/anuncios-beneficios` | Beneficios y descuentos |
| `/publicaciones`, `/notificaciones`, `/cloudinary`, `/parametros` | Contenido, avisos, archivos y configuración |

Las rutas protegidas requieren sesión (JWT) y control por rol: **Administrador**, **Coordinador** y **Alumno**.

## Tareas programadas

Al iniciar, el servidor registra jobs de `node-cron` (`src/features/cron/services/cron-jobs.service.js`) para: revisión nocturna de ciclos y renovaciones, limpieza de renovaciones y reservas abandonadas, recordatorios de vencimiento y de morosos parciales, congelamientos por finalizar, asistencia sin marcar, cumpleaños, reposiciones y purga de tokens vencidos. Los parámetros de tolerancia y anticipación viven en la tabla `parametros_sistema`.

## Despliegue

`npm start` genera el cliente Prisma, aplica las migraciones pendientes y levanta el servidor. Define las variables de entorno en la plataforma (sin commitear `.env`) y, si el frontend está en otro dominio, configura `CORS_ORIGIN`, `COOKIE_CROSS_SITE` y `COOKIE_PARTITIONED`.

## Licencia

MIT
