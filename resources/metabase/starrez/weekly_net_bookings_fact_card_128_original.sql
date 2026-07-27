with gross_by_week as (
  select
    term_session_code,
    "Week of Leasing Cycle" as week_of_leasing_cycle,
    room_location_description,
    "Portfolio" as portfolio,
    "Client" as client,
    m."HOO" as hoo,
    "Booking Channel" as booking_channel,
    nationality_description,
    "Weeks Leased" as weeks_leased,
    asset.like_for_like_eligible,
    count(*) as gross_bookings
  from {{#120-gross-booking-model}} m
  left join starrez_data.asset_lookup asset
    on lower(btrim(asset.asset)) = lower(btrim(m.room_location_description))
  where "Record Type" in ('Sales', 'Cancellation')
    and "Week of Leasing Cycle" is not null
  group by
    term_session_code,
    "Week of Leasing Cycle",
    room_location_description,
    "Portfolio",
    "Client",
    m."HOO",
    "Booking Channel",
    nationality_description,
    "Weeks Leased",
    asset.like_for_like_eligible
),
cancelled_by_week as (
  select
    term_session_code,
    "CANCELLED Week of Leasing Cycle" as week_of_leasing_cycle,
    room_location_description,
    "Portfolio" as portfolio,
    "Client" as client,
    m."HOO" as hoo,
    "Booking Channel" as booking_channel,
    nationality_description,
    "Weeks Leased" as weeks_leased,
    asset.like_for_like_eligible,
    count(*) as cancelled_bookings
  from {{#120-gross-booking-model}} m
  left join starrez_data.asset_lookup asset
    on lower(btrim(asset.asset)) = lower(btrim(m.room_location_description))
  where "Record Type" = 'Cancellation'
    and "CANCELLED Week of Leasing Cycle" is not null
  group by
    term_session_code,
    "CANCELLED Week of Leasing Cycle",
    room_location_description,
    "Portfolio",
    "Client",
    m."HOO",
    "Booking Channel",
    nationality_description,
    "Weeks Leased",
    asset.like_for_like_eligible
)
select
  coalesce(g.term_session_code, c.term_session_code) as term_session_code,
  coalesce(g.week_of_leasing_cycle, c.week_of_leasing_cycle) as week_of_leasing_cycle,
  coalesce(g.room_location_description, c.room_location_description) as room_location_description,
  coalesce(g.portfolio, c.portfolio) as portfolio,
  coalesce(g.client, c.client) as client,
  coalesce(g.hoo, c.hoo) as hoo,
  coalesce(g.booking_channel, c.booking_channel) as booking_channel,
  coalesce(g.nationality_description, c.nationality_description) as nationality_description,
  coalesce(g.weeks_leased, c.weeks_leased) as weeks_leased,
  coalesce(g.like_for_like_eligible, c.like_for_like_eligible) as like_for_like_eligible,
  coalesce(g.gross_bookings, 0) as gross_bookings,
  coalesce(c.cancelled_bookings, 0) as cancelled_bookings,
  coalesce(g.gross_bookings, 0) - coalesce(c.cancelled_bookings, 0) as net_bookings
from gross_by_week g
full outer join cancelled_by_week c
  on c.term_session_code = g.term_session_code
 and c.week_of_leasing_cycle = g.week_of_leasing_cycle
 and c.room_location_description is not distinct from g.room_location_description
 and c.portfolio is not distinct from g.portfolio
 and c.client is not distinct from g.client
 and c.hoo is not distinct from g.hoo
 and c.booking_channel is not distinct from g.booking_channel
 and c.nationality_description is not distinct from g.nationality_description
 and c.weeks_leased is not distinct from g.weeks_leased
 and c.like_for_like_eligible is not distinct from g.like_for_like_eligible
order by term_session_code, week_of_leasing_cycle

