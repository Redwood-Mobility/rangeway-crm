-- One indexed row per calendar series.
--
-- `singleEvents=true` expands a recurring event into every occurrence. A single
-- standing block produced a thousand identical rows spanning fourteen years and
-- buried everything else in the index. A series is one thing worth finding, not
-- one thing per day.
--
-- `series_key` is Google's recurring event ID for an instance and the event ID
-- for a one-off, so a recurring series occupies exactly one row and later syncs
-- move that row to the occurrence nearest to now rather than appending another.

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS series_key TEXT NOT NULL DEFAULT '';

-- Existing rows predate the concept; each one stands for itself.
UPDATE calendar_events SET series_key = provider_event_id WHERE series_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_series_unique
  ON calendar_events (organization_id, connection_id, series_key);
