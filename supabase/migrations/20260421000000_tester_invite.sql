ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tester_ig_handle text,
  ADD COLUMN IF NOT EXISTS tester_invite_status text CHECK (tester_invite_status IN ('pending', 'invited')),
  ADD COLUMN IF NOT EXISTS tester_submitted_at timestamptz;
