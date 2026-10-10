import { ApiError } from '../../shared/utils/error.util.js';
import { VALID_ROLES } from '../roles/roles.constants.js';
import { registroLogic } from './logic/registro.logic.js';
import { prisma } from '../../config/database.config.js';

import { dashboardService } from './services/dashboard.service.js';
import { reporteService } from './services/reporte.service.js';
import { emailService } from '../../shared/services/brevo.email.service.js';

export const usuarioService = {
  createUser: async (userData) => {
    const {
      email,
      password,
      username: providedUsername,
      tipo_documento_id,
      numero_documento,
      rol_id,
      fecha_nacimiento,
      especializacion,
      sede_id,
      cargo,
      area,
      direccion_id,
      condiciones_medicas,
      seguro_medico,
      grupo_sanguineo,
      rolNombre: providedRolNombre,
      contacto_emergencia,
      parentesco,
      datosRolEspecifico,
      direccion,
      ...otrosdatos
    } = userData;

    const datosRol = {
      especializacion,
      sede_id,
      cargo,
      area,
      direccion_id,
      condiciones_medicas,
      seguro_medico,
      grupo_sanguineo,
      direccion,
      ...datosRolEspecifico,
    };

    const fechaConvertida = fecha_nacimiento ? new Date(fecha_nacimiento) : null;
    const rolNombre = providedRolNombre || rol_id || VALID_ROLES.ALUMNO;

    let rol;
    if (typeof rolNombre === 'string') {
      const rolNombreNormalizado =
        rolNombre.charAt(0).toUpperCase() + rolNombre.slice(1).toLowerCase();
      rol = await prisma.roles.findUnique({
        where: { nombre: rolNombreNormalizado },
        select: { id: true, nombre: true },
      });
    } else {
      rol = await prisma.roles.findUnique({
        where: { id: Number.parseInt(rolNombre) },
        select: { id: true, nombre: true },
      });
    }

    if (!rol) throw new ApiError(`El rol '${rolNombre}' no existe`, 400);

    if (tipo_documento_id && numero_documento) {
      const existeDocumento = await prisma.usuarios.findFirst({
        where: { tipo_documento_id, numero_documento },
        select: { id: true },
      });
      if (existeDocumento) {
        throw new ApiError(`El documento ${numero_documento} ya se encuentra registrado`, 400);
      }
    }

    if (providedUsername) {
      const existeUsername = await prisma.usuarios.findUnique({
        where: { username: providedUsername },
        select: { id: true },
      });
      if (existeUsername) {
        throw new ApiError(`El nombre de usuario '${providedUsername}' ya está en uso`, 400);
      }
    }

    const user = await prisma.$transaction(async (tx) => {
      const nuevoUsuario = await tx.usuarios.create({
        data: {
          username: `temp_${Date.now()}`,
          email: email || null,
          rol_id: rol.id,
          tipo_documento_id: tipo_documento_id || null,
          numero_documento: numero_documento || null,
          fecha_nacimiento: fechaConvertida,
          ...otrosdatos,
          activo: true,
        },
      });

      const finalUsername =
        providedUsername ||
        registroLogic.generarFallbackUsername(
          otrosdatos.nombres,
          otrosdatos.apellidos,
          nuevoUsuario.id
        );

      await tx.usuarios.update({
        where: { id: nuevoUsuario.id },
        data: { username: finalUsername },
      });

      nuevoUsuario.username = finalUsername;

      const passwordToHash = await registroLogic.crearCredenciales(
        tx,
        nuevoUsuario.id,
        finalUsername,
        password
      );

      await registroLogic.createRoleSpecificData(
        tx,
        rol.nombre.toLowerCase(),
        nuevoUsuario.id,
        datosRol
      );

      if (rol.nombre.toLowerCase() === 'alumno' && datosRolEspecifico) {
        await registroLogic.crearContactoEmergencia(
          tx,
          nuevoUsuario.id,
          otrosdatos.nombres,
          datosRolEspecifico.contacto_emergencia,
          datosRolEspecifico.parentesco
        );
      }

      // Hack para scope léxico: password autogenerado u originado
      nuevoUsuario.finalProvidedPassword = passwordToHash;

      return nuevoUsuario;
    });

    if (user.email) {
      emailService
        .sendCredentialsEmail(user.email, user.nombres, user.username, user.finalProvidedPassword)
        .catch(() => { });
    }

    return {
      id: user.id,
      username: providedUsername || user.username,
      email: user.email,
      nombres: user.nombres,
      rol: rol.nombre,
    };
  },

  getUserById: async (userId) => {
    const usuario = await prisma.usuarios.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        nombres: true,
        apellidos: true,
        telefono_personal: true,
        fecha_nacimiento: true,
        genero: true,
        tipo_documento_id: true,
        numero_documento: true,
        activo: true,
        roles: { select: { id: true, nombre: true } },
        alumnos: {
          select: {
            condiciones_medicas: true,
            seguro_medico: true,
            grupo_sanguineo: true,
            direccion_id: true,
            direcciones: {
              select: {
                id: true,
                direccion_completa: true,
                distrito: true,
                ciudad: true,
                referencia: true,
              },
            },
          },
        },
        coordinadores: { select: { usuario_id: true, especializacion: true } },
        administrador: {
          select: {
            usuario_id: true,
            cargo: true,
            area: true,
            sedes: { select: { id: true, nombre: true } },
          },
        },
      },
    });

    if (!usuario) throw new ApiError('Usuario no encontrado', 404);
    return usuario;
  },

  getUserByUsername: async (username) => {
    return await prisma.usuarios.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        email: true,
        nombres: true,
        apellidos: true,
        telefono_personal: true,
        rol_id: true,
        activo: true,
        roles: { select: { id: true, nombre: true } },
        alumnos: {
          select: { condiciones_medicas: true, seguro_medico: true, grupo_sanguineo: true },
        },
        credenciales_usuario: { select: { hash_contrasena: true } },
      },
    });
  },

  updateStudentProfile: async (userId, payload) => {
    const usuario = await prisma.usuarios.findUnique({
      where: { id: userId },
      select: {
        id: true,
        alumnos: {
          select: {
            usuario_id: true,
            direccion_id: true,
            direcciones: { select: { id: true } },
            alumnos_contactos: { where: { es_principal: true }, select: { id: true } },
          },
        },
        credenciales_usuario: { select: { usuario_id: true } },
      },
    });

    if (!usuario) throw new ApiError('Usuario no encontrado', 404);
    if (!usuario.alumnos) throw new ApiError('El usuario no corresponde a un alumno', 400);

    const usuarioId = userId;

    const {
      password,
      direccion_completa,
      distrito,
      ciudad,
      referencia,
      contacto_emergencia,
      datosRolEspecifico,
    } = payload;

    const direccion =
      direccion_completa !== undefined ||
        distrito !== undefined ||
        ciudad !== undefined ||
        referencia !== undefined
        ? { direccion_completa, distrito, ciudad, referencia }
        : null;

    const alumnoUpdates = {};
    if (datosRolEspecifico) {
      if (datosRolEspecifico.condiciones_medicas !== undefined) {
        alumnoUpdates.condiciones_medicas = datosRolEspecifico.condiciones_medicas;
      }
      if (datosRolEspecifico.seguro_medico !== undefined) {
        alumnoUpdates.seguro_medico = datosRolEspecifico.seguro_medico;
      }
      if (datosRolEspecifico.grupo_sanguineo !== undefined) {
        alumnoUpdates.grupo_sanguineo = datosRolEspecifico.grupo_sanguineo;
      }
    }

    return await prisma.$transaction(async (tx) => {
      if (password) {
        await registroLogic.crearCredenciales(tx, usuarioId, null, password);
      }

      if (Object.keys(alumnoUpdates).length > 0) {
        await tx.alumnos.update({
          where: { usuario_id: usuarioId },
          data: alumnoUpdates,
        });
      }

      if (direccion) {
        await tx.direcciones.upsert({
          where: { id: usuario.alumnos.direccion_id || 0 },
          update: {
            ...(direccion.direccion_completa && {
              direccion_completa: direccion.direccion_completa,
            }),
            ...(direccion.distrito && { distrito: direccion.distrito }),
            ...(direccion.ciudad && { ciudad: direccion.ciudad }),
            ...(direccion.referencia && { referencia: direccion.referencia }),
          },
          create: {
            direccion_completa: direccion.direccion_completa || '',
            distrito: direccion.distrito || '',
            ciudad: direccion.ciudad || 'Lima',
            referencia: direccion.referencia || null,
            alumnos: {
              connect: { usuario_id: usuarioId },
            },
          },
        });
      }

      if (contacto_emergencia) {
        await registroLogic.crearContactoEmergencia(
          tx,
          usuarioId,
          '',
          contacto_emergencia.telefono,
          contacto_emergencia.relacion
        );

        // Adenda: Fixeando la parte de upsert
        await tx.alumnos_contactos.updateMany({
          where: { alumno_id: usuarioId, es_principal: true },
          data: { nombre_completo: contacto_emergencia.nombre_completo },
        });
      }

      return await tx.usuarios.findUnique({
        where: { id: usuarioId },
        select: {
          id: true,
          username: true,
          email: true,
          nombres: true,
          apellidos: true,
          telefono_personal: true,
          fecha_nacimiento: true,
          genero: true,
          activo: true,
          roles: { select: { id: true, nombre: true } },
          alumnos: {
            select: {
              condiciones_medicas: true,
              seguro_medico: true,
              grupo_sanguineo: true,
              direcciones: {
                select: {
                  id: true,
                  direccion_completa: true,
                  distrito: true,
                  ciudad: true,
                  referencia: true,
                },
              },
              alumnos_contactos: {
                select: {
                  id: true,
                  nombre_completo: true,
                  telefono: true,
                  relacion: true,
                  es_principal: true,
                },
              },
            },
          },
        },
      });
    });
  },

  // getUsersByRol: async (rolOrId, sedeId) => {
  //   const isNumber = !Number.isNaN(Number(rolOrId));

  //   let whereClause = {
  //     activo: true,
  //     roles: isNumber
  //       ? { id: Number.parseInt(rolOrId) }
  //       : { nombre: { equals: rolOrId, mode: 'insensitive' } },
  //   };

  //   if (sedeId) {
  //     whereClause.alumnos = {
  //       inscripciones: {
  //         some: {
  //           horarios_clases: {
  //             canchas: {
  //               sede_id: Number.parseInt(sedeId),
  //             },
  //           },
  //         },
  //       },
  //     };
  //   }

  //   const usuarios = await prisma.usuarios.findMany({
  //     where: whereClause,
  //     include: {
  //       roles: true,
  //       // Solo trae los datos del rol, no vuelvas a incluir 'usuarios' dentro de ellos
  //       alumnos: {
  //         select: {
  //           condiciones_medicas: true,
  //           seguro_medico: true,
  //           grupo_sanguineo: true,
  //           alumnos_contactos: {
  //             select: {
  //               relacion: true,
  //               telefono: true,
  //             }
  //           },
  //           inscripciones: {
  //             select: {
  //               horarios_clases: {
  //                 select: {
  //                   canchas: {
  //                     select: {
  //                       sedes: {
  //                         select: {
  //                           id: true,
  //                           nombre: true,
  //                         }
  //                       }
  //                     }
  //                   }
  //                 }
  //               }
  //             }
  //           }
  //         }
  //       },
  //       coordinadores: {
  //         select: {
  //           especializacion: true,
  //         },
  //       },
  //     },
  //     orderBy: { nombres: 'asc' },
  //   });

  //   return usuarios;
  // },

  getUsersByRol: async (rolOrId, sedeId) => {
    const isNumber = !Number.isNaN(Number(rolOrId));

    let whereClause = {
      activo: true,
      roles: isNumber
        ? { id: Number.parseInt(rolOrId) }
        : { nombre: { equals: rolOrId, mode: 'insensitive' } },
    };

    if (sedeId) {
      // Regex estricto, no parseInt: parseInt('1.9x') daría 1 y filtraría por
      // la sede equivocada en silencio.
      const sedeBruto = String(sedeId).trim();
      if (!/^[0-9]+$/.test(sedeBruto) || Number(sedeBruto) <= 0) {
        throw new ApiError('El parámetro sede_id debe ser un entero positivo', 400);
      }
      const sedeIdInt = Number(sedeBruto);
      // 🎯 BL-008: solo las membresías ACTIVO cuentan para la pertenencia a una
      // sede; el historial de sedes pasadas queda fuera del filtro.
      whereClause.alumnos = {
        inscripciones: {
          some: {
            estado: 'ACTIVO',
            horarios_clases: {
              canchas: { sede_id: sedeIdInt },
            },
          },
        },
      };
    }

    return await prisma.usuarios.findMany({
      where: whereClause,
      select: {
        id: true,
        nombres: true,
        apellidos: true,
        numero_documento: true,
        telefono_personal: true,
        fecha_nacimiento: true,
        email: true,
        genero: true,
        username: true,
        alumnos: {
          select: {
            condiciones_medicas: true,
            seguro_medico: true,
            grupo_sanguineo: true,
            historial: true,
            direcciones: {
              select: {
                direccion_completa: true,
                distrito: true,
                ciudad: true,
                referencia: true
              }
            },

            // 🔥 NUEVO: Traemos las deudas pendientes del alumno
            cuentas_por_cobrar: {
              where: { estado: 'PENDIENTE' },
              select: { monto_final: true }
            },

            alumnos_contactos: {
              where: { es_principal: true },
              select: {
                nombre_completo: true,
                telefono: true,
                relacion: true
              }
            },
            inscripciones: {
              orderBy: { fecha_inscripcion: 'desc' },
              select: {
                estado: true,
                fecha_inscripcion: true,
                tipo_inscripcion: true,
                horarios_clases: {
                  select: {
                    hora_inicio: true,
                    hora_fin: true,
                    dia_semana: true,
                    niveles_entrenamiento: { select: { nombre: true } },
                    canchas: {
                      select: {
                        nombre: true,
                        sedes: { select: { nombre: true } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { nombres: 'asc' },
    });
  },

  async getReporteMaestro(fechaInicio, fechaFin) {
    const pagos = await prisma.pagos.findMany({
      where: {
        fecha_pago: {
          gte: fechaInicio ? new Date(`${fechaInicio}T00:00:00.000Z`) : undefined,
          lte: fechaFin ? new Date(`${fechaFin}T23:59:59.999Z`) : undefined,
        }
      },
      orderBy: { fecha_pago: 'desc' },
      include: {
        metodos_pago: {
          select: { nombre: true }
        },
        cuentas_por_cobrar: {
          include: {
            catalogo_conceptos: {
              select: { nombre: true }
            },
            // 🔥 PLAN A: Buscamos el link exacto de la deuda actual
            inscripciones_deudas_link: {
              include: {
                inscripciones: {
                  include: {
                    horarios_clases: {
                      include: {
                        niveles_entrenamiento: { select: { nombre: true } },
                        canchas: { include: { sedes: { select: { nombre: true } } } }
                      }
                    }
                  }
                }
              }
            },
            alumnos: {
              include: {
                usuarios: {
                  select: { nombres: true, apellidos: true }
                },
                // 🔥 PLAN B: Recuperamos tu código original. 
                // Traemos la última inscripción histórica por si falla el Plan A
                inscripciones: {
                  take: 1,
                  orderBy: { fecha_inscripcion: 'desc' },
                  include: {
                    horarios_clases: {
                      include: {
                        niveles_entrenamiento: { select: { nombre: true } },
                        canchas: { include: { sedes: { select: { nombre: true } } } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    return pagos.map(pago => {
      const cuenta = pago.cuentas_por_cobrar;
      const alumno = cuenta?.alumnos;
      const usuario = alumno?.usuarios;

      // INTENTO 1 (Plan A): Buscar por el link directo
      const links = cuenta?.inscripciones_deudas_link || [];
      let inscripcionAsociada = links[0]?.inscripciones;

      // INTENTO 2 (Plan B): Si la deuda no tiene link (pagos viejos/manuales), usamos su última inscripción
      if (!inscripcionAsociada && alumno?.inscripciones?.length > 0) {
        inscripcionAsociada = alumno.inscripciones[0];
      }

      const horario = inscripcionAsociada?.horarios_clases;

      return {
        "id": pago.id,
        "Fecha de Pago": pago.fecha_pago ? new Date(pago.fecha_pago).toLocaleDateString('es-PE') : 'N/A',
        "Fecha de Corte": cuenta?.fecha_vencimiento ? new Date(cuenta.fecha_vencimiento).toLocaleDateString('es-PE') : 'N/A',
        "Sede": horario?.canchas?.sedes?.nombre || 'Sin Sede',
        "Alumno": usuario ? `${usuario.nombres} ${usuario.apellidos}` : 'Desconocido',
        "Monto": Number(pago.monto_pagado).toFixed(2),
        "Medio de pago": pago.metodos_pago?.nombre || 'Otros',
        "Motivo": cuenta?.catalogo_conceptos?.nombre || cuenta?.detalle_adicional || 'Pago',
        "Nivel": horario?.niveles_entrenamiento?.nombre || 'Sin Nivel',
        "Talla": "No registrada",
        "Estado Deuda": cuenta?.estado || 'N/A',
        "Validación Admin": pago.estado_validacion || 'N/A',
        "Boleta/Factura": pago.comprobante_enviado || false,
        "Comentarios": pago.notas_validacion || ''
      };
    });
  },



  getUserByDni: async (dni) => {
    return await prisma.usuarios.findFirst({
      where: { numero_documento: dni },
      include: {
        alumnos: true // Traemos la info de alumno también por si acaso
      }
    });
  },
  // Rutas delegadas a servicios especialistas
  getDashboardStats: dashboardService.getDashboardStats,
  getGraficosAvanzados: dashboardService.getGraficosAvanzados,
  getDetailedExcelReport: reporteService.getDetailedExcelReport,
};
