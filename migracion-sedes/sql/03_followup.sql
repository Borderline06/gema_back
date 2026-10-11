create or replace temp view v_ins_sede as
select i.id ins_id, i.alumno_id, i.horario_id, i.estado, i.tipo_inscripcion, i.id_grupo_transaccion, h.cancha_id, h.coordinador_id, c.sede_id
from inscripciones i join horarios_clases h on h.id=i.horario_id join canchas c on c.id=h.cancha_id;
\echo == usuarios por rol vs tablas de perfil
select r.nombre, count(u.id) usuarios, count(a.usuario_id) en_alumnos, count(co.usuario_id) en_coord, count(ad.usuario_id) en_admin
from roles r left join usuarios u on u.rol_id=r.id left join alumnos a on a.usuario_id=u.id left join coordinadores co on co.usuario_id=u.id left join administrador ad on ad.usuario_id=u.id group by r.nombre;
\echo == 155 alumnos sin inscripcion: que tienen
select count(*) total, count(*) filter (where exists(select 1 from cuentas_por_cobrar cp where cp.alumno_id=a.usuario_id)) con_cuentas,
 count(*) filter (where exists(select 1 from recuperaciones r where r.alumno_id=a.usuario_id)) con_recup,
 count(*) filter (where exists(select 1 from solicitudes_lesion r where r.alumno_id=a.usuario_id)) con_lesion,
 count(*) filter (where exists(select 1 from beneficios_pendientes r where r.alumno_id=a.usuario_id)) con_benef,
 count(*) filter (where exists(select 1 from notificaciones r where r.alumno_id=a.usuario_id)) con_notif,
 count(*) filter (where u.activo) activos, min(u.creado_en), max(u.creado_en)
from alumnos a join usuarios u on u.id=a.usuario_id where not exists (select 1 from inscripciones i where i.alumno_id=a.usuario_id);
\echo == cuentas sin link (estado correcto)
select estado, count(*) from cuentas_por_cobrar cp where not exists (select 1 from inscripciones_deudas_link l where l.cuenta_id=cp.id) group by 1;
\echo == cuentas sin link, de alumnos con 0 / 1 / >1 sedes
select n_sedes, count(*) from (select cp.id, (select count(distinct sede_id) from v_ins_sede v where v.alumno_id=cp.alumno_id) n_sedes from cuentas_por_cobrar cp where not exists (select 1 from inscripciones_deudas_link l where l.cuenta_id=cp.id)) x group by 1 order by 1;
\echo == quien registra asistencia (rol)
select r.nombre, count(*) from registros_asistencia ra join usuarios u on u.id=ra.registrado_por join roles r on r.id=u.rol_id group by 1;
select count(*) total_asistencia_cross_coord from registros_asistencia ra join v_ins_sede v on v.ins_id=ra.inscripcion_id join horarios_clases h on h.id=v.horario_id where h.coordinador_id is distinct from ra.registrado_por;
\echo == horarios sin coordinador y coordinadores sin horario por sede
select h.id, c.sede_id, h.dia_semana, h.activo from horarios_clases h join canchas c on c.id=h.cancha_id where h.coordinador_id is null;
select u.id, u.nombres, u.activo from coordinadores co join usuarios u on u.id=co.usuario_id where not exists (select 1 from horarios_clases h where h.coordinador_id=co.usuario_id);
\echo == notificaciones: alumno_id nulo / usuario no alumno
select count(*) total, count(*) filter (where alumno_id is null) sin_alumno, count(*) filter (where usuario_id not in (select usuario_id from alumnos)) usuario_no_alumno from notificaciones;
\echo == pagos y movimientos: sede 'natural' de pagos
select count(*) pagos, count(*) filter (where exists(select 1 from inscripciones_deudas_link l where l.cuenta_id=p.cuenta_id)) con_link from pagos p;
\echo == movimientos null sede: conceptos
select left(concepto,40), tipo_movimiento, count(*) , min(fecha_movimiento) from movimientos_financieros group by 1,2 order by 3 desc limit 10;
\echo == publicaciones autor
select p.id, p.titulo, p.autor_id, a.sede_id from publicaciones p join administrador a on a.usuario_id=p.autor_id;
\echo == horarios_clases: activos por sede, e inscripciones a horarios inactivos
select count(*) filter (where not activo) horarios_inactivos from horarios_clases;
select count(*) from inscripciones i join horarios_clases h on h.id=i.horario_id where not h.activo and i.estado<>'FINALIZADO';
\echo == documentos duplicados / emails duplicados en usuarios (riesgo de colision al duplicar)
select count(*) - count(distinct (tipo_documento_id, numero_documento)) dup_doc, count(*)-count(distinct lower(email)) dup_email, count(*)-count(distinct username) dup_user from usuarios;
\echo == unique constraints / indices unicos
select tablename, indexdef from pg_indexes where schemaname='public' and indexdef like '%UNIQUE%' order by 1;
\echo == secuencias vs max(id)
select c.relname, (select last_value from pg_sequences where sequencename=c.relname) from pg_class c where relkind='S' and relnamespace='public'::regnamespace order by 1;
