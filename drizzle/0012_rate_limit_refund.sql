-- Give back a hit that turned out not to be an attempt worth counting.
--
-- The per-account budget is cleared on a successful sign-in, so the comment
-- above LIMITS — "only failures count, so signing in often costs nothing" —
-- is true of it. The per-IP budget was never cleared, and every attempt
-- consumed it whether or not it succeeded.
--
-- That is fine for one person on a home connection and wrong for the customers
-- this is built for. An MSME office shares one public address behind NAT, so
-- twenty successful sign-ins in fifteen minutes is a dozen people arriving on a
-- Monday morning — and the twenty-first is locked out, along with everybody
-- else in the building, by a limiter that was supposed to be counting attacks.
--
-- Not a `clear`, deliberately. Clearing the IP budget on success would let
-- anybody holding one valid credential wipe the counter between guesses at
-- other accounts, which is most of what the IP key is there to stop. A refund
-- of exactly the hit just spent leaves failures accumulating and successes
-- costing nothing.
CREATE OR REPLACE FUNCTION refund_rate_limit(k text) RETURNS void
LANGUAGE sql
AS $$
  UPDATE rate_limits
     SET hits = greatest(0, hits - 1)
   WHERE key = k;
$$;
