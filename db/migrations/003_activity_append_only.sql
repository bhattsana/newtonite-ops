-- activity_events is append-only: the database itself refuses UPDATE and DELETE (TRUNCATE, used by the dev seed, is not affected).
CREATE FUNCTION activity_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'activity_events is append-only'; END $$;
CREATE TRIGGER activity_events_no_update_delete BEFORE UPDATE OR DELETE ON activity_events FOR EACH ROW EXECUTE FUNCTION activity_events_immutable();
