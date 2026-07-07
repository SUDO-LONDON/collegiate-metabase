#!/usr/bin/env python3
"""Create the Collegiate Net Booking Model in Metabase."""

from __future__ import annotations

import argparse
import json
import os
import textwrap
import urllib.error
import urllib.parse
import urllib.request

import collegiate_leasing_model as gross_booking_model


DATABASE_ID = int(os.getenv("MB_DATABASE_ID", "2"))
ROOT_COLLECTION = os.getenv("COLLEGIATE_ROOT_COLLECTION", "Commercial Reporting")
MODEL_COLLECTION = os.getenv("COLLEGIATE_MODEL_COLLECTION", "Models")
MODEL_NAME = os.getenv("COLLEGIATE_NET_BOOKING_MODEL_NAME", "Net Booking Model")


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
                "Net Booking Model calculated from gross and cancellation rows "
                "in the Gross Booking Model."
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


def model_sql() -> str:
    return f"""
-- Net Booking Model.
-- Source: Gross Booking Model.
-- Purpose: aggregate gross bookings and cancellations by term, leasing week, and room location.
with gross_booking_model as (
  -- Keep Net Booking Model based on the same SQL source as the existing Gross Booking Model.
  {gross_booking_model.model_sql()}
),
gross_bookings as (
  select
    term_session_code,
    "Week of Leasing Cycle" as leasing_week,
    room_location_description,
    count(*) as gross_bookings
  from gross_booking_model
  where "Record Type" = 'Sales'
  group by
    term_session_code,
    "Week of Leasing Cycle",
    room_location_description
),
cancelled_bookings as (
  select
    term_session_code,
    "CANCELLED Week of Leasing Cycle" as leasing_week,
    room_location_description,
    count(*) as cancelled_bookings
  from gross_booking_model
  where "Record Type" = 'Cancellation'
  group by
    term_session_code,
    "CANCELLED Week of Leasing Cycle",
    room_location_description
),
booking_keys as (
  -- UNION gives one row for every unique term/week/location combination from either side.
  select term_session_code, leasing_week, room_location_description
  from gross_bookings
  union
  select term_session_code, leasing_week, room_location_description
  from cancelled_bookings
)
select
  booking_keys.term_session_code as "Term Session Code",
  booking_keys.leasing_week as "Week of Leasing Cycle",
  booking_keys.room_location_description as "Room Location Description",
  coalesce(gross.gross_bookings, 0) as "Gross Bookings",
  coalesce(cancelled.cancelled_bookings, 0) as "Cancelled Bookings",
  coalesce(gross.gross_bookings, 0) - coalesce(cancelled.cancelled_bookings, 0) as "Net Bookings"
from booking_keys
left join gross_bookings gross
  on coalesce(gross.term_session_code, '__missing_term_session_code__')
   = coalesce(booking_keys.term_session_code, '__missing_term_session_code__')
 and coalesce(gross.leasing_week, -1)
   = coalesce(booking_keys.leasing_week, -1)
 and coalesce(gross.room_location_description, '__missing_room_location_description__')
   = coalesce(booking_keys.room_location_description, '__missing_room_location_description__')
left join cancelled_bookings cancelled
  on coalesce(cancelled.term_session_code, '__missing_term_session_code__')
   = coalesce(booking_keys.term_session_code, '__missing_term_session_code__')
 and coalesce(cancelled.leasing_week, -1)
   = coalesce(booking_keys.leasing_week, -1)
 and coalesce(cancelled.room_location_description, '__missing_room_location_description__')
   = coalesce(booking_keys.room_location_description, '__missing_room_location_description__')
order by
  "Term Session Code",
  "Week of Leasing Cycle",
  "Room Location Description"
"""


def validation_sql() -> str:
    return f"""
with net_booking_model as (
  {model_sql()}
)
select
  count(*) as rows,
  sum("Gross Bookings") as gross_bookings,
  sum("Cancelled Bookings") as cancelled_bookings,
  sum("Net Bookings") as net_bookings,
  count(*) filter (where "Gross Bookings" = 0) as cancellation_only_rows,
  count(*) filter (where "Cancelled Bookings" = 0) as gross_only_rows
from net_booking_model
"""


def source_validation_sql() -> str:
    return f"""
with gross_booking_model as (
  {gross_booking_model.model_sql()}
)
select
  count(*) filter (where "Record Type" = 'Sales') as sales_rows,
  count(*) filter (where "Record Type" = 'Cancellation') as cancellation_rows
from gross_booking_model
"""


def model_field_metadata(metadata: list[dict]) -> list[dict]:
    overrides = {
        "Term Session Code": {"semantic_type": "type/Category"},
        "Room Location Description": {"semantic_type": "type/Description"},
        "Gross Bookings": {"semantic_type": "type/Quantity"},
        "Cancelled Bookings": {"semantic_type": "type/Quantity"},
        "Net Bookings": {"semantic_type": "type/Quantity"},
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
    parser.add_argument("--dry-run", action="store_true", help="Print SQL without changing Metabase.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.dry_run:
        for sql in [model_sql(), validation_sql(), source_validation_sql()]:
            print(textwrap.dedent(sql).strip())
            print()
        return 0

    missing = [name for name in ["MB_URL", "MB_USER", "MB_PASSWORD"] if not os.getenv(name)]
    if missing:
        raise SystemExit(f"Missing environment variables: {', '.join(missing)}")

    client = MetabaseClient(os.environ["MB_URL"])
    client.login(os.environ["MB_USER"], os.environ["MB_PASSWORD"])

    source = client.query(textwrap.dedent(source_validation_sql()).strip())["data"]["rows"][0]
    result = client.query(textwrap.dedent(validation_sql()).strip())
    rows = result["data"]["rows"][0]
    print(
        f"{MODEL_NAME}: {rows[0]} rows, "
        f"{rows[1]} gross bookings, "
        f"{rows[2]} cancelled bookings, "
        f"{rows[3]} net bookings, "
        f"{rows[4]} cancellation-only rows, "
        f"{rows[5]} gross-only rows"
    )
    print(f"Source: {source[0]} sales rows, {source[1]} cancellation rows")

    root = client.ensure_collection(ROOT_COLLECTION)
    collection = client.ensure_collection(MODEL_COLLECTION, root["id"])
    model = client.ensure_model(collection["id"], MODEL_NAME, model_sql())
    metadata = client.model_metadata(model_sql())
    client.update_model_metadata(model["id"], model_field_metadata(metadata))
    print(f"Model {model['id']}: {model['name']}")
    print(f"Collection {collection['id']}: {ROOT_COLLECTION} / {MODEL_COLLECTION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
