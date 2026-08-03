CREATE TABLE api_idempotency_keys (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_id UUID NOT NULL,
  response_body JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, actor_id, operation, idempotency_key),
  CONSTRAINT api_idempotency_keys_organization_actor_fk
    FOREIGN KEY (organization_id, actor_id)
    REFERENCES actors (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT api_idempotency_keys_operation_length_check
    CHECK (char_length(operation) BETWEEN 1 AND 100),
  CONSTRAINT api_idempotency_keys_key_shape_check
    CHECK (
      char_length(idempotency_key) BETWEEN 8 AND 128
      AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT api_idempotency_keys_request_hash_shape_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_idempotency_keys_response_shape_check
    CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
  CONSTRAINT api_idempotency_keys_completion_check
    CHECK (
      (response_body IS NULL AND completed_at IS NULL)
      OR (response_body IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE INDEX api_idempotency_keys_created_at_idx
  ON api_idempotency_keys (organization_id, created_at DESC);
