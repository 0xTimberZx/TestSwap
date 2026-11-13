-- Gas board guards (see supabase/functions/gas-board/check.ts): each new post
-- reads the address's history (24 h cooldown from its last post or resolution,
-- at most 3 fills ever). This index keeps that lookup cheap as the table grows.
create index if not exists gas_requests_address_history
  on public.gas_requests (address, created_at desc);
