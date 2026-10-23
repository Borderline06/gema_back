import dotenv from 'dotenv';

dotenv.config();

// ============================================
// SERVER CONFIGURATION
// ============================================
export const PORT = process.env.PORT || 5000;
export const NODE_ENV = process.env.NODE_ENV || 'development';

// ============================================
// JWT CONFIGURATION
// ============================================
export const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-key-change-in-production';
const rawJwtExpires = process.env.JWT_EXPIRES_IN || '15m';
export const JWT_EXPIRES_IN = /^\d+$/.test(rawJwtExpires) ? `${rawJwtExpires}m` : rawJwtExpires;
export const REFRESH_TOKEN_EXPIRATION_DAYS =
  Number.parseInt(process.env.REFRESH_TOKEN_EXPIRATION_DAYS) || 7;

// ============================================
// CORS CONFIGURATION
// ============================================
const rawCorsOrigins = process.env.CORS_ORIGIN || 'http://localhost:3000';
const normalizeCorsOrigin = (origin) => origin.trim().replace(/\/$/, '');
const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
};

export const CORS_ORIGIN = rawCorsOrigins.split(',').map(normalizeCorsOrigin).filter(Boolean);
export const CORS_CREDENTIALS = parseBooleanEnv(process.env.CORS_CREDENTIALS, false);
export const COOKIE_CROSS_SITE = parseBooleanEnv(process.env.COOKIE_CROSS_SITE, false);
export const COOKIE_PARTITIONED = parseBooleanEnv(
  process.env.COOKIE_PARTITIONED,
  COOKIE_CROSS_SITE
);

// ============================================
// FRONTEND CONFIGURATION
// ============================================
export const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ============================================
// BRANDING (nombre visible de la empresa)
// ============================================
export const COMPANY_NAME = process.env.COMPANY_NAME || 'G+';

// ============================================
// BREVO (EMAIL) CONFIGURATION
// ============================================
export const BREVO_API_KEY = process.env.BREVO_API_KEY;
export const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || COMPANY_NAME;
export const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'no-reply@academiagema.com';
export const BREVO_TIMEOUT_MS = Number.parseInt(process.env.BREVO_TIMEOUT_MS) || 8000;

// ============================================
// TWILIO CONFIGURATION
// ============================================
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
export const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// ============================================
// CLOUDINARY CONFIGURATION
// ============================================
export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// ============================================
// TWILIO TEMPLATES (Producción)
// ============================================
export const TWILIO_TEMPLATE_VENCIMIENTO_SID = process.env.TWILIO_TEMPLATE_VENCIMIENTO_SID;
export const TWILIO_TEMPLATE_CUMPLEANOS_SID = process.env.TWILIO_TEMPLATE_CUMPLEANOS_SID;
export const TWILIO_TEMPLATE_PAGO_PARCIAL_SID = process.env.TWILIO_TEMPLATE_PAGO_PARCIAL_SID;
