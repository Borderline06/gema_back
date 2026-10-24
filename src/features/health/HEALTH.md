# Feature: Health — Documentación Técnica

Endpoint de verificación de estado (health check) del servidor. Usado por balanceadores de carga, monitores uptime, y despliegues para confirmar que la API está respondiendo.

---

## Estructura de Archivos

```
src/features/health/
├── health.routes.js       # Ruta GET /
└── health.controller.js   # Responde con timestamp
```

---

## Endpoints

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/health` | No | Verifica que el servidor esté activo |

---

## Respuesta

```json
{
  "status": "success",
  "statusCode": 200,
  "message": "G+ API is running",
  "data": {
    "timestamp": "2026-03-01T22:00:00.000Z"
  }
}
```

---

## Código

### `health.router.js`
Ruta pública sin middlewares de auth ni validación. Solo un `GET /`.

### `health.controller.js`
Usa el patrón estándar §4.1 (`catchAsync`) y §4.2 (`apiResponse.success`). Retorna un timestamp para confirmar que el servidor está procesando requests en tiempo real.

> Este feature no tiene service ni schema porque no accede a base de datos ni recibe datos del cliente.
