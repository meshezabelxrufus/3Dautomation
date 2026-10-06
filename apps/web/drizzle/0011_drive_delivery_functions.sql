-- Step 9: Google Drive delivery. n8n uploads the design package item by item; every created Drive
-- folder/file is recorded here as soon as it exists, so re-runs reuse it instead of creating duplicates.

CREATE TRIGGER "trg_90_drive_items_updated_at" BEFORE UPDATE ON "drive_items"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint

-- Claims a Drive export for the project and returns everything the workflow needs (no secrets):
-- the project record, the canonical design, the source images and the Drive items already created.
-- outcome: started | already_completed | in_progress | invalid_state | not_found
CREATE OR REPLACE FUNCTION "start_drive_export"(p_project_id uuid, p_mode text)
RETURNS TABLE (outcome text, export_id uuid, plan jsonb, project_status "project_status")
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  d "final_designs"%ROWTYPE;
  v_id uuid;
  v_plan jsonb;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  IF p.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::jsonb, NULL::"project_status"; RETURN; END IF;
  IF p.status = 'COMPLETED' THEN
    RETURN QUERY SELECT 'already_completed'::text, NULL::uuid,
      (SELECT jsonb_build_object('folder_url', drive_url, 'folder_id', drive_file_id) FROM "drive_items"
        WHERE project_id = p.id AND item_key = 'folder:project'), p.status;
    RETURN;
  END IF;
  IF p.status <> 'UPLOADING_TO_DRIVE' THEN RETURN QUERY SELECT 'invalid_state'::text, NULL::uuid, NULL::jsonb, p.status; RETURN; END IF;

  -- A run that stopped reporting (n8n restart) no longer blocks a new one.
  UPDATE "drive_exports" SET status = 'FAILED', finished_at = now(), error_reason = 'The upload stopped responding.'
  WHERE project_id = p.id AND status = 'RUNNING' AND started_at < now() - interval '20 minutes';
  IF EXISTS (SELECT 1 FROM "drive_exports" WHERE project_id = p.id AND status = 'RUNNING') THEN
    RETURN QUERY SELECT 'in_progress'::text, NULL::uuid, NULL::jsonb, p.status; RETURN;
  END IF;

  SELECT * INTO d FROM "final_designs" WHERE project_id = p.id AND status = 'FINALIZED';
  INSERT INTO "drive_exports" (project_id, mode) VALUES (p.id, CASE WHEN p_mode = 'live' THEN 'live' ELSE 'test' END)
  RETURNING id INTO v_id;

  SELECT jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.project_name, 'client_name', p.client_name,
                                  'design_brief', p.design_brief, 'created_at', p.created_at),
    'final_design', jsonb_build_object('id', d.id, 'finalized_at', d.finalized_at, 'master_asset_id', d.master_asset_id,
                                       'design_summary', d.view_prompts->>'design_summary', 'invariants', d.view_prompts->'invariants'),
    'approved_concept', (SELECT jsonb_build_object('id', c.id, 'number', c.concept_number, 'title', c.title, 'description', c.description,
                                                   'materials', to_jsonb(c.materials), 'key_features', to_jsonb(c.key_features))
                         FROM "concepts" c WHERE c.id = d.approved_concept_id),
    'approved_revision', (SELECT jsonb_build_object('id', r.id, 'number', r.revision_number, 'feedback', r.client_feedback,
                                                    'summary', r.interpreted_instruction->>'summary')
                          FROM "revisions" r WHERE r.id = d.approved_revision_id),
    'views', (SELECT COALESCE(jsonb_agg(jsonb_build_object('type', v.view_type, 'asset_id', v.image_asset_id, 'version', v.version_number)
                                        ORDER BY array_position(ARRAY['FRONT','BACK','LEFT','RIGHT']::"view_type"[], v.view_type)), '[]'::jsonb)
              FROM "final_views" v WHERE v.project_id = p.id AND v.is_current),
    'concepts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('number', c.concept_number, 'title', c.title, 'asset_id', c.image_asset_id,
                                                              'status', c.status) ORDER BY c.concept_number), '[]'::jsonb)
                 FROM "concepts" c WHERE c.project_id = p.id AND c.image_asset_id IS NOT NULL),
    'revisions', (SELECT COALESCE(jsonb_agg(jsonb_build_object('concept_number', c.concept_number, 'number', r.revision_number,
                                                               'asset_id', r.image_asset_id) ORDER BY c.concept_number, r.revision_number), '[]'::jsonb)
                  FROM "revisions" r JOIN "concepts" c ON c.id = r.concept_id
                  WHERE c.project_id = p.id AND r.status IN ('READY', 'SELECTED') AND r.image_asset_id IS NOT NULL),
    'root', (SELECT jsonb_build_object('drive_file_id', i.drive_file_id, 'drive_url', i.drive_url)
             FROM "drive_items" i WHERE i.project_id IS NULL AND i.item_key = 'root'),
    'items', (SELECT COALESCE(jsonb_object_agg(i.item_key, jsonb_build_object('drive_file_id', i.drive_file_id, 'drive_url', i.drive_url,
                                                 'uploaded_asset_id', i.uploaded_asset_id, 'status', i.status)), '{}'::jsonb)
              FROM "drive_items" i WHERE i.project_id = p.id)
  ) INTO v_plan;

  RETURN QUERY SELECT 'started'::text, v_id, v_plan, p.status;
END;
$$;
--> statement-breakpoint

-- Records one Drive item (upsert by project + key). Called after every Drive step, so an ID is
-- never lost. A finished view upload also stores its Drive file ID on the view.
CREATE OR REPLACE FUNCTION "save_drive_item"(p_project_id uuid, p_item jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  v_key text := p_item->>'key';
  v_status text := COALESCE(p_item->>'status', 'PENDING');
  v_view text;
BEGIN
  IF v_key IS NULL OR (p_project_id IS NULL AND v_key <> 'root') THEN
    PERFORM "raise_workflow_guard"('save_drive_item: invalid item');
  END IF;
  INSERT INTO "drive_items" (project_id, item_key, kind, name, drive_file_id, drive_url, source_asset_id,
                             uploaded_asset_id, status, error_reason, attempts, uploaded_at)
  VALUES (p_project_id, v_key, p_item->>'kind', p_item->>'name', p_item->>'drive_file_id', p_item->>'drive_url',
          (p_item->>'source_asset_id')::uuid, (p_item->>'uploaded_asset_id')::uuid, v_status, p_item->>'error',
          COALESCE((p_item->>'attempts')::int, 0),
          CASE WHEN v_status = 'DONE' AND p_item->>'kind' = 'FILE' THEN now() END)
  ON CONFLICT (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), item_key) DO UPDATE SET
    kind = EXCLUDED.kind, name = EXCLUDED.name,
    drive_file_id = EXCLUDED.drive_file_id, drive_url = COALESCE(EXCLUDED.drive_url, drive_items.drive_url),
    source_asset_id = EXCLUDED.source_asset_id,
    uploaded_asset_id = COALESCE(EXCLUDED.uploaded_asset_id, drive_items.uploaded_asset_id),
    status = EXCLUDED.status, error_reason = EXCLUDED.error_reason, attempts = EXCLUDED.attempts,
    uploaded_at = CASE WHEN EXCLUDED.status = 'DONE' AND EXCLUDED.kind = 'FILE' THEN now() ELSE drive_items.uploaded_at END;

  v_view := substring(v_key FROM '^file:(FRONT|BACK|LEFT|RIGHT)$');
  IF v_view IS NOT NULL AND v_status = 'DONE' THEN
    UPDATE "final_views" SET drive_file_id = p_item->>'drive_file_id'
    WHERE project_id = p_project_id AND view_type = v_view::"view_type" AND is_current;
  END IF;
  RETURN QUERY SELECT 'saved'::text;
END;
$$;
--> statement-breakpoint

-- Every required item is in Drive: the export completes and so does the project.
-- outcome: completed | incomplete | stale | not_found
CREATE OR REPLACE FUNCTION "complete_drive_export"(p_project_id uuid, p_export_id uuid, p_summary jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text, missing text[])
LANGUAGE plpgsql AS $$
DECLARE
  p "projects"%ROWTYPE;
  e "drive_exports"%ROWTYPE;
  v_missing text[];
  v_folder "drive_items"%ROWTYPE;
BEGIN
  SELECT * INTO p FROM "projects" WHERE id = p_project_id FOR UPDATE;
  SELECT * INTO e FROM "drive_exports" WHERE id = p_export_id AND project_id = p_project_id FOR UPDATE;
  IF p.id IS NULL OR e.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::text[]; RETURN; END IF;
  IF e.status <> 'RUNNING' OR p.status <> 'UPLOADING_TO_DRIVE' THEN RETURN QUERY SELECT 'stale'::text, NULL::text[]; RETURN; END IF;

  SELECT ARRAY(SELECT k FROM unnest(ARRAY['folder:project', 'folder:03_APPROVED_DESIGN', 'folder:04_METADATA', 'file:MASTER',
                                          'file:FRONT', 'file:BACK', 'file:LEFT', 'file:RIGHT', 'file:METADATA']) AS k
               WHERE NOT EXISTS (SELECT 1 FROM "drive_items" i WHERE i.project_id = p.id AND i.item_key = k AND i.status = 'DONE'))
  INTO v_missing;
  IF cardinality(v_missing) > 0 THEN RETURN QUERY SELECT 'incomplete'::text, v_missing; RETURN; END IF;

  SELECT * INTO v_folder FROM "drive_items" WHERE project_id = p.id AND item_key = 'folder:project';
  UPDATE "drive_exports" SET status = 'COMPLETED', finished_at = now(), summary = p_summary, error_reason = NULL WHERE id = e.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'DRIVE_UPLOAD_COMPLETED', jsonb_build_object('exportId', e.id, 'mode', e.mode, 'driveFolderId', v_folder.drive_file_id,
          'driveFileIds', (SELECT jsonb_object_agg(replace(i.item_key, 'file:', ''), i.drive_file_id) FROM "drive_items" i
                           WHERE i.project_id = p.id AND i.item_key IN ('file:MASTER', 'file:FRONT', 'file:BACK', 'file:LEFT', 'file:RIGHT', 'file:METADATA'))));
  UPDATE "projects" SET status = 'COMPLETED' WHERE id = p.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p.id, 'PROJECT_COMPLETED', jsonb_build_object('driveFolderId', v_folder.drive_file_id));
  RETURN QUERY SELECT 'completed'::text, NULL::text[];
END;
$$;
--> statement-breakpoint

-- Some items failed: the run ends, successful uploads are kept, the project stays in UPLOADING_TO_DRIVE
-- so the client can retry (only what's missing is uploaded again).
CREATE OR REPLACE FUNCTION "fail_drive_export"(p_project_id uuid, p_export_id uuid, p_reason text, p_summary jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  e "drive_exports"%ROWTYPE;
BEGIN
  SELECT * INTO e FROM "drive_exports" WHERE id = p_export_id AND project_id = p_project_id FOR UPDATE;
  IF e.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  IF e.status <> 'RUNNING' THEN RETURN QUERY SELECT 'stale'::text; RETURN; END IF;
  UPDATE "drive_exports" SET status = 'FAILED', finished_at = now(), summary = p_summary,
         error_reason = left(COALESCE(p_reason, 'The Google Drive upload did not finish.'), 500)
  WHERE id = e.id;
  INSERT INTO "project_events" (project_id, event_type, payload)
  VALUES (p_project_id, 'GENERATION_FAILED', jsonb_build_object('stage', 'DRIVE', 'exportId', e.id,
          'reason', left(COALESCE(p_reason, ''), 500)) || COALESCE(p_summary, '{}'::jsonb));
  RETURN QUERY SELECT 'failed'::text;
END;
$$;
