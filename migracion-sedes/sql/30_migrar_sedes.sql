-- =====================================================================
-- MOTOR v2: extraccion de sedes por poda, GOBERNADA POR POLITICAS.
-- No se ejecuta directo: usar ../migrar.sh (inyecta el bloque de politicas).
--
--   ./migrar.sh <base_copia> '<ids sedes>' [preset] [clave=valor ...]
--
-- Todo se decide en _mig.politica (ver ../politicas/*.vars). Sin IDs fijos.
-- Siempre hace ROLLBACK salvo confirmar=1. Una politica 'bloquear' aborta con
-- un mensaje claro si aparece un caso. Nada se anula en silencio: cada SET NULL
-- es explicito, medido y queda en _mig.hallazgos / _mig.trazabilidad.
-- Solo para COPIAS desechables: borra datos.
-- =====================================================================
\set ON_ERROR_STOP on
\if :{?keep}
\else
\echo FALTA -v keep=...
\quit
\endif
begin;

drop schema if exists _mig cascade;
create schema _mig;

create table _mig.politica(clave text primary key, valor text not null, permitidos text[] not null, descripcion text);
-- @@POLITICA@@
do $$ declare r record; begin
  for r in select * from _mig.politica where valor <> all(permitidos) loop
    raise exception 'Politica % invalida: "%". Permitidos: %', r.clave, r.valor, r.permitidos;
  end loop;
end $$;

create function _mig.pol(k text) returns text language sql stable as $$ select valor from _mig.politica where clave = k $$;
create function _mig.bloqueo(k text, caso text, n bigint) returns void language plpgsql as $$
begin
  if n > 0 and _mig.pol(k) = 'bloquear' then
    raise exception 'POLITICA %=bloquear: % casos de "%". Defina otra opcion o resuelva el caso.', k, n, caso;
  end if;
end $$;
create function _mig.contar() returns table(tabla text, n bigint) language sql as $$
  select c.relname::text, (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I', c.relname), false, true, '')))[1]::text::bigint
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by 1 $$;
create function _mig.nulls_fk() returns table(tabla text, columna text, n_null bigint) language plpgsql as $f$
declare r record;
begin
  for r in select k.conrelid::regclass::text t, a.attname::text c from pg_constraint k
           join pg_attribute a on a.attrelid=k.conrelid and a.attnum = any(k.conkey)
           where k.contype='f' and k.connamespace='public'::regnamespace and not a.attnotnull loop
    tabla := r.t; columna := r.c;
    execute format('select count(*) from %s where %I is null', r.t, r.c) into n_null;
    return next;
  end loop;
end $f$;

create table _mig.hallazgos(codigo text, politica text, descripcion text, n bigint);
create table _mig.conteo_origen as select * from _mig.contar();
create table _mig.nulls_origen  as select * from _mig.nulls_fk();

-- ------------------------------------------------------------ sedes y horarios
create table _mig.k_sedes as select id from public.sedes where id = any(:'keep'::int[]);
do $$ begin
  if not exists (select 1 from _mig.k_sedes) then raise exception 'keep no coincide con ninguna sede'; end if;
end $$;
insert into _mig.hallazgos select 'KEEP_INEXISTENTE', null, 'ids de keep que no existen', count(*)
  from unnest(:'keep'::int[]) k where k not in (select id from _mig.k_sedes);
create table _mig.k_canchas  as select id from public.canchas where sede_id in (select id from _mig.k_sedes);
create table _mig.k_horarios as select id from public.horarios_clases where cancha_id in (select id from _mig.k_canchas);

-- --------------------------------------------------- alumnos multi-sede (politica multisede)
create table _mig.alumnos_multisede as
select i.alumno_id,
       array_agg(distinct c.sede_id order by c.sede_id) filter (where c.sede_id in (select id from _mig.k_sedes))     sedes_nuevo,
       array_agg(distinct c.sede_id order by c.sede_id) filter (where c.sede_id not in (select id from _mig.k_sedes)) sedes_madre,
       count(*) filter (where i.estado <> 'FINALIZADO') ins_vigentes,
       count(*) filter (where i.estado <> 'FINALIZADO' and c.sede_id in (select id from _mig.k_sedes))     ins_vigentes_k,
       count(*) filter (where i.estado <> 'FINALIZADO' and c.sede_id not in (select id from _mig.k_sedes)) ins_vigentes_madre
from public.inscripciones i join public.horarios_clases h on h.id=i.horario_id join public.canchas c on c.id=h.cancha_id
group by i.alumno_id
having bool_or(c.sede_id in (select id from _mig.k_sedes)) and bool_or(c.sede_id not in (select id from _mig.k_sedes));

create table _mig.alumnos_excluidos as
select alumno_id id from _mig.alumnos_multisede
where _mig.pol('multisede') = 'excluir' or (_mig.pol('multisede') = 'solo_si_vigente_en_k' and ins_vigentes_k = 0);

create table _mig.k_ins as
select id from public.inscripciones
where horario_id in (select id from _mig.k_horarios) and alumno_id not in (select id from _mig.alumnos_excluidos);

create table _mig.alumnos_base as select distinct alumno_id id from public.inscripciones where id in (select id from _mig.k_ins);

-- recuperaciones "visitantes" (destino en sede migrada, alumno sin inscripcion alli)
create table _mig.recup_visitante as
select r.id, r.alumno_id from public.recuperaciones r
where r.horario_destino_id in (select id from _mig.k_horarios)
  and r.alumno_id not in (select id from _mig.alumnos_base) and r.alumno_id not in (select id from _mig.alumnos_excluidos);
insert into _mig.hallazgos select 'RECUP_VISITANTE','recup_visitante','recuperaciones con destino en sede migrada de alumnos no inscritos alli', count(*) from _mig.recup_visitante;
select _mig.bloqueo('recup_visitante','RECUP_VISITANTE',(select count(*) from _mig.recup_visitante));

create table _mig.alumnos_sin_ins as
select usuario_id id from public.alumnos a where not exists (select 1 from public.inscripciones i where i.alumno_id=a.usuario_id);
insert into _mig.hallazgos select 'ALUMNOS_SIN_INSCRIPCION','alumnos_sin_inscripcion','alumnos sin inscripcion (sede no deducible)', count(*) from _mig.alumnos_sin_ins;

create table _mig.k_alumnos as
select id from _mig.alumnos_base
union select alumno_id from _mig.recup_visitante where _mig.pol('recup_visitante')='incluir_alumno'
union select id from _mig.alumnos_sin_ins where _mig.pol('alumnos_sin_inscripcion')='copiar';

-- ------------------------------------------------------------ recuperaciones
insert into _mig.hallazgos select 'RECUP_DESTINO_FUERA','recup_destino_fuera','recuperaciones de alumnos migrados con destino en sede no migrada', count(*)
  from public.recuperaciones r where r.alumno_id in (select id from _mig.k_alumnos) and r.horario_destino_id is not null and r.horario_destino_id not in (select id from _mig.k_horarios);
select _mig.bloqueo('recup_destino_fuera','RECUP_DESTINO_FUERA',(select n from _mig.hallazgos where codigo='RECUP_DESTINO_FUERA'));

-- ------------------------------------------------------------ coordinadores
create table _mig.coord_docentes as
select distinct coordinador_id id from public.horarios_clases where id in (select id from _mig.k_horarios) and coordinador_id is not null;
create table _mig.coord_foraneos as
select distinct registrado_por id from public.registros_asistencia where inscripcion_id in (select id from _mig.k_ins) and registrado_por is not null
except select id from _mig.coord_docentes;
insert into _mig.hallazgos select 'COORD_FORANEO','coord_foraneo','coordinadores que registraron asistencia migrada sin dictar en sedes migradas', count(*) from _mig.coord_foraneos;
select _mig.bloqueo('coord_foraneo','COORD_FORANEO',(select count(*) from _mig.coord_foraneos));
create table _mig.k_coord as
select id from _mig.coord_docentes union select id from _mig.coord_foraneos where _mig.pol('coord_foraneo')='conservar';

-- ------------------------------------------------------------ cuentas
create table _mig.cuentas_clasif as
select cp.id, cp.alumno_id,
  exists (select 1 from public.inscripciones_deudas_link l where l.cuenta_id=cp.id) tiene_link,
  exists (select 1 from public.inscripciones_deudas_link l where l.cuenta_id=cp.id and l.inscripcion_id in (select id from _mig.k_ins))     en_k,
  exists (select 1 from public.inscripciones_deudas_link l where l.cuenta_id=cp.id and l.inscripcion_id not in (select id from _mig.k_ins)) fuera_k,
  cp.alumno_id in (select alumno_id from _mig.alumnos_multisede) alumno_multisede
from public.cuentas_por_cobrar cp;

insert into _mig.hallazgos select 'CUENTA_MIXTA','cuenta_mixta','cuentas de alumnos migrados ligadas a inscripciones migradas y no migradas', count(*)
  from _mig.cuentas_clasif where alumno_id in (select id from _mig.k_alumnos) and en_k and fuera_k;
insert into _mig.hallazgos select 'CUENTA_SIN_LINK','cuenta_sin_link','cuentas de alumnos migrados sin link a inscripcion', count(*)
  from _mig.cuentas_clasif where alumno_id in (select id from _mig.k_alumnos) and not tiene_link;
insert into _mig.hallazgos select 'CUENTA_SIN_LINK_MULTISEDE','cuenta_sin_link','  de ellas, de alumnos multi-sede (ambiguas)', count(*)
  from _mig.cuentas_clasif where alumno_id in (select id from _mig.k_alumnos) and not tiene_link and alumno_multisede;
select _mig.bloqueo('cuenta_mixta','CUENTA_MIXTA',(select n from _mig.hallazgos where codigo='CUENTA_MIXTA')) where _mig.pol('cuentas')<>'ninguno';
select _mig.bloqueo('cuenta_sin_link','CUENTA_SIN_LINK',(select n from _mig.hallazgos where codigo='CUENTA_SIN_LINK')) where _mig.pol('cuentas')<>'ninguno';

create table _mig.k_cuentas as
select id from _mig.cuentas_clasif c
where _mig.pol('cuentas') <> 'ninguno' and alumno_id in (select id from _mig.k_alumnos)
  and case when tiene_link then
        (case _mig.pol('cuentas') when 'por_alumno' then true else en_k end)
        and not (en_k and fuera_k and _mig.pol('cuenta_mixta') in ('descartar','bloquear'))
      else
        case _mig.pol('cuenta_sin_link') when 'por_alumno' then true when 'solo_alumno_unisede' then not alumno_multisede else false end
      end;

-- ------------------------------------------------------------ movimientos
create table _mig.k_mov as
select id from public.movimientos_financieros
where sede_id in (select id from _mig.k_sedes) or (sede_id is null and _mig.pol('mov_sin_sede')='copiar');
insert into _mig.hallazgos select 'MOV_SEDE_NULL','mov_sin_sede','movimientos sin sede', count(*) from public.movimientos_financieros where sede_id is null;
insert into _mig.hallazgos select 'MOV_OTRA_SEDE',null,'movimientos de sedes no migradas (no se copian)', count(*) from public.movimientos_financieros where sede_id is not null and sede_id not in (select id from _mig.k_sedes);

-- ------------------------------------------------------------ administradores
create table _mig.admin_sede as select usuario_id id from public.administrador where sede_id in (select id from _mig.k_sedes);
create table _mig.admin_ref as
  select revisado_por id from public.pagos where cuenta_id in (select id from _mig.k_cuentas) and revisado_por is not null
  union select aplicado_por from public.descuentos_aplicados where cuenta_id in (select id from _mig.k_cuentas) and aplicado_por is not null
  union select revisado_por from public.solicitudes_lesion where alumno_id in (select id from _mig.k_alumnos) and revisado_por is not null
  union select registrado_por from public.movimientos_financieros where id in (select id from _mig.k_mov) and registrado_por is not null
  union select asignado_por from public.beneficios_pendientes where alumno_id in (select id from _mig.k_alumnos) and asignado_por in (select usuario_id from public.administrador)
  union select autor_id from public.publicaciones where _mig.pol('publicaciones')='copiar_todas';
create table _mig.admin_foraneos as
select id from _mig.admin_ref where id not in (select id from _mig.admin_sede);
insert into _mig.hallazgos select 'ADMIN_FORANEO','admin_foraneo','admins de otras sedes referenciados por filas migradas', count(*) from _mig.admin_foraneos;
select _mig.bloqueo('admin_foraneo','ADMIN_FORANEO',(select count(*) from _mig.admin_foraneos));
create table _mig.k_admin as
select id from _mig.admin_sede union select id from _mig.admin_foraneos where _mig.pol('admin_foraneo')='conservar';

create table _mig.k_usuarios as select id from _mig.k_alumnos union select id from _mig.k_coord union select id from _mig.k_admin;

-- ------------------------------------------------------------ otras mediciones
insert into _mig.hallazgos select 'GRUPO_TRANS_MIXTO','grupo_transaccion_mixto','id_grupo_transaccion con inscripciones migradas y no migradas', count(*)
  from (select id_grupo_transaccion from public.inscripciones where id_grupo_transaccion is not null group by 1
        having bool_or(id in (select id from _mig.k_ins)) and bool_or(id not in (select id from _mig.k_ins))) x;
select _mig.bloqueo('grupo_transaccion_mixto','GRUPO_TRANS_MIXTO',(select n from _mig.hallazgos where codigo='GRUPO_TRANS_MIXTO'));
insert into _mig.hallazgos select 'CONGELAMIENTO_SIN_INSCRIPCION',null,'congelamientos sin inscripcion (se resuelven por alumno de la lesion)', count(*) from public.congelamientos where inscripcion_id is null;
insert into _mig.hallazgos select 'REPROG_CREADOR_ANULADO',null,'reprogramaciones migradas cuyo creador no migra (creado_por queda NULL)', count(*)
  from public.reprogramaciones_clases where horario_id in (select id from _mig.k_horarios) and creado_por is not null and creado_por not in (select id from _mig.k_usuarios);
insert into _mig.hallazgos select 'USUARIO_DOBLE_PERFIL',null,'usuarios migrados con perfil de alumno y coordinador', count(*)
  from (select id from _mig.k_alumnos intersect select id from _mig.k_coord) x;
insert into _mig.hallazgos select 'ADMIN_SEDE_ANULADA',null,'admins conservados cuya sede no migra (sede_id queda NULL)', count(*)
  from public.administrador where usuario_id in (select id from _mig.k_admin) and (sede_id is null or sede_id not in (select id from _mig.k_sedes));

-- ------------------------------------------------------------ trazabilidad (que migra y bajo que regla)
create table _mig.trazabilidad(entidad text, id bigint, destino text, regla text, compartido boolean);
insert into _mig.trazabilidad
select 'alumno', a.usuario_id,
  case when a.usuario_id in (select id from _mig.k_alumnos) then 'NUEVO' else 'NO_MIGRA' end,
  case when a.usuario_id in (select id from _mig.k_alumnos) then
         case when a.usuario_id in (select id from _mig.alumnos_base) then 'inscripcion_en_sede'
              when a.usuario_id in (select alumno_id from _mig.recup_visitante) then 'visitante_recuperacion'
              else 'sin_inscripcion_copiado' end
       when a.usuario_id in (select id from _mig.alumnos_excluidos) then 'multisede_excluido'
       when a.usuario_id in (select id from _mig.alumnos_sin_ins) then 'sin_inscripcion_no_copiado'
       else 'otra_sede' end,
  a.usuario_id in (select alumno_id from _mig.alumnos_multisede)
from public.alumnos a;
insert into _mig.trazabilidad
select 'inscripcion', i.id, case when i.id in (select id from _mig.k_ins) then 'NUEVO' else 'NO_MIGRA' end,
  case when i.id in (select id from _mig.k_ins) then 'horario_en_sede'
       when i.horario_id in (select id from _mig.k_horarios) then 'alumno_excluido' else 'otra_sede' end, false
from public.inscripciones i;
insert into _mig.trazabilidad
select 'cuenta', c.id, case when c.id in (select id from _mig.k_cuentas) then 'NUEVO' else 'NO_MIGRA' end,
  case when c.id in (select id from _mig.k_cuentas) then
         case when not c.tiene_link then 'sin_link_'||_mig.pol('cuenta_sin_link') when c.en_k and c.fuera_k then 'mixta_'||_mig.pol('cuenta_mixta') else 'cuentas_'||_mig.pol('cuentas') end
       when _mig.pol('cuentas')='ninguno' then 'politica_cuentas_ninguno'
       when c.alumno_id not in (select id from _mig.k_alumnos) then 'alumno_no_migra'
       when not c.tiene_link then 'sin_link_'||_mig.pol('cuenta_sin_link')
       when c.en_k and c.fuera_k then 'mixta_'||_mig.pol('cuenta_mixta')
       else 'solo_fuera_de_sedes' end,
  (c.en_k and c.fuera_k)
from _mig.cuentas_clasif c;
insert into _mig.trazabilidad
select 'recuperacion', r.id,
  case when r.alumno_id in (select id from _mig.k_alumnos) and (r.horario_destino_id is null or r.horario_destino_id in (select id from _mig.k_horarios) or _mig.pol('recup_destino_fuera')='destino_nulo') then 'NUEVO' else 'NO_MIGRA' end,
  case when r.alumno_id not in (select id from _mig.k_alumnos) then 'alumno_no_migra'
       when r.horario_destino_id is not null and r.horario_destino_id not in (select id from _mig.k_horarios) then 'destino_fuera_'||_mig.pol('recup_destino_fuera')
       else 'alumno_migrado' end,
  r.horario_destino_id is not null and r.horario_destino_id not in (select id from _mig.k_horarios)
from public.recuperaciones r;

-- ------------------------------------------------------------ borrado en orden de FK
create table _mig.asist_borradas as select id from public.registros_asistencia where inscripcion_id not in (select id from _mig.k_ins);
delete from public.registros_asistencia where inscripcion_id not in (select id from _mig.k_ins);
update public.registros_asistencia set registrado_por = null
 where _mig.pol('coord_foraneo')='anular_referencia' and registrado_por in (select id from _mig.coord_foraneos);

-- congelamientos.inscripcion_id es nullable: "NOT IN" con NULL no borra -> se liga al alumno por la lesion
delete from public.congelamientos c
 where (c.inscripcion_id is not null and c.inscripcion_id not in (select id from _mig.k_ins))
    or (c.inscripcion_id is null and not exists (select 1 from public.solicitudes_lesion s where s.id=c.solicitud_lesion_id and s.alumno_id in (select id from _mig.k_alumnos)));

delete from public.recuperaciones where alumno_id not in (select id from _mig.k_alumnos);
delete from public.recuperaciones where _mig.pol('recup_destino_fuera')='eliminar' and horario_destino_id is not null and horario_destino_id not in (select id from _mig.k_horarios);
update public.recuperaciones set horario_destino_id = null where _mig.pol('recup_destino_fuera')='destino_nulo' and horario_destino_id is not null and horario_destino_id not in (select id from _mig.k_horarios);
create table _mig.recup_ref_anuladas as
  select id from public.recuperaciones where _mig.pol('recup_ref_asistencia')='anular_nuevos' and registro_asistencia_id in (select id from _mig.asist_borradas);
update public.recuperaciones set registro_asistencia_id = null where id in (select id from _mig.recup_ref_anuladas);
insert into _mig.hallazgos select 'RECUP_REF_ASISTENCIA_ANULADA','recup_ref_asistencia','recuperaciones migradas cuyo registro_asistencia_id apuntaba a asistencia no migrada (queda NULL)', count(*) from _mig.recup_ref_anuladas;

delete from public.inscripciones where id not in (select id from _mig.k_ins);       -- link: CASCADE

delete from public.descuentos_aplicados where cuenta_id not in (select id from _mig.k_cuentas);
delete from public.pagos                where cuenta_id not in (select id from _mig.k_cuentas);
delete from public.cuentas_por_cobrar   where id not in (select id from _mig.k_cuentas);

delete from public.movimientos_financieros where id not in (select id from _mig.k_mov);   -- explicito: evita SET NULL al borrar sede

delete from public.beneficios_pendientes where alumno_id not in (select id from _mig.k_alumnos);
delete from public.alumnos_contactos     where alumno_id not in (select id from _mig.k_alumnos);
delete from public.solicitudes_lesion    where alumno_id not in (select id from _mig.k_alumnos);

-- referencias a admin anuladas (solo admin_foraneo = anular_referencia)
update public.pagos set revisado_por = null where _mig.pol('admin_foraneo')='anular_referencia' and revisado_por in (select id from _mig.admin_foraneos);
update public.descuentos_aplicados set aplicado_por = null where _mig.pol('admin_foraneo')='anular_referencia' and aplicado_por in (select id from _mig.admin_foraneos);
update public.solicitudes_lesion set revisado_por = null where _mig.pol('admin_foraneo')='anular_referencia' and revisado_por in (select id from _mig.admin_foraneos);
update public.movimientos_financieros set registrado_por = null where _mig.pol('admin_foraneo')='anular_referencia' and registrado_por in (select id from _mig.admin_foraneos);
delete from public.beneficios_pendientes where _mig.pol('admin_foraneo')='anular_referencia' and asignado_por in (select id from _mig.admin_foraneos);   -- asignado_por NOT NULL

delete from public.publicaciones
 where _mig.pol('publicaciones')='no_copiar' or autor_id not in (select id from _mig.k_admin);
delete from public.administrador where usuario_id not in (select id from _mig.k_admin);
update public.administrador set sede_id = null where sede_id is not null and sede_id not in (select id from _mig.k_sedes);

update public.reprogramaciones_clases set creado_por = null
 where horario_id in (select id from _mig.k_horarios) and creado_por is not null and creado_por not in (select id from _mig.k_usuarios);

delete from public.canchas  where id not in (select id from _mig.k_canchas);          -- horarios y reprogramaciones: CASCADE
delete from public.sedes    where id not in (select id from _mig.k_sedes);

-- notificaciones: dueno = alumno_id (FK SET NULL) -> borrado explicito, o quedarian huerfanas
delete from public.notificaciones n
 where not (coalesce(n.alumno_id in (select id from _mig.k_alumnos), false)
         or coalesce(n.usuario_id in (select id from _mig.k_usuarios), false));

delete from public.alumnos       where usuario_id not in (select id from _mig.k_alumnos);
delete from public.coordinadores where usuario_id not in (select id from _mig.k_coord);
delete from public.usuarios      where id not in (select id from _mig.k_usuarios);
delete from public.refresh_tokens where _mig.pol('refresh_tokens')='no_copiar';
delete from public.credenciales_usuario where _mig.pol('credenciales')='no_copiar';
delete from public.direcciones d
 where not exists (select 1 from public.alumnos a where a.direccion_id=d.id) and not exists (select 1 from public.sedes s where s.direccion_id=d.id);

create table _mig.conteo_final as select * from _mig.contar();
create table _mig.nulls_final  as select * from _mig.nulls_fk();

-- ------------------------------------------------------------ reporte
\echo
\echo ===== POLITICA APLICADA =====
select clave, valor from _mig.politica order by clave;
\echo ===== HALLAZGOS (n>0: requiere decision; "politica" indica quien lo gobierna) =====
select codigo, politica, n, descripcion from _mig.hallazgos where n > 0 order by codigo;
\echo ===== TRAZABILIDAD (entidad / destino / regla) =====
select entidad, destino, regla, count(*) n, count(*) filter (where compartido) compartidos from _mig.trazabilidad group by 1,2,3 order by 1,2,3;
\echo ===== CONTEO origen vs final (solo tablas que cambian) =====
select o.tabla, o.n origen, f.n final, o.n - f.n eliminados from _mig.conteo_origen o join _mig.conteo_final f using (tabla) where o.n <> f.n order by 1;
\echo ===== SET NULL: columnas FK con mas NULL que en origen (cada una debe estar explicada arriba) =====
select o.tabla, o.columna, o.n_null origen, f.n_null final from _mig.nulls_origen o join _mig.nulls_final f using (tabla, columna) where f.n_null > o.n_null order by 1,2;

\if :{?confirmar}
commit;
\echo >>> COMMIT: poda persistida en esta base.
\else
rollback;
\echo >>> ROLLBACK (dry-run). Use confirmar=1 para persistir.
\endif
