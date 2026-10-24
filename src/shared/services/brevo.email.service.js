import { logger } from '../utils/logger.util.js';
import { BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, BREVO_TIMEOUT_MS, COMPANY_NAME, FRONTEND_URL } from '../../config/secret.config.js';

const buildBaseTemplate = (bodyContent) => `
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
    
    <div style="background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%); padding: 40px 20px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 1px; text-transform: uppercase;">${COMPANY_NAME}</h1>
      <div style="height: 4px; width: 50px; background-color: #f97316; margin: 15px auto; border-radius: 2px;"></div>
    </div>

    ${bodyContent}

    <div style="background-color: #f1f5f9; padding: 20px; text-align: center;">
      <p style="color: #64748b; font-size: 12px; margin: 0;">
        © ${new Date().getFullYear()} ${COMPANY_NAME}. Todos los derechos reservados.
      </p>
    </div>
  </div>
`;

export const emailService = {
  /**
   * Envía un correo electrónico genérico usando Brevo.
   * @param {Object} options - Opciones de envío.
   * @param {string} options.to - Correo destino.
   * @param {string} options.toName - Nombre del destinatario.
   * @param {string} options.subject - Asunto del correo.
   * @param {string} options.htmlContent - Contenido HTML del correo.
   * @param {number} [options.maxRetries=2] - Intentos máximos ante fallo.
   * @returns {Promise<boolean>} Retorna true si el envío fue exitoso.
   */
  async send(options, maxRetries = 2) {
    if (!BREVO_API_KEY) {
      logger.warn('BREVO_API_KEY no está configurado, omitiendo envío de correo a ' + options.to);
      return false;
    }

    const { to, toName, subject, htmlContent } = options;
    const bodyData = {
      sender: {
        name: BREVO_SENDER_NAME,
        email: BREVO_SENDER_EMAIL,
      },
      to: [
        {
          email: to,
          name: toName || to,
        },
      ],
      subject: subject,
      htmlContent: htmlContent,
    };

    const myHeaders = new Headers();
    myHeaders.append('accept', 'application/json');
    myHeaders.append('api-key', BREVO_API_KEY.trim());
    myHeaders.append('content-type', 'application/json');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);

      try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: myHeaders,
          body: JSON.stringify(bodyData),
          signal: controller.signal,
          cache: 'no-store',
        });

        if (!response.ok) {
          const errorData = await response.text();
          logger.error(`Error enviando correo con Brevo: ${response.status} - ${errorData}`);
          if (response.status >= 400 && response.status < 500) return false;
          throw new Error(`Brevo 5xx: ${response.status}`);
        }

        logger.info(`Correo enviado exitosamente a ${to} (intento ${attempt})`);
        return true;
      } catch (error) {
        if (error.name === 'AbortError') {
          logger.warn(
            `[Brevo] Timeout (${BREVO_TIMEOUT_MS}ms) excedido enviando correo a ${to} (intento ${attempt})`
          );
        } else {
          logger.warn(`[Brevo] Intento ${attempt} fallido al enviar a ${to}: ${error.message}`);
        }

        if (attempt === maxRetries) {
          logger.error(`[Brevo] Error definitivo al enviar a ${to} tras ${maxRetries} intentos.`);
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    return false;
  },

  /**
   * Envía el correo de recuperación de contraseña.
   * @param {string} email - Correo del usuario.
   * @param {string} nombres - Nombres del usuario.
   * @param {string} token - Token JWT de reseteo.
   * @returns {Promise<boolean>}
   */
  async sendPasswordRecoveryEmail(email, nombres, token) {
    const frontUrl = FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontUrl}/reset-password?token=${token}`;

    const htmlContent = buildBaseTemplate(`
      <div style="padding: 40px 30px;">
        <h2 style="color: #1e293b; margin-top: 0; font-size: 22px;">Hola, ${nombres}</h2>
        <p style="color: #475569; line-height: 1.6; font-size: 15px;">
          Has solicitado restablecer tu contraseña. Haz clic en el siguiente botón para continuar:
        </p>

        <div style="text-align: center; margin-top: 30px; margin-bottom: 30px;">
          <a href="${resetLink}" style="background-color: #f97316; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 10px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 10px 15px -3px rgba(249, 115, 22, 0.3);">
            Restablecer Contraseña
          </a>
        </div>

        <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-top: 40px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
          Este enlace expirará en 1 hora. Si no solicitaste este cambio, puedes ignorar este correo.
        </p>
      </div>
    `);

    return this.send({
      to: email,
      toName: nombres,
      subject: `Recuperación de Contraseña - ${COMPANY_NAME}`,
      htmlContent,
    });
  },

  /**
   * Envía correo de credenciales de acceso inicial.
   * @param {string} email - Correo del destinatario.
   * @param {string} nombres - Nombres del usuario.
   * @param {string} username - Nombre de usuario generado.
   * @param {string} [password] - Contraseña inicial (opcional, default = username).
   * @returns {Promise<boolean>}
   */
  async sendCredentialsEmail(email, nombres, username, password) {
    const frontUrl = FRONTEND_URL || 'http://localhost:3000';
    const loginLink = `${frontUrl}/login`;

    const htmlContent = buildBaseTemplate(`
      <div style="padding: 40px 30px;">
        <h2 style="color: #1e293b; margin-top: 0; font-size: 22px;">¡Hola, ${nombres}!</h2>
        <p style="color: #475569; line-height: 1.6; font-size: 15px;">
          Es un gusto darte la bienvenida a nuestra familia. Tu registro como <strong>Alumno</strong> se ha completado con éxito. 
          A continuación, encontrarás tus credenciales para acceder a nuestra plataforma:
        </p>

        <div style="background-color: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px; padding: 25px; margin: 30px 0; text-align: center;">
          <div style="margin-bottom: 15px;">
            <span style="display: block; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: bold; margin-bottom: 4px;">Nombre de usuario</span>
            <span style="color: #1e3a8a; font-size: 18px; font-weight: bold;">${username}</span>
          </div>
          <div>
            <span style="display: block; color: #64748b; font-size: 12px; text-transform: uppercase; font-weight: bold; margin-bottom: 4px;">Contraseña inicial</span>
            <span style="color: #1e3a8a; font-size: 18px; font-weight: bold;">${password ?? username}</span>
            <small style="display: block; color: #f97316; font-size: 11px; margin-top: 4px;">(Corresponde a tu nombre de usuario autogenerado)</small>
          </div>
        </div>

        <div style="text-align: center; margin-top: 35px;">
          <a href="${loginLink}" style="background-color: #f97316; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 10px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 10px 15px -3px rgba(249, 115, 22, 0.3);">
            Ingresar a la Plataforma
          </a>
        </div>

        <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-top: 40px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
          Por seguridad, te recomendamos cambiar tu contraseña desde tu perfil una vez que hayas ingresado.
        </p>
      </div>
    `);

    return this.send({
      to: email,
      toName: nombres,
      subject: `¡Bienvenido a ${COMPANY_NAME}! 🏐 Tus credenciales`,
      htmlContent,
    });
  },

  /**
   * Envía correo de feliz cumpleaños.
   * @param {string} email - Correo del destinatario.
   * @param {string} nombres - Nombres del usuario.
   * @returns {Promise<boolean>}
   */
  async sendBirthdayEmail(email, nombres) {
    const htmlContent = buildBaseTemplate(`
      <div style="padding: 40px 30px; text-align: center;">
        <h2 style="color: #1e293b; margin-top: 0; font-size: 24px;">¡Feliz Cumpleaños, ${nombres}! 🎉</h2>
        <p style="color: #475569; line-height: 1.6; font-size: 16px;">
          De parte de toda la familia de ${COMPANY_NAME} queremos desearte un día lleno de alegría y éxito.
        </p>
        <div style="font-size: 50px; margin: 20px 0;">🎂 🏐</div>
        <p style="color: #475569; line-height: 1.6; font-size: 16px;">
          Que disfrutes tu día al máximo y sigas alcanzando todas tus metas deportivas.
        </p>
      </div>
    `);

    return this.send({
      to: email,
      toName: nombres,
      subject: `¡Feliz Cumpleaños! 🎉🎂 - ${COMPANY_NAME}`,
      htmlContent,
    });
  },

  /**
   * Envía correo recordando deuda pendiente parcial.
   * @param {string} email - Correo del destinatario.
   * @param {string} nombres - Nombres del usuario.
   * @returns {Promise<boolean>}
   */
  async sendPartialPaymentReminder(email, nombres) {
    const htmlContent = buildBaseTemplate(`
      <div style="padding: 30px;">
        <h2 style="color: #1e293b; margin-top: 0; font-size: 20px;">Hola, ${nombres}</h2>
        <p style="color: #475569; line-height: 1.6; font-size: 15px;">
          Te recordamos amablemente que tienes un <strong>saldo pendiente (pago parcial)</strong> en tu mensualidad de ${COMPANY_NAME}.
        </p>
        <p style="color: #475569; line-height: 1.6; font-size: 15px;">
          Para evitar la suspensión de tus accesos o pérdida de beneficios de alumno antiguo, por favor regularízalo antes del cierre de tu ciclo de facturación.
        </p>
        
        <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin: 25px 0;">
          <p style="color: #92400e; margin: 0; font-size: 14px;">
            Si ya regularizaste tu pago en las últimas horas, por favor haz caso omiso a este mensaje.
          </p>
        </div>
      </div>
    `);

    return this.send({
      to: email,
      toName: nombres,
      subject: `Aviso Importante: Saldo Pendiente - ${COMPANY_NAME}`,
      htmlContent,
    });
  },
};
