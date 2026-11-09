-- vet402 site funnel — daily aggregates (2026-11-09).
--
-- Counts are page views and named events, not people. There is no visitor id in site_events_daily.
-- visits = page_view where source is not internal (first paint or external referrer group).
-- key_page_views = page_view on listed path groups (product doc and funnel surfaces).
-- actions = snippet_copy, outbound_github, outbound_npm, contact_click, signup_started combined.
--
-- Run (last N UTC days, default 14):
--   psql "$DATABASE_URL" -v days=14 -f docs/metrics/site-funnel.sql
--
\if :{?days}
\else
\set days 14
\endif

WITH bounds AS (
  SELECT (now() AT TIME ZONE 'UTC')::date - (:'days'::int - 1) AS start_day,
         (now() AT TIME ZONE 'UTC')::date AS end_day
),
days AS (
  SELECT generate_series(b.start_day, b.end_day, '1 day'::interval)::date AS day
    FROM bounds b
),
ev AS (
  SELECT day, event, path, source, count
    FROM site_events_daily, bounds b
   WHERE day >= b.start_day AND day <= b.end_day
),
key_paths AS (
  SELECT unnest(ARRAY[
    '/docs/api', '/docs/mcp', '/connect', '/playground', '/x402/check-a-seller',
    '/x402/stablecoin-payments', '/x402/chains', '/x402/chains/[chain]',
    '/observatory', '/observatory/state', '/observatory/e/[id]',
    '/sellers/[host]', '/payee', '/payee/[address]', '/faq', '/blog/what-is-x402'
  ]::text[]) AS path
),
action_events AS (
  SELECT unnest(ARRAY[
    'snippet_copy', 'outbound_github', 'outbound_npm', 'contact_click', 'signup_started'
  ]::text[]) AS event
)
SELECT
  d.day,
  coalesce((
    SELECT sum(count) FROM ev e
     WHERE e.day = d.day AND e.event = 'page_view' AND e.source <> 'internal'
  ), 0) AS visits,
  coalesce((
    SELECT json_object_agg(src.source, src.c) FROM (
      SELECT source, sum(count) AS c FROM ev e
       WHERE e.day = d.day AND e.event = 'page_view' AND e.source <> 'internal'
       GROUP BY source
    ) src
  ), '{}'::json) AS visits_by_source,
  coalesce((
    SELECT sum(e.count) FROM ev e
     WHERE e.day = d.day AND e.event = 'page_view'
       AND (e.path IN (SELECT path FROM key_paths) OR e.path LIKE '/x402/chains/%')
  ), 0) AS key_page_views,
  coalesce((
    SELECT sum(e.count) FROM ev e
      JOIN action_events a ON a.event = e.event
     WHERE e.day = d.day
  ), 0) AS actions,
  coalesce((
    SELECT json_object_agg(ab.event, ab.c) FROM (
      SELECT e.event, sum(e.count) AS c FROM ev e
        JOIN action_events a ON a.event = e.event
       WHERE e.day = d.day
       GROUP BY e.event
    ) ab
  ), '{}'::json) AS action_breakdown,
  coalesce((
    SELECT sum(count) FROM ev e
     WHERE e.day = d.day AND e.event = 'signup_completed'
  ), 0) AS signups,
  coalesce((
    SELECT count(*)::bigint FROM api_keys k
     WHERE (k.created_at AT TIME ZONE 'UTC')::date = d.day
       AND (k.owner_relation IS NULL OR k.owner_relation <> 'self')
  ), 0) AS keys_created,
  coalesce((
    SELECT sum(c.count) FROM client_usage_daily c
     WHERE c.day = d.day AND c.client NOT IN ('self-monitor', 'crawler', 'site')
  ), 0) AS keyless_external_calls,
  coalesce((
    SELECT count(DISTINCT du.api_key_id) FROM decision_usage_daily du
      LEFT JOIN api_keys ak ON ak.id = du.api_key_id
     WHERE du.day = d.day
       AND (ak.owner_relation IS NULL OR ak.owner_relation <> 'self')
  ), 0) AS keyed_active_keys
FROM days d
ORDER BY d.day;
