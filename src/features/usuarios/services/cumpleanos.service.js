import { prisma } from '../../../config/database.config.js';
import { twilioProvider } from '../../../shared/services/twilio.whatsapp.service.js';
import { emailService } from '../../../shared/services/brevo.email.service.js';
import { logger } from '../../../shared/utils/logger.util.js';
import { TWILIO_TEMPLATE_CUMPLEANOS_SID, COMPANY_NAME } from '../../../config/secret.config.js';

// 🔥 IMPORTAMOS DAYJS PARA HORA EXACTA DE PERÚ 🔥
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_LIMA = 'America/Lima';

// Helper de seguridad: Lotes
const chunkArray = (array, size) => {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

class CumpleanosService {
  async ejecutarSaludosCumpleanos() {
    // 1. Obtener el día y mes exactamente con la hora de Lima
    const hoyLima = dayjs().tz(TZ_LIMA);
    const mesActual = hoyLima.month() + 1; // En dayjs los meses van de 0 a 11
    const diaActual = hoyLima.date();

    // 2. Consulta en crudo (SQL) que es súper rápida para extraer partes de una fecha
    const cumpleaneros = await prisma.$queryRaw`
      SELECT id, nombres, apellidos, telefono_personal, email 
      FROM usuarios 
      WHERE activo = true 
        AND EXTRACT(MONTH FROM fecha_nacimiento) = ${mesActual} 
        AND EXTRACT(DAY FROM fecha_nacimiento) = ${diaActual}
    `;

    if (!cumpleaneros || cumpleaneros.length === 0) {
      logger.info('[FESTEJERO] Hoy no hay cumpleaños, a descansar.');
      return;
    }

    logger.info(`[FESTEJERO] Encontrados ${cumpleaneros.length} cumpleañeros hoy.`);

    // 3. Sistema de envíos por lotes (Batches de 40 para proteger Twilio y Brevo)
    const lotes = chunkArray(cumpleaneros, 40);
    let totalExitosos = 0;

    for (const lote of lotes) {
      const promesasLote = lote.map(async (usuario) => {
        let wpEnviado = false;
        let emailEnviado = false;

        // =============================================
        // 📲 WHATSAPP
        // =============================================
        if (usuario.telefono_personal) {
          if (TWILIO_TEMPLATE_CUMPLEANOS_SID) {
            // Pasamos solo la variable {{1}} que necesita tu plantilla
            const variables = { "1": usuario.nombres };
            
            const wpResultado = await twilioProvider.sendTemplateMessage(
              usuario.telefono_personal,
              TWILIO_TEMPLATE_CUMPLEANOS_SID,
              variables
            );
            wpEnviado = wpResultado.success;
          } else {
            // Plan de Respaldo por si falla el código de Twilio
            const mensaje = `¡Hola ${usuario.nombres}! 🎉 En ${COMPANY_NAME} celebramos contigo este día especial 🎈🎂🥳. Que sea un año lleno de logros y grandes historias para disfrutar. 👉 ¡Nos vemos en cancha para seguir creciendo juntos! 💪✨`;
            const wpResultado = await twilioProvider.sendWhatsAppMessage(usuario.telefono_personal, mensaje);
            wpEnviado = wpResultado.success;
          }
        }

        // =============================================
        // 📧 EMAIL
        // =============================================
        if (usuario.email) {
          try {
            // Si el servicio de email retorna algo para saber si fue exitoso, lo capturas
            emailEnviado = await emailService.sendBirthdayEmail(usuario.email, usuario.nombres);
          } catch (error) {
            logger.error(`[FESTEJERO ERROR] No se pudo enviar email a ${usuario.email}`, error);
          }
        }

        // Si se envió al menos por WA o Email, lo contamos como éxito
        return wpEnviado || emailEnviado;
      });

      // Esperamos a que todo el lote de 40 termine
      const resultadosLote = await Promise.all(promesasLote);
      
      // Contamos los que devolvieron 'true' (éxito)
      totalExitosos += resultadosLote.filter(exito => exito === true).length;

      // Pausa de 1 segundo entre lotes
      if (lotes.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info(
      `[FESTEJERO] Se enviaron ${totalExitosos}/${cumpleaneros.length} mensajes de cumpleaños con éxito.`
    );
  }
}

export const cumpleanosService = new CumpleanosService();