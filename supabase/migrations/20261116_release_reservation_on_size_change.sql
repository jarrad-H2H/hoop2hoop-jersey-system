-- A reserved number is held in ONE size. Wolves, 13 Nov 2026: George Bartle reserved 5XS #10, the
-- size was then switched to 4XS and Add to Cart bought the 4XS with "#10" attached (order
-- H2H2413715). The widget now drops its hold when the size changes, and releases it at once
-- through this function instead of leaving the jersey held for the rest of its 30 minutes.
--
-- release_reservation: frees one live hold (status 'reserved'). Stock jerseys go back on sale;
-- a made-to-order placeholder (inventory status 'Pending') is removed, because it was never a real
-- jersey. Callable by the widget (anon): the hold id is a random UUID known only to the browser
-- that made the hold, and only an unpaid hold can be released.
create or replace function public.release_reservation(p_pending_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv_id uuid;
  v_inv_status text;
begin
  update pending_allocations
     set status = 'expired', expires_at = least(expires_at, now())
   where id = p_pending_id and status = 'reserved'
  returning inventory_id into v_inv_id;
  if not found then
    return false;
  end if;

  if v_inv_id is not null then
    select status into v_inv_status from inventory where id = v_inv_id for update;
    if v_inv_status = 'Pending' then
      update pending_allocations set inventory_id = null where id = p_pending_id;
      delete from inventory where id = v_inv_id and status = 'Pending';
    elsif v_inv_status = 'Allocated' then
      update inventory
         set status = 'Available', allocated_player_id = null, allocation_date = null, return_date_due = null
       where id = v_inv_id;
      insert into allocations (allocation_type, club_id, jersey_number, size, product_type, note)
      select 'return', club_id, jersey_number, size, product_type,
             'Reservation released: size changed before checkout - returned to stock'
        from inventory where id = v_inv_id;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function public.release_reservation(uuid) from public;
grant execute on function public.release_reservation(uuid) to anon, authenticated, service_role;

-- Expiry clean-up (cron, every minute). It used to set the held inventory row to 'Available'
-- whatever it was, so an unpaid made-to-order hold turned its placeholder ('Pending', never a real
-- jersey) into phantom stock. Now: real held stock ('Allocated') goes back on sale as before;
-- made-to-order placeholders are removed.
create or replace function public.expire_pending_allocations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_placeholders uuid[];
begin
  with due as (
    select id from pending_allocations
     where status = 'reserved' and expires_at <= now()
     for update skip locked
  )
  select array_agg(id) into v_ids from due;
  if v_ids is null then
    return 0;
  end if;

  update pending_allocations set status = 'expired' where id = any(v_ids);

  select array_agg(i.id) into v_placeholders
    from pending_allocations pa join inventory i on i.id = pa.inventory_id
   where pa.id = any(v_ids) and i.status = 'Pending';
  if v_placeholders is not null then
    update pending_allocations set inventory_id = null where id = any(v_ids) and inventory_id = any(v_placeholders);
    delete from inventory where id = any(v_placeholders) and status = 'Pending';
  end if;

  with inv as (
    update inventory i
       set status = 'Available', allocated_player_id = null, allocation_date = null, return_date_due = null
      from pending_allocations pa
     where pa.id = any(v_ids) and i.id = pa.inventory_id and i.status = 'Allocated'
    returning i.club_id, i.jersey_number, i.size, i.product_type
  )
  insert into allocations (allocation_type, club_id, player_id, jersey_number, size, previous_jersey_number, previous_size, product_type, note)
  select 'return', club_id, null, jersey_number, size, null, null, product_type,
         'Auto-expired reservation (pending_allocations) - returned to stock'
    from inv;

  return array_length(v_ids, 1);
end;
$$;
