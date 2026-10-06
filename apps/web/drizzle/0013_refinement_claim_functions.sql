-- A refinement run claims its revision (revisions.claimed_at, set by the n8n refine workflow when it loads
-- the revision), so a duplicate webhook can't pay for Claude and the image model twice. A retry clears it.
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
  UPDATE "revisions" SET status = 'GENERATING', error_reason = NULL, claimed_at = NULL WHERE id = rv.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'REFINEMENT_STARTED', jsonb_build_object('conceptId', c.id, 'revisionId', rv.id, 'revisionNumber', rv.revision_number,
          'baseRevisionId', rv.base_revision_id, 'retry', true));
  RETURN QUERY SELECT 'started'::text, rv.id, rv.revision_number, 'REFINING'::"project_status";
END;
$$;
