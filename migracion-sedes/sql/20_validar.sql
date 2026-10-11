-- =====================================================================
-- VALIDACION POST-EXTRACCION. Ejecutar sobre la copia ya podada (necesita el esquema _mig).
--   psql -d <copia_podada> -f 20_validar.sql
-- Cada bloque debe devolver 0 filas / 0, salvo los marcados INFORMATIVO.
-- =====================================================================
\echo === V1. FKs validadas (no hay constraints deshabilitadas/NOT VALID)
select conrelid::regclass, conname from pg_constraint where contype='f' and not convalidated;
select tgrelid::regclass, tgname from pg_trigger where not tgisinternal and tgenabled='D';

\echo === V2. Huerfanos reales por FK (debe ser 0 filas; la FK ya lo impide, se verifica igualmente)
do $$ declare r record; n bigint; begin
  for r in select conrelid::regclass t, (select string_agg(format('c.%I',attname),',') from pg_attribute where attrelid=conrelid and attnum=any(conkey)) cols,
                  confrelid::regclass p, conname,
                  (select string_agg(format('c.%I = p.%I',a.attname,b.attname),' and ') from unnest(conkey,confkey) u(x,y) join pg_attribute a on a.attrelid=conrelid and a.attnum=u.x join pg_attribute b on b.attrelid=confrelid and b.attnum=u.y) cond,
                  (select string_agg(format('c.%I is not null',attname),' and ') from pg_attribute where attrelid=conrelid and attnum=any(conkey)) nn
           from pg_constraint where contype='f' and connamespace='public'::regnamespace loop
    execute format('select count(*) from %s c where %s and not exists (select 1 from %s p where %s)', r.t, r.nn, r.p, r.cond) into n;
    if n>0 then raise notice 'HUERFANOS % (%): %', r.conname, r.t, n; end if;
  end loop; raise notice 'V2 completo'; end $$;

\echo === V3. Referencias blandas (sin FK) huerfanas. Comparar contra origen (origen ya tenia 43 en recuperaciones.registro_asistencia_id)
select 'recuperaciones.registro_asistencia_id' ref, count(*) from public.recuperaciones r where registro_asistencia_id is not null and not exists (select 1 from public.registros_asistencia a where a.id=r.registro_asistencia_id)
union all select 'beneficios_pendientes.asignado_por', count(*) from public.beneficios_pendientes b where not exists (select 1 from public.usuarios u where u.id=b.asignado_por);

\echo === V4. Personas: usuario sin perfil, perfil de rol incorrecto, alumno sin inscripcion (INFORMATIVO), coordinador sin horario (INFORMATIVO)
select 'usuario sin ningun perfil' chk, count(*) from public.usuarios u where not exists (select 1 from alumnos a where a.usuario_id=u.id) and not exists (select 1 from coordinadores c where c.usuario_id=u.id) and not exists (select 1 from administrador d where d.usuario_id=u.id)
union all select 'alumno sin inscripcion', count(*) from public.alumnos a where not exists (select 1 from inscripciones i where i.alumno_id=a.usuario_id)
union all select 'coordinador sin horario ni asistencia', count(*) from public.coordinadores c where not exists (select 1 from horarios_clases h where h.coordinador_id=c.usuario_id) and not exists (select 1 from registros_asistencia r where r.registrado_por=c.usuario_id)
union all select 'notificacion sin dueno', count(*) from public.notificaciones where alumno_id is null and usuario_id is null
union all select 'sede de administrador fuera del conjunto', count(*) from public.administrador where sede_id is not null and sede_id not in (select id from public.sedes);

\echo === V5. Solo quedan sedes esperadas, y todo hecho cuelga de una sede conservada
select 'sedes' what, array_agg(id order by id) from public.sedes;
select 'inscripciones en sede no conservada' chk, count(*) from inscripciones i join horarios_clases h on h.id=i.horario_id join canchas c on c.id=h.cancha_id where c.sede_id not in (select id from sedes);
select 'movimientos sin sede o ajena' chk, count(*) from movimientos_financieros where sede_id is null or sede_id not in (select id from sedes);

\echo === V6. Duplicados (claves unicas de negocio)
select 'usuarios doc duplicado (excluye numero NULL, 180 preexistentes en origen)' chk, count(*) from (select tipo_documento_id, numero_documento from usuarios where numero_documento is not null group by 1,2 having count(*)>1) x
union all select 'asistencia diaria duplicada', count(*) from (select inscripcion_id, fecha from registros_asistencia group by 1,2 having count(*)>1) x
union all select 'link duplicado', count(*) from (select cuenta_id, inscripcion_id from inscripciones_deudas_link group by 1,2 having count(*)>1) x;

\echo === V7. Alumnos multi-sede: casos que quedan duplicados (INFORMATIVO). Tabla _mig.alumnos_multisede
select count(*) alumnos_multisede, count(*) filter (where ins_vigentes>0) con_vigente_en_madre from _mig.alumnos_multisede;
select a.alumno_id, a.sedes_nuevo, a.sedes_madre, a.ins_vigentes from _mig.alumnos_multisede a order by ins_vigentes desc, alumno_id limit 10;

\echo === V8. Secuencias vs max(id) (el sistema nuevo no debe reutilizar ids)
select s.sequencename, s.last_value, m.max_id from pg_sequences s
 left join lateral (select (xpath('/row/m/text()', query_to_xml(format('select max(id) m from public.%I', regexp_replace(s.sequencename,'_id_seq$','')), false, true,'')))[1]::text::bigint max_id) m on true
 where s.schemaname='public' and (m.max_id is not null and s.last_value < m.max_id);

\echo === V9. Conteos origen vs final
select o.tabla, o.n origen, f.n final, o.n - f.n eliminados from _mig.conteo_origen o join _mig.conteo_final f using (tabla) where o.n <> f.n order by 1;
