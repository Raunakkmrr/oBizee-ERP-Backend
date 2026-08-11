-- Fuzzy search over the job record.
--
-- `pg_trgm` rather than prefix matching, because the query is typed by somebody
-- with a customer on the line who half-remembers the name. "Kumar" has to find
-- "Rani Kumari", "Deshmuk" has to find "Deshmukh Hospital", and a prefix index
-- finds neither. Trigram similarity is what closes that gap, and the GIN
-- indexes below are what stop it being a sequential scan over every job.
--
-- Every index is on the searched column alone. The tenant filter rides the
-- existing btree indexes and Postgres combines the two with a bitmap AND, so
-- adding tenant_id to these would only make them larger.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- The job number is spoken aloud on calls (FR-210), so it is searched as a
-- substring: somebody reads back "1007" from a WhatsApp message, not the whole
-- `J-2610-1007`. ILIKE '%1007%' can use a trigram index; it cannot use a btree.
CREATE INDEX IF NOT EXISTS jobs_number_trgm_idx ON jobs USING gin (job_number gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS jobs_service_type_trgm_idx ON jobs USING gin (service_type gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS customers_name_trgm_idx ON customers USING gin (name gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sites_locality_trgm_idx ON sites USING gin (locality gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS users_name_trgm_idx ON users USING gin (name gin_trgm_ops);
--> statement-breakpoint

-- Phone is matched as a substring of the E.164 form, so the last four digits
-- find the contact. `919811667788` has to be found by `667788` and by
-- `9811667788`, which is what a caller ID shows.
CREATE INDEX IF NOT EXISTS contacts_phone_trgm_idx ON contacts USING gin (phone_e164 gin_trgm_ops);
--> statement-breakpoint

-- Keeps the ordering key covered for the paged list: scheduled date first,
-- then the row's birthday as the tie-break.
CREATE INDEX IF NOT EXISTS jobs_tenant_order_idx ON jobs (tenant_id, scheduled_date DESC, created_at DESC);
