-- Concept generation (Step 5): concepts are reviewable as structured text before images
-- exist, and the generate/complete/fail transitions are database functions so callers
-- (n8n, the app) get atomic, rule-checked state changes with one call.

-- CONCEPT_REVIEW now requires at least one READY concept (not an image).
CREATE OR REPLACE FUNCTION "enforce_project_rules"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

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

  IF NEW.status = 'CONCEPT_REVIEW' AND OLD.status = 'GENERATING_CONCEPTS' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "concepts"
      WHERE project_id = NEW.id AND status IN ('READY', 'SELECTED', 'REJECTED', 'REFINING', 'FINAL')
    ) THEN
      PERFORM "raise_workflow_guard"('CONCEPT_REVIEW requires at least one ready concept');
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

-- Starts (or restarts) concept generation. Allowed from DRAFT, CONCEPT_REVIEW ("more ideas")
-- and FAILED when the failure happened during concept generation (retry).
-- outcome: started | not_found | invalid_state | invalid_request
CREATE OR REPLACE FUNCTION "start_concept_generation"(p_project_id uuid, p_requested integer, p_source text DEFAULT 'app')
RETURNS TABLE (
  outcome text,
  current_status "project_status",
  project_name text,
  client_name text,
  design_brief text,
  existing_concepts jsonb
) LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
BEGIN
  IF p_requested IS NULL OR p_requested < 2 OR p_requested > 5 THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::"project_status", NULL::text, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::"project_status", NULL::text, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  IF NOT (p.status IN ('DRAFT', 'CONCEPT_REVIEW') OR (p.status = 'FAILED' AND p.failed_from_status = 'GENERATING_CONCEPTS')) THEN
    RETURN QUERY SELECT 'invalid_state'::text, p.status, p.project_name, p.client_name, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  UPDATE "projects" SET status = 'GENERATING_CONCEPTS' WHERE id = p_project_id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'CONCEPT_GENERATION_STARTED',
          jsonb_build_object('requestedCount', p_requested, 'source', p_source, 'retry', p.status = 'FAILED'));

  RETURN QUERY
  SELECT 'started'::text, 'GENERATING_CONCEPTS'::"project_status", p.project_name, p.client_name, p.design_brief,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'concept_number', c.concept_number, 'title', c.title,
                    'description', c.description, 'status', c.status) ORDER BY c.concept_number)
           FROM "concepts" c WHERE c.project_id = p_project_id AND c.status <> 'FAILED'
         ), '[]'::jsonb);
END;
$$;
--> statement-breakpoint

-- Saves validated concepts and moves the project to CONCEPT_REVIEW in one transaction.
-- p_concepts: [{title, description, creative_direction, visual_characteristics, shape_language,
--               key_features[], materials[], image_generation_prompt}]
-- outcome: completed | not_found | stale (project is no longer generating; nothing written)
CREATE OR REPLACE FUNCTION "complete_concept_generation"(p_project_id uuid, p_concepts jsonb, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, concept_ids uuid[], current_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  v_next integer;
  v_ids uuid[];
BEGIN
  IF jsonb_typeof(p_concepts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_concepts) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'complete_concept_generation: p_concepts must be an array of 1-5 concepts'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_guard';
  END IF;

  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid[], NULL::"project_status";
    RETURN;
  END IF;
  IF p.status <> 'GENERATING_CONCEPTS' THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid[], p.status;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(concept_number), 0) + 1 INTO v_next FROM "concepts" WHERE project_id = p_project_id;

  WITH inserted AS (
    INSERT INTO "concepts" (project_id, concept_number, title, description, creative_direction,
                            visual_characteristics, shape_language, key_features, materials,
                            generation_prompt, status)
    SELECT p_project_id,
           v_next + (t.ord - 1)::integer,
           t.c->>'title',
           t.c->>'description',
           t.c->>'creative_direction',
           t.c->>'visual_characteristics',
           t.c->>'shape_language',
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.c->'key_features')), '{}'),
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.c->'materials')), '{}'),
           t.c->>'image_generation_prompt',
           'READY'
    FROM jsonb_array_elements(p_concepts) WITH ORDINALITY AS t(c, ord)
    RETURNING id, concept_number
  )
  SELECT array_agg(id ORDER BY concept_number) INTO v_ids FROM inserted;

  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'CONCEPT_GENERATION_COMPLETED',
          jsonb_build_object('conceptCount', cardinality(v_ids), 'conceptIds', to_jsonb(v_ids))
          || COALESCE(p_meta, '{}'::jsonb));

  UPDATE "projects" SET status = 'CONCEPT_REVIEW' WHERE id = p_project_id;

  RETURN QUERY SELECT 'completed'::text, v_ids, 'CONCEPT_REVIEW'::"project_status";
END;
$$;
--> statement-breakpoint

-- Marks a generating project FAILED with a client-safe reason and logs GENERATION_FAILED.
-- outcome: failed | noop (project not generating, e.g. already completed or failed)
CREATE OR REPLACE FUNCTION "fail_concept_generation"(p_project_id uuid, p_reason text, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, current_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND OR p.status <> 'GENERATING_CONCEPTS' THEN
    RETURN QUERY SELECT 'noop'::text, p.status;
    RETURN;
  END IF;

  UPDATE "projects" SET status = 'FAILED', failure_reason = left(COALESCE(p_reason, 'Concept generation failed.'), 500)
  WHERE id = p_project_id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'GENERATION_FAILED',
          jsonb_build_object('stage', 'CONCEPTS', 'reason', left(COALESCE(p_reason, ''), 500)) || COALESCE(p_details, '{}'::jsonb));

  RETURN QUERY SELECT 'failed'::text, 'FAILED'::"project_status";
END;
$$;
