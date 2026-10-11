\echo == columnas *_id / *_por / sede sin FK (posibles referencias blandas)
select c.table_name, c.column_name, c.data_type
from information_schema.columns c
where c.table_schema='public' and c.table_name not like '\_%' and c.column_name ~ '(_id$|_por$|^id_|sede|uuid$)'
 and c.column_name<>'id'
 and not exists (select 1 from pg_constraint k where k.contype='f' and k.conrelid=('public.'||c.table_name)::regclass and (select attnum from pg_attribute where attrelid=k.conrelid and attname=c.column_name) = any(k.conkey))
 and not exists (select 1 from pg_constraint k where k.contype='p' and k.conrelid=('public.'||c.table_name)::regclass and (select attnum from pg_attribute where attrelid=k.conrelid and attname=c.column_name) = any(k.conkey))
order by 1,2;
\echo == nulabilidad de FKs relevantes
select table_name, column_name, is_nullable from information_schema.columns where table_schema='public' and (table_name,column_name) in (('registros_asistencia','registrado_por'),('horarios_clases','coordinador_id'),('recuperaciones','horario_destino_id'),('recuperaciones','registro_asistencia_id'),('beneficios_pendientes','asignado_por'),('pagos','revisado_por'),('publicaciones','autor_id'),('solicitudes_lesion','revisado_por'),('descuentos_aplicados','aplicado_por'),('alumnos','direccion_id'),('cuentas_por_cobrar','alumno_id'),('registros_asistencia','reprogramacion_clase_id'));
\echo == soft refs: orphans ya existentes en el ORIGEN
select 'recuperaciones.registro_asistencia_id' ref, count(*) from recuperaciones r where registro_asistencia_id is not null and not exists (select 1 from registros_asistencia a where a.id=r.registro_asistencia_id);
select 'beneficios_pendientes.asignado_por' ref, count(*) from beneficios_pendientes b where asignado_por is not null and not exists (select 1 from usuarios u where u.id=b.asignado_por);
