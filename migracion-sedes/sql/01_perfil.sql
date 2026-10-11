\echo == sedes
select s.id,s.nombre,s.activo,s.tipo_instalacion,d.distrito,(select count(*) from canchas c where c.sede_id=s.id) canchas,
 (select count(*) from horarios_clases h join canchas c on c.id=h.cancha_id where c.sede_id=s.id) horarios,
 (select count(*) from inscripciones i join horarios_clases h on h.id=i.horario_id join canchas c on c.id=h.cancha_id where c.sede_id=s.id) insc,
 (select count(distinct i.alumno_id) from inscripciones i join horarios_clases h on h.id=i.horario_id join canchas c on c.id=h.cancha_id where c.sede_id=s.id) alumnos,
 (select count(*) from administrador a where a.sede_id=s.id) admins,
 (select count(*) from movimientos_financieros m where m.sede_id=s.id) movs
from sedes s left join direcciones d on d.id=s.direccion_id order by 1;
\echo == parametros_sistema
select clave, left(valor,80) valor from parametros_sistema;
\echo == administrador
select a.usuario_id,a.sede_id,a.cargo,a.area,u.activo from administrador a join usuarios u on u.id=a.usuario_id;
\echo == roles
select * from roles;
\echo == inscripciones estado
select estado,tipo_inscripcion,count(*) from inscripciones group by 1,2 order by 1,2;
\echo == alumnos sin inscripcion
select count(*) from alumnos a where not exists (select 1 from inscripciones i where i.alumno_id=a.usuario_id);
\echo == coordinadores sin horario / horarios sin coordinador
select count(*) from coordinadores c where not exists (select 1 from horarios_clases h where h.coordinador_id=c.usuario_id);
select count(*) from horarios_clases where coordinador_id is null;
