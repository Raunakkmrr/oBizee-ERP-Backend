-- Rate limiting for the sign-in endpoints.
--
-- In the database rather than in memory, for two reasons that both matter to
-- the thing being defended:
--
--   * a restart must not reset the window, or an attacker who can provoke one
--     gets a fresh allowance;
--   * two instances must not each grant the full allowance, which is what
--     in-process counters do the moment this scales past one node.
--
-- Fixed window rather than sliding: a sliding window needs the timestamps kept,
-- and for "five password guesses in fifteen minutes" the extra precision buys
-- nothing an attacker can exploit.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL
);

--> statement-breakpoint

-- Rows are only interesting until their window closes; this is for pruning.
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

--> statement-breakpoint

/*
  Count one hit against a key and say whether it is allowed.

  Atomic in a single statement, like `next_in_series`: the read and the
  increment cannot interleave, so twenty simultaneous guesses consume twenty
  hits rather than racing to consume one. A limiter that undercounts under
  concurrency is exactly no limiter, because concurrency is how guessing is
  done.

  Returns the seconds until the window reopens, so the caller can answer with a
  truthful `Retry-After` instead of a guess.
*/
CREATE OR REPLACE FUNCTION consume_rate_limit(
  k               text,
  max_hits        integer,
  window_seconds  integer
)
RETURNS TABLE (allowed boolean, retry_after integer)
LANGUAGE plpgsql
AS $$
DECLARE
  row_after  rate_limits%ROWTYPE;
  now_ts     timestamptz := now();
  window_len interval    := make_interval(secs => window_seconds);
BEGIN
  INSERT INTO rate_limits AS r (key, window_start, hits)
  VALUES (k, now_ts, 1)
  ON CONFLICT (key) DO UPDATE
    SET hits = CASE
                 WHEN r.window_start + window_len <= now_ts THEN 1
                 ELSE r.hits + 1
               END,
        window_start = CASE
                 WHEN r.window_start + window_len <= now_ts THEN now_ts
                 ELSE r.window_start
               END
  RETURNING * INTO row_after;

  IF row_after.hits <= max_hits THEN
    RETURN QUERY SELECT true, 0;
  ELSE
    RETURN QUERY SELECT
      false,
      GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (row_after.window_start + window_len - now_ts)))::integer
      );
  END IF;
END;
$$;

--> statement-breakpoint

/*
  Forget a key.

  A successful sign-in clears the failure count for that account, so somebody
  who mistypes twice and then gets in is not carrying two strikes into
  tomorrow. Only failures accumulate.
*/
CREATE OR REPLACE FUNCTION clear_rate_limit(k text)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM rate_limits WHERE key = k;
$$;

--> statement-breakpoint

/* Housekeeping — closed windows are dead weight. Safe to call any time. */
CREATE OR REPLACE FUNCTION prune_rate_limits(older_than_seconds integer DEFAULT 86400)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM rate_limits
  WHERE window_start < now() - make_interval(secs => older_than_seconds);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
