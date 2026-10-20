# Emission & Noise Monitor — web app

A web dashboard and REST API for the **IoT-Based Smart Vehicle Emission and Noise Monitoring System** database (`smart_emission_db`).

All compliance rules stay inside MySQL — the trigger, stored procedures, views and constraints you already built. The Python backend only inserts readings, reads results and calls the procedures. This makes the database the single source of truth, which is the point of the DBMS project.

```
Browser (HTML/CSS/JS, Chart.js, Leaflet)
        │  JSON over HTTP
Flask backend (app.py)  ──  REST API, input checks, error messages
        │  SQL, CALL
MySQL 8.0 (smart_emission_db)  ──  tables, trigger, procedures, views, indexes
```

## What you need

- MySQL 8.0 with `smart_emission_db` (from the project SQL script)
- Python 3.10 or newer (python.org — tick "Add Python to PATH" when installing)
- An internet connection for fonts, charts and map tiles (the app itself runs locally)

## Setup

### 1. Prepare the database

Open MySQL Workbench and run **one** of these:

- **You already have the database** (you ran the project script earlier): run `database/02_upgrade_existing.sql`. It replaces `PayFine` with the race-safe version and creates `vw_sensor_health`. It doesn't delete any data and is safe to run more than once.
- **Starting from scratch:** first set Edit → Preferences → SQL Editor → *DBMS connection read timeout* to 600 and reconnect, then run `database/01_full_setup.sql`. It creates everything and generates 50,000 demo readings.

### 2. Start the app

**Windows, the easy way:** double-click `run_windows.bat`.
The first time, it installs the packages and opens a `.env` file. Put your MySQL password after `DB_PASSWORD=`, save, close Notepad, and double-click `run_windows.bat` again. Your browser opens at http://127.0.0.1:5000.

**Any system, manually:**

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows   (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env          # Windows   (macOS/Linux: cp .env.example .env)
# edit .env and set DB_PASSWORD
python app.py
```

Then open http://127.0.0.1:5000. Stop the server with Ctrl+C.

## Pages

| Page | What it shows | Database objects used |
|---|---|---|
| Overview | Headline figures, hotspot map, latest readings, daily trend, violation rate by zone, violation types | `vw_zone_summary`, `GetZoneHotspots`, `Violations_Log` |
| Live monitor | Send a reading and see the decision; start simulated traffic | INSERT → `trg_check_environmental_compliance` |
| Hotspot map | Ranked grid cells on a map for 24 h / 7 days / 30 days | `GetZoneHotspots` |
| Vehicles & fines | Searchable compliance list; per-vehicle violations; record payments | `vw_vehicle_compliance`, `PayFine` |
| Repeat offenders | Vehicles above a chosen violation count | `GetRepeatOffenders` |
| Rules & sensors | Edit emission limits, fines and zone noise limits; mark sensors faulty or active | `Compliance_Thresholds`, `Zones`, `IoT_Sensors`, `vw_sensor_health` |
| Query lab | EXPLAIN / EXPLAIN ANALYZE with and without indexes, with a before/after table | `information_schema.statistics`, index DDL |

## Suggested demo (about 10 minutes)

1. **Overview** — explain the figures, the map and the meters (the black tick is the limit; red means over).
2. **Live monitor** — click the scenario chips in this order, pressing *Send reading* each time:
   - *Diesel in silence zone* → Emission and noise violation, fine ₹1,050
   - *Same exhaust: Petrol / Diesel / CNG* → three different outcomes for one reading
   - *75 dB in industrial zone*, then *75 dB in silence zone* → legal, then a noise violation
   - *Faulty sensor* → Ignored, not penalised
   - *Impossible value* → Rejected by the CHECK constraint before reaching the trigger
3. **Rules & sensors** — change the Diesel emission fine to 1000 and save. Back on Live monitor, send *Same exhaust: Diesel* again: the fine is now ₹1,000. Change it back to 750.
4. **Live monitor** — press *Start simulated traffic* and go to **Overview**: figures and the feed update every few seconds. Stop it afterwards.
5. **Vehicles & fines** — open a vehicle, record a payment. Payments go through `PayFine`, which rejects double payments.
6. **Hotspot map** — switch between 7 and 30 days. Point out *Different vehicles*: many vehicles in one cell means the location is the problem.
7. **Query lab** — with indexes absent, run Q1 and Q2. Create indexes, run them again, and show the before/after table (full scan → index range scan).

## API

All endpoints return JSON. Errors return `{"error": "message"}` with a suitable status code.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | MySQL version and database name |
| GET | `/api/summary` | Headline figures |
| GET | `/api/violations/daily?days=30` | Violations per complete day |
| GET | `/api/violations/by-type` | Count and fines per violation type |
| GET | `/api/zones[?rates=1]` | Zones, zone summary, optional violation rates |
| GET | `/api/hotspots?days=7&limit=10` | `CALL GetZoneHotspots` |
| GET | `/api/feed?limit=25&after=<log_id>` | Latest readings with limits and outcome |
| POST | `/api/readings` | Insert one reading `{sensor_id, co_level, no2_level, noise_level, latitude, longitude}` |
| POST | `/api/simulate` | Insert `{count}` random realistic readings (max 50) |
| GET | `/api/sensors` | Sensors with health data |
| PUT | `/api/sensors/<id>/status` | `{sensor_status: "Active" \| "Faulty"}` |
| GET | `/api/vehicles?q=&engine=&sort=&page=&size=` | Paged `vw_vehicle_compliance` |
| GET | `/api/vehicles/<id>` | Vehicle, sensors and last 100 violations |
| POST | `/api/violations/<id>/pay` | `CALL PayFine` (409 if already paid) |
| GET | `/api/offenders?days=30&min=60` | `CALL GetRepeatOffenders` |
| GET / PUT | `/api/thresholds[/<engine>]` | Read or update limits and fines |
| PUT | `/api/zones/<id>` | `{max_noise_limit}` |
| GET | `/api/lab`, `/api/lab/<q1\|q2\|q3>` | Query lab info and EXPLAIN results |
| POST | `/api/lab/indexes` | `{action: "create" \| "drop"}` |

## Design notes

- **Rules live in the database.** The backend never decides whether a reading is a violation; it inserts the reading and reads back what the trigger wrote. The Live monitor shows the limits the trigger used so the decision can be explained.
- **SQL injection.** Every value from the browser is passed as a query parameter. Sort orders and Query Lab statements come from fixed whitelists, never from user text.
- **Errors in plain language.** MySQL errors are translated: 1452 (unknown sensor), 3819 (CHECK constraint), and 1644 (`SIGNAL` from `PayFine`) become clear messages.
- **Index drop gotcha (error 1553).** When `idx_tl_sensor_time (sensor_id, recorded_at)` exists, MySQL removes the automatic foreign-key index on `sensor_id` and uses the composite index for the foreign key instead. Dropping the composite index then fails with error 1553. The Query Lab handles this by creating a plain `sensor_id` index before dropping. If you drop indexes by hand in Workbench, run `CREATE INDEX fk_log_sensor ON Telemetry_Logs (sensor_id);` first.
- **Local use only.** The server listens on 127.0.0.1 and has no login, which suits a project demo. Don't expose it to a network without adding authentication.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red banner: "Can't reach the database" | Start MySQL (Workbench → Server → Startup/Shutdown), and check `DB_PASSWORD` in `.env` |
| `Access denied for user 'root'` | The password in `.env` is wrong |
| `Unknown database 'smart_emission_db'` | Run `database/01_full_setup.sql` |
| Vehicles page: "Table … vw_sensor_health doesn't exist" or payments fail oddly | Run `database/02_upgrade_existing.sql` |
| Charts or map are blank | They load from the internet; check your connection |
| `Address already in use` | Another program uses port 5000. Set `PORT=5050` in `.env` and open http://127.0.0.1:5050 |
| `'python' is not recognized` | Reinstall Python and tick "Add Python to PATH" |
