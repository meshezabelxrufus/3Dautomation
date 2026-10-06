-- Concept images (Step 6). Concepts are saved as soon as Claude returns (status GENERATING =
-- image pending), each image job settles its concept independently (READY or FAILED, retryable),
-- and the batch is closed by finish_concept_generation(). One failed image never discards the
-- other concepts.

-- CONCEPT_REVIEW requires at least one concept that finished generating (READY or FAILED etc.).
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
    IF NOT EXISTS (SELECT 1 FROM "concepts" WHERE project_id = NEW.id AND status <> 'GENERATING') THEN
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

-- Saves Claude's concepts with images pending (status GENERATING). The project stays in
-- GENERATING_CONCEPTS until finish_concept_generation(). outcome: saved | not_found | stale
CREATE OR REPLACE FUNCTION "save_concept_texts"(p_project_id uuid, p_concepts jsonb, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, concept_ids uuid[], current_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  v_next integer;
  v_ids uuid[];
BEGIN
  IF jsonb_typeof(p_concepts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_concepts) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'save_concept_texts: p_concepts must be an array of 1-5 concepts'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_guard';
  END IF;
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid[], NULL::"project_status"; RETURN;
  END IF;
  IF p.status <> 'GENERATING_CONCEPTS' THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid[], p.status; RETURN;
  END IF;

  SELECT COALESCE(MAX(concept_number), 0) + 1 INTO v_next FROM "concepts" WHERE project_id = p_project_id;
  WITH inserted AS (
    INSERT INTO "concepts" (project_id, concept_number, title, description, creative_direction,
                            visual_characteristics, shape_language, key_features, materials,
                            generation_prompt, status)
    SELECT p_project_id, v_next + (t.ord - 1)::integer,
           t.c->>'title', t.c->>'description', t.c->>'creative_direction',
           t.c->>'visual_characteristics', t.c->>'shape_language',
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.c->'key_features')), '{}'),
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.c->'materials')), '{}'),
           t.c->>'image_generation_prompt', 'GENERATING'
    FROM jsonb_array_elements(p_concepts) WITH ORDINALITY AS t(c, ord)
    RETURNING id, concept_number
  )
  SELECT array_agg(id ORDER BY concept_number) INTO v_ids FROM inserted;

  RETURN QUERY SELECT 'saved'::text, v_ids, p.status;
END;
$$;
--> statement-breakpoint

-- Claims a concept's image job. First run: GENERATING with no request yet. Retry: FAILED -> GENERATING.
-- outcome: started | in_progress | already_done | invalid_state | not_found
CREATE OR REPLACE FUNCTION "start_concept_image"(p_concept_id uuid)
RETURNS TABLE (outcome text, concept_id uuid, project_id uuid, concept_number integer, title text,
               prompt text, concept_status "concept_status", project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  c "concepts"%ROWTYPE;
  v_project "project_status";
BEGIN
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, p_concept_id, NULL::uuid, NULL::integer, NULL::text, NULL::text,
                        NULL::"concept_status", NULL::"project_status";
    RETURN;
  END IF;
  SELECT status INTO v_project FROM "projects" WHERE id = c.project_id FOR SHARE;

  IF v_project NOT IN ('GENERATING_CONCEPTS', 'CONCEPT_REVIEW') THEN
    RETURN QUERY SELECT 'invalid_state'::text, c.id, c.project_id, c.concept_number, c.title, NULL::text, c.status, v_project; RETURN;
  END IF;
  IF c.status = 'GENERATING' AND c.image_requested_at IS NOT NULL THEN
    RETURN QUERY SELECT 'in_progress'::text, c.id, c.project_id, c.concept_number, c.title, NULL::text, c.status, v_project; RETURN;
  END IF;
  IF c.status NOT IN ('GENERATING', 'FAILED') THEN
    RETURN QUERY SELECT 'already_done'::text, c.id, c.project_id, c.concept_number, c.title, NULL::text, c.status, v_project; RETURN;
  END IF;
  IF c.generation_prompt IS NULL OR length(trim(c.generation_prompt)) = 0 THEN
    RETURN QUERY SELECT 'invalid_state'::text, c.id, c.project_id, c.concept_number, c.title, NULL::text, c.status, v_project; RETURN;
  END IF;

  UPDATE "concepts" SET status = 'GENERATING', image_requested_at = now(), image_error = NULL WHERE id = c.id;
  RETURN QUERY SELECT 'started'::text, c.id, c.project_id, c.concept_number, c.title, c.generation_prompt,
                      'GENERATING'::"concept_status", v_project;
END;
$$;
--> statement-breakpoint

-- Attaches a stored image to a concept: GENERATING -> READY. outcome: completed | stale | not_found
CREATE OR REPLACE FUNCTION "complete_concept_image"(p_concept_id uuid, p_asset_id uuid, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, concept_status "concept_status")
LANGUAGE plpgsql AS $$
DECLARE
  c "concepts"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::"concept_status"; RETURN; END IF;
  IF c.status <> 'GENERATING' THEN RETURN QUERY SELECT 'stale'::text, c.status; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "assets" a WHERE a.id = p_asset_id AND a.project_id = c.project_id) THEN
    PERFORM "raise_workflow_guard"('complete_concept_image: asset does not belong to the concept''s project');
  END IF;

  UPDATE "concepts"
  SET status = 'READY', image_asset_id = p_asset_id, image_url = '/api/assets/' || p_asset_id::text, image_error = NULL
  WHERE id = c.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (c.project_id, 'CONCEPT_IMAGE_GENERATED',
          jsonb_build_object('conceptId', c.id, 'conceptNumber', c.concept_number, 'assetId', p_asset_id) || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'completed'::text, 'READY'::"concept_status";
END;
$$;
--> statement-breakpoint

-- Marks one concept's image as failed (retryable): GENERATING -> FAILED. outcome: failed | stale | not_found
CREATE OR REPLACE FUNCTION "fail_concept_image"(p_concept_id uuid, p_reason text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, concept_status "concept_status")
LANGUAGE plpgsql AS $$
DECLARE
  c "concepts"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::"concept_status"; RETURN; END IF;
  IF c.status <> 'GENERATING' THEN RETURN QUERY SELECT 'stale'::text, c.status; RETURN; END IF;
  UPDATE "concepts" SET status = 'FAILED', image_error = left(COALESCE(p_reason, 'Image generation failed.'), 500) WHERE id = c.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (c.project_id, 'CONCEPT_IMAGE_FAILED',
          jsonb_build_object('conceptId', c.id, 'conceptNumber', c.concept_number, 'reason', left(COALESCE(p_reason, ''), 500))
          || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'failed'::text, 'FAILED'::"concept_status";
END;
$$;
--> statement-breakpoint

-- Closes a generation batch: any concept of the batch still waiting for its image is marked FAILED
-- (retryable), the completion event is logged, and the project moves to CONCEPT_REVIEW.
-- outcome: completed | stale | not_found
CREATE OR REPLACE FUNCTION "finish_concept_generation"(p_project_id uuid, p_concept_ids uuid[], p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, images_ready integer, images_failed integer, current_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  v_ready integer;
  v_failed integer;
  r record;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, 0, 0, NULL::"project_status"; RETURN; END IF;
  IF p.status <> 'GENERATING_CONCEPTS' THEN RETURN QUERY SELECT 'stale'::text, 0, 0, p.status; RETURN; END IF;

  FOR r IN SELECT id FROM "concepts" WHERE id = ANY(p_concept_ids) AND status = 'GENERATING' LOOP
    PERFORM "fail_concept_image"(r.id, 'Image generation did not finish in time. You can retry it.', '{"code":"image_timeout"}'::jsonb);
  END LOOP;

  SELECT count(*) FILTER (WHERE status = 'READY'), count(*) FILTER (WHERE status = 'FAILED')
  INTO v_ready, v_failed FROM "concepts" WHERE id = ANY(p_concept_ids);

  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'CONCEPT_GENERATION_COMPLETED',
          jsonb_build_object('conceptCount', cardinality(p_concept_ids), 'conceptIds', to_jsonb(p_concept_ids),
                             'imagesReady', v_ready, 'imagesFailed', v_failed) || COALESCE(p_meta, '{}'::jsonb));
  UPDATE "projects" SET status = 'CONCEPT_REVIEW' WHERE id = p_project_id;
  RETURN QUERY SELECT 'completed'::text, v_ready, v_failed, 'CONCEPT_REVIEW'::"project_status";
END;
$$;
--> statement-breakpoint

-- A Claude-stage failure also releases any concept still waiting for an image.
CREATE OR REPLACE FUNCTION "fail_concept_generation"(p_project_id uuid, p_reason text, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, current_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  r record;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND OR p.status <> 'GENERATING_CONCEPTS' THEN
    RETURN QUERY SELECT 'noop'::text, p.status; RETURN;
  END IF;
  FOR r IN SELECT id FROM "concepts" WHERE project_id = p_project_id AND status = 'GENERATING' LOOP
    PERFORM "fail_concept_image"(r.id, 'Generation stopped before this image was made. You can retry it.', '{"code":"generation_failed"}'::jsonb);
  END LOOP;
  UPDATE "projects" SET status = 'FAILED', failure_reason = left(COALESCE(p_reason, 'Concept generation failed.'), 500)
  WHERE id = p_project_id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'GENERATION_FAILED',
          jsonb_build_object('stage', 'CONCEPTS', 'reason', left(COALESCE(p_reason, ''), 500)) || COALESCE(p_details, '{}'::jsonb));
  RETURN QUERY SELECT 'failed'::text, 'FAILED'::"project_status";
END;
$$;
--> statement-breakpoint

-- Refinement result: revision READY with its image, concept REFINING -> READY, project -> CONCEPT_REVIEW.
-- outcome: completed | stale | not_found
CREATE OR REPLACE FUNCTION "complete_refinement"(p_revision_id uuid, p_asset_id uuid, p_interpretation jsonb, p_prompt text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  rv "revisions"%ROWTYPE;
  c "concepts"%ROWTYPE;
BEGIN
  SELECT * INTO rv FROM "revisions" WHERE id = p_revision_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  SELECT * INTO c FROM "concepts" WHERE id = rv.concept_id FOR UPDATE;
  PERFORM 1 FROM "projects" WHERE id = c.project_id FOR UPDATE;
  IF rv.status <> 'GENERATING' THEN RETURN QUERY SELECT 'stale'::text; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "assets" a WHERE a.id = p_asset_id AND a.project_id = c.project_id) THEN
    PERFORM "raise_workflow_guard"('complete_refinement: asset does not belong to the project');
  END IF;

  UPDATE "revisions"
  SET status = 'READY', image_asset_id = p_asset_id, image_url = '/api/assets/' || p_asset_id::text,
      interpreted_instruction = p_interpretation, generation_prompt = p_prompt, error_reason = NULL
  WHERE id = rv.id;
  IF c.status = 'REFINING' THEN UPDATE "concepts" SET status = 'READY' WHERE id = c.id; END IF;
  UPDATE "projects" SET status = 'CONCEPT_REVIEW' WHERE id = c.project_id AND status = 'REFINING';
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (c.project_id, 'REVISION_CREATED',
          jsonb_build_object('conceptId', c.id, 'revisionId', rv.id, 'revisionNumber', rv.revision_number, 'assetId', p_asset_id)
          || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'completed'::text;
END;
$$;
--> statement-breakpoint

-- Failed refinement: not fatal. Revision FAILED, concept back to READY, project back to CONCEPT_REVIEW.
CREATE OR REPLACE FUNCTION "fail_refinement"(p_revision_id uuid, p_reason text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  rv "revisions"%ROWTYPE;
  c "concepts"%ROWTYPE;
BEGIN
  SELECT * INTO rv FROM "revisions" WHERE id = p_revision_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  SELECT * INTO c FROM "concepts" WHERE id = rv.concept_id FOR UPDATE;
  PERFORM 1 FROM "projects" WHERE id = c.project_id FOR UPDATE;
  IF rv.status <> 'GENERATING' THEN RETURN QUERY SELECT 'stale'::text; RETURN; END IF;

  UPDATE "revisions" SET status = 'FAILED', error_reason = left(COALESCE(p_reason, 'Refinement failed.'), 500) WHERE id = rv.id;
  IF c.status = 'REFINING' THEN UPDATE "concepts" SET status = 'READY' WHERE id = c.id; END IF;
  UPDATE "projects" SET status = 'CONCEPT_REVIEW' WHERE id = c.project_id AND status = 'REFINING';
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (c.project_id, 'GENERATION_FAILED',
          jsonb_build_object('stage', 'REFINEMENT', 'conceptId', c.id, 'revisionId', rv.id, 'reason', left(COALESCE(p_reason, ''), 500))
          || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'failed'::text;
END;
$$;
