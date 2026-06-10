-- Read-only role for the Setoku gateway. RUN THIS YOURSELF against the target
-- database (e.g. staging) — Setoku never executes DDL.
-- Replace the password, then set the resulting URL as the SETOKU_DATABASE_URL secret:
--   postgresql://setoku_ro:<password>@<host>:5432/<db>

CREATE ROLE setoku_ro LOGIN PASSWORD 'CHANGE_ME';
GRANT CONNECT ON DATABASE postgres TO setoku_ro;          -- adjust db name
GRANT USAGE ON SCHEMA public TO setoku_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO setoku_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO setoku_ro;

-- Defense in depth (the gateway already runs READ ONLY transactions):
ALTER ROLE setoku_ro SET default_transaction_read_only = on;
ALTER ROLE setoku_ro SET statement_timeout = '20s';
