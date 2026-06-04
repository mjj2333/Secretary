-- Phase 6b: review status for mined style examples + the agent's original generated draft body.
ALTER TABLE style_examples ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
  CHECK (status IN ('pending','approved','rejected'));
ALTER TABLE drafts ADD COLUMN generated_body_text TEXT;
