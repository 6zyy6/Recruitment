CREATE TABLE IF NOT EXISTS recruitment_state (
  id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL,
  payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  CONSTRAINT recruitment_state_payload_json CHECK (JSON_VALID(payload))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  INDEX sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4;
