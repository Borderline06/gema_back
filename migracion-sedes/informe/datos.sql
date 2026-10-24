-- Datos para el informe al cliente. Parametro: :'keep' (ids de sedes que migran)
with k as (select unnest(:'keep'::int[]) id),
ins as (select i.id, i.alumno_id, i.estado, i.id_grupo_transaccion g, i.fecha_inscripcion, c.sede_id, s.nombre sede
        from inscripciones i join horarios_clases h on h.id=i.horario_id join canchas c on c.id=h.cancha_id join sedes s on s.id=c.sede_id),
k_alu as (select distinct alumno_id from ins where sede_id in (select id from k)),
nom as (select u.id, trim(u.nombres||' '||u.apellidos) nombre, u.numero_documento doc from usuarios u),
grupos as (select g, array_agg(distinct sede order by sede) sedes, array_agg(distinct sede_id order by sede_id) sede_ids, count(*) n_ins,
                  count(*) filter (where estado<>'FINALIZADO') vigentes, min(alumno_id) alumno_id, min(fecha_inscripcion)::date fecha
           from ins where g is not null group by g having count(distinct sede_id)>1),
sinins as (select a.usuario_id id, u.creado_en::date alta, u.activo,
           (select count(*) from cuentas_por_cobrar c where c.alumno_id=a.usuario_id) cuentas,
           (select count(*) from notificaciones n where n.alumno_id=a.usuario_id) notifs
           from alumnos a join usuarios u on u.id=a.usuario_id where not exists (select 1 from inscripciones i where i.alumno_id=a.usuario_id)),
vis as (select r.id, r.alumno_id, r.fecha_falta, r.fecha_programada, r.estado, r.es_por_lesion, sd.nombre sede_destino, cd.sede_id destino_id
        from recuperaciones r join horarios_clases hd on hd.id=r.horario_destino_id join canchas cd on cd.id=hd.cancha_id join sedes sd on sd.id=cd.sede_id
        where cd.sede_id in (select id from k) and r.alumno_id not in (select alumno_id from k_alu)),
pg as (select p.revisado_por, count(*) n from pagos p join cuentas_por_cobrar cp on cp.id=p.cuenta_id where cp.alumno_id in (select alumno_id from k_alu) group by 1)
select json_build_object(
 'keep', (select json_agg(json_build_object('id',s.id,'nombre',s.nombre) order by s.id) from sedes s where s.id in (select id from k)),
 'grupos', (select json_agg(json_build_object('g',left(g::text,8),'alumno_id',g2.alumno_id,'alumno',(select nombre from nom where id=g2.alumno_id),'sedes',sedes,'n_ins',n_ins,'vigentes',vigentes,'fecha',fecha,
              'afecta', bool_or_k) order by bool_or_k desc, vigentes desc, g)
            from (select grupos.*, grupos.alumno_id aid, (exists (select 1 from unnest(sede_ids) x where x in (select id from k)) and exists (select 1 from unnest(sede_ids) x where x not in (select id from k))) bool_or_k from grupos) g2),
 'sin_ins', (select json_agg(json_build_object('id',s.id,'nombre',(select nombre from nom where id=s.id),'doc',(select doc from nom where id=s.id),'alta',alta,'activo',activo,'cuentas',cuentas,'notifs',notifs) order by alta, id) from sinins s),
 'visitantes', (select json_agg(json_build_object('id',v.id,'alumno_id',alumno_id,'alumno',(select nombre from nom where id=v.alumno_id),
                 'sedes_alumno',(select string_agg(distinct sede, ' / ') from ins where ins.alumno_id=v.alumno_id),'destino',sede_destino,'falta',fecha_falta,'programada',fecha_programada,'estado',estado,'lesion',es_por_lesion) order by fecha_programada, v.id) from vis v),
 'eddy', json_build_object(
    'pagos_por_revisor', (select json_object_agg(coalesce(revisado_por::text,'sin_revisor'), n) from pg),
    'pagos_total_migrados', (select sum(n) from pg),
    'eddy_pagos_global', (select count(*) from pagos where revisado_por=97),
    'lesiones', (select count(*) from solicitudes_lesion where revisado_por=97 and alumno_id in (select alumno_id from k_alu)),
    'beneficios', (select count(*) from beneficios_pendientes where asignado_por=97 and alumno_id in (select alumno_id from k_alu)),
    'movimientos', (select count(*) from movimientos_financieros where registrado_por=97),
    'sede', (select s.nombre from administrador a join sedes s on s.id=a.sede_id where a.usuario_id=97),
    'cargo', (select cargo from administrador where usuario_id=97)),
 'n_alumnos_migran', (select count(*) from k_alu)
);
