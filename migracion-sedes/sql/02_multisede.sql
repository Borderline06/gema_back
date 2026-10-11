-- Vista auxiliar en la base de PRUEBA: pares (alumno, sede) vía inscripciones
create or replace temp view v_ins_sede as
select i.id ins_id, i.alumno_id, i.horario_id, i.estado, i.tipo_inscripcion, h.cancha_id, h.coordinador_id, c.sede_id
from inscripciones i join horarios_clases h on h.id=i.horario_id join canchas c on c.id=h.cancha_id;

\echo == 1. alumnos por nro de sedes (todas las inscripciones)
select n_sedes, count(*) from (select alumno_id, count(distinct sede_id) n_sedes from v_ins_sede group by 1) x group by 1 order by 1;
\echo == 1b. alumnos multi-sede: combinaciones de sedes
select sedes, count(*) alumnos from (select alumno_id, string_agg(distinct sede_id::text, ',' order by sede_id::text) sedes from v_ins_sede group by 1 having count(distinct sede_id)>1) x group by 1 order by 2 desc;
\echo == 1c. multi-sede solo con inscripciones ACTIVAS/pendientes (vigentes)
select count(*) from (select alumno_id from v_ins_sede where estado<>'FINALIZADO' group by 1 having count(distinct sede_id)>1) x;
\echo == 2. coordinadores por nro de sedes
select n_sedes, count(*) from (select coordinador_id, count(distinct sede_id) n_sedes from v_ins_sede group by 1) x group by 1 order by 1;
\echo == 2b. coordinadores via horarios (sin necesidad de inscripciones)
select u.id, u.nombres||' '||u.apellidos, string_agg(distinct c.sede_id::text, ',') sedes, count(*) horarios
from horarios_clases h join canchas c on c.id=h.cancha_id join usuarios u on u.id=h.coordinador_id group by 1,2 order by 1;
\echo == 3. recuperaciones: sede de inscripcion origen vs horario destino (cruzan sede?)
select count(*) total,
 count(*) filter (where exists(select 1 from v_ins_sede v where v.alumno_id=r.alumno_id) ) con_ins,
 count(*) filter (where hd.id is null) sin_horario_destino
from recuperaciones r left join horarios_clases hd on hd.id=r.horario_destino_id;
select sd.sede_id sede_destino, count(*) from recuperaciones r join horarios_clases hd on hd.id=r.horario_destino_id join canchas sd on sd.id=hd.cancha_id group by 1 order by 1;
\echo == 3b. recuperaciones cuyo alumno NO tiene ninguna inscripcion en la sede del horario destino
select count(*) from recuperaciones r join horarios_clases hd on hd.id=r.horario_destino_id join canchas cd on cd.id=hd.cancha_id
where not exists (select 1 from v_ins_sede v where v.alumno_id=r.alumno_id and v.sede_id=cd.sede_id);
\echo == 3c. recuperaciones con registro_asistencia_id: sede asistencia vs sede horario destino
select count(*) filter (where va.sede_id is distinct from cd.sede_id) sede_distinta, count(*) total
from recuperaciones r join horarios_clases hd on hd.id=r.horario_destino_id join canchas cd on cd.id=hd.cancha_id
join registros_asistencia ra on ra.id=r.registro_asistencia_id join v_ins_sede va on va.ins_id=ra.inscripcion_id;
\echo == 4. cuentas_por_cobrar: sedes alcanzadas via inscripciones_deudas_link
select n_sedes, count(*) from (select cp.id, count(distinct v.sede_id) n_sedes from cuentas_por_cobrar cp left join inscripciones_deudas_link l on l.cuenta_id=cp.id left join v_ins_sede v on v.ins_id=l.inscripcion_id group by 1) x group by 1 order by 1;
\echo == 4b. cuentas sin link a inscripcion (sin sede determinable por link)
select count(*), count(*) filter (where cp.estado<>'PAGADO') no_pagadas from cuentas_por_cobrar cp where not exists (select 1 from inscripciones_deudas_link l where l.cuenta_id=cp.id);
select cc.nombre, cp.estado, count(*) from cuentas_por_cobrar cp join catalogo_conceptos cc on cc.id=cp.concepto_id where not exists (select 1 from inscripciones_deudas_link l where l.cuenta_id=cp.id) group by 1,2 order by 3 desc;
\echo == 4c. cuentas cuyo alumno es multi-sede
select count(*) from cuentas_por_cobrar cp where cp.alumno_id in (select alumno_id from v_ins_sede group by 1 having count(distinct sede_id)>1);
\echo == 4d. inscripciones sin link de deuda
select count(*) from inscripciones i where not exists (select 1 from inscripciones_deudas_link l where l.inscripcion_id=i.id);
\echo == 5. inscripciones_deudas_link: cuenta de un alumno distinto al de la inscripcion?
select count(*) from inscripciones_deudas_link l join inscripciones i on i.id=l.inscripcion_id join cuentas_por_cobrar cp on cp.id=l.cuenta_id where i.alumno_id<>cp.alumno_id;
\echo == 6. link: cuentas ligadas a inscripciones de mas de una sede
select count(*) from (select l.cuenta_id from inscripciones_deudas_link l join v_ins_sede v on v.ins_id=l.inscripcion_id group by 1 having count(distinct v.sede_id)>1) x;
\echo == 7. movimientos_financieros por sede (incluye NULL)
select sede_id, count(*), sum(monto) from movimientos_financieros group by 1;
\echo == 8. reprogramaciones por sede y masivas
select c.sede_id, r.es_masiva, count(*) from reprogramaciones_clases r join horarios_clases h on h.id=r.horario_id join canchas c on c.id=h.cancha_id group by 1,2 order by 1,2;
\echo == 8b. grupo_uuid abarcando varias sedes
select count(*) from (select r.grupo_uuid from reprogramaciones_clases r join horarios_clases h on h.id=r.horario_id join canchas c on c.id=h.cancha_id where r.grupo_uuid is not null group by 1 having count(distinct c.sede_id)>1) x;
\echo == 9. id_grupo_transaccion (inscripciones) abarcando varias sedes
select count(*) from (select id_grupo_transaccion from v_ins_sede v join inscripciones i on i.id=v.ins_id where i.id_grupo_transaccion is not null group by 1 having count(distinct v.sede_id)>1) x;
\echo == 10. direcciones compartidas (alumno/sede/etc)
select d.id, (select count(*) from alumnos a where a.direccion_id=d.id) alumnos, (select count(*) from sedes s where s.direccion_id=d.id) sedes from direcciones d where (select count(*) from alumnos a where a.direccion_id=d.id)+(select count(*) from sedes s where s.direccion_id=d.id) > 1;
\echo == 11. congelamientos / lesiones: alumno multi-sede
select count(*) filter (where a in (select alumno_id from v_ins_sede group by 1 having count(distinct sede_id)>1)) en_multi, count(*) total from (select alumno_id a from solicitudes_lesion) x;
\echo == 12. registros_asistencia: registrado_por coordinador de OTRA sede que la inscripcion
select count(*) from registros_asistencia ra join v_ins_sede v on v.ins_id=ra.inscripcion_id where not exists (select 1 from horarios_clases h join canchas c on c.id=h.cancha_id where h.coordinador_id=ra.registrado_por and c.sede_id=v.sede_id);
\echo == 13. beneficios_pendientes.asignado_por / descuentos.aplicado_por (FK?)
select count(*) from beneficios_pendientes where asignado_por is not null and asignado_por not in (select usuario_id from administrador);
select count(*) from descuentos_aplicados;
