-- =====================================================================
-- PROTOTIPO: extraccion de sedes por poda (copy -> prune) en una COPIA.
--
-- USO (sobre una copia desechable, NUNCA sobre produccion ni sobre bankhub):
--   psql -d <copia> -v ON_ERROR_STOP=1 -v keep='{11,12}' -f 10_extraer_sedes.sql
--
--   keep = ids de sedes que se CONSERVAN (las del sistema nuevo).
--   No hay IDs fijos en el script; todo se deriva de :keep.
--
-- Principios:
--   * No se deshabilitan constraints ni triggers. El orden de borrado respeta las FK.
--   * Nada se anula en silencio: antes de cada borrado que arrastraria un
--     SET NULL/CASCADE se mide y se deja en _mig.hallazgos.
--   * Las decisiones de negocio NO confirmadas estan marcadas con [REVISAR].
--   * Resultado auxiliar (para el cliente): _mig.alumnos_multisede,
--     _mig.conteo_origen / _mig.conteo_final, _mig.hallazgos.
-- =====================================================================
\set ON_ERROR_STOP on
begin;

drop schema if exists _mig cascade;
create schema _mig;

create table _mig.hallazgos(codigo text, descripcion text, n bigint);

create function _mig.contar() returns table(tabla text, n bigint) language sql as $$
  select c.relname::text,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I', c.relname), false, true, '')))[1]::text::bigint
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by 1
$$;
create table _mig.conteo_origen as select * from _mig.contar();

-- Detector generico de "SET NULL silencioso": cuenta NULLs de toda columna FK nullable
create function _mig.nulls_fk() returns table(tabla text, columna text, n_null bigint) language plpgsql as $f$
declare r record;
begin
  for r in select k.conrelid::regclass::text t, a.attname::text c
           from pg_constraint k join pg_attribute a on a.attrelid=k.conrelid and a.attnum = any(k.conkey)
           where k.contype='f' and k.connamespace='public'::regnamespace and not a.attnotnull
  loop
    tabla := r.t; columna := r.c;
    execute format('select count(*) from %s where %I is null', r.t, r.c) into n_null;
    return next;
  end loop;
end $f$;
create table _mig.nulls_origen as select * from _mig.nulls_fk();

-- ---------------------------------------------------------------- 0. sedes
create table _mig.k_sedes as select id from public.sedes where id = any(:'keep'::int[]);
insert into _mig.hallazgos select 'KEEP_INEXISTENTE', 'ids pedidos en keep que no existen en sedes', count(*)
  from unnest(:'keep'::int[]) k where k not in (select id from _mig.k_sedes);

-- ----------------------------------------------- 1. conjuntos "a conservar"
create table _mig.k_canchas  as select id from public.canchas where sede_id in (select id from _mig.k_sedes);
create table _mig.k_horarios as select id from public.horarios_clases where cancha_id in (select id from _mig.k_canchas);
create table _mig.k_ins      as select id from public.inscripciones where horario_id in (select id from _mig.k_horarios);

-- alumnos: los que tienen >=1 inscripcion en una sede conservada (cualquier estado)
create table _mig.k_alumnos  as select distinct alumno_id id from public.inscripciones where id in (select id from _mig.k_ins);

-- Foto de alumnos multi-sede (origen) ANTES de borrar: es la lista a duplicar / decidir
create table _mig.alumnos_multisede as
select i.alumno_id,
       array_agg(distinct c.sede_id order by c.sede_id) filter (where c.sede_id in (select id from _mig.k_sedes))     sedes_nuevo,
       array_agg(distinct c.sede_id order by c.sede_id) filter (where c.sede_id not in (select id from _mig.k_sedes)) sedes_madre,
       count(*) filter (where i.estado <> 'FINALIZADO') ins_vigentes
from public.inscripciones i join public.horarios_clases h on h.id=i.horario_id join public.canchas c on c.id=h.cancha_id
group by i.alumno_id
having bool_or(c.sede_id in (select id from _mig.k_sedes)) and bool_or(c.sede_id not in (select id from _mig.k_sedes));

-- coordinadores: los que dictan en K + los que registraron asistencia de inscripciones K (FK registros_asistencia.registrado_por)
create table _mig.k_coord as
  select coordinador_id id from public.horarios_clases where id in (select id from _mig.k_horarios) and coordinador_id is not null
  union select registrado_por from public.registros_asistencia where inscripcion_id in (select id from _mig.k_ins) and registrado_por is not null;

insert into _mig.hallazgos select 'COORD_DE_OTRA_SEDE', 'coordinadores conservados solo porque registraron asistencia de una inscripcion K (no dictan en K) [REVISAR]', count(*)
  from _mig.k_coord where id not in (select coordinador_id from public.horarios_clases where id in (select id from _mig.k_horarios) and coordinador_id is not null);

-- cuentas por cobrar: criterio a nivel ALUMNO (todas las del alumno conservado) [REVISAR: ver hallazgos de cuentas mixtas]
create table _mig.k_cuentas as select id from public.cuentas_por_cobrar where alumno_id in (select id from _mig.k_alumnos);

insert into _mig.hallazgos
select 'CUENTA_LINK_MIXTO', 'cuentas conservadas ligadas a inscripciones de K y de fuera de K (un pago cubre ambos sistemas) [REVISAR]', count(*)
from (select l.cuenta_id from public.inscripciones_deudas_link l join _mig.k_cuentas kc on kc.id=l.cuenta_id
      group by l.cuenta_id having bool_or(l.inscripcion_id in (select id from _mig.k_ins)) and bool_or(l.inscripcion_id not in (select id from _mig.k_ins))) x;
insert into _mig.hallazgos
select 'CUENTA_SIN_LINK', 'cuentas conservadas sin link a inscripcion (sede no determinable; se conservan por alumno) [REVISAR]', count(*)
from public.cuentas_por_cobrar cp where cp.id in (select id from _mig.k_cuentas) and not exists (select 1 from public.inscripciones_deudas_link l where l.cuenta_id=cp.id);
insert into _mig.hallazgos
select 'CUENTA_SIN_LINK_ALUMNO_MULTISEDE', '  de ellas, de alumnos multi-sede (ambiguas: podrian ser de la sede madre) [REVISAR]', count(*)
from public.cuentas_por_cobrar cp where cp.id in (select id from _mig.k_cuentas) and cp.alumno_id in (select alumno_id from _mig.alumnos_multisede)
  and not exists (select 1 from public.inscripciones_deudas_link l where l.cuenta_id=cp.id);

-- administradores: los de sedes K + los referenciados por filas conservadas (FK NO ACTION)
create table _mig.k_admin as
  select usuario_id id from public.administrador where sede_id in (select id from _mig.k_sedes)
  union select revisado_por from public.pagos where cuenta_id in (select id from _mig.k_cuentas) and revisado_por is not null
  union select aplicado_por from public.descuentos_aplicados where cuenta_id in (select id from _mig.k_cuentas) and aplicado_por is not null
  union select revisado_por from public.solicitudes_lesion where alumno_id in (select id from _mig.k_alumnos) and revisado_por is not null;
insert into _mig.hallazgos select 'ADMIN_FORANEO_REFERENCIADO', 'administradores fuera de K conservados porque pagos/descuentos/lesiones conservados los referencian [REVISAR]', count(*)
  from _mig.k_admin where id not in (select usuario_id from public.administrador where sede_id in (select id from _mig.k_sedes));
insert into _mig.hallazgos select 'ADMIN_SIN_SEDE', 'administradores sin sede_id (no determinable)', count(*) from public.administrador where sede_id is null;

-- ---------------------------------------- 2. mediciones previas a SET NULL/DELETE
insert into _mig.hallazgos select 'RECUP_DESTINO_FUERA', 'recuperaciones de alumnos K con horario_destino fuera de K (se eliminan) [REVISAR]', count(*)
  from public.recuperaciones r where r.alumno_id in (select id from _mig.k_alumnos) and r.horario_destino_id is not null and r.horario_destino_id not in (select id from _mig.k_horarios);
insert into _mig.hallazgos select 'RECUP_DESTINO_K_ALUMNO_FUERA', 'recuperaciones con destino en K de alumnos que NO son K (alumno sin inscripcion en K; se eliminan) [REVISAR]', count(*)
  from public.recuperaciones r where r.horario_destino_id in (select id from _mig.k_horarios) and r.alumno_id not in (select id from _mig.k_alumnos);
insert into _mig.hallazgos select 'MOV_SEDE_NULL', 'movimientos_financieros sin sede (no se conservan) [REVISAR: gastos generales del club]', count(*)
  from public.movimientos_financieros where sede_id is null;
insert into _mig.hallazgos select 'MOV_OTRA_SEDE', 'movimientos_financieros de sedes fuera de K (no se conservan)', count(*)
  from public.movimientos_financieros where sede_id is not null and sede_id not in (select id from _mig.k_sedes);
insert into _mig.hallazgos select 'ALUMNOS_SIN_INSCRIPCION', 'alumnos sin ninguna inscripcion (sede no determinable; NO se conservan) [REVISAR]', count(*)
  from public.alumnos a where not exists (select 1 from public.inscripciones i where i.alumno_id=a.usuario_id);
insert into _mig.hallazgos select 'GRUPO_TRANS_MIXTO', 'id_grupo_transaccion con inscripciones K y no-K (compra unica partida entre sistemas) [REVISAR]', count(*)
  from (select id_grupo_transaccion from public.inscripciones where id_grupo_transaccion is not null group by 1
        having bool_or(id in (select id from _mig.k_ins)) and bool_or(id not in (select id from _mig.k_ins))) x;
insert into _mig.hallazgos select 'REPROG_CREADOR_PERDIDO', 'reprogramaciones conservadas cuyo creado_por no se conserva (quedaria NULL)', count(*)
  from public.reprogramaciones_clases r where r.horario_id in (select id from _mig.k_horarios) and r.creado_por is not null
   and r.creado_por not in (select usuario_id from public.coordinadores where usuario_id in (select id from _mig.k_coord)
        union select id from _mig.k_admin union select id from _mig.k_alumnos);
insert into _mig.hallazgos select 'USUARIO_DOBLE_PERFIL', 'usuarios conservados con mas de un perfil (alumno+coordinador) [REVISAR]', count(*)
  from (select id from _mig.k_alumnos intersect select id from _mig.k_coord) x;

insert into _mig.hallazgos select 'CONGELAMIENTO_SIN_INSCRIPCION', 'congelamientos con inscripcion_id NULL: sede solo deducible por alumno de la lesion [REVISAR]', count(*) from public.congelamientos where inscripcion_id is null;

-- ------------------------------------------------ 3. borrado en orden de FK
-- hojas de inscripciones
delete from public.registros_asistencia where inscripcion_id not in (select id from _mig.k_ins);
-- OJO NULL: congelamientos.inscripcion_id es nullable; "NOT IN" con NULL no borra. Se liga al alumno por la lesion.
delete from public.congelamientos c
 where (c.inscripcion_id is not null and c.inscripcion_id not in (select id from _mig.k_ins))
    or (c.inscripcion_id is null and not exists (select 1 from public.solicitudes_lesion s where s.id=c.solicitud_lesion_id and s.alumno_id in (select id from _mig.k_alumnos)));

-- recuperaciones: lo que no es de alumno K o apunta a un horario que desaparece
delete from public.recuperaciones
 where alumno_id not in (select id from _mig.k_alumnos)
    or (horario_destino_id is not null and horario_destino_id not in (select id from _mig.k_horarios));

delete from public.inscripciones where id not in (select id from _mig.k_ins);   -- inscripciones_deudas_link: CASCADE

-- finanzas de alumnos no K
delete from public.descuentos_aplicados where cuenta_id not in (select id from _mig.k_cuentas);
delete from public.pagos                where cuenta_id not in (select id from _mig.k_cuentas);
delete from public.cuentas_por_cobrar   where id not in (select id from _mig.k_cuentas);   -- link: CASCADE

-- movimientos: se borran explicitamente (evita el SET NULL silencioso al borrar la sede)
delete from public.movimientos_financieros where sede_id is null or sede_id not in (select id from _mig.k_sedes);

-- resto de datos del alumno
delete from public.beneficios_pendientes where alumno_id not in (select id from _mig.k_alumnos);
delete from public.alumnos_contactos     where alumno_id not in (select id from _mig.k_alumnos);
delete from public.solicitudes_lesion    where alumno_id not in (select id from _mig.k_alumnos)
   and id not in (select solicitud_lesion_id from public.congelamientos where solicitud_lesion_id is not null)
   and id not in (select solicitud_lesion_id from public.recuperaciones where solicitud_lesion_id is not null);

-- publicaciones (autor NOT NULL, NO ACTION): solo las de admins conservados [REVISAR: son comunicaciones globales?]
delete from public.publicaciones where autor_id not in (select id from _mig.k_admin);

-- estructura de sede (reprogramaciones/horarios caen por CASCADE desde canchas)
delete from public.administrador where usuario_id not in (select id from _mig.k_admin);
delete from public.canchas  where id not in (select id from _mig.k_canchas);
delete from public.sedes    where id not in (select id from _mig.k_sedes);
delete from public.horarios_clases where cancha_id not in (select id from public.canchas);  -- no-op si el cascade actuo

-- notificaciones: pertenecen por alumno_id (usuario_id casi siempre NULL). FK alumno_id = SET NULL,
-- asi que sin este borrado explicito quedarian filas huerfanas (con datos de otras sedes) en el sistema nuevo.
delete from public.notificaciones n
 where not (coalesce(n.alumno_id in (select id from _mig.k_alumnos), false)
         or coalesce(n.usuario_id in (select id from _mig.k_alumnos union select id from _mig.k_coord union select id from _mig.k_admin), false));

-- personas
delete from public.alumnos      where usuario_id not in (select id from _mig.k_alumnos);
delete from public.coordinadores where usuario_id not in (select id from _mig.k_coord);
delete from public.usuarios u
 where u.id not in (select id from _mig.k_alumnos union select id from _mig.k_coord union select id from _mig.k_admin);   -- credenciales/tokens/notificaciones: CASCADE

delete from public.direcciones d
 where not exists (select 1 from public.alumnos a where a.direccion_id=d.id)
   and not exists (select 1 from public.sedes s where s.direccion_id=d.id);

create table _mig.conteo_final as select * from _mig.contar();
create table _mig.nulls_final as select * from _mig.nulls_fk();

-- ------------------------------------------------------------- 4. reporte
\echo
\echo ===== HALLAZGOS (n>0 requiere decision) =====
select * from _mig.hallazgos where n > 0 order by codigo;
\echo
\echo ===== CONTEO origen vs final por tabla =====
select o.tabla, o.n origen, f.n final, o.n - f.n eliminados
from _mig.conteo_origen o join _mig.conteo_final f using (tabla) order by o.tabla;
\echo
\echo ===== SET NULL SILENCIOSO: columnas FK cuyo n de NULL aumento mas de lo esperado (revisar una por una) =====
select o.tabla, o.columna, o.n_null origen, f.n_null final, f.n_null::numeric - o.n_null * (select f2.n::numeric / nullif(o2.n,0) from _mig.conteo_final f2 join _mig.conteo_origen o2 using (tabla) where f2.tabla = replace(o.tabla,'public.','')) esperado_prop
from _mig.nulls_origen o join _mig.nulls_final f using (tabla, columna)
where f.n_null > o.n_null order by 1,2;
\echo
\echo ===== alumnos multi-sede (ya duplicados en origen y destino) =====
select count(*) alumnos_multisede, count(*) filter (where ins_vigentes > 0) con_inscripcion_vigente_fuera_de_k from _mig.alumnos_multisede;

-- Por defecto SE REVIERTE. Para confirmar la poda cambiar a commit (o usar la copia como resultado).
\if :{?confirmar}
commit;
\else
rollback;
\echo >>> ROLLBACK (use -v confirmar=1 para persistir la poda en la copia)
\endif
