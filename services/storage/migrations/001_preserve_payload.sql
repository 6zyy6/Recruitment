ALTER TABLE recruitment_state
  MODIFY COLUMN payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD CONSTRAINT recruitment_state_payload_json CHECK (JSON_VALID(payload));
