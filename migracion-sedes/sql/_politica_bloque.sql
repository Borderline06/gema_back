\if :{?p_multisede}
\else
\set p_multisede ''
\endif
\if :{?p_cuentas}
\else
\set p_cuentas ''
\endif
\if :{?p_cuenta_mixta}
\else
\set p_cuenta_mixta ''
\endif
\if :{?p_cuenta_sin_link}
\else
\set p_cuenta_sin_link ''
\endif
\if :{?p_recup_destino_fuera}
\else
\set p_recup_destino_fuera ''
\endif
\if :{?p_recup_visitante}
\else
\set p_recup_visitante ''
\endif
\if :{?p_recup_ref_asistencia}
\else
\set p_recup_ref_asistencia ''
\endif
\if :{?p_alumnos_sin_inscripcion}
\else
\set p_alumnos_sin_inscripcion ''
\endif
\if :{?p_mov_sin_sede}
\else
\set p_mov_sin_sede ''
\endif
\if :{?p_admin_foraneo}
\else
\set p_admin_foraneo ''
\endif
\if :{?p_coord_foraneo}
\else
\set p_coord_foraneo ''
\endif
\if :{?p_publicaciones}
\else
\set p_publicaciones ''
\endif
\if :{?p_grupo_transaccion_mixto}
\else
\set p_grupo_transaccion_mixto ''
\endif
\if :{?p_refresh_tokens}
\else
\set p_refresh_tokens ''
\endif
\if :{?p_credenciales}
\else
\set p_credenciales ''
\endif

insert into _mig.politica(clave, valor, permitidos, descripcion)
select k, coalesce(nullif(ov, ''), def), perm, descr from (values
  ('multisede', :'p_multisede', 'duplicar', array['duplicar','excluir','solo_si_vigente_en_k'], 'Alumno con inscripciones en sedes elegidas y fuera'),
  ('cuentas', :'p_cuentas', 'por_alumno', array['por_alumno','por_inscripcion','ninguno'], 'Criterio del historial de cuentas/pagos/descuentos'),
  ('cuenta_mixta', :'p_cuenta_mixta', 'conservar', array['conservar','descartar','bloquear'], 'Cuenta ligada a inscripciones de sedes elegidas Y de fuera'),
  ('cuenta_sin_link', :'p_cuenta_sin_link', 'por_alumno', array['por_alumno','solo_alumno_unisede','descartar','bloquear'], 'Cuenta sin link a ninguna inscripcion (sede no deducible)'),
  ('recup_destino_fuera', :'p_recup_destino_fuera', 'eliminar', array['eliminar','destino_nulo','bloquear'], 'Recuperacion de alumno migrado con destino en sede no migrada'),
  ('recup_visitante', :'p_recup_visitante', 'eliminar', array['eliminar','incluir_alumno','bloquear'], 'Recuperacion con destino en sede migrada de alumno no inscrito alli'),
  ('recup_ref_asistencia', :'p_recup_ref_asistencia', 'anular_nuevos', array['dejar','anular_nuevos'], 'registro_asistencia_id (sin FK) que apuntaria a asistencia no migrada'),
  ('alumnos_sin_inscripcion', :'p_alumnos_sin_inscripcion', 'no_copiar', array['copiar','no_copiar'], 'Alumnos sin ninguna inscripcion (sede no deducible)'),
  ('mov_sin_sede', :'p_mov_sin_sede', 'no_copiar', array['copiar','no_copiar'], 'movimientos_financieros con sede_id NULL'),
  ('admin_foraneo', :'p_admin_foraneo', 'conservar', array['conservar','anular_referencia','bloquear'], 'Admin de sede no migrada referenciado por filas migradas'),
  ('coord_foraneo', :'p_coord_foraneo', 'conservar', array['conservar','anular_referencia','bloquear'], 'Coordinador que registro asistencia en sede migrada sin dictar alli'),
  ('publicaciones', :'p_publicaciones', 'solo_admin_conservado', array['solo_admin_conservado','no_copiar','copiar_todas'], 'Publicaciones (autor NOT NULL)'),
  ('grupo_transaccion_mixto', :'p_grupo_transaccion_mixto', 'permitir', array['permitir','bloquear'], 'Compra (id_grupo_transaccion) con inscripciones migradas y no migradas'),
  ('refresh_tokens', :'p_refresh_tokens', 'no_copiar', array['copiar','no_copiar'], 'Sesiones activas'),
  ('credenciales', :'p_credenciales', 'copiar', array['copiar','no_copiar'], 'Hash de credenciales (no_copiar = obliga a restablecer contrasena)')
) v(k, ov, def, perm, descr);
