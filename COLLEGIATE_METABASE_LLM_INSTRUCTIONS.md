# Collegiate Metabase LLM handoff

Use this file as the full prompt/context for an LLM that needs to inspect,
create, or refresh Collegiate models in Metabase.

This handoff was updated from the live Metabase instance
`https://metabase.collegiate-ac.com/` on 2026-07-13. Do not use older local
assumptions without re-checking the live instance first.

The LLM must not guess. If verification fails, ask the user one short, plain
question before continuing.

## Ask for credentials first

Ask this first, exactly this simply:

```text
What are the Metabase URL, email, and password I should use?
```

Only ask for these Metabase credentials at the start:

- `MB_URL`, for example `https://metabase.collegiate-ac.com`.
- `MB_USER`, the Metabase email/username.
- `MB_PASSWORD`, the Metabase password.

Do not ask for StarRez, PostgreSQL, Azure, or SSH credentials unless Metabase
cannot run SQL against the connected `starrez` database and the user confirms
that direct database access is required.

If any later question is needed, ask one simple question at a time. Good
examples:

- `Which Metabase database should I use for starrez?`
- `I can see report table 65521 but not 65535. Should I stop?`
- `Should table 65526 be used in this model, or should I leave it alone?`
- `Can I update the existing Gross Booking Model?`

Bad examples:

- Multi-part questions.
- Questions with raw API payloads.
- Questions that ask the user to understand stack traces.
- Questions that ask for credentials already provided.

## Non-negotiable rules

- Use the live Metabase API as the source of truth.
- Do not print, store, or paste credentials into files, logs, SQL comments, or
  model descriptions.
- Do not hardcode database ID `2` for a different Metabase instance. In the live
  Collegiate instance it was `2` on 2026-07-13, but always discover it.
- Do not treat StarRez report IDs as Metabase card IDs.
- Do not assume old report tables exist just because `config.source_reports`
  lists them.
- Do not use `DROP ... CASCADE` on StarRez report tables. Existing views/models
  may depend on the table object.
- Do not overwrite a working model with older SQL from memory.
- Native SQL Metabase models must not contain Metabase variables such as
  `{{property}}`, `{{as_of_date}}`, or field-filter tags.

## Metabase API pattern

Authenticate:

```http
POST /api/session
Content-Type: application/json

{"username":"<MB_USER>","password":"<MB_PASSWORD>"}
```

Use the returned `id` as:

```http
X-Metabase-Session: <session id>
```

Find the StarRez database:

```http
GET /api/database
```

Choose the database where `details.dbname` is `starrez`. On the live audit this
was:

| Metabase database ID | Name               | Engine     | PostgreSQL dbname |
| -------------------- | ------------------ | ---------- | ----------------- |
| `2`                  | `Azure PostgreSQL` | `postgres` | `starrez`         |

If there is not exactly one match, ask:

```text
Which Metabase database should I use for starrez?
```

Run SQL through Metabase:

```http
POST /api/dataset
Content-Type: application/json
X-Metabase-Session: <session id>

{
  "database": <starrez_database_id>,
  "type": "native",
  "native": {"query": "<sql>"},
  "parameters": []
}
```

For DDL, Metabase may return an error like "Select statement did not produce a
ResultSet" after running the statement. Treat that as success only if the DDL
actually ran. Do not ignore other errors.

Sync metadata after creating or changing tables/views:

```http
POST /api/database/<starrez_database_id>/sync_schema
```

## First live checks

Run these checks before creating or updating anything.

Find live schemas and relations:

```sql
select table_schema, table_name, table_type
from information_schema.tables
where table_schema in (
  'starrez_data',
  'starrez_meta',
  'config',
  'reporting',
  'models',
  'external_data'
)
order by table_schema, table_name;
```

Find columns:

```sql
select table_schema, table_name, column_name, ordinal_position
from information_schema.columns
where table_schema in (
  'starrez_data',
  'starrez_meta',
  'config',
  'reporting',
  'models',
  'external_data'
)
order by table_schema, table_name, ordinal_position;
```

Find current Metabase models:

```http
GET /api/card?f=all
```

Then fetch model details with:

```http
GET /api/card/<card_id>
```

Important: current Metabase may store native SQL in either shape:

```json
{ "dataset_query": { "type": "native", "native": { "query": "select ..." } } }
```

or:

```json
{
  "dataset_query": {
    "lib/type": "mbql/query",
    "stages": [{ "lib/type": "mbql.stage/native", "native": "select ..." }]
  }
}
```

When reading an existing model, check both locations. Do not assume
`dataset_query.native.query` exists.

## Live database layout

All objects below are in PostgreSQL database `starrez`.

Live schemas:

- `starrez_data`: StarRez source/report tables, lookup tables, and a small
  leasing-model view.
- `starrez_meta`: StarRez export bookkeeping.
- `config`: editable configuration tables and current-year settings.
- `reporting`: adapter views. In the live audit, only a subset existed and all
  returned `0` rows.
- `models`: reusable cleaned views for external data only at the time of audit.
- `external_data`: optional imported CSV/Excel tables. Both audited tables were
  empty.

### Live StarRez data objects

Counts below are audit snapshots from 2026-07-13. Use them as sanity checks, not
as fixed truth.

| Relation                                    | Type  |   Rows | Notes                                                                |
| ------------------------------------------- | ----- | -----: | -------------------------------------------------------------------- |
| `starrez_data.active_report`                | table | 56,056 | Active/preview report table                                          |
| `starrez_data.asset_lookup`                 | table |     32 | Maps asset/property to portfolio, client, city                       |
| `starrez_data.entry`                        | table | 91,149 | StarRez entry data                                                   |
| `starrez_data.leasing_model`                | view  | 32,117 | Database view over sales table, not the full Metabase Gross model    |
| `starrez_data.table_65521`                  | table | 56,263 | Sales table used by Gross/Net models                                 |
| `starrez_data.table_65526`                  | table | 14,851 | Extra StarRez report table, not used by current Gross/Net models     |
| `starrez_data.table_65535`                  | table | 18,235 | Cancellations table used by Gross/Net models                         |
| `starrez_data."weekly lookup"`              | table |    728 | Raw weekly lookup upload with generic columns                        |
| `starrez_data.weekly_lookup_20260624165612` | table |    728 | Imported Weekly Lookup source used by Metabase model `Weekly Lookup` |
| `starrez_data.weekly_lookup_sales_weeks`    | view  |  2,908 | Clean long-format lookup: term, date, sales week                     |
| `starrez_meta.weeks`                        | table |    171 | Export snapshot registry                                             |

Only these numbered `starrez_data.table_<report_id>` relations were visible in
the live audit:

- `starrez_data.table_65521`
- `starrez_data.table_65526`
- `starrez_data.table_65535`

Old report tables such as `starrez_data.table_63801`,
`starrez_data.table_59717`, `starrez_data.table_59906`, and
`starrez_data.table_62751` were not present in the live audit. Do not build
models that reference them unless a fresh live check confirms they exist.

### Current source columns

`starrez_data.table_65521` columns:

```text
term_session_code, room_location_description, entry_id, booking_id,
date_created, date_held, date_reserved, contract_date_start,
contract_date_end, term_session_description, entry_status_description,
room_type_description, room_space_description, room_rate_description,
room_rate_amount, total_rent, gender_description, age,
nationality_description, university, year_of_study, course, agents,
booking_type_description, incentives, hear_about_us, _metabase_row_id
```

`starrez_data.table_65535` columns:

```text
_metabase_row_id, term_session_code, entry_id, booking_id,
room_location_description, date_created, date_held, date_reserved,
date_cancelled, term_session_description, entry_status_description,
room_type_description, room_space_description, contract_date_start,
contract_date_end, room_rate_description, room_rate_amount, total_rent,
gender_description, age, nationality_description, agents, group_id,
cancellation_reason, comments
```

`starrez_data.table_65526` columns:

```text
term_session_code, booking_id, term_session_description,
entry_status_description, room_rate_amount, date_created, date_held,
date_reserved, total_rent, entry_id, room_location_description, incentives,
gm_incentive, _metabase_row_id
```

`starrez_data.weekly_lookup_sales_weeks` columns:

```text
term_session_code, lookup_date, sales_week
```

### Term distribution

Live term counts on 2026-07-13:

| Relation      | Term session code |   Rows |
| ------------- | ----------------- | -----: |
| `table_65521` | `2019/2020`       |  3,217 |
| `table_65521` | `2020/2021`       |  4,641 |
| `table_65521` | `2021/2022`       |  7,789 |
| `table_65521` | `2022/2023`       |  8,499 |
| `table_65521` | `2023/2024`       |  9,179 |
| `table_65521` | `2024/2025`       |  8,338 |
| `table_65521` | `2025/2026`       |  9,919 |
| `table_65521` | `2026/2027`       |  4,681 |
| `table_65526` | `2025/2026`       | 10,347 |
| `table_65526` | `2026/2027`       |  4,504 |
| `table_65535` | `2019/2020`       |     27 |
| `table_65535` | `2020/2021`       |    689 |
| `table_65535` | `2021/2022`       |  2,606 |
| `table_65535` | `2022/2023`       |  3,890 |
| `table_65535` | `2023/2024`       |  3,392 |
| `table_65535` | `2024/2025`       |  2,735 |
| `table_65535` | `2025/2026`       |  2,902 |
| `table_65535` | `2026/2027`       |  1,994 |

The Gross Booking Model filters out historic years `2019/2020`, `2020/2021`,
`2021/2022`, and `2022/2023`.

## Config and warehouse layer

Live config tables on 2026-07-13:

| Relation                         | Rows | Purpose                                        |
| -------------------------------- | ---: | ---------------------------------------------- |
| `config.academic_year_periods`   |    4 | Academic-year campaign/check-in settings       |
| `config.agent_lookup`            |   13 | Agent aliases                                  |
| `config.agent_spend_budget`      |    0 | Manual agent budget/spend                      |
| `config.agent_spend_forecast`    |    0 | Manual agent forecast ranges                   |
| `config.contract_length_buckets` |    2 | Contract-week buckets                          |
| `config.current_academic_year`   |    1 | View over the current academic year            |
| `config.incentive_budget`        |   23 | Incentive budgets and additional spend         |
| `config.incentive_code_lookup`   |   67 | Valid incentive codes and values               |
| `config.nationality_lookup`      |    7 | Nationality grouping                           |
| `config.nomination_adjustments`  |    8 | Nomination additions                           |
| `config.properties`              |   35 | Property, bed count, portfolio, exclusion flag |
| `config.property_targets`        |   27 | Revenue and occupancy targets                  |
| `config.rebooker_forecast`       |    0 | Manual rebooker forecast                       |
| `config.reporting_settings`      |    1 | Dashboard-wide settings                        |
| `config.room_group_lookup`       |    3 | Room grouping                                  |
| `config.source_reports`          |   19 | Source-report registry                         |
| `config.study_year_lookup`       |    6 | Study-year grouping                            |

Current academic year:

| Academic year | Label     | Campaign start | Check-in date | Current |
| ------------- | --------- | -------------- | ------------- | ------- |
| `2324`        | `2023/24` | `2022-11-14`   | `2023-09-30`  | no      |
| `2425`        | `2024/25` | `2023-11-06`   | `2024-09-30`  | no      |
| `2526`        | `2025/26` | `2024-10-28`   | `2025-09-30`  | no      |
| `2627`        | `2026/27` | `2025-11-03`   | `2026-09-30`  | yes     |

Excluded properties:

- `Burges House`
- `Castle Street`
- `Clarendon Street`
- `Corporation Village`
- `Market Way`
- `Pillar Box`
- `The Moor`
- `The Neighbourhood Exeter`

Reporting settings:

| Setting               | Value |
| --------------------- | ----: |
| `top_agents_limit`    |     3 |
| `default_period_days` |    30 |

### Source-report registry

`config.source_reports` still contains registry rows for old report IDs. Treat
this as a registry/history table, not as proof that `starrez_data.table_<id>`
exists.

| Source key             | Report ID | Adapter relation                         | Live relation status on 2026-07-13 |
| ---------------------- | --------- | ---------------------------------------- | ---------------------------------- |
| `bookings_2324`        | `63801`   | `reporting.bookings_2324`                | not present                        |
| `bookings_2324_summer` | `59766`   | `"59766"`                                | not present                        |
| `bookings_2324_v3`     | `57290`   | `"57290"`                                | not present                        |
| `bookings_2425`        | `59717`   | `reporting.bookings_2425`                | not present                        |
| `bookings_2526`        | `59906`   | `reporting.bookings_2526`                | not present                        |
| `bookings_2627`        | `62751`   | `reporting.bookings_2627`                | not present                        |
| `cancelled_2324`       | `47213`   | `reporting.cancelled_2324`               | not present                        |
| `cancelled_2526`       | `56259`   | `reporting.cancelled_2526`               | present, 0 rows                    |
| `cancelled_2627`       | `62798`   | `reporting.cancelled_2627`               | present, 0 rows                    |
| `incentive_2425`       | `54074`   | `reporting.incentives_2425`              | present, 0 rows                    |
| `incentive_2526`       | `59321`   | `reporting.incentives_2526`              | present, 0 rows                    |
| `incentive_2627`       | `63796`   | `reporting.incentives_2627`              | not present                        |
| `lavanda_weekly_2526`  | `excel`   | `external_data.lavanda_weekly_reporting` | present, 0 rows                    |
| `rebooker_pool_2223`   | `45963`   | `reporting.rebooker_eligibility_2223`    | present, 0 rows                    |
| `rebooker_pool_2324`   | `45931`   | `reporting.rebooker_eligibility_2324`    | present, 0 rows                    |
| `rebooker_pool_2425`   | `55145`   | `reporting.rebooker_eligibility_2425`    | present, 0 rows                    |
| `rebooker_pool_2526`   | `60147`   | `reporting.rebooker_eligibility_2526`    | not present                        |
| `rebooker_pool_2627`   | `62392`   | `reporting.rebooker_eligibility_2627`    | not present                        |
| `student_crowd_rooms`  | `excel`   | `external_data.student_crowd_rooms`      | present, 0 rows                    |

Live SQL routines:

- `models.norm_text(text)`
- `models.parse_money(text)`
- `models.parse_report_date(text)`
- `reporting.assert_source_relation(...)`
- `reporting.create_booking_adapter(...)`
- `reporting.create_cancelled_adapter(...)`
- `reporting.create_empty_cancelled_adapter(...)`
- `reporting.create_empty_incentive_adapter(...)`
- `reporting.create_empty_rebooker_adapter(...)`
- `reporting.create_incentive_adapter(...)`
- `reporting.create_rebooker_adapter(...)`
- `reporting.jsonb_first_text(...)`

Live `models` views:

- `models.lavanda_bookings_clean`, 0 rows.
- `models.student_crowd_rooms_clean`, 0 rows.

The broader old notebook-conversion views such as `models.bookings_clean`,
`models.bookings_classified`, and `models.bookings_aligned_weeks` were not
present in the live audit.

## Current Metabase collections

Live collections on 2026-07-13:

| Collection                            | Parent                 |
| ------------------------------------- | ---------------------- |
| `Our analytics`                       | root                   |
| `Collegiate Reporting`                | root                   |
| `Collegiate Reporting - Manual Input` | root                   |
| `Collegiate Reporting - Ready Now`    | root                   |
| `Commercial Reporting`                | root                   |
| `Commercial Dashboards`               | `Commercial Reporting` |
| `Models`                              | `Commercial Reporting` |
| `Visuals`                             | `Commercial Reporting` |

Gross and Net models should be in:

```text
Commercial Reporting / Models
```

Find or create the parent collection by name, then find or create the child
collection `Models` under it. Do not create a second root-level `Models`
collection.

## Current Metabase models

The live audit found 80 cards and 4 Metabase models.

| Model name            | Live ID on audit | Collection                      | Type/source                                                                    | Audit result |
| --------------------- | ---------------: | ------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| `Gross Booking Model` |              120 | `Commercial Reporting / Models` | Native SQL stage                                                               | runs         |
| `Net Booking Model`   |              124 | `Commercial Reporting / Models` | Native SQL stage                                                               | runs         |
| `Weekly Lookup`       |              119 | root/personal location          | MBQL source table `starrez_data.weekly_lookup_20260624165612`                  | runs         |
| `March 26`            |               43 | root/personal location          | MBQL source table `starrez_data.march_26_20260604174942__mbarchiv__1783286467` | failed       |

Only `Gross Booking Model` and `Net Booking Model` are part of the current
booking-model creation path.

`Weekly Lookup` is an imported lookup-table model. Do not confuse it with the
clean database view `starrez_data.weekly_lookup_sales_weeks`.

`March 26` is not part of the booking-model path. It failed during the audit and
points at an archived/import table name.

## Create or update a native SQL model

Preferred path for the live instance:

1. Find the existing model by name and collection.
2. Fetch it with `GET /api/card/<card_id>`.
3. Extract the existing native SQL.
4. Reuse that SQL for updates unless the user has asked for a logic change.

Only generate SQL from the recipe in this file when the model is missing, the
existing SQL is broken, or the user has asked you to rebuild it.

Use this extraction logic:

```text
If dataset_query.type is native, use dataset_query.native.query.
Otherwise, scan dataset_query.stages for a stage with lib/type mbql.stage/native.
Use that stage's native string.
If neither exists, it is not a native SQL model.
```

Use `POST /api/card` to create and `PUT /api/card/<id>` to update.

Metabase accepts this create/update shape for a native SQL model:

```json
{
  "name": "Gross Booking Model",
  "type": "model",
  "dataset_query": {
    "type": "native",
    "database": <starrez_database_id>,
    "native": {"query": "<model SQL with no Metabase variables>"}
  },
  "display": "table",
  "visualization_settings": {},
  "collection_id": <commercial_reporting_models_collection_id>,
  "description": "<short description>"
}
```

When updating an existing model:

- Find by name and collection, not by hardcoded ID.
- Preserve `display` and `visualization_settings` unless there is a reason to
  change them.
- Read the model back after saving because Metabase may store the query as a
  `stages[0].native` object.

Update result metadata after creating/updating SQL:

1. Run:

   ```sql
   select * from (<model_sql>) model_metadata limit 0;
   ```

2. Use returned `data.cols` as `result_metadata`.
3. Apply semantic overrides.
4. Send:

   ```http
   PUT /api/card/<model_card_id>
   Content-Type: application/json

   {"result_metadata":[...]}
   ```

## Gross Booking Model

Metabase model name:

```text
Gross Booking Model
```

Live sources:

- Sales: `starrez_data.table_65521`
- Cancellations: `starrez_data.table_65535`
- Weekly lookup: `starrez_data.weekly_lookup_sales_weeks`
- Asset lookup: `starrez_data.asset_lookup`

Do not use old source tables `table_59906` or `table_62751` for this model.
They were not present in the live audit.

The live Gross model is a native SQL stage. Build or refresh it with this shape:

1. `weekly_lookup_sales_weeks` CTE:
   - Prefer selecting from the live view `starrez_data.weekly_lookup_sales_weeks`.
   - Required fields: `term_session_code`, `lookup_date`, `sales_week`.
   - Do not hardcode spreadsheet column positions unless the clean view is
     missing and the user confirms this fallback.
2. `asset_lookup` CTE:
   - Select one row per lower-trimmed `asset`.
   - Output `asset_key`, `asset`, `portfolio`, `client`, `city`.
   - Source: `starrez_data.asset_lookup`.
3. `gross_booking_lookup` CTE:
   - Source: `starrez_data.table_65521`.
   - Deduplicate by trimmed `booking_id`.
   - Only include booking IDs that appear in `starrez_data.table_65535`.
   - Used to backfill cancellation fields not present in report 65535:
     `university`, `year_of_study`, `course`, `booking_type_description`,
     `incentives`, `hear_about_us`.
4. `sales` CTE:
   - Source: `starrez_data.table_65521`.
   - Keep original sales columns.
   - Parse `date_held`, `date_reserved`, `contract_date_start`, and
     `contract_date_end` into real date columns.
   - Filter out `2019/2020`, `2020/2021`, `2021/2022`, and `2022/2023`.
5. `cancellations_raw` CTE:
   - Source: `starrez_data.table_65535`.
   - Shape rows to match the sales output.
   - Use `-c._metabase_row_id` so cancellation row IDs do not collide with
     sales row IDs.
   - Parse `date_held`, `date_reserved`, `contract_date_start`,
     `contract_date_end`, and `date_cancelled`.
   - Filter out `2019/2020`, `2020/2021`, `2021/2022`, and `2022/2023`.
6. `cancellations` CTE:
   - Keep only rows where parsed `date_held_date` or parsed
     `date_reserved_date` is not null.
7. Final `union all`:
   - Sales rows get `Record Sort = 1` and `Record Type = 'Sales'`.
   - Cancellation rows get `Record Sort = 2` and
     `Record Type = 'Cancellation'`.
   - Calculate `Weeks Leased` as contract duration in days divided by 7.
   - Classify `Booking Channel` with this precedence:
     1. `term_session_description` containing `RB` means `Rebooker`.
     2. Populated `agents` means `Agent`.
     3. Otherwise use `booking_type_description`.
   - Set `Booking Status` to `Reserved` when parsed `date_reserved` exists,
     otherwise `Date Held`.
   - Join `weekly_lookup_sales_weeks` on term and parsed `date_held_date` for
     `Week of Leasing Cycle`.
   - Join `asset_lookup` on lower-trimmed `room_location_description`.
   - For cancellation rows, set `Date Cancelled`, `Cancellation Status`, and
     `CANCELLED Week of Leasing Cycle` from parsed `date_cancelled`.

Use this date parsing expression consistently:

```sql
case
  when nullif(btrim(<text_column>), '') is null then null
  when nullif(btrim(<text_column>), '') ~ '^\d{1,2}/\d{1,2}/\d{2}$'
    then to_date(nullif(btrim(<text_column>), ''), 'DD/MM/YY')
  when nullif(btrim(<text_column>), '') ~ '^\d{1,2}/\d{1,2}/\d{4}$'
    then to_date(nullif(btrim(<text_column>), ''), 'DD/MM/YYYY')
  when nullif(btrim(<text_column>), '') ~ '^\d{4}-\d{1,2}-\d{1,2}$'
    then to_date(nullif(btrim(<text_column>), ''), 'YYYY-MM-DD')
  when left(nullif(btrim(<text_column>), ''), 10) ~ '^\d{4}-\d{2}-\d{2}$'
    then to_date(left(nullif(btrim(<text_column>), ''), 10), 'YYYY-MM-DD')
  else null
end
```

Gross output columns observed live:

```text
term_session_code, room_location_description, entry_id, booking_id,
date_created, date_held, date_reserved, contract_date_start,
contract_date_end, term_session_description, entry_status_description,
room_type_description, room_space_description, room_rate_description,
room_rate_amount, total_rent, gender_description, age,
nationality_description, university, year_of_study, course, agents,
booking_type_description, incentives, hear_about_us, _metabase_row_id,
Record Sort, Record Type, date_held_date, date_reserved_date,
contract_start_date, contract_end_date, Weeks Leased, Booking Channel,
Booking Status, Week of Leasing Cycle, Portfolio, Client, City,
Date Cancelled, Cancellation Status, CANCELLED Week of Leasing Cycle
```

Recommended metadata overrides:

| Field             | Semantic type          |
| ----------------- | ---------------------- |
| `Record Type`     | `type/Category`        |
| `Booking Channel` | `type/Source`          |
| `Portfolio`       | `type/Category`        |
| `Client`          | `type/Category`        |
| `City`            | `type/City`            |
| `Date Cancelled`  | `type/CancelationDate` |

Gross validation SQL:

```sql
with gross_booking_model as (
  <gross_model_sql>
)
select
  count(*) as rows,
  count(*) filter (where "Record Type" = 'Sales') as sales_rows,
  count(*) filter (where "Record Type" = 'Cancellation') as cancellation_rows,
  count(*) filter (where "Week of Leasing Cycle" is not null) as rows_with_week,
  count(*) filter (
    where "Record Type" = 'Cancellation'
      and "CANCELLED Week of Leasing Cycle" is not null
  ) as cancellation_rows_with_cancelled_week,
  count(*) filter (
    where term_session_code in ('2019/2020', '2020/2021', '2021/2022', '2022/2023')
  ) as historic_rows
from gross_booking_model;
```

`historic_rows` should be `0`.

## Net Booking Model

Metabase model name:

```text
Net Booking Model
```

Live source:

- The Gross Booking Model SQL embedded as a CTE.

Do not reference the Gross model by Metabase card ID inside the Net model SQL.
Embed the same Gross SQL or use a stable database view only if the user asks for
that architecture.

The live Net model is a native SQL stage. Its output is by term, leasing week,
and room location, with weekly and cumulative booking counts.

Build or refresh it with this shape:

1. `gross_booking_model` CTE:
   - Use the current Gross Booking Model SQL.
2. `gross_bookings` CTE:
   - Filter `Record Type = 'Sales'`.
   - Group by `term_session_code`, `Week of Leasing Cycle`, and
     `room_location_description`.
   - Count rows as `gross_bookings`.
3. `cancelled_bookings` CTE:
   - Filter `Record Type = 'Cancellation'`.
   - Group by `term_session_code`, `CANCELLED Week of Leasing Cycle`, and
     `room_location_description`.
   - Count rows as `cancelled_bookings`.
4. `current_week_lookup` CTE:
   - Use `starrez_data.weekly_lookup_sales_weeks`.
   - Join `lookup_date = current_date` per term to find the current sales week.
   - If no current week matches, use `9999` fallback so no weeks are zeroed.
5. `booking_keys` CTE:
   - Get every distinct term/room combination with gross or cancelled activity.
   - Cross join `generate_series(1, 55)` so every week exists and cumulative
     lines carry forward.
6. Final select:
   - Output weekly `Gross Bookings`, `Cancelled Bookings`, and `Net Bookings`.
   - For future weeks beyond the current sales week, weekly columns are `0`.
   - Cumulative columns are `null` for future weeks so chart lines stop at the
     current week.

Net output columns observed live:

```text
Term Session Code, Week of Leasing Cycle, Room Location Description,
Gross Bookings, Cancelled Bookings, Net Bookings,
Cumulative Gross Bookings, Cumulative Cancelled Bookings,
Cumulative Net Bookings
```

Recommended metadata overrides:

| Field                       | Semantic type      |
| --------------------------- | ------------------ |
| `Term Session Code`         | `type/Category`    |
| `Room Location Description` | `type/Description` |
| `Gross Bookings`            | `type/Quantity`    |
| `Cancelled Bookings`        | `type/Quantity`    |
| `Net Bookings`              | `type/Quantity`    |

Net validation SQL:

```sql
with net_booking_model as (
  <net_model_sql>
)
select
  count(*) as rows,
  sum("Gross Bookings") as gross_bookings,
  sum("Cancelled Bookings") as cancelled_bookings,
  sum("Net Bookings") as net_bookings,
  max("Week of Leasing Cycle") as max_week,
  count(*) filter (where "Cumulative Net Bookings" is null) as future_week_rows
from net_booking_model;
```

## Avoid stale local scripts unless checked

Older scripts or notes may still default to `starrez_data."weekly lookup"` and
manual spreadsheet-column unpivoting. The live database now has
`starrez_data.weekly_lookup_sales_weeks`, which is the safer lookup source for
new or refreshed Gross/Net SQL.

If a script generates model SQL, inspect the generated SQL before using it:

- It must not reference missing old report tables such as `table_59906` or
  `table_62751`.
- It should use `table_65521` for sales and `table_65535` for cancellations.
- It should use `weekly_lookup_sales_weeks` unless the user confirms a fallback.
- It must not contain Metabase variables.

## Report table refresh safety

StarRez report tables are loaded by the StarRez/Metabase integration. If you are
refreshing source report tables, preserve the table object when possible.

Safe replacement pattern:

1. Add missing columns.
2. Ensure `_metabase_row_id` exists when needed.
3. Truncate the existing table.
4. Load the new rows.
5. Recreate or preserve primary key/indexes.
6. Sync Metabase schema.

Do not `DROP ... CASCADE` a report table. A past issue showed
`starrez_data.leasing_model` depended on `starrez_data.table_65521`; dropping the
table would break dependent views/models.

## Final validation checklist

Before saying the work is complete:

1. `/api/session` succeeds.
2. Exactly one Metabase database has `details.dbname = "starrez"`, or the user
   confirmed which one to use.
3. The source relations exist:
   - `starrez_data.table_65521`
   - `starrez_data.table_65535`
   - `starrez_data.weekly_lookup_sales_weeks`
   - `starrez_data.asset_lookup`
4. The source columns match the required columns.
5. `Gross Booking Model` runs through `/api/card/<id>/query` or an equivalent
   wrapped SQL validation.
6. `Net Booking Model` runs through `/api/card/<id>/query` or an equivalent
   wrapped SQL validation.
7. Result metadata has been updated after SQL changes.
8. The `starrez` database schema sync has been triggered after table/view
   changes.
9. No credentials were written to repo files or model descriptions.

## What to say when blocked

Use plain, short wording. Ask one question.

Examples:

```text
I can connect to Metabase, but I cannot find the starrez database. Which database should I use?
```

```text
I found the sales table 65521, but I cannot find the cancellations table 65535. Should I stop?
```

```text
The old report table 62751 is listed in config, but it is not in the database. Should I ignore it?
```

```text
The existing model is broken. Can I replace its SQL with the current 65521/65535 version?
```
