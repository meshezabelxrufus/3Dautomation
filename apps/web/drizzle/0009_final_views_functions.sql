-- Step 8: final design approval and the four views.
-- The final design is the CANONICAL design: once FINALIZED its master image and approved concept/revision
-- never change, and Claude's per-view instructions are written to it once. Every view (and every
-- regeneration) is a new final_views version generated from the master image; earlier versions are kept.

-- Canonical design is immutable once finalized; view instructions are write-once.
CREATE OR REPLACE FUNCTION "protect_final_design"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'FINALIZED' AND (
       NEW.master_image IS DISTINCT FROM OLD.master_image
    OR NEW.master_asset_id IS DISTINCT FROM OLD.master_asset_id
    OR NEW.approved_concept_id IS DISTINCT FROM OLD.approved_concept_id
    OR NEW.approved_revision_id IS DISTINCT FROM OLD.approved_revision_id) THEN
    PERFORM "raise_workflow_guard"('the finalized master design cannot be changed');
  END IF;
  IF OLD.view_prompts IS NOT NULL AND NEW.view_prompts IS DISTINCT FROM OLD.view_prompts THEN
    PERFORM "raise_workflow_guard"('the canonical view instructions cannot be changed');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_30_final_designs_protect" BEFORE UPDATE ON "final_designs"
  FOR EACH ROW EXECUTE FUNCTION "protect_final_design"();
--> statement-breakpoint

-- Finalizes exactly the chosen version (p_revision_id null = the original concept image).
-- Idempotent: repeating the same request returns the same final design.
-- outcome: finalized | already_finalized | conflict | not_found | concept_mismatch | busy | invalid_state | invalid_version
CREATE OR REPLACE FUNCTION "finalize_design"(p_project_id uuid, p_concept_id uuid, p_revision_id uuid)
RETURNS TABLE (outcome text, final_design_id uuid, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  c "concepts"%ROWTYPE;
  p "projects"%ROWTYPE;
  rv "revisions"%ROWTYPE;
  d "final_designs"%ROWTYPE;
  v_image text;
  v_asset uuid;
  v_id uuid;
BEGIN
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::"project_status"; RETURN; END IF;
  IF c.id IS NULL OR c.project_id <> p.id THEN
    RETURN QUERY SELECT 'concept_mismatch'::text, NULL::uuid, p.status; RETURN;
  END IF;

  SELECT * INTO d FROM "final_designs" WHERE project_id = p.id AND status <> 'CANCELLED';
  IF d.id IS NOT NULL THEN
    IF d.approved_concept_id = c.id AND d.approved_revision_id IS NOT DISTINCT FROM p_revision_id THEN
      RETURN QUERY SELECT 'already_finalized'::text, d.id, p.status; RETURN;
    END IF;
    RETURN QUERY SELECT 'conflict'::text, d.id, p.status; RETURN;
  END IF;
  IF p.status = 'REFINING' OR c.status = 'REFINING' THEN RETURN QUERY SELECT 'busy'::text, NULL::uuid, p.status; RETURN; END IF;
  IF p.status <> 'CONCEPT_REVIEW' OR c.status NOT IN ('READY', 'SELECTED') THEN
    RETURN QUERY SELECT 'invalid_state'::text, NULL::uuid, p.status; RETURN;
  END IF;

  IF p_revision_id IS NOT NULL THEN
    SELECT * INTO rv FROM "revisions" WHERE id = p_revision_id FOR UPDATE;
    IF rv.id IS NULL OR rv.concept_id <> c.id OR rv.status NOT IN ('READY', 'SELECTED') OR rv.image_asset_id IS NULL THEN
      RETURN QUERY SELECT 'invalid_version'::text, NULL::uuid, p.status; RETURN;
    END IF;
    v_image := rv.image_url; v_asset := rv.image_asset_id;
  ELSE
    IF c.image_asset_id IS NULL THEN RETURN QUERY SELECT 'invalid_version'::text, NULL::uuid, p.status; RETURN; END IF;
    v_image := c.image_url; v_asset := c.image_asset_id;
  END IF;

  UPDATE "projects" SET status = 'FINALIZING' WHERE id = p.id;
  INSERT INTO "final_designs" (project_id, approved_concept_id, approved_revision_id, master_image, master_asset_id)
  VALUES (p.id, c.id, p_revision_id, v_image, v_asset) RETURNING id INTO v_id;
  UPDATE "final_designs" SET status = 'FINALIZED' WHERE id = v_id;
  -- The finalized version is the concept's version from now on.
  IF p_revision_id IS NOT NULL THEN
    UPDATE "revisions" SET status = 'READY' WHERE concept_id = c.id AND status = 'SELECTED' AND id <> p_revision_id;
    IF rv.status = 'READY' THEN UPDATE "revisions" SET status = 'SELECTED' WHERE id = p_revision_id; END IF;
  END IF;
  UPDATE "concepts" SET status = 'FINAL', active_revision_id = p_revision_id WHERE id = c.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'DESIGN_FINALIZED', jsonb_build_object('finalDesignId', v_id, 'conceptId', c.id, 'revisionId', p_revision_id,
          'revisionNumber', COALESCE(rv.revision_number, 0), 'masterAssetId', v_asset));
  RETURN QUERY SELECT 'finalized'::text, v_id, 'FINALIZING'::"project_status";
END;
$$;
--> statement-breakpoint

-- Starts views: a new GENERATING version per requested view type.
--   p_view_types null: first run (all four), or every FAILED view when retrying.
--   While generating, only FAILED views can be started again (successful views are never redone);
--   in VIEW_REVIEW any view can be regenerated ("regenerate this view").
-- outcome: started | in_progress | nothing_to_do | not_found | invalid_state | not_retryable
CREATE OR REPLACE FUNCTION "start_view_generation"(p_project_id uuid, p_final_design_id uuid, p_view_types "view_type"[])
RETURNS TABLE (outcome text, views jsonb, view_prompts jsonb, master_asset_id uuid, context jsonb, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  d "final_designs"%ROWTYPE;
  v_types "view_type"[];
  v_type "view_type";
  cur "final_views"%ROWTYPE;
  v_next integer;
  v_id uuid;
  v_views jsonb := '[]'::jsonb;
  v_regenerate boolean;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  SELECT * INTO d FROM "final_designs" WHERE id = p_final_design_id AND project_id = p_project_id;
  IF p.id IS NULL OR d.id IS NULL OR d.status <> 'FINALIZED' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::jsonb, NULL::jsonb, NULL::uuid, NULL::jsonb, p.status; RETURN;
  END IF;
  IF p.status NOT IN ('FINALIZING', 'GENERATING_VIEWS', 'VIEW_REVIEW') THEN
    RETURN QUERY SELECT 'invalid_state'::text, NULL::jsonb, NULL::jsonb, NULL::uuid, NULL::jsonb, p.status; RETURN;
  END IF;

  IF p_view_types IS NOT NULL AND cardinality(p_view_types) > 0 THEN
    v_types := ARRAY(SELECT DISTINCT unnest(p_view_types));
  ELSIF NOT EXISTS (SELECT 1 FROM "final_views" WHERE project_id = p.id) THEN
    v_types := ARRAY['FRONT', 'BACK', 'LEFT', 'RIGHT']::"view_type"[];
  ELSE
    v_types := ARRAY(SELECT view_type FROM "final_views" WHERE project_id = p.id AND is_current AND status = 'FAILED');
  END IF;
  IF cardinality(v_types) = 0 AND EXISTS (SELECT 1 FROM "final_views" WHERE project_id = p.id AND is_current AND status = 'GENERATING') THEN
    RETURN QUERY SELECT 'in_progress'::text, NULL::jsonb, NULL::jsonb, NULL::uuid, NULL::jsonb, p.status; RETURN;
  END IF;
  IF cardinality(v_types) = 0 THEN
    RETURN QUERY SELECT 'nothing_to_do'::text, '[]'::jsonb, d.view_prompts, d.master_asset_id, NULL::jsonb, p.status; RETURN;
  END IF;

  FOREACH v_type IN ARRAY v_types LOOP
    SELECT * INTO cur FROM "final_views" WHERE project_id = p.id AND view_type = v_type AND is_current FOR UPDATE;
    IF cur.id IS NOT NULL AND cur.status = 'GENERATING' THEN
      RETURN QUERY SELECT 'in_progress'::text, NULL::jsonb, NULL::jsonb, NULL::uuid, NULL::jsonb, p.status; RETURN;
    END IF;
    IF p.status = 'GENERATING_VIEWS' AND cur.id IS NOT NULL AND cur.status <> 'FAILED' THEN
      RETURN QUERY SELECT 'not_retryable'::text, NULL::jsonb, NULL::jsonb, NULL::uuid, NULL::jsonb, p.status; RETURN;
    END IF;
  END LOOP;

  v_regenerate := p.status = 'VIEW_REVIEW';
  IF p.status <> 'GENERATING_VIEWS' THEN UPDATE "projects" SET status = 'GENERATING_VIEWS' WHERE id = p.id; END IF;
  FOREACH v_type IN ARRAY v_types LOOP
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next FROM "final_views" WHERE project_id = p.id AND view_type = v_type;
    UPDATE "final_views" SET is_current = false WHERE project_id = p.id AND view_type = v_type AND is_current;
    INSERT INTO "final_views" (project_id, final_design_id, view_type, version_number)
    VALUES (p.id, d.id, v_type, v_next) RETURNING id INTO v_id;
    v_views := v_views || jsonb_build_object('view_id', v_id, 'view_type', v_type, 'version_number', v_next);
  END LOOP;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'VIEW_GENERATION_STARTED', jsonb_build_object('finalDesignId', d.id, 'viewTypes', to_jsonb(v_types), 'regenerate', v_regenerate));

  RETURN QUERY
  SELECT 'started'::text, v_views, d.view_prompts, d.master_asset_id,
         (SELECT jsonb_build_object(
            'concept', jsonb_build_object('title', c.title, 'description', c.description, 'creative_direction', c.creative_direction,
                                          'visual_characteristics', c.visual_characteristics, 'shape_language', c.shape_language,
                                          'key_features', to_jsonb(c.key_features), 'materials', to_jsonb(c.materials)),
            'revision', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('number', r.revision_number,
                                          'summary', r.interpreted_instruction->>'summary') END,
            'current_prompt', COALESCE(r.interpreted_instruction->>'revised_prompt', c.generation_prompt))
          FROM "concepts" c LEFT JOIN "revisions" r ON r.id = d.approved_revision_id WHERE c.id = d.approved_concept_id),
         'GENERATING_VIEWS'::"project_status";
END;
$$;
--> statement-breakpoint

-- Stores Claude's per-view instructions once. A concurrent second write keeps the first (canonical).
CREATE OR REPLACE FUNCTION "save_view_prompts"(p_final_design_id uuid, p_prompts jsonb)
RETURNS TABLE (outcome text, view_prompts jsonb)
LANGUAGE plpgsql AS $$
DECLARE
  d "final_designs"%ROWTYPE;
BEGIN
  SELECT * INTO d FROM "final_designs" WHERE id = p_final_design_id FOR UPDATE;
  IF d.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::jsonb; RETURN; END IF;
  IF d.view_prompts IS NOT NULL THEN RETURN QUERY SELECT 'kept'::text, d.view_prompts; RETURN; END IF;
  IF jsonb_typeof(p_prompts) <> 'object' OR NOT (p_prompts ?& ARRAY['front_prompt', 'back_prompt', 'left_prompt', 'right_prompt']) THEN
    PERFORM "raise_workflow_guard"('save_view_prompts: all four view prompts are required');
  END IF;
  UPDATE "final_designs" SET view_prompts = p_prompts WHERE id = d.id;
  RETURN QUERY SELECT 'saved'::text, p_prompts;
END;
$$;
--> statement-breakpoint

-- Claude couldn't prepare the instructions: the views of this run fail (retryable).
CREATE OR REPLACE FUNCTION "fail_view_preparation"(p_project_id uuid, p_view_ids uuid[], p_reason text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, failed integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM 1 FROM "projects" WHERE id = p_project_id FOR UPDATE;
  UPDATE "final_views" SET status = 'FAILED', error_reason = left(COALESCE(p_reason, 'The views could not be prepared.'), 500)
  WHERE id = ANY(p_view_ids) AND project_id = p_project_id AND status = 'GENERATING';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'GENERATION_FAILED', jsonb_build_object('stage', 'VIEW_PROMPTS', 'viewIds', to_jsonb(p_view_ids),
          'reason', left(COALESCE(p_reason, ''), 500)) || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'failed'::text, v_n;
END;
$$;
--> statement-breakpoint

-- Claims one view's image job and returns its canonical instruction and the master image.
-- outcome: started | in_progress | already_done | stale | no_prompts | not_found
CREATE OR REPLACE FUNCTION "start_view_image"(p_view_id uuid)
RETURNS TABLE (outcome text, view_id uuid, project_id uuid, view_type "view_type", version_number integer,
               prompt text, master_asset_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v "final_views"%ROWTYPE;
  d "final_designs"%ROWTYPE;
  v_prompt text;
BEGIN
  SELECT * INTO v FROM "final_views" WHERE id = p_view_id FOR UPDATE;
  IF v.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, p_view_id, NULL::uuid, NULL::"view_type", NULL::integer, NULL::text, NULL::uuid; RETURN;
  END IF;
  IF NOT v.is_current THEN
    RETURN QUERY SELECT 'stale'::text, v.id, v.project_id, v.view_type, v.version_number, NULL::text, NULL::uuid; RETURN;
  END IF;
  IF v.status <> 'GENERATING' THEN
    RETURN QUERY SELECT 'already_done'::text, v.id, v.project_id, v.view_type, v.version_number, NULL::text, NULL::uuid; RETURN;
  END IF;
  IF v.image_requested_at IS NOT NULL THEN
    RETURN QUERY SELECT 'in_progress'::text, v.id, v.project_id, v.view_type, v.version_number, NULL::text, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO d FROM "final_designs" WHERE id = v.final_design_id;
  v_prompt := d.view_prompts ->> (lower(v.view_type::text) || '_prompt');
  IF v_prompt IS NULL OR d.master_asset_id IS NULL THEN
    RETURN QUERY SELECT 'no_prompts'::text, v.id, v.project_id, v.view_type, v.version_number, NULL::text, NULL::uuid; RETURN;
  END IF;
  UPDATE "final_views" SET image_requested_at = now(), error_reason = NULL WHERE id = v.id;
  RETURN QUERY SELECT 'started'::text, v.id, v.project_id, v.view_type, v.version_number, v_prompt, d.master_asset_id;
END;
$$;
--> statement-breakpoint

-- GENERATING -> READY with the stored image. A superseded (non-current) version is left alone.
CREATE OR REPLACE FUNCTION "complete_view_image"(p_view_id uuid, p_asset_id uuid, p_prompt text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  v "final_views"%ROWTYPE;
BEGIN
  SELECT * INTO v FROM "final_views" WHERE id = p_view_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  IF v.status <> 'GENERATING' OR NOT v.is_current THEN RETURN QUERY SELECT 'stale'::text; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "assets" a WHERE a.id = p_asset_id AND a.project_id = v.project_id) THEN
    PERFORM "raise_workflow_guard"('complete_view_image: asset does not belong to the project');
  END IF;
  UPDATE "final_views"
  SET status = 'READY', image_asset_id = p_asset_id, image_url = '/api/assets/' || p_asset_id::text,
      generation_prompt = p_prompt, error_reason = NULL
  WHERE id = v.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (v.project_id, 'VIEW_GENERATED', jsonb_build_object('viewId', v.id, 'viewType', v.view_type,
          'versionNumber', v.version_number, 'assetId', p_asset_id) || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'completed'::text;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "fail_view_image"(p_view_id uuid, p_reason text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  v "final_views"%ROWTYPE;
BEGIN
  SELECT * INTO v FROM "final_views" WHERE id = p_view_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  IF v.status <> 'GENERATING' THEN RETURN QUERY SELECT 'stale'::text; RETURN; END IF;
  UPDATE "final_views" SET status = 'FAILED', error_reason = left(COALESCE(p_reason, 'The view could not be generated.'), 500)
  WHERE id = v.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (v.project_id, 'GENERATION_FAILED', jsonb_build_object('stage', 'VIEW', 'viewId', v.id, 'viewType', v.view_type,
          'versionNumber', v.version_number, 'reason', left(COALESCE(p_reason, ''), 500)) || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'failed'::text;
END;
$$;
--> statement-breakpoint

-- Closes a run: leftovers of this run fail (timeout); when all four current views are READY/APPROVED the
-- project moves to VIEW_REVIEW. outcome: review | waiting (other views still running) | needs_retry | stale
CREATE OR REPLACE FUNCTION "finish_view_generation"(p_project_id uuid, p_view_ids uuid[])
RETURNS TABLE (outcome text, ready integer, failed integer, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  v_ready integer;
  v_failed integer;
  v_running integer;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL OR p.status <> 'GENERATING_VIEWS' THEN
    RETURN QUERY SELECT 'stale'::text, 0, 0, p.status; RETURN;
  END IF;
  UPDATE "final_views" SET status = 'FAILED', error_reason = 'The view did not finish in time. You can retry it.'
  WHERE id = ANY(COALESCE(p_view_ids, '{}')) AND status = 'GENERATING';

  SELECT count(*) FILTER (WHERE status IN ('READY', 'APPROVED')), count(*) FILTER (WHERE status = 'FAILED'),
         count(*) FILTER (WHERE status = 'GENERATING')
  INTO v_ready, v_failed, v_running FROM "final_views" WHERE project_id = p.id AND is_current;

  IF v_ready = 4 THEN
    UPDATE "projects" SET status = 'VIEW_REVIEW' WHERE id = p.id;
    RETURN QUERY SELECT 'review'::text, v_ready, v_failed, 'VIEW_REVIEW'::"project_status"; RETURN;
  END IF;
  RETURN QUERY SELECT (CASE WHEN v_running > 0 THEN 'waiting' ELSE 'needs_retry' END)::text, v_ready, v_failed, p.status;
END;
$$;
--> statement-breakpoint

-- "Approve all views": every current view approved, project -> UPLOADING_TO_DRIVE.
-- outcome: approved | not_found | invalid_state | incomplete
CREATE OR REPLACE FUNCTION "approve_all_views"(p_project_id uuid)
RETURNS TABLE (outcome text, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  v record;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::"project_status"; RETURN; END IF;
  IF p.status <> 'VIEW_REVIEW' THEN RETURN QUERY SELECT 'invalid_state'::text, p.status; RETURN; END IF;
  IF "count_current_views"(p.id, ARRAY['READY', 'APPROVED']::"view_status"[], false) <> 4 THEN
    RETURN QUERY SELECT 'incomplete'::text, p.status; RETURN;
  END IF;
  FOR v IN SELECT id, view_type FROM "final_views" WHERE project_id = p.id AND is_current AND status = 'READY' FOR UPDATE LOOP
    UPDATE "final_views" SET status = 'APPROVED' WHERE id = v.id;
    INSERT INTO "project_events" (project_id, event_type, payload)
    VALUES (p.id, 'VIEW_APPROVED', jsonb_build_object('viewId', v.id, 'viewType', v.view_type));
  END LOOP;
  UPDATE "projects" SET status = 'UPLOADING_TO_DRIVE' WHERE id = p.id;
  INSERT INTO "project_events" (project_id, event_type, payload) VALUES (p.id, 'DRIVE_UPLOAD_STARTED', '{}'::jsonb);
  RETURN QUERY SELECT 'approved'::text, 'UPLOADING_TO_DRIVE'::"project_status";
END;
$$;
