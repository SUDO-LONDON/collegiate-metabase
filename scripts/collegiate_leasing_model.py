#!/usr/bin/env python3
"""Create the Collegiate Leasing Model in Postgres and Metabase."""

from __future__ import annotations

import argparse
import json
import os
import textwrap
import urllib.error
import urllib.parse
import urllib.request


DATABASE_ID = int(os.getenv("MB_DATABASE_ID", "2"))
ROOT_COLLECTION = os.getenv("COLLEGIATE_ROOT_COLLECTION", "Commercial Reporting")
MODEL_COLLECTION = os.getenv("COLLEGIATE_MODEL_COLLECTION", "Models")
MODEL_NAME = os.getenv("COLLEGIATE_LEASING_MODEL_NAME", "Gross Booking Model")

SALES_TABLE = os.getenv("COLLEGIATE_SALES_TABLE", 'starrez_data.table_65521')
CANCELLATION_TABLE = os.getenv("COLLEGIATE_CANCELLATION_TABLE", 'starrez_data.table_65535')
LOOKUP_TABLE = os.getenv("COLLEGIATE_WEEKLY_LOOKUP_TABLE", 'starrez_data."weekly lookup"')
ASSET_LOOKUP_TABLE = os.getenv("COLLEGIATE_ASSET_LOOKUP_TABLE", "starrez_data.asset_lookup")


class MetabaseClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.session_id: str | None = None

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None
        headers = {"Content-Type": "application/json"}
        if self.session_id:
            headers["X-Metabase-Session"] = self.session_id
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError(f"{method} {path} failed: {error.code} {detail}") from error
        return json.loads(raw) if raw else {}

    def login(self, username: str, password: str) -> None:
        self.session_id = self.request(
            "POST",
            "/api/session",
            {"username": username, "password": password},
        )["id"]

    def query(self, sql: str) -> dict:
        return self.request(
            "POST",
            "/api/dataset",
            {
                "database": DATABASE_ID,
                "type": "native",
                "native": {"query": sql},
            },
        )

    def execute_ddl(self, sql: str) -> None:
        try:
            self.query(sql)
        except RuntimeError as error:
            if "Select statement did not produce a ResultSet" not in str(error):
                raise

    def collections(self) -> list[dict]:
        result = self.request("GET", "/api/collection")
        return result if isinstance(result, list) else result.get("data", [])

    def ensure_collection(self, name: str, parent_id: int | None = None) -> dict:
        for collection in self.collections():
            if collection.get("name") == name and collection.get("parent_id") == parent_id:
                return collection
        body = {"name": name}
        if parent_id is not None:
            body["parent_id"] = parent_id
        return self.request("POST", "/api/collection", body)

    def find_card(self, name: str, collection_id: int) -> dict | None:
        query = urllib.parse.urlencode({"f": "all", "collection_id": collection_id})
        result = self.request("GET", f"/api/card?{query}")
        cards = result if isinstance(result, list) else result.get("data", [])
        for card in cards:
            if card.get("name") == name and card.get("collection_id") == collection_id:
                return card
        return None

    def ensure_model(self, collection_id: int, name: str, sql: str) -> dict:
        existing = self.find_card(name, collection_id)
        body = {
            "name": name,
            "type": "model",
            "dataset_query": {
                "type": "native",
                "database": DATABASE_ID,
                "native": {"query": sql},
            },
            "display": existing.get("display", "table") if existing else "table",
            "visualization_settings": existing.get("visualization_settings", {}) if existing else {},
            "collection_id": collection_id,
            "description": (
                "Gross Booking Model created from StarRez Sales Table 65521 "
                "and Cancellations Table 65535."
            ),
        }
        if existing:
            return self.request("PUT", f"/api/card/{existing['id']}", body)
        return self.request("POST", "/api/card", body)

    def model_metadata(self, sql: str) -> list[dict]:
        metadata_sql = f"select * from ({textwrap.dedent(sql).strip()}) model_metadata limit 0"
        result = self.query(metadata_sql)
        return result["data"]["cols"]

    def update_model_metadata(self, card_id: int, metadata: list[dict]) -> dict:
        return self.request("PUT", f"/api/card/{card_id}", {"result_metadata": metadata})

    def sync_database_schema(self) -> None:
        self.request("POST", f"/api/database/{DATABASE_ID}/sync_schema")


def date_expr(column: str) -> str:
    value = f"nullif(btrim({column}), '')"
    return f"""case
    when {value} is null then null
    when {value} ~ '^\\d{{1,2}}/\\d{{1,2}}/\\d{{2}}$' then to_date({value}, 'DD/MM/YY')
    when {value} ~ '^\\d{{1,2}}/\\d{{1,2}}/\\d{{4}}$' then to_date({value}, 'DD/MM/YYYY')
    when {value} ~ '^\\d{{4}}-\\d{{1,2}}-\\d{{1,2}}$' then to_date({value}, 'YYYY-MM-DD')
    when left({value}, 10) ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}$' then to_date(left({value}, 10), 'YYYY-MM-DD')
    else null
  end"""


def int_expr(column: str) -> str:
    value = f"nullif(btrim({column}), '')"
    return f"""case
    when {value} ~ '^\\d+$' then {value}::integer
    else null
  end"""


def lookup_select(term_session_code: str, date_column: str, sales_week_column: str) -> str:
    return f"""
select
  -- Label each lookup slice with the Term Session Code it belongs to.
  '{term_session_code}' as term_session_code,
  -- Convert the uploaded lookup date text into a real date for joining.
  {date_expr(date_column)} as lookup_date,
  -- Convert the uploaded sales week text into a number.
  {int_expr(sales_week_column)} as sales_week
from {LOOKUP_TABLE}
"""


def weekly_lookup_sql() -> str:
    return f"""
select term_session_code, lookup_date, sales_week
from (
  -- The uploaded weekly lookup table came in with generic column names.
  -- These mappings turn the spreadsheet-style year columns into one reusable lookup:
  -- Term Session Code + lookup date -> sales week.
  {lookup_select("2023/2024", "column7", "column9")}
  union all
  {lookup_select("2024/2025", "column12", "column14")}
  union all
  {lookup_select("2025/2026", "column17", "column19")}
  union all
  {lookup_select("2026/2027", "column22", "column24")}
) lookup_rows
where lookup_date is not null
  and sales_week is not null
"""


def asset_lookup_sql() -> str:
    return f"""
select distinct on (lower(btrim(asset)))
  -- Asset Lookup maps StarRez Room Location Description to reporting attributes.
  -- The uploaded lookup uses "asset" as the property/location name.
  lower(btrim(asset)) as asset_key,
  nullif(btrim(asset), '') as asset,
  nullif(btrim(portfolio), '') as portfolio,
  nullif(btrim(client), '') as client,
  nullif(btrim(city), '') as city
from {ASSET_LOOKUP_TABLE}
where nullif(btrim(asset), '') is not null
order by lower(btrim(asset)), asset
"""


def model_sql() -> str:
    return f"""
-- Leasing Model, Step 1.
-- Sources:
--   Sales Table 65521
--   Cancellations Table 65535
--   Asset Lookup
-- Purpose: clean the sales/cancellation reports, add calculated leasing fields, and attach sales week lookups.
with weekly_lookup_sales_weeks as (
  -- Reusable lookup CTE for Week of Leasing Cycle.
  -- It normalises the uploaded weekly lookup into:
  --   term_session_code, lookup_date, sales_week
  {weekly_lookup_sql()}
),
asset_lookup as (
  -- Reusable lookup for Portfolio, Client, and City.
  -- Match Room Location Description from StarRez to Asset Lookup.asset.
  {asset_lookup_sql()}
),
gross_booking_lookup as (
  -- De-duplicated gross-booking lookup used to backfill fields that are missing from cancellation rows.
  -- Booking IDs are not perfectly unique in the sales report, so take one stable row per booking_id.
  select distinct on (nullif(btrim(s.booking_id), ''))
    nullif(btrim(s.booking_id), '') as booking_id,
    s.university,
    s.year_of_study,
    s.course,
    s.booking_type_description,
    s.incentives,
    s.hear_about_us
  from {SALES_TABLE} s
  where nullif(btrim(s.booking_id), '') is not null
  order by nullif(btrim(s.booking_id), ''), s._metabase_row_id
),
sales as (
  -- Start from the Sales Table and keep all original StarRez columns.
  -- StarRez date fields are text, so this block creates real date columns for calculations and joins.
  select
    s.*,
    -- Date Held drives the Week of Leasing Cycle lookup.
    {date_expr("s.date_held")} as date_held_date,
    -- Date Reserved determines Booking Status.
    {date_expr("s.date_reserved")} as date_reserved_date,
    -- Contract dates are used to calculate Weeks Leased.
    {date_expr("s.contract_date_start")} as contract_start_date,
    {date_expr("s.contract_date_end")} as contract_end_date
  from {SALES_TABLE} s
  -- Remove historic academic years from the model.
  where coalesce(nullif(btrim(s.term_session_code), ''), '') not in (
    '2019/2020',
    '2020/2021',
    '2021/2022',
    '2022/2023'
  )
),
cancellations as (
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
    -c._metabase_row_id as _metabase_row_id,
    -- Date Held drives the normal Week of Leasing Cycle lookup.
    {date_expr("c.date_held")} as date_held_date,
    -- Date Reserved determines Booking Status.
    {date_expr("c.date_reserved")} as date_reserved_date,
    -- Contract dates are used to calculate Weeks Leased.
    {date_expr("c.contract_date_start")} as contract_start_date,
    {date_expr("c.contract_date_end")} as contract_end_date,
    -- Date Cancelled drives cancellation status and the cancellation-specific leasing cycle week.
    {date_expr("c.date_cancelled")} as date_cancelled_date
  from {CANCELLATION_TABLE} c
  left join gross_booking_lookup gross
    on gross.booking_id = nullif(btrim(c.booking_id), '')
  -- Remove historic academic years from the cancellation rows as well.
  where coalesce(nullif(btrim(c.term_session_code), ''), '') not in (
    '2019/2020',
    '2020/2021',
    '2021/2022',
    '2022/2023'
  )
)
-- Sales rows retain the existing leasing model behaviour.
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
  1::integer as "Record Sort",
  'Sales'::text as "Record Type",
  sales.date_held_date,
  sales.date_reserved_date,
  sales.contract_start_date,
  sales.contract_end_date,
  -- Weeks Leased = contract duration in days divided by 7.
  case
    when sales.contract_start_date is not null and sales.contract_end_date is not null
      then (sales.contract_end_date - sales.contract_start_date)::numeric / 7
    else null
  end as "Weeks Leased",
  -- Booking Channel precedence:
  -- 1. Term descriptions containing RB are Rebooker.
  -- 2. Populated Agents values are Agent.
  -- 3. Otherwise use Booking Type Description.
  case
    when coalesce(sales.term_session_description, '') ilike '%RB%' then 'Rebooker'
    when nullif(btrim(coalesce(sales.agents, '')), '') is not null then 'Agent'
    else sales.booking_type_description
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
  -- Sales rows are not cancellation events.
  null::date as "Date Cancelled",
  null::text as "Cancellation Status",
  null::integer as "CANCELLED Week of Leasing Cycle"
from sales
-- Left join so every leasing record remains in the model even if the lookup has no matching date.
left join weekly_lookup_sales_weeks lookup
  on lookup.term_session_code = sales.term_session_code
 and lookup.lookup_date = sales.date_held_date
left join asset_lookup asset
  on asset.asset_key = lower(btrim(sales.room_location_description))
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
  2::integer as "Record Sort",
  'Cancellation'::text as "Record Type",
  cancellations.date_held_date,
  cancellations.date_reserved_date,
  cancellations.contract_start_date,
  cancellations.contract_end_date,
  -- Weeks Leased is still based on the contract dates, even for cancellation rows.
  case
    when cancellations.contract_start_date is not null and cancellations.contract_end_date is not null
      then (cancellations.contract_end_date - cancellations.contract_start_date)::numeric / 7
    else null
  end as "Weeks Leased",
  -- Booking Channel uses the same precedence as sales rows.
  case
    when coalesce(cancellations.term_session_description, '') ilike '%RB%' then 'Rebooker'
    when nullif(btrim(coalesce(cancellations.agents, '')), '') is not null then 'Agent'
    else cancellations.booking_type_description
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
  -- Pull through Date Cancelled from report 65535 as a real date.
  cancellations.date_cancelled_date as "Date Cancelled",
  -- Only cancellation rows with Date Cancelled populated are marked Cancelled.
  case
    when cancellations.date_cancelled_date is not null then 'Cancelled'
    else null
  end as "Cancellation Status",
  -- Cancellation-specific leasing cycle week follows Date Cancelled, not Date Held.
  cancelled_lookup.sales_week as "CANCELLED Week of Leasing Cycle"
from cancellations
left join weekly_lookup_sales_weeks held_lookup
  on held_lookup.term_session_code = cancellations.term_session_code
 and held_lookup.lookup_date = cancellations.date_held_date
left join weekly_lookup_sales_weeks cancelled_lookup
  on cancelled_lookup.term_session_code = cancellations.term_session_code
 and cancelled_lookup.lookup_date = cancellations.date_cancelled_date
left join asset_lookup asset
  on asset.asset_key = lower(btrim(cancellations.room_location_description))
order by "Record Sort", _metabase_row_id
"""


def validation_sql() -> str:
    return f"""
with leasing_model as (
  {model_sql()}
)
select
  count(*) as rows,
  count(*) filter (where "Week of Leasing Cycle" is not null) as rows_with_leasing_cycle_week,
  count(*) filter (where "Cancellation Status" = 'Cancelled') as cancelled_rows,
  count(*) filter (where "CANCELLED Week of Leasing Cycle" is not null) as rows_with_cancelled_leasing_cycle_week,
  count(*) filter (where "Portfolio" is not null) as rows_with_portfolio,
  count(*) filter (where "Client" is not null) as rows_with_client,
  count(*) filter (where "City" is not null) as rows_with_city,
  count(*) filter (where "Record Type" = 'Sales') as sales_rows,
  count(*) filter (where "Record Type" = 'Cancellation') as cancellation_rows,
  count(distinct room_location_description) filter (
    where nullif(btrim(room_location_description), '') is not null
      and "City" is null
  ) as unmatched_asset_locations,
  count(*) filter (where term_session_code in ('2019/2020', '2020/2021', '2021/2022', '2022/2023')) as historic_rows,
  min(term_session_code) as min_term_session_code,
  max(term_session_code) as max_term_session_code
from leasing_model
"""


def unmatched_asset_locations_sql() -> str:
    return f"""
with leasing_model as (
  {model_sql()}
)
select room_location_description, count(*) as rows
from leasing_model
where nullif(btrim(room_location_description), '') is not null
  and "City" is null
group by room_location_description
order by rows desc, room_location_description
limit 20
"""


def model_field_metadata(metadata: list[dict]) -> list[dict]:
    overrides = {
        "Record Type": {"semantic_type": "type/Category"},
        "Portfolio": {"semantic_type": "type/Category"},
        "Client": {"semantic_type": "type/Category"},
        "City": {"semantic_type": "type/City"},
    }
    updated = []
    for field in metadata:
        field = dict(field)
        if field.get("name") in overrides:
            field.update(overrides[field["name"]])
        updated.append(field)
    return updated


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print SQL without changing Metabase or Postgres.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.dry_run:
        for sql in [model_sql(), validation_sql()]:
            print(textwrap.dedent(sql).strip())
            print()
        return 0

    missing = [name for name in ["MB_URL", "MB_USER", "MB_PASSWORD"] if not os.getenv(name)]
    if missing:
        raise SystemExit(f"Missing environment variables: {', '.join(missing)}")

    client = MetabaseClient(os.environ["MB_URL"])
    client.login(os.environ["MB_USER"], os.environ["MB_PASSWORD"])

    result = client.query(textwrap.dedent(validation_sql()).strip())
    rows = result["data"]["rows"][0]
    print(
        f"{MODEL_NAME}: {rows[0]} rows, "
        f"{rows[1]} with leasing cycle week, "
        f"{rows[2]} cancelled rows, "
        f"{rows[3]} with cancelled leasing cycle week, "
        f"{rows[4]} with Portfolio, "
        f"{rows[5]} with Client, "
        f"{rows[6]} with City, "
        f"{rows[7]} sales rows, "
        f"{rows[8]} cancellation rows, "
        f"{rows[9]} unmatched asset locations, "
        f"{rows[10]} historic rows, "
        f"terms {rows[11]} to {rows[12]}"
    )

    root = client.ensure_collection(ROOT_COLLECTION)
    collection = client.ensure_collection(MODEL_COLLECTION, root["id"])
    model = client.ensure_model(collection["id"], MODEL_NAME, model_sql())
    metadata = client.model_metadata(model_sql())
    client.update_model_metadata(model["id"], model_field_metadata(metadata))
    print(f"Model {model['id']}: {model['name']}")
    print(f"Collection {collection['id']}: {ROOT_COLLECTION} / {MODEL_COLLECTION}")

    unmatched = client.query(textwrap.dedent(unmatched_asset_locations_sql()).strip())["data"]["rows"]
    if unmatched:
        print("Unmatched asset locations:")
        for location, row_count in unmatched:
            print(f"  {location}: {row_count} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
