-- The public widget read pending_allocations directly (every column, including buyers' names and
-- birth years) through an anon SELECT policy. These two functions return only what the widget
-- needs, so that policy (and the unused anon INSERT policy) can be dropped
-- (20261018_drop_anon_pending_allocations_policies.sql).

-- Live holds on the given numbers at a club, for clash checks: purchases, and reservations that
-- haven't expired. No names.
CREATE OR REPLACE FUNCTION public.widget_reservation_holds(p_club_id uuid, p_jersey_numbers integer[])
 RETURNS TABLE(jersey_number integer, year_of_birth integer, team_id text, status text, expires_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT pa.jersey_number, pa.year_of_birth, pa.team_id, pa.status, pa.expires_at
  FROM   pending_allocations pa
  WHERE  pa.club_id = p_club_id
    AND  pa.jersey_number = ANY (p_jersey_numbers)
    AND  (pa.status = 'purchased' OR (pa.status = 'reserved' AND pa.expires_at > now()))
    AND  EXISTS (SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id);
$function$;

-- The stock jersey a returning player bought through the allocator with this number: the one the
-- order webhook writes off when they say it will be their only jersey (lookupPlayerByName). Their
-- most recent purchase, unless that jersey was reserved or bought again since (returned, then sold
-- to someone else), and only while it is still Allocated. Names must match exactly (ignoring case),
-- never as a pattern, so this can't be used to search buyers. Returns only the jersey's id.
CREATE OR REPLACE FUNCTION public.widget_own_purchased_jersey(p_club_id uuid, p_jersey_number integer, p_product_type text, p_first_name text, p_last_name text, p_year_of_birth integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH latest AS (
    SELECT pa.inventory_id, pa.created_at
    FROM   pending_allocations pa
    WHERE  pa.club_id        = p_club_id
      AND  pa.jersey_number  = p_jersey_number
      AND  pa.product_type   = p_product_type
      AND  pa.status         = 'purchased'
      AND  pa.inventory_id IS NOT NULL
      AND  lower(pa.player_first_name) = lower(p_first_name)
      AND  lower(pa.player_last_name)  = lower(p_last_name)
      AND  (p_year_of_birth IS NULL OR pa.year_of_birth = p_year_of_birth)
      AND  EXISTS (SELECT 1 FROM shopify_product_club_map m WHERE m.club_id = p_club_id)
    ORDER  BY pa.purchased_at DESC
    LIMIT  1
  )
  SELECT i.id
  FROM   latest l
  JOIN   inventory i ON i.id = l.inventory_id AND i.status = 'Allocated'
  WHERE  NOT EXISTS (
    SELECT 1 FROM pending_allocations n
    WHERE  n.inventory_id = l.inventory_id
      AND  n.status IN ('reserved', 'purchased')
      AND  n.created_at > l.created_at
  );
$function$;

REVOKE ALL ON FUNCTION public.widget_reservation_holds(uuid,integer[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.widget_reservation_holds(uuid,integer[]) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.widget_own_purchased_jersey(uuid,integer,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.widget_own_purchased_jersey(uuid,integer,text,text,text,integer) TO anon, authenticated, service_role;
