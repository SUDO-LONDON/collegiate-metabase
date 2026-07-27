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
  from
    (
      -- Leasing Model, Step 1.
      -- Sources:
      --   Sales Table 65521
      --   Cancellations Table 65535
      --   Asset Lookup
      --   Weekly Lookup Sales Weeks (clean, long-format, maintained independently - no more position-based unpivoting)
      -- Purpose: clean the sales/cancellation reports, add calculated leasing fields, and attach sales week lookups.
      with weekly_lookup_sales_weeks as (
        -- Sourced directly from the maintained long-format lookup table.
        -- No per-term UNION ALL blocks or hardcoded column numbers needed -
        -- new academic years are added as new rows in this table, not new columns.
        select
          nullif(btrim(term_session_code), '') as term_session_code,
          lookup_date :: date as lookup_date,
          sales_week :: integer as sales_week
        from
          starrez_data.weekly_lookup_sales_weeks
        where
          nullif(btrim(term_session_code), '') is not null
          and lookup_date is not null
          and sales_week is not null
      ),
      asset_lookup as (
        -- Reusable lookup for Portfolio, Client, and City.
        -- Match Room Location Description from StarRez to Asset Lookup.asset.
        select
          distinct on (lower(btrim(asset))) -- Asset Lookup maps StarRez Room Location Description to reporting attributes.
          -- The uploaded lookup uses "asset" as the property/location name.
          lower(btrim(asset)) as asset_key,
          nullif(btrim(asset), '') as asset,
          nullif(btrim(portfolio), '') as portfolio,
          nullif(btrim(client), '') as client,
          nullif(btrim(city), '') as city,
          nullif(btrim("HOO"), '') as hoo
        from
          starrez_data.asset_lookup
        where
          nullif(btrim(asset), '') is not null
        order by
          lower(btrim(asset)),
          asset
      ),
      gross_booking_lookup as (
        -- De-duplicated gross-booking lookup used to backfill fields that are missing from cancellation rows.
        -- Booking IDs are not perfectly unique in the sales report, so take one stable row per booking_id.
        -- Pre-filtered to only booking_ids that actually appear in the cancellations report,
        -- so we are not deduping the entire sales table just to backfill a handful of cancelled bookings.
        select
          distinct on (nullif(btrim(s.booking_id), '')) nullif(btrim(s.booking_id), '') as booking_id,
          s.university,
          s.year_of_study,
          s.course,
          s.booking_type_description,
          s.incentives,
          s.hear_about_us
        from
          starrez_data.table_65521 s
        where
          nullif(btrim(s.booking_id), '') in (
            select
              nullif(btrim(c.booking_id), '')
            from
              starrez_data.table_65535 c
            where
              nullif(btrim(c.booking_id), '') is not null
          )
        order by
          nullif(btrim(s.booking_id), ''),
          s._metabase_row_id
      ),
      sales as (
        -- Start from the Sales Table and keep all original StarRez columns.
        -- StarRez date fields are text, so this block creates real date columns for calculations and joins.
        select
          s.*,
          -- Date Held drives the Week of Leasing Cycle lookup.
          case
            when nullif(btrim(s.date_held), '') is null then null
            when nullif(btrim(s.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(s.date_held), ''), 'DD/MM/YY')
            when nullif(btrim(s.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(s.date_held), ''), 'DD/MM/YYYY')
            when nullif(btrim(s.date_held), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(s.date_held), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(s.date_held), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.date_held), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_held_date,
          -- Date Reserved determines Booking Status.
          case
            when nullif(btrim(s.date_reserved), '') is null then null
            when nullif(btrim(s.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(s.date_reserved), ''), 'DD/MM/YY')
            when nullif(btrim(s.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(s.date_reserved), ''), 'DD/MM/YYYY')
            when nullif(btrim(s.date_reserved), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(s.date_reserved), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(s.date_reserved), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.date_reserved), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_reserved_date,
          -- Contract dates are used to calculate Weeks Leased.
          case
            when nullif(btrim(s.contract_date_start), '') is null then null
            when nullif(btrim(s.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(
              nullif(btrim(s.contract_date_start), ''),
              'DD/MM/YY'
            )
            when nullif(btrim(s.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(s.contract_date_start), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(s.contract_date_start), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(s.contract_date_start), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(s.contract_date_start), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.contract_date_start), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_start_date,
          case
            when nullif(btrim(s.contract_date_end), '') is null then null
            when nullif(btrim(s.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(s.contract_date_end), ''), 'DD/MM/YY')
            when nullif(btrim(s.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(s.contract_date_end), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(s.contract_date_end), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(s.contract_date_end), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(s.contract_date_end), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.contract_date_end), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_end_date
        from
          starrez_data.table_65521 s -- Remove historic academic years from the model.
        where
          coalesce(nullif(btrim(s.term_session_code), ''), '') not in ('2019/2020', '2020/2021', '2021/2022', '2022/2023') -- Exclude Castle Street from the model entirely.
          and coalesce(nullif(btrim(s.room_location_description), ''), '') not ilike '%castle street%' -- Nomination bookings are supplied by the dedicated aggregate source below.
          and coalesce(s.booking_type_description, '') not ilike '%nomination%'
      ),
      cancellations_raw as (
        -- Cancellation rows come from report 65535.
        -- They are shaped to match the sales rows so both can live in one model.
        select
          c.term_session_code,
          c.room_location_description,
          c.entry_id,
          c.booking_id,
          c.date_created,
          c.date_held,
          c.date_reserved,
          c.contract_date_start,
          c.contract_date_end,
          c.term_session_description,
          c.entry_status_description,
          c.room_type_description,
          c.room_space_description,
          c.room_rate_description,
          c.room_rate_amount,
          c.total_rent,
          c.gender_description,
          c.age,
          c.nationality_description,
          -- These fields do not exist in report 65535, so backfill from the gross booking lookup when possible.
          gross.university,
          gross.year_of_study,
          gross.course,
          c.agents,
          gross.booking_type_description,
          gross.incentives,
          gross.hear_about_us,
          -- Use negative IDs for cancellation rows so they do not collide with the sales report row IDs.
          - c._metabase_row_id as _metabase_row_id,
          -- Date Held drives the normal Week of Leasing Cycle lookup.
          case
            when nullif(btrim(c.date_held), '') is null then null
            when nullif(btrim(c.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.date_held), ''), 'DD/MM/YY')
            when nullif(btrim(c.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(c.date_held), ''), 'DD/MM/YYYY')
            when nullif(btrim(c.date_held), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(c.date_held), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(c.date_held), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.date_held), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_held_date,
          -- Date Reserved determines Booking Status.
          case
            when nullif(btrim(c.date_reserved), '') is null then null
            when nullif(btrim(c.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.date_reserved), ''), 'DD/MM/YY')
            when nullif(btrim(c.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(c.date_reserved), ''), 'DD/MM/YYYY')
            when nullif(btrim(c.date_reserved), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(c.date_reserved), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(c.date_reserved), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.date_reserved), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_reserved_date,
          -- Contract dates are used to calculate Weeks Leased.
          case
            when nullif(btrim(c.contract_date_start), '') is null then null
            when nullif(btrim(c.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(
              nullif(btrim(c.contract_date_start), ''),
              'DD/MM/YY'
            )
            when nullif(btrim(c.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(c.contract_date_start), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(c.contract_date_start), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(c.contract_date_start), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(c.contract_date_start), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.contract_date_start), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_start_date,
          case
            when nullif(btrim(c.contract_date_end), '') is null then null
            when nullif(btrim(c.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.contract_date_end), ''), 'DD/MM/YY')
            when nullif(btrim(c.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(c.contract_date_end), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(c.contract_date_end), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(c.contract_date_end), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(c.contract_date_end), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.contract_date_end), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_end_date,
          -- Date Cancelled drives cancellation status and the cancellation-specific leasing cycle week.
          case
            when nullif(btrim(c.date_cancelled), '') is null then null
            when nullif(btrim(c.date_cancelled), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.date_cancelled), ''), 'DD/MM/YY')
            when nullif(btrim(c.date_cancelled), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(c.date_cancelled), ''), 'DD/MM/YYYY')
            when nullif(btrim(c.date_cancelled), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(c.date_cancelled), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(c.date_cancelled), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.date_cancelled), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_cancelled_date
        from
          starrez_data.table_65535 c
          left join gross_booking_lookup gross on gross.booking_id = nullif(btrim(c.booking_id), '') -- Remove historic academic years from the cancellation rows as well.
        where
          coalesce(nullif(btrim(c.term_session_code), ''), '') not in ('2019/2020', '2020/2021', '2021/2022', '2022/2023') -- Exclude Castle Street from the model entirely.
          and coalesce(nullif(btrim(c.room_location_description), ''), '') not ilike '%castle street%' -- Exclude cancellations linked to legacy nomination-coded sales rows.
          and coalesce(gross.booking_type_description, '') not ilike '%nomination%'
      ),
      cancellations as (
        -- Only keep cancellation rows that have a real Date Held or Date Reserved.
        -- Cancellations with neither populated never had a proper "held" event recorded upstream,
        -- so they should not be counted as gross bookings that were later cancelled.
        select
          *
        from
          cancellations_raw
        where
          date_held_date is not null
          or date_reserved_date is not null
      ) -- Sales rows retain the existing leasing model behaviour.
      select
        -- Keep every original Sales Table column plus the cleaned date columns above.
        sales.term_session_code,
        sales.room_location_description,
        sales.entry_id,
        sales.booking_id,
        sales.date_created,
        sales.date_held,
        sales.date_reserved,
        sales.contract_date_start,
        sales.contract_date_end,
        sales.term_session_description,
        sales.entry_status_description,
        sales.room_type_description,
        sales.room_space_description,
        sales.room_rate_description,
        sales.room_rate_amount,
        sales.total_rent,
        sales.gender_description,
        sales.age,
        sales.nationality_description,
        sales.university,
        sales.year_of_study,
        sales.course,
        sales.agents,
        sales.booking_type_description,
        sales.incentives,
        sales.hear_about_us,
        sales._metabase_row_id,
        -- These fields make the combined model explicit and sortable:
        -- sales rows first, cancellation rows after them.
        1 :: integer as "Record Sort",
        'Sales' :: text as "Record Type",
        sales.date_held_date,
        sales.date_reserved_date,
        sales.contract_start_date,
        sales.contract_end_date,
        -- Weeks Leased = contract duration in days divided by 7.
        case
          when sales.contract_start_date is not null
          and sales.contract_end_date is not null then (
            sales.contract_end_date - sales.contract_start_date
          ) :: numeric / 7
          else null
        end as "Weeks Leased",
        -- Booking Channel precedence:
        -- 1. Term descriptions containing RB are Rebooker.
        -- 2. Populated Agents values are Agent.
        -- 3. Otherwise use Booking Type Description.
        case
          when coalesce(sales.term_session_description, '') ilike '%RB%' then 'Rebooker'
          when nullif(btrim(coalesce(sales.agents, '')), '') is not null then 'Agent'
          when nullif(btrim(sales.booking_type_description), '') is null then 'Direct Let'
          when sales.booking_type_description ilike '%nomination%' then 'Nomination'
          when sales.booking_type_description ilike 'direct let%' then 'Direct Let'
          else 'Other'
        end as "Booking Channel",
        -- Booking Status is Reserved when Date Reserved exists; otherwise it remains Date Held.
        case
          when sales.date_reserved_date is not null then 'Reserved'
          else 'Date Held'
        end as "Booking Status",
        -- Week of Leasing Cycle comes from the weekly lookup based on Term Session Code and Date Held.
        lookup.sales_week as "Week of Leasing Cycle",
        -- Asset lookup columns are calculated by matching Room Location Description to Asset Lookup.asset.
        asset.portfolio as "Portfolio",
        asset.client as "Client",
        asset.city as "City",
        asset.hoo as "HOO",
        -- Sales rows are not cancellation events.
        null :: date as "Date Cancelled",
        null :: text as "Cancellation Status",
        null :: integer as "CANCELLED Week of Leasing Cycle"
      from
        sales -- Left join so every leasing record remains in the model even if the lookup has no matching date.
        left join weekly_lookup_sales_weeks lookup on lookup.term_session_code = sales.term_session_code
        and lookup.lookup_date = sales.date_held_date
        left join asset_lookup asset on asset.asset_key = lower(btrim(sales.room_location_description))
      union all
      -- Cancellation rows add cancellation-specific fields while preserving the same gross-booking columns.
      select
        cancellations.term_session_code,
        cancellations.room_location_description,
        cancellations.entry_id,
        cancellations.booking_id,
        cancellations.date_created,
        cancellations.date_held,
        cancellations.date_reserved,
        cancellations.contract_date_start,
        cancellations.contract_date_end,
        cancellations.term_session_description,
        cancellations.entry_status_description,
        cancellations.room_type_description,
        cancellations.room_space_description,
        cancellations.room_rate_description,
        cancellations.room_rate_amount,
        cancellations.total_rent,
        cancellations.gender_description,
        cancellations.age,
        cancellations.nationality_description,
        cancellations.university,
        cancellations.year_of_study,
        cancellations.course,
        cancellations.agents,
        cancellations.booking_type_description,
        cancellations.incentives,
        cancellations.hear_about_us,
        cancellations._metabase_row_id,
        -- Cancellation rows are appended after sales rows in the combined model.
        2 :: integer as "Record Sort",
        'Cancellation' :: text as "Record Type",
        cancellations.date_held_date,
        cancellations.date_reserved_date,
        cancellations.contract_start_date,
        cancellations.contract_end_date,
        -- Weeks Leased is still based on the contract dates, even for cancellation rows.
        case
          when cancellations.contract_start_date is not null
          and cancellations.contract_end_date is not null then (
            cancellations.contract_end_date - cancellations.contract_start_date
          ) :: numeric / 7
          else null
        end as "Weeks Leased",
        -- Booking Channel uses the same precedence as sales rows.
        case
          when coalesce(cancellations.term_session_description, '') ilike '%RB%' then 'Rebooker'
          when nullif(btrim(coalesce(cancellations.agents, '')), '') is not null then 'Agent'
          when nullif(btrim(cancellations.booking_type_description), '') is null then 'Direct Let'
          when cancellations.booking_type_description ilike '%nomination%' then 'Nomination'
          when cancellations.booking_type_description ilike 'direct let%' then 'Direct Let'
          else 'Other'
        end as "Booking Channel",
        -- Booking Status is Reserved when Date Reserved exists; otherwise it remains Date Held.
        case
          when cancellations.date_reserved_date is not null then 'Reserved'
          else 'Date Held'
        end as "Booking Status",
        -- Normal Week of Leasing Cycle still follows Date Held.
        held_lookup.sales_week as "Week of Leasing Cycle",
        -- Asset lookup columns use the same Room Location Description match as sales rows.
        asset.portfolio as "Portfolio",
        asset.client as "Client",
        asset.city as "City",
        asset.hoo as "HOO",
        -- Pull through Date Cancelled from report 65535 as a real date.
        cancellations.date_cancelled_date as "Date Cancelled",
        -- Only cancellation rows with Date Cancelled populated are marked Cancelled.
        case
          when cancellations.date_cancelled_date is not null then 'Cancelled'
          else null
        end as "Cancellation Status",
        -- Cancellation-specific leasing cycle week follows Date Cancelled, not Date Held.
        cancelled_lookup.sales_week as "CANCELLED Week of Leasing Cycle"
      from
        cancellations
        left join weekly_lookup_sales_weeks held_lookup on held_lookup.term_session_code = cancellations.term_session_code
        and held_lookup.lookup_date = cancellations.date_held_date
        left join weekly_lookup_sales_weeks cancelled_lookup on cancelled_lookup.term_session_code = cancellations.term_session_code
        and cancelled_lookup.lookup_date = cancellations.date_cancelled_date
        left join asset_lookup asset on asset.asset_key = lower(btrim(cancellations.room_location_description))
      union all
      -- Dedicated nominations source. Each aggregate row expands to one Gross-model lease row per bed.
      select
        n.term_session_code,
        n.room_location_description,
        'NOM-' || substr(md5(n.row_key || '|' || bed.bed_number :: text), 1, 16) as entry_id,
        'NOM-' || substr(md5(n.row_key || '|' || bed.bed_number :: text), 1, 16) as booking_id,
        n.date_held as date_created,
        n.date_held,
        null :: text as date_reserved,
        n.contract_date_start,
        n.contract_date_end,
        n.term_session_description,
        'Reserved' :: text as entry_status_description,
        n.room_type_description,
        null :: text as room_space_description,
        null :: text as room_rate_description,
        n.room_rate_amount :: text,
        (n.total_rent_numeric / n.beds_leased :: numeric) :: text as total_rent,
        null :: text as gender_description,
        null :: text as age,
        null :: text as nationality_description,
        null :: text as university,
        null :: text as year_of_study,
        null :: text as course,
        null :: text as agents,
        n.booking_type_description,
        null :: text as incentives,
        null :: text as hear_about_us,
        3000000000000000000 :: bigint + (
          (
            'x' || substr(md5(n.row_key || '|' || bed.bed_number :: text), 1, 15)
          ) :: bit(60) :: bigint
        ) as _metabase_row_id,
        3 :: integer as "Record Sort",
        'Sales' :: text as "Record Type",
        n.date_held_date,
        null :: date as date_reserved_date,
        n.contract_start_date,
        n.contract_end_date,
        n.weeks_leased :: numeric as "Weeks Leased",
        'Nomination' :: text as "Booking Channel",
        'Reserved' :: text as "Booking Status",
        lookup.sales_week as "Week of Leasing Cycle",
        asset.portfolio as "Portfolio",
        asset.client as "Client",
        asset.city as "City",
        asset.hoo as "HOO",
        null :: date as "Date Cancelled",
        null :: text as "Cancellation Status",
        null :: integer as "CANCELLED Week of Leasing Cycle"
      from
        (
          select
            nullif(btrim(src.term_session_code), '') as term_session_code,
            nullif(btrim(src.room_location_description), '') as room_location_description,
            nullif(btrim(src.date_held), '') as date_held,
            nullif(btrim(src.contract_date_start), '') as contract_date_start,
            nullif(btrim(src.contract_date_end), '') as contract_date_end,
            nullif(btrim(src.term_session_description), '') as term_session_description,
            nullif(btrim(src.room_type_description), '') as room_type_description,
            src.room_rate_amount,
            replace(nullif(btrim(src.total_rent), ''), ',', '') :: numeric as total_rent_numeric,
            coalesce(
              nullif(btrim(src.booking_type_description), ''),
              'Nomination'
            ) as booking_type_description,
            src."Beds Leased" :: integer as beds_leased,
            src."Weeks Leased" :: numeric as weeks_leased,
            md5(
              concat_ws(
                '|',
                src.term_session_code,
                src.room_location_description,
                src.date_held,
                src.contract_date_start,
                src.contract_date_end,
                src.term_session_description,
                src.room_type_description,
                src.room_rate_amount :: text,
                src.total_rent,
                src.booking_type_description,
                src."Beds Leased" :: text,
                src."Weeks Leased" :: text
              )
            ) as row_key,
            case
              when nullif(btrim(src.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(btrim(src.date_held), 'DD/MM/YY')
              when nullif(btrim(src.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(btrim(src.date_held), 'DD/MM/YYYY')
              when nullif(btrim(src.date_held), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(btrim(src.date_held), 'YYYY-MM-DD')
              when left(nullif(btrim(src.date_held), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(left(btrim(src.date_held), 10), 'YYYY-MM-DD')
              else null
            end as date_held_date,
            case
              when nullif(btrim(src.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(btrim(src.contract_date_start), 'DD/MM/YY')
              when nullif(btrim(src.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(btrim(src.contract_date_start), 'DD/MM/YYYY')
              when nullif(btrim(src.contract_date_start), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(btrim(src.contract_date_start), 'YYYY-MM-DD')
              when left(nullif(btrim(src.contract_date_start), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
                left(btrim(src.contract_date_start), 10),
                'YYYY-MM-DD'
              )
              else null
            end as contract_start_date,
            case
              when nullif(btrim(src.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(btrim(src.contract_date_end), 'DD/MM/YY')
              when nullif(btrim(src.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(btrim(src.contract_date_end), 'DD/MM/YYYY')
              when nullif(btrim(src.contract_date_end), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(btrim(src.contract_date_end), 'YYYY-MM-DD')
              when left(nullif(btrim(src.contract_date_end), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
                left(btrim(src.contract_date_end), 10),
                'YYYY-MM-DD'
              )
              else null
            end as contract_end_date
          from
            starrez_data."nominations all years" src
          where
            nullif(btrim(src.term_session_code), '') is not null
            and src."Beds Leased" > 0
            and src."Weeks Leased" is not null
            and src.room_rate_amount is not null
            and nullif(btrim(src.total_rent), '') is not null
        ) n
        cross join lateral generate_series(1, n.beds_leased) as bed(bed_number)
        left join weekly_lookup_sales_weeks lookup on lookup.term_session_code = n.term_session_code
        and lookup.lookup_date = n.date_held_date -- Asset Lookup membership is mandatory for nominations; unmatched room locations are excluded entirely.
        inner join asset_lookup asset on asset.asset_key = lower(btrim(n.room_location_description))
      order by
        "Record Sort",
        _metabase_row_id
    ) m
    left join starrez_data.asset_lookup asset on lower(btrim(asset.asset)) = lower(btrim(m.room_location_description))
  where
    "Record Type" in ('Sales', 'Cancellation')
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
  from
    (
      -- Leasing Model, Step 1.
      -- Sources:
      --   Sales Table 65521
      --   Cancellations Table 65535
      --   Asset Lookup
      --   Weekly Lookup Sales Weeks (clean, long-format, maintained independently - no more position-based unpivoting)
      -- Purpose: clean the sales/cancellation reports, add calculated leasing fields, and attach sales week lookups.
      with weekly_lookup_sales_weeks as (
        -- Sourced directly from the maintained long-format lookup table.
        -- No per-term UNION ALL blocks or hardcoded column numbers needed -
        -- new academic years are added as new rows in this table, not new columns.
        select
          nullif(btrim(term_session_code), '') as term_session_code,
          lookup_date :: date as lookup_date,
          sales_week :: integer as sales_week
        from
          starrez_data.weekly_lookup_sales_weeks
        where
          nullif(btrim(term_session_code), '') is not null
          and lookup_date is not null
          and sales_week is not null
      ),
      asset_lookup as (
        -- Reusable lookup for Portfolio, Client, and City.
        -- Match Room Location Description from StarRez to Asset Lookup.asset.
        select
          distinct on (lower(btrim(asset))) -- Asset Lookup maps StarRez Room Location Description to reporting attributes.
          -- The uploaded lookup uses "asset" as the property/location name.
          lower(btrim(asset)) as asset_key,
          nullif(btrim(asset), '') as asset,
          nullif(btrim(portfolio), '') as portfolio,
          nullif(btrim(client), '') as client,
          nullif(btrim(city), '') as city,
          nullif(btrim("HOO"), '') as hoo
        from
          starrez_data.asset_lookup
        where
          nullif(btrim(asset), '') is not null
        order by
          lower(btrim(asset)),
          asset
      ),
      gross_booking_lookup as (
        -- De-duplicated gross-booking lookup used to backfill fields that are missing from cancellation rows.
        -- Booking IDs are not perfectly unique in the sales report, so take one stable row per booking_id.
        -- Pre-filtered to only booking_ids that actually appear in the cancellations report,
        -- so we are not deduping the entire sales table just to backfill a handful of cancelled bookings.
        select
          distinct on (nullif(btrim(s.booking_id), '')) nullif(btrim(s.booking_id), '') as booking_id,
          s.university,
          s.year_of_study,
          s.course,
          s.booking_type_description,
          s.incentives,
          s.hear_about_us
        from
          starrez_data.table_65521 s
        where
          nullif(btrim(s.booking_id), '') in (
            select
              nullif(btrim(c.booking_id), '')
            from
              starrez_data.table_65535 c
            where
              nullif(btrim(c.booking_id), '') is not null
          )
        order by
          nullif(btrim(s.booking_id), ''),
          s._metabase_row_id
      ),
      sales as (
        -- Start from the Sales Table and keep all original StarRez columns.
        -- StarRez date fields are text, so this block creates real date columns for calculations and joins.
        select
          s.*,
          -- Date Held drives the Week of Leasing Cycle lookup.
          case
            when nullif(btrim(s.date_held), '') is null then null
            when nullif(btrim(s.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(s.date_held), ''), 'DD/MM/YY')
            when nullif(btrim(s.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(s.date_held), ''), 'DD/MM/YYYY')
            when nullif(btrim(s.date_held), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(s.date_held), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(s.date_held), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.date_held), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_held_date,
          -- Date Reserved determines Booking Status.
          case
            when nullif(btrim(s.date_reserved), '') is null then null
            when nullif(btrim(s.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(s.date_reserved), ''), 'DD/MM/YY')
            when nullif(btrim(s.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(s.date_reserved), ''), 'DD/MM/YYYY')
            when nullif(btrim(s.date_reserved), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(s.date_reserved), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(s.date_reserved), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.date_reserved), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_reserved_date,
          -- Contract dates are used to calculate Weeks Leased.
          case
            when nullif(btrim(s.contract_date_start), '') is null then null
            when nullif(btrim(s.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(
              nullif(btrim(s.contract_date_start), ''),
              'DD/MM/YY'
            )
            when nullif(btrim(s.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(s.contract_date_start), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(s.contract_date_start), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(s.contract_date_start), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(s.contract_date_start), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.contract_date_start), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_start_date,
          case
            when nullif(btrim(s.contract_date_end), '') is null then null
            when nullif(btrim(s.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(s.contract_date_end), ''), 'DD/MM/YY')
            when nullif(btrim(s.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(s.contract_date_end), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(s.contract_date_end), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(s.contract_date_end), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(s.contract_date_end), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(s.contract_date_end), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_end_date
        from
          starrez_data.table_65521 s -- Remove historic academic years from the model.
        where
          coalesce(nullif(btrim(s.term_session_code), ''), '') not in ('2019/2020', '2020/2021', '2021/2022', '2022/2023') -- Exclude Castle Street from the model entirely.
          and coalesce(nullif(btrim(s.room_location_description), ''), '') not ilike '%castle street%' -- Nomination bookings are supplied by the dedicated aggregate source below.
          and coalesce(s.booking_type_description, '') not ilike '%nomination%'
      ),
      cancellations_raw as (
        -- Cancellation rows come from report 65535.
        -- They are shaped to match the sales rows so both can live in one model.
        select
          c.term_session_code,
          c.room_location_description,
          c.entry_id,
          c.booking_id,
          c.date_created,
          c.date_held,
          c.date_reserved,
          c.contract_date_start,
          c.contract_date_end,
          c.term_session_description,
          c.entry_status_description,
          c.room_type_description,
          c.room_space_description,
          c.room_rate_description,
          c.room_rate_amount,
          c.total_rent,
          c.gender_description,
          c.age,
          c.nationality_description,
          -- These fields do not exist in report 65535, so backfill from the gross booking lookup when possible.
          gross.university,
          gross.year_of_study,
          gross.course,
          c.agents,
          gross.booking_type_description,
          gross.incentives,
          gross.hear_about_us,
          -- Use negative IDs for cancellation rows so they do not collide with the sales report row IDs.
          - c._metabase_row_id as _metabase_row_id,
          -- Date Held drives the normal Week of Leasing Cycle lookup.
          case
            when nullif(btrim(c.date_held), '') is null then null
            when nullif(btrim(c.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.date_held), ''), 'DD/MM/YY')
            when nullif(btrim(c.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(c.date_held), ''), 'DD/MM/YYYY')
            when nullif(btrim(c.date_held), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(c.date_held), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(c.date_held), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.date_held), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_held_date,
          -- Date Reserved determines Booking Status.
          case
            when nullif(btrim(c.date_reserved), '') is null then null
            when nullif(btrim(c.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.date_reserved), ''), 'DD/MM/YY')
            when nullif(btrim(c.date_reserved), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(c.date_reserved), ''), 'DD/MM/YYYY')
            when nullif(btrim(c.date_reserved), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(c.date_reserved), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(c.date_reserved), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.date_reserved), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_reserved_date,
          -- Contract dates are used to calculate Weeks Leased.
          case
            when nullif(btrim(c.contract_date_start), '') is null then null
            when nullif(btrim(c.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(
              nullif(btrim(c.contract_date_start), ''),
              'DD/MM/YY'
            )
            when nullif(btrim(c.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(c.contract_date_start), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(c.contract_date_start), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(c.contract_date_start), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(c.contract_date_start), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.contract_date_start), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_start_date,
          case
            when nullif(btrim(c.contract_date_end), '') is null then null
            when nullif(btrim(c.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.contract_date_end), ''), 'DD/MM/YY')
            when nullif(btrim(c.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(
              nullif(btrim(c.contract_date_end), ''),
              'DD/MM/YYYY'
            )
            when nullif(btrim(c.contract_date_end), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(
              nullif(btrim(c.contract_date_end), ''),
              'YYYY-MM-DD'
            )
            when left(nullif(btrim(c.contract_date_end), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.contract_date_end), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as contract_end_date,
          -- Date Cancelled drives cancellation status and the cancellation-specific leasing cycle week.
          case
            when nullif(btrim(c.date_cancelled), '') is null then null
            when nullif(btrim(c.date_cancelled), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(nullif(btrim(c.date_cancelled), ''), 'DD/MM/YY')
            when nullif(btrim(c.date_cancelled), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(nullif(btrim(c.date_cancelled), ''), 'DD/MM/YYYY')
            when nullif(btrim(c.date_cancelled), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(nullif(btrim(c.date_cancelled), ''), 'YYYY-MM-DD')
            when left(nullif(btrim(c.date_cancelled), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
              left(nullif(btrim(c.date_cancelled), ''), 10),
              'YYYY-MM-DD'
            )
            else null
          end as date_cancelled_date
        from
          starrez_data.table_65535 c
          left join gross_booking_lookup gross on gross.booking_id = nullif(btrim(c.booking_id), '') -- Remove historic academic years from the cancellation rows as well.
        where
          coalesce(nullif(btrim(c.term_session_code), ''), '') not in ('2019/2020', '2020/2021', '2021/2022', '2022/2023') -- Exclude Castle Street from the model entirely.
          and coalesce(nullif(btrim(c.room_location_description), ''), '') not ilike '%castle street%' -- Exclude cancellations linked to legacy nomination-coded sales rows.
          and coalesce(gross.booking_type_description, '') not ilike '%nomination%'
      ),
      cancellations as (
        -- Only keep cancellation rows that have a real Date Held or Date Reserved.
        -- Cancellations with neither populated never had a proper "held" event recorded upstream,
        -- so they should not be counted as gross bookings that were later cancelled.
        select
          *
        from
          cancellations_raw
        where
          date_held_date is not null
          or date_reserved_date is not null
      ) -- Sales rows retain the existing leasing model behaviour.
      select
        -- Keep every original Sales Table column plus the cleaned date columns above.
        sales.term_session_code,
        sales.room_location_description,
        sales.entry_id,
        sales.booking_id,
        sales.date_created,
        sales.date_held,
        sales.date_reserved,
        sales.contract_date_start,
        sales.contract_date_end,
        sales.term_session_description,
        sales.entry_status_description,
        sales.room_type_description,
        sales.room_space_description,
        sales.room_rate_description,
        sales.room_rate_amount,
        sales.total_rent,
        sales.gender_description,
        sales.age,
        sales.nationality_description,
        sales.university,
        sales.year_of_study,
        sales.course,
        sales.agents,
        sales.booking_type_description,
        sales.incentives,
        sales.hear_about_us,
        sales._metabase_row_id,
        -- These fields make the combined model explicit and sortable:
        -- sales rows first, cancellation rows after them.
        1 :: integer as "Record Sort",
        'Sales' :: text as "Record Type",
        sales.date_held_date,
        sales.date_reserved_date,
        sales.contract_start_date,
        sales.contract_end_date,
        -- Weeks Leased = contract duration in days divided by 7.
        case
          when sales.contract_start_date is not null
          and sales.contract_end_date is not null then (
            sales.contract_end_date - sales.contract_start_date
          ) :: numeric / 7
          else null
        end as "Weeks Leased",
        -- Booking Channel precedence:
        -- 1. Term descriptions containing RB are Rebooker.
        -- 2. Populated Agents values are Agent.
        -- 3. Otherwise use Booking Type Description.
        case
          when coalesce(sales.term_session_description, '') ilike '%RB%' then 'Rebooker'
          when nullif(btrim(coalesce(sales.agents, '')), '') is not null then 'Agent'
          when nullif(btrim(sales.booking_type_description), '') is null then 'Direct Let'
          when sales.booking_type_description ilike '%nomination%' then 'Nomination'
          when sales.booking_type_description ilike 'direct let%' then 'Direct Let'
          else 'Other'
        end as "Booking Channel",
        -- Booking Status is Reserved when Date Reserved exists; otherwise it remains Date Held.
        case
          when sales.date_reserved_date is not null then 'Reserved'
          else 'Date Held'
        end as "Booking Status",
        -- Week of Leasing Cycle comes from the weekly lookup based on Term Session Code and Date Held.
        lookup.sales_week as "Week of Leasing Cycle",
        -- Asset lookup columns are calculated by matching Room Location Description to Asset Lookup.asset.
        asset.portfolio as "Portfolio",
        asset.client as "Client",
        asset.city as "City",
        asset.hoo as "HOO",
        -- Sales rows are not cancellation events.
        null :: date as "Date Cancelled",
        null :: text as "Cancellation Status",
        null :: integer as "CANCELLED Week of Leasing Cycle"
      from
        sales -- Left join so every leasing record remains in the model even if the lookup has no matching date.
        left join weekly_lookup_sales_weeks lookup on lookup.term_session_code = sales.term_session_code
        and lookup.lookup_date = sales.date_held_date
        left join asset_lookup asset on asset.asset_key = lower(btrim(sales.room_location_description))
      union all
      -- Cancellation rows add cancellation-specific fields while preserving the same gross-booking columns.
      select
        cancellations.term_session_code,
        cancellations.room_location_description,
        cancellations.entry_id,
        cancellations.booking_id,
        cancellations.date_created,
        cancellations.date_held,
        cancellations.date_reserved,
        cancellations.contract_date_start,
        cancellations.contract_date_end,
        cancellations.term_session_description,
        cancellations.entry_status_description,
        cancellations.room_type_description,
        cancellations.room_space_description,
        cancellations.room_rate_description,
        cancellations.room_rate_amount,
        cancellations.total_rent,
        cancellations.gender_description,
        cancellations.age,
        cancellations.nationality_description,
        cancellations.university,
        cancellations.year_of_study,
        cancellations.course,
        cancellations.agents,
        cancellations.booking_type_description,
        cancellations.incentives,
        cancellations.hear_about_us,
        cancellations._metabase_row_id,
        -- Cancellation rows are appended after sales rows in the combined model.
        2 :: integer as "Record Sort",
        'Cancellation' :: text as "Record Type",
        cancellations.date_held_date,
        cancellations.date_reserved_date,
        cancellations.contract_start_date,
        cancellations.contract_end_date,
        -- Weeks Leased is still based on the contract dates, even for cancellation rows.
        case
          when cancellations.contract_start_date is not null
          and cancellations.contract_end_date is not null then (
            cancellations.contract_end_date - cancellations.contract_start_date
          ) :: numeric / 7
          else null
        end as "Weeks Leased",
        -- Booking Channel uses the same precedence as sales rows.
        case
          when coalesce(cancellations.term_session_description, '') ilike '%RB%' then 'Rebooker'
          when nullif(btrim(coalesce(cancellations.agents, '')), '') is not null then 'Agent'
          when nullif(btrim(cancellations.booking_type_description), '') is null then 'Direct Let'
          when cancellations.booking_type_description ilike '%nomination%' then 'Nomination'
          when cancellations.booking_type_description ilike 'direct let%' then 'Direct Let'
          else 'Other'
        end as "Booking Channel",
        -- Booking Status is Reserved when Date Reserved exists; otherwise it remains Date Held.
        case
          when cancellations.date_reserved_date is not null then 'Reserved'
          else 'Date Held'
        end as "Booking Status",
        -- Normal Week of Leasing Cycle still follows Date Held.
        held_lookup.sales_week as "Week of Leasing Cycle",
        -- Asset lookup columns use the same Room Location Description match as sales rows.
        asset.portfolio as "Portfolio",
        asset.client as "Client",
        asset.city as "City",
        asset.hoo as "HOO",
        -- Pull through Date Cancelled from report 65535 as a real date.
        cancellations.date_cancelled_date as "Date Cancelled",
        -- Only cancellation rows with Date Cancelled populated are marked Cancelled.
        case
          when cancellations.date_cancelled_date is not null then 'Cancelled'
          else null
        end as "Cancellation Status",
        -- Cancellation-specific leasing cycle week follows Date Cancelled, not Date Held.
        cancelled_lookup.sales_week as "CANCELLED Week of Leasing Cycle"
      from
        cancellations
        left join weekly_lookup_sales_weeks held_lookup on held_lookup.term_session_code = cancellations.term_session_code
        and held_lookup.lookup_date = cancellations.date_held_date
        left join weekly_lookup_sales_weeks cancelled_lookup on cancelled_lookup.term_session_code = cancellations.term_session_code
        and cancelled_lookup.lookup_date = cancellations.date_cancelled_date
        left join asset_lookup asset on asset.asset_key = lower(btrim(cancellations.room_location_description))
      union all
      -- Dedicated nominations source. Each aggregate row expands to one Gross-model lease row per bed.
      select
        n.term_session_code,
        n.room_location_description,
        'NOM-' || substr(md5(n.row_key || '|' || bed.bed_number :: text), 1, 16) as entry_id,
        'NOM-' || substr(md5(n.row_key || '|' || bed.bed_number :: text), 1, 16) as booking_id,
        n.date_held as date_created,
        n.date_held,
        null :: text as date_reserved,
        n.contract_date_start,
        n.contract_date_end,
        n.term_session_description,
        'Reserved' :: text as entry_status_description,
        n.room_type_description,
        null :: text as room_space_description,
        null :: text as room_rate_description,
        n.room_rate_amount :: text,
        (n.total_rent_numeric / n.beds_leased :: numeric) :: text as total_rent,
        null :: text as gender_description,
        null :: text as age,
        null :: text as nationality_description,
        null :: text as university,
        null :: text as year_of_study,
        null :: text as course,
        null :: text as agents,
        n.booking_type_description,
        null :: text as incentives,
        null :: text as hear_about_us,
        3000000000000000000 :: bigint + (
          (
            'x' || substr(md5(n.row_key || '|' || bed.bed_number :: text), 1, 15)
          ) :: bit(60) :: bigint
        ) as _metabase_row_id,
        3 :: integer as "Record Sort",
        'Sales' :: text as "Record Type",
        n.date_held_date,
        null :: date as date_reserved_date,
        n.contract_start_date,
        n.contract_end_date,
        n.weeks_leased :: numeric as "Weeks Leased",
        'Nomination' :: text as "Booking Channel",
        'Reserved' :: text as "Booking Status",
        lookup.sales_week as "Week of Leasing Cycle",
        asset.portfolio as "Portfolio",
        asset.client as "Client",
        asset.city as "City",
        asset.hoo as "HOO",
        null :: date as "Date Cancelled",
        null :: text as "Cancellation Status",
        null :: integer as "CANCELLED Week of Leasing Cycle"
      from
        (
          select
            nullif(btrim(src.term_session_code), '') as term_session_code,
            nullif(btrim(src.room_location_description), '') as room_location_description,
            nullif(btrim(src.date_held), '') as date_held,
            nullif(btrim(src.contract_date_start), '') as contract_date_start,
            nullif(btrim(src.contract_date_end), '') as contract_date_end,
            nullif(btrim(src.term_session_description), '') as term_session_description,
            nullif(btrim(src.room_type_description), '') as room_type_description,
            src.room_rate_amount,
            replace(nullif(btrim(src.total_rent), ''), ',', '') :: numeric as total_rent_numeric,
            coalesce(
              nullif(btrim(src.booking_type_description), ''),
              'Nomination'
            ) as booking_type_description,
            src."Beds Leased" :: integer as beds_leased,
            src."Weeks Leased" :: numeric as weeks_leased,
            md5(
              concat_ws(
                '|',
                src.term_session_code,
                src.room_location_description,
                src.date_held,
                src.contract_date_start,
                src.contract_date_end,
                src.term_session_description,
                src.room_type_description,
                src.room_rate_amount :: text,
                src.total_rent,
                src.booking_type_description,
                src."Beds Leased" :: text,
                src."Weeks Leased" :: text
              )
            ) as row_key,
            case
              when nullif(btrim(src.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(btrim(src.date_held), 'DD/MM/YY')
              when nullif(btrim(src.date_held), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(btrim(src.date_held), 'DD/MM/YYYY')
              when nullif(btrim(src.date_held), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(btrim(src.date_held), 'YYYY-MM-DD')
              when left(nullif(btrim(src.date_held), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(left(btrim(src.date_held), 10), 'YYYY-MM-DD')
              else null
            end as date_held_date,
            case
              when nullif(btrim(src.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(btrim(src.contract_date_start), 'DD/MM/YY')
              when nullif(btrim(src.contract_date_start), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(btrim(src.contract_date_start), 'DD/MM/YYYY')
              when nullif(btrim(src.contract_date_start), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(btrim(src.contract_date_start), 'YYYY-MM-DD')
              when left(nullif(btrim(src.contract_date_start), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
                left(btrim(src.contract_date_start), 10),
                'YYYY-MM-DD'
              )
              else null
            end as contract_start_date,
            case
              when nullif(btrim(src.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$' then to_date(btrim(src.contract_date_end), 'DD/MM/YY')
              when nullif(btrim(src.contract_date_end), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(btrim(src.contract_date_end), 'DD/MM/YYYY')
              when nullif(btrim(src.contract_date_end), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$' then to_date(btrim(src.contract_date_end), 'YYYY-MM-DD')
              when left(nullif(btrim(src.contract_date_end), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$' then to_date(
                left(btrim(src.contract_date_end), 10),
                'YYYY-MM-DD'
              )
              else null
            end as contract_end_date
          from
            starrez_data."nominations all years" src
          where
            nullif(btrim(src.term_session_code), '') is not null
            and src."Beds Leased" > 0
            and src."Weeks Leased" is not null
            and src.room_rate_amount is not null
            and nullif(btrim(src.total_rent), '') is not null
        ) n
        cross join lateral generate_series(1, n.beds_leased) as bed(bed_number)
        left join weekly_lookup_sales_weeks lookup on lookup.term_session_code = n.term_session_code
        and lookup.lookup_date = n.date_held_date -- Asset Lookup membership is mandatory for nominations; unmatched room locations are excluded entirely.
        inner join asset_lookup asset on asset.asset_key = lower(btrim(n.room_location_description))
      order by
        "Record Sort",
        _metabase_row_id
    ) m
    left join starrez_data.asset_lookup asset on lower(btrim(asset.asset)) = lower(btrim(m.room_location_description))
  where
    "Record Type" = 'Cancellation'
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
  coalesce(
    g.room_location_description,
    c.room_location_description
  ) as room_location_description,
  coalesce(g.portfolio, c.portfolio) as portfolio,
  coalesce(g.client, c.client) as client,
  coalesce(g.hoo, c.hoo) as hoo,
  coalesce(g.booking_channel, c.booking_channel) as booking_channel,
  coalesce(
    g.nationality_description,
    c.nationality_description
  ) as nationality_description,
  coalesce(g.weeks_leased, c.weeks_leased) as weeks_leased,
  coalesce(
    g.like_for_like_eligible,
    c.like_for_like_eligible
  ) as like_for_like_eligible,
  coalesce(g.gross_bookings, 0) as gross_bookings,
  coalesce(c.cancelled_bookings, 0) as cancelled_bookings,
  coalesce(g.gross_bookings, 0) - coalesce(c.cancelled_bookings, 0) as net_bookings
from
  gross_by_week g
  full outer join cancelled_by_week c on c.term_session_code = g.term_session_code
  and c.week_of_leasing_cycle = g.week_of_leasing_cycle
  and c.room_location_description is not distinct
from
  g.room_location_description
  and c.portfolio is not distinct
from
  g.portfolio
  and c.client is not distinct
from
  g.client
  and c.hoo is not distinct
from
  g.hoo
  and c.booking_channel is not distinct
from
  g.booking_channel
  and c.nationality_description is not distinct
from
  g.nationality_description
  and c.weeks_leased is not distinct
from
  g.weeks_leased
  and c.like_for_like_eligible is not distinct
from
  g.like_for_like_eligible
order by
  term_session_code,
  week_of_leasing_cycle
