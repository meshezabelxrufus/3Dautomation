-- Workflow integrity rules. The database is authoritative for workflow state.
--
--   1. workflow_status_transitions: allowed (entity, from, to) status changes. Must match
--      src/server/domain/workflow-states.ts (checked by tests/db/state-machine-sync.test.ts).
--   2. enforce_status_transition(): rejects any INSERT/UPDATE whose status change is not listed.
--   3. enforce_project_rules(): FAILED/retry bookkeeping, cross-entity guards, finalized_at.
--   4. Phase guards: child rows can only be created in the matching project phase.
--   5. updated_at / finalized_at maintenance.
--   6. project_events is append-only.
--
-- Violations raise SQLSTATE 23514 (check_violation) with CONSTRAINT
-- 'workflow_status_transition' or 'workflow_guard'.

INSERT INTO "workflow_status_transitions" ("entity", "from_status", "to_status") VALUES
  ('project', '(new)', 'DRAFT'),
  ('project', 'DRAFT', 'GENERATING_CONCEPTS'),
  ('project', 'GENERATING_CONCEPTS', 'CONCEPT_REVIEW'),
  ('project', 'GENERATING_CONCEPTS', 'FAILED'),
  ('project', 'CONCEPT_REVIEW', 'GENERATING_CONCEPTS'),
  ('project', 'CONCEPT_REVIEW', 'REFINING'),
  ('project', 'CONCEPT_REVIEW', 'FINALIZING'),
  ('project', 'REFINING', 'CONCEPT_REVIEW'),
  ('project', 'FINALIZING', 'GENERATING_VIEWS'),
  ('project', 'FINALIZING', 'CONCEPT_REVIEW'),
  ('project', 'FINALIZING', 'FAILED'),
  ('project', 'GENERATING_VIEWS', 'VIEW_REVIEW'),
  ('project', 'GENERATING_VIEWS', 'FAILED'),
  ('project', 'VIEW_REVIEW', 'GENERATING_VIEWS'),
  ('project', 'VIEW_REVIEW', 'UPLOADING_TO_DRIVE'),
  ('project', 'UPLOADING_TO_DRIVE', 'COMPLETED'),
  ('project', 'UPLOADING_TO_DRIVE', 'FAILED'),
  ('project', 'FAILED', 'GENERATING_CONCEPTS'),
  ('project', 'FAILED', 'FINALIZING'),
  ('project', 'FAILED', 'GENERATING_VIEWS'),
  ('project', 'FAILED', 'UPLOADING_TO_DRIVE'),
  ('concept', '(new)', 'GENERATING'),
  ('concept', '(new)', 'READY'),
  ('concept', 'GENERATING', 'READY'),
  ('concept', 'GENERATING', 'FAILED'),
  ('concept', 'READY', 'SELECTED'),
  ('concept', 'READY', 'REJECTED'),
  ('concept', 'READY', 'REFINING'),
  ('concept', 'READY', 'FINAL'),
  ('concept', 'SELECTED', 'READY'),
  ('concept', 'SELECTED', 'REJECTED'),
  ('concept', 'SELECTED', 'REFINING'),
  ('concept', 'SELECTED', 'FINAL'),
  ('concept', 'REJECTED', 'READY'),
  ('concept', 'REFINING', 'READY'),
  ('concept', 'REFINING', 'SELECTED'),
  ('concept', 'FAILED', 'GENERATING'),
  ('revision', '(new)', 'GENERATING'),
  ('revision', '(new)', 'READY'),
  ('revision', 'GENERATING', 'READY'),
  ('revision', 'GENERATING', 'FAILED'),
  ('revision', 'READY', 'SELECTED'),
  ('revision', 'SELECTED', 'READY'),
  ('final_design', '(new)', 'PENDING'),
  ('final_design', 'PENDING', 'FINALIZED'),
  ('final_design', 'PENDING', 'CANCELLED'),
  ('final_view', '(new)', 'GENERATING'),
  ('final_view', 'GENERATING', 'READY'),
  ('final_view', 'GENERATING', 'FAILED'),
  ('final_view', 'READY', 'APPROVED'),
  ('final_view', 'APPROVED', 'READY');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "set_updated_at"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "raise_workflow_guard"(p_message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow_guard_failed: %', p_message
    USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_guard';
END;
$$;
--> statement-breakpoint

-- Generic transition guard. TG_ARGV[0] = workflow_entity of the table.
CREATE OR REPLACE FUNCTION "enforce_status_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entity "workflow_entity" := TG_ARGV[0]::"workflow_entity";
  v_from text;
  v_to text := NEW.status::text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_from := '(new)';
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    v_from := OLD.status::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "workflow_status_transitions" t
    WHERE t.entity = v_entity AND t.from_status = v_from AND t.to_status = v_to
  ) THEN
    RAISE EXCEPTION 'invalid_state_transition: % % -> %', v_entity, v_from, v_to
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'workflow_status_transition',
            DETAIL = json_build_object('entity', v_entity, 'from', v_from, 'to', v_to)::text;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Raises unless the project exists and is in one of the allowed statuses. Locks the project row
-- so concurrent phase changes and child writes are serialised.
CREATE OR REPLACE FUNCTION "assert_project_status"(p_project_id uuid, p_allowed "project_status"[], p_action text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_status "project_status";
BEGIN
  SELECT status INTO v_status FROM "projects" WHERE id = p_project_id FOR SHARE;
  IF v_status IS NULL THEN
    PERFORM "raise_workflow_guard"(format('%s: project %s not found', p_action, p_project_id));
  ELSIF NOT (v_status = ANY (p_allowed)) THEN
    PERFORM "raise_workflow_guard"(format('%s requires project status in %s, got %s', p_action, p_allowed, v_status));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "count_current_views"(p_project_id uuid, p_statuses "view_status"[], p_require_drive boolean)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT view_type)::integer
  FROM "final_views"
  WHERE project_id = p_project_id
    AND is_current
    AND status = ANY (p_statuses)
    AND (NOT p_require_drive OR drive_file_id IS NOT NULL);
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_project_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- FAILED bookkeeping: remember where we failed; a retry may only return there.
  IF NEW.status = 'FAILED' THEN
    NEW.failed_from_status := OLD.status;
  ELSIF OLD.status = 'FAILED' THEN
    IF NEW.status IS DISTINCT FROM OLD.failed_from_status THEN
      RAISE EXCEPTION 'invalid_state_transition: project FAILED -> % (retry must return to %)', NEW.status, OLD.failed_from_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_status_transition';
    END IF;
    NEW.failed_from_status := NULL;
    NEW.failure_reason := NULL;
  END IF;

  -- Cross-entity guards.
  IF NEW.status = 'CONCEPT_REVIEW' AND OLD.status = 'GENERATING_CONCEPTS' THEN
    IF NOT EXISTS (SELECT 1 FROM "concepts" WHERE project_id = NEW.id AND image_url IS NOT NULL) THEN
      PERFORM "raise_workflow_guard"('CONCEPT_REVIEW requires at least one generated concept');
    END IF;
  END IF;

  IF NEW.status = 'GENERATING_VIEWS' THEN
    IF NOT EXISTS (SELECT 1 FROM "final_designs" WHERE project_id = NEW.id AND status = 'FINALIZED') THEN
      PERFORM "raise_workflow_guard"('GENERATING_VIEWS requires a FINALIZED final design');
    END IF;
  END IF;

  IF NEW.status = 'VIEW_REVIEW' THEN
    IF "count_current_views"(NEW.id, ARRAY['READY', 'APPROVED']::"view_status"[], false) <> 4 THEN
      PERFORM "raise_workflow_guard"('VIEW_REVIEW requires all 4 current views to be READY or APPROVED');
    END IF;
  END IF;

  IF NEW.status = 'UPLOADING_TO_DRIVE' THEN
    IF "count_current_views"(NEW.id, ARRAY['APPROVED']::"view_status"[], false) <> 4 THEN
      PERFORM "raise_workflow_guard"('UPLOADING_TO_DRIVE requires all 4 current views to be APPROVED');
    END IF;
  END IF;

  IF NEW.status = 'COMPLETED' THEN
    IF "count_current_views"(NEW.id, ARRAY['APPROVED']::"view_status"[], true) <> 4 THEN
      PERFORM "raise_workflow_guard"('COMPLETED requires all 4 current views APPROVED with a drive_file_id');
    END IF;
    NEW.finalized_at := now();
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_concept_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "assert_project_status"(NEW.project_id, ARRAY['GENERATING_CONCEPTS']::"project_status"[], 'creating a concept');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_revision_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_project_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT project_id INTO v_project_id FROM "concepts" WHERE id = NEW.concept_id;
    IF v_project_id IS NOT NULL THEN
      PERFORM "assert_project_status"(v_project_id, ARRAY['REFINING']::"project_status"[], 'creating a revision');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_final_design_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_concept_status "concept_status";
  v_revision_status "revision_status";
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM "assert_project_status"(NEW.project_id, ARRAY['FINALIZING']::"project_status"[], 'changing a final design');
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_concept_status FROM "concepts" WHERE id = NEW.approved_concept_id;
    IF v_concept_status IS NOT NULL AND v_concept_status NOT IN ('READY', 'SELECTED') THEN
      PERFORM "raise_workflow_guard"(format('final design requires a READY or SELECTED concept, got %s', v_concept_status));
    END IF;
    IF NEW.approved_revision_id IS NOT NULL THEN
      SELECT status INTO v_revision_status FROM "revisions" WHERE id = NEW.approved_revision_id;
      IF v_revision_status IS NOT NULL AND v_revision_status NOT IN ('READY', 'SELECTED') THEN
        PERFORM "raise_workflow_guard"(format('final design requires a READY or SELECTED revision, got %s', v_revision_status));
      END IF;
    END IF;
  ELSIF NEW.status = 'FINALIZED' AND OLD.status IS DISTINCT FROM 'FINALIZED' THEN
    NEW.finalized_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_final_view_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "assert_project_status"(NEW.project_id, ARRAY['GENERATING_VIEWS']::"project_status"[], 'creating a final view');
    IF NOT EXISTS (SELECT 1 FROM "final_designs" WHERE id = NEW.final_design_id AND status = 'FINALIZED') THEN
      PERFORM "raise_workflow_guard"('final views require a FINALIZED final design');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "project_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Allow deletes cascaded from a project delete (trigger depth > 1); reject direct edits.
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'project_events is append-only (% rejected)', TG_OP
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_events_append_only';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

-- Trigger names are prefixed so BEFORE triggers fire in a fixed order:
-- 10 = transition check, 20 = entity rules, 90 = timestamps.
CREATE TRIGGER "trg_10_projects_status_transition" BEFORE INSERT OR UPDATE OF "status" ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "enforce_status_transition"('project');
--> statement-breakpoint
CREATE TRIGGER "trg_20_projects_rules" BEFORE UPDATE OF "status" ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "enforce_project_rules"();
--> statement-breakpoint
CREATE TRIGGER "trg_90_projects_updated_at" BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint

CREATE TRIGGER "trg_10_concepts_status_transition" BEFORE INSERT OR UPDATE OF "status" ON "concepts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_status_transition"('concept');
--> statement-breakpoint
CREATE TRIGGER "trg_20_concepts_rules" BEFORE INSERT ON "concepts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_concept_rules"();
--> statement-breakpoint
CREATE TRIGGER "trg_90_concepts_updated_at" BEFORE UPDATE ON "concepts"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint

CREATE TRIGGER "trg_10_revisions_status_transition" BEFORE INSERT OR UPDATE OF "status" ON "revisions"
  FOR EACH ROW EXECUTE FUNCTION "enforce_status_transition"('revision');
--> statement-breakpoint
CREATE TRIGGER "trg_20_revisions_rules" BEFORE INSERT ON "revisions"
  FOR EACH ROW EXECUTE FUNCTION "enforce_revision_rules"();
--> statement-breakpoint

CREATE TRIGGER "trg_10_final_designs_status_transition" BEFORE INSERT OR UPDATE OF "status" ON "final_designs"
  FOR EACH ROW EXECUTE FUNCTION "enforce_status_transition"('final_design');
--> statement-breakpoint
CREATE TRIGGER "trg_20_final_designs_rules" BEFORE INSERT OR UPDATE OF "status" ON "final_designs"
  FOR EACH ROW EXECUTE FUNCTION "enforce_final_design_rules"();
--> statement-breakpoint

CREATE TRIGGER "trg_10_final_views_status_transition" BEFORE INSERT OR UPDATE OF "status" ON "final_views"
  FOR EACH ROW EXECUTE FUNCTION "enforce_status_transition"('final_view');
--> statement-breakpoint
CREATE TRIGGER "trg_20_final_views_rules" BEFORE INSERT ON "final_views"
  FOR EACH ROW EXECUTE FUNCTION "enforce_final_view_rules"();
--> statement-breakpoint
CREATE TRIGGER "trg_90_final_views_updated_at" BEFORE UPDATE ON "final_views"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint

CREATE TRIGGER "trg_10_project_events_append_only" BEFORE UPDATE OR DELETE ON "project_events"
  FOR EACH ROW EXECUTE FUNCTION "project_events_append_only"();
