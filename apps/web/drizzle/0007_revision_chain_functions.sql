-- Step 7: the revision chain. Every refinement is a new revision linked to the version it was edited
-- from (base_revision_id); concepts point at their current version (active_revision_id, null = the
-- original image, "revision 0"). Revisions are never overwritten: a failed revision can be retried in
-- place (FAILED -> GENERATING) because it never produced an image.

-- Both links must stay inside one concept.
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_base_revision_same_concept_fk"
  FOREIGN KEY ("base_revision_id", "concept_id") REFERENCES "revisions"("id", "concept_id");
--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_active_revision_same_concept_fk"
  FOREIGN KEY ("active_revision_id", "id") REFERENCES "revisions"("id", "concept_id");
--> statement-breakpoint
CREATE INDEX "revisions_base_revision_idx" ON "revisions" ("base_revision_id");
--> statement-breakpoint

-- Backfill: chain existing revisions to the previous good one; the newest good one is current.
UPDATE "revisions" r SET "base_revision_id" = (
  SELECT p.id FROM "revisions" p
  WHERE p.concept_id = r.concept_id AND p.revision_number < r.revision_number AND p.status IN ('READY', 'SELECTED')
  ORDER BY p.revision_number DESC LIMIT 1);
--> statement-breakpoint
UPDATE "concepts" c SET "active_revision_id" = (
  SELECT r.id FROM "revisions" r
  WHERE r.concept_id = c.id AND r.status IN ('READY', 'SELECTED') AND r.image_url IS NOT NULL
  ORDER BY r.revision_number DESC LIMIT 1);
--> statement-breakpoint

-- Retrying a failed refinement reuses its revision row.
INSERT INTO "workflow_status_transitions" (entity, from_status, to_status) VALUES ('revision', 'FAILED', 'GENERATING');
--> statement-breakpoint

-- Starts a refinement of exactly the version the client was looking at.
-- outcome: started | not_found | concept_mismatch | busy | invalid_state | no_image | stale_version | invalid_request
CREATE OR REPLACE FUNCTION "start_refinement"(p_project_id uuid, p_concept_id uuid, p_base_revision_id uuid, p_feedback text)
RETURNS TABLE (outcome text, revision_id uuid, revision_number integer, active_revision_id uuid, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  c "concepts"%ROWTYPE;
  p "projects"%ROWTYPE;
  v_feedback text := btrim(COALESCE(p_feedback, ''));
  v_number integer;
  v_id uuid;
BEGIN
  IF char_length(v_feedback) NOT BETWEEN 1 AND 1000 THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::"project_status"; RETURN;
  END IF;
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::"project_status"; RETURN;
  END IF;
  IF c.id IS NULL OR c.project_id <> p.id THEN
    RETURN QUERY SELECT 'concept_mismatch'::text, NULL::uuid, NULL::integer, NULL::uuid, p.status; RETURN;
  END IF;
  IF p.status = 'REFINING' OR c.status = 'REFINING' THEN
    RETURN QUERY SELECT 'busy'::text, NULL::uuid, NULL::integer, c.active_revision_id, p.status; RETURN;
  END IF;
  IF p.status <> 'CONCEPT_REVIEW' OR c.status NOT IN ('READY', 'SELECTED') THEN
    RETURN QUERY SELECT 'invalid_state'::text, NULL::uuid, NULL::integer, c.active_revision_id, p.status; RETURN;
  END IF;
  IF c.image_url IS NULL THEN
    RETURN QUERY SELECT 'no_image'::text, NULL::uuid, NULL::integer, c.active_revision_id, p.status; RETURN;
  END IF;
  IF p_base_revision_id IS DISTINCT FROM c.active_revision_id THEN
    RETURN QUERY SELECT 'stale_version'::text, NULL::uuid, NULL::integer, c.active_revision_id, p.status; RETURN;
  END IF;

  UPDATE "projects" SET status = 'REFINING' WHERE id = p.id;
  UPDATE "concepts" SET status = 'REFINING' WHERE id = c.id;
  SELECT COALESCE(MAX(r.revision_number), 0) + 1 INTO v_number FROM "revisions" r WHERE r.concept_id = c.id;
  INSERT INTO "revisions" (concept_id, revision_number, client_feedback, base_revision_id, status)
  VALUES (c.id, v_number, v_feedback, c.active_revision_id, 'GENERATING')
  RETURNING id INTO v_id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'REFINEMENT_STARTED', jsonb_build_object('conceptId', c.id, 'revisionId', v_id, 'revisionNumber', v_number,
          'baseRevisionId', c.active_revision_id, 'retry', false));
  RETURN QUERY SELECT 'started'::text, v_id, v_number, c.active_revision_id, 'REFINING'::"project_status";
END;
$$;
--> statement-breakpoint

-- Retries a failed refinement in place: same revision, same feedback, same base version.
-- Only the newest revision can be retried, and only while its base is still the current version.
-- outcome: started | not_found | concept_mismatch | busy | invalid_state | not_retryable | stale_version
CREATE OR REPLACE FUNCTION "retry_refinement"(p_project_id uuid, p_concept_id uuid, p_revision_id uuid)
RETURNS TABLE (outcome text, revision_id uuid, revision_number integer, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  rv "revisions"%ROWTYPE;
  c "concepts"%ROWTYPE;
  p "projects"%ROWTYPE;
BEGIN
  SELECT * INTO rv FROM "revisions" WHERE id = p_revision_id FOR UPDATE;
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL OR rv.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, p.status; RETURN;
  END IF;
  IF c.id IS NULL OR c.project_id <> p.id OR rv.concept_id <> c.id THEN
    RETURN QUERY SELECT 'concept_mismatch'::text, NULL::uuid, NULL::integer, p.status; RETURN;
  END IF;
  IF p.status = 'REFINING' OR c.status = 'REFINING' THEN
    RETURN QUERY SELECT 'busy'::text, rv.id, rv.revision_number, p.status; RETURN;
  END IF;
  IF p.status <> 'CONCEPT_REVIEW' OR c.status NOT IN ('READY', 'SELECTED') THEN
    RETURN QUERY SELECT 'invalid_state'::text, rv.id, rv.revision_number, p.status; RETURN;
  END IF;
  IF rv.status <> 'FAILED' OR EXISTS (SELECT 1 FROM "revisions" n WHERE n.concept_id = c.id AND n.revision_number > rv.revision_number) THEN
    RETURN QUERY SELECT 'not_retryable'::text, rv.id, rv.revision_number, p.status; RETURN;
  END IF;
  IF rv.base_revision_id IS DISTINCT FROM c.active_revision_id THEN
    RETURN QUERY SELECT 'stale_version'::text, rv.id, rv.revision_number, p.status; RETURN;
  END IF;

  UPDATE "projects" SET status = 'REFINING' WHERE id = p.id;
  UPDATE "concepts" SET status = 'REFINING' WHERE id = c.id;
  UPDATE "revisions" SET status = 'GENERATING', error_reason = NULL WHERE id = rv.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'REFINEMENT_STARTED', jsonb_build_object('conceptId', c.id, 'revisionId', rv.id, 'revisionNumber', rv.revision_number,
          'baseRevisionId', rv.base_revision_id, 'retry', true));
  RETURN QUERY SELECT 'started'::text, rv.id, rv.revision_number, 'REFINING'::"project_status";
END;
$$;
--> statement-breakpoint

-- "Use this version": makes a version (null = original) the concept's current version and approves
-- the concept. outcome: selected | not_found | concept_mismatch | invalid_state | invalid_version
CREATE OR REPLACE FUNCTION "use_concept_version"(p_project_id uuid, p_concept_id uuid, p_revision_id uuid)
RETURNS TABLE (outcome text, active_revision_id uuid, concept_status "concept_status")
LANGUAGE plpgsql AS $$
DECLARE
  c "concepts"%ROWTYPE;
  p "projects"%ROWTYPE;
  rv "revisions"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "concepts" WHERE id = p_concept_id FOR UPDATE;
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::"concept_status"; RETURN;
  END IF;
  IF c.id IS NULL OR c.project_id <> p.id THEN
    RETURN QUERY SELECT 'concept_mismatch'::text, NULL::uuid, NULL::"concept_status"; RETURN;
  END IF;
  IF p.status <> 'CONCEPT_REVIEW' OR c.status NOT IN ('READY', 'SELECTED') THEN
    RETURN QUERY SELECT 'invalid_state'::text, c.active_revision_id, c.status; RETURN;
  END IF;
  IF p_revision_id IS NOT NULL THEN
    SELECT * INTO rv FROM "revisions" WHERE id = p_revision_id;
    IF rv.id IS NULL OR rv.concept_id <> c.id OR rv.status NOT IN ('READY', 'SELECTED') OR rv.image_url IS NULL THEN
      RETURN QUERY SELECT 'invalid_version'::text, c.active_revision_id, c.status; RETURN;
    END IF;
  ELSIF c.image_url IS NULL THEN
    RETURN QUERY SELECT 'invalid_version'::text, c.active_revision_id, c.status; RETURN;
  END IF;

  UPDATE "concepts" SET active_revision_id = p_revision_id WHERE id = c.id;
  IF c.status = 'READY' THEN UPDATE "concepts" SET status = 'SELECTED' WHERE id = c.id; END IF;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'CONCEPT_SELECTED', jsonb_build_object('conceptId', c.id, 'revisionId', p_revision_id,
          'revisionNumber', COALESCE(rv.revision_number, 0), 'via', 'use_this_version'));
  RETURN QUERY SELECT 'selected'::text, p_revision_id, 'SELECTED'::"concept_status";
END;
$$;
--> statement-breakpoint

-- A finished refinement becomes the concept's current version (the active candidate).
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
  UPDATE "concepts" SET active_revision_id = rv.id WHERE id = c.id;
  IF c.status = 'REFINING' THEN UPDATE "concepts" SET status = 'READY' WHERE id = c.id; END IF;
  UPDATE "projects" SET status = 'CONCEPT_REVIEW' WHERE id = c.project_id AND status = 'REFINING';
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (c.project_id, 'REVISION_CREATED',
          jsonb_build_object('conceptId', c.id, 'revisionId', rv.id, 'revisionNumber', rv.revision_number,
                             'baseRevisionId', rv.base_revision_id, 'assetId', p_asset_id)
          || COALESCE(p_meta, '{}'::jsonb));
  RETURN QUERY SELECT 'completed'::text;
END;
$$;
