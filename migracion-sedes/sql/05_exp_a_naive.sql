\echo === Intento A: DELETE FROM sedes WHERE id NOT IN (11,12)  (el plan "ingenuo")
begin;
delete from sedes where id not in (11,12);
rollback;
\echo === Intento A2: borrar solo canchas/horarios de sedes ajenas (lo que haria el cascade)
begin;
delete from canchas where sede_id not in (11,12);
rollback;
