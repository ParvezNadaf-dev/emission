"""
Smart Vehicle Emission & Noise Monitoring - web backend.

A small Flask API on top of the existing MySQL database (smart_emission_db).
All compliance rules stay inside MySQL (trigger, procedures, constraints);
this layer only reads data, inserts readings and calls the stored procedures.

Run:  python app.py      then open http://127.0.0.1:5000
"""
import datetime as dt
import os
import random
import re
import time
from decimal import Decimal

import mysql.connector
from mysql.connector import errorcode
from flask import Flask, jsonify, request, send_from_directory
from flask.json.provider import DefaultJSONProvider

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "127.0.0.1"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "smart_emission_db"),
    "autocommit": True,
    "charset": "utf8mb4",
}

# Coordinates used by the simulator (same as the SQL seed procedure)
CITY_CENTRE = (12.9716, 77.5946)
JUNCTIONS = [
    ("Junction J1", 12.9177, 77.6238), ("Junction J2", 13.0358, 77.5970),
    ("Junction J3", 13.0076, 77.6950), ("Junction J4", 12.9767, 77.5713),
    ("Junction J5", 12.9569, 77.7011),
]

# Fixed, whitelisted queries for the Query Lab (never built from user input)
LAB_QUERIES = {
    "q1": {
        "title": "All readings from the last 24 hours",
        "sql": "SELECT log_id, sensor_id, co_level, noise_level, recorded_at "
               "FROM Telemetry_Logs WHERE recorded_at >= NOW() - INTERVAL 1 DAY",
    },
    "q2": {
        "title": "One sensor's readings from the last 7 days, newest first",
        "sql": "SELECT log_id, co_level, no2_level, noise_level, recorded_at "
               "FROM Telemetry_Logs WHERE sensor_id = 42 "
               "AND recorded_at >= NOW() - INTERVAL 7 DAY ORDER BY recorded_at DESC",
    },
    "q3": {
        "title": "Count of readings from the last 24 hours",
        "sql": "SELECT COUNT(*) FROM Telemetry_Logs WHERE recorded_at >= NOW() - INTERVAL 1 DAY",
    },
}
LAB_INDEXES = {
    "idx_tl_time": "CREATE INDEX idx_tl_time ON Telemetry_Logs (recorded_at)",
    "idx_tl_sensor_time": "CREATE INDEX idx_tl_sensor_time ON Telemetry_Logs (sensor_id, recorded_at)",
}


# --------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------
class JSONProvider(DefaultJSONProvider):
    """Serialise MySQL DECIMAL and DATETIME values."""
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, (dt.datetime, dt.date)):
            return o.isoformat(sep=" ") if isinstance(o, dt.datetime) else o.isoformat()
        if isinstance(o, (bytes, bytearray)):
            return o.decode("utf-8", "replace")
        return super().default(o)


app = Flask(__name__, static_folder="static", static_url_path="/static")
app.json = JSONProvider(app)

def connect():
    """Open a short-lived connection for one request.

    A local MySQL connection takes only a few milliseconds, and one connection
    per request avoids pool-exhaustion errors when the dashboard loads several
    panels at once.
    """
    return mysql.connector.connect(**DB_CONFIG)


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify({"error": e.message}), e.status


@app.errorhandler(mysql.connector.Error)
def handle_db_error(e):
    app.logger.error("Database error on %s: %s", request.path, e)
    if e.errno in (errorcode.CR_CONN_HOST_ERROR, errorcode.CR_CONNECTION_ERROR,
                   errorcode.ER_ACCESS_DENIED_ERROR, errorcode.ER_BAD_DB_ERROR, 2003, 2005, 2013):
        return jsonify({"error": "Can't reach the database. Check that MySQL is running and the "
                                 "settings in your .env file are correct.", "detail": str(e)}), 503
    return jsonify({"error": f"Database error {e.errno}: {e.msg}"}), 500


def query(sql, params=(), one=False):
    conn = connect()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        return (rows[0] if rows else None) if one else rows
    finally:
        conn.close()


def execute(sql, params=()):
    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        if cur.with_rows:
            cur.fetchall()
        last_id, count = cur.lastrowid, cur.rowcount
        cur.close()
        return last_id, count
    finally:
        conn.close()


def call_proc(name, args):
    conn = connect()
    try:
        cur = conn.cursor(dictionary=True)
        cur.callproc(name, args)
        rows = []
        results = cur.stored_results
        for result in (results() if callable(results) else results):
            cols = result.column_names
            rows = [r if isinstance(r, dict) else dict(zip(cols, r)) for r in result.fetchall()]
        cur.close()
        return rows
    finally:
        conn.close()


def int_arg(name, default, lo, hi):
    try:
        v = int(request.args.get(name, default))
    except (TypeError, ValueError):
        raise ApiError(f"'{name}' must be a whole number")
    if not lo <= v <= hi:
        raise ApiError(f"'{name}' must be between {lo} and {hi}")
    return v


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    row = query("SELECT VERSION() AS version, DATABASE() AS db", one=True)
    return jsonify({"ok": True, **row})


# --------------------------------------------------------------------------
# Overview
# --------------------------------------------------------------------------
@app.get("/api/summary")
def summary():
    row = query("""
        SELECT
          (SELECT COUNT(*) FROM Vehicles)                                    AS vehicles,
          (SELECT COUNT(*) FROM IoT_Sensors WHERE sensor_status = 'Active')  AS active_sensors,
          (SELECT COUNT(*) FROM IoT_Sensors WHERE sensor_status = 'Faulty')  AS faulty_sensors,
          (SELECT COUNT(*) FROM Telemetry_Logs)                              AS readings,
          (SELECT COUNT(*) FROM Violations_Log)                              AS violations,
          (SELECT COUNT(*) FROM Violations_Log
            WHERE occurred_at >= NOW() - INTERVAL 1 DAY)                     AS violations_24h,
          (SELECT COALESCE(SUM(fine_amount), 0) FROM Violations_Log
            WHERE status = 'Pending')                                        AS pending_fines,
          (SELECT COALESCE(SUM(fine_amount), 0) FROM Violations_Log
            WHERE status = 'Paid')                                           AS collected_fines
    """, one=True)
    row["violation_rate"] = round(100 * row["violations"] / row["readings"], 2) if row["readings"] else 0
    return jsonify(row)


@app.get("/api/violations/daily")
def violations_daily():
    days = int_arg("days", 30, 1, 365)
    rows = query("""
        SELECT DATE(occurred_at) AS day,
               SUM(violation_type IN ('Emission','Both')) AS emission,
               SUM(violation_type IN ('Noise','Both'))    AS noise,
               COUNT(*) AS total
        FROM Violations_Log
        WHERE occurred_at >= CURDATE() - INTERVAL %s DAY
          AND occurred_at <  CURDATE()          -- complete days only
        GROUP BY DATE(occurred_at) ORDER BY day
    """, (days,))
    return jsonify(rows)


@app.get("/api/violations/by-type")
def violations_by_type():
    return jsonify(query("""
        SELECT violation_type, COUNT(*) AS count, SUM(fine_amount) AS fines
        FROM Violations_Log GROUP BY violation_type ORDER BY FIELD(violation_type,'Emission','Noise','Both')
    """))


@app.get("/api/zones")
def zones():
    zone_rows = query("SELECT * FROM Zones ORDER BY max_noise_limit")
    summary_rows = query("SELECT * FROM vw_zone_summary ORDER BY total_violations DESC")
    # Violation rate per zone = violations / readings taken inside the zone (active sensors only)
    if request.args.get("rates") != "1":
        return jsonify({"zones": zone_rows, "summary": summary_rows})
    rates = query("""
        SELECT COALESCE(z.zone_name, 'Outside all zones') AS zone_name, COALESCE(z.zone_type, '-') AS zone_type,
               COALESCE(z.max_noise_limit, (SELECT MAX(max_noise_limit) FROM Compliance_Thresholds)) AS noise_limit,
               COUNT(*) AS readings, COUNT(vl.violation_id) AS violations,
               ROUND(100 * COUNT(vl.violation_id) / COUNT(*), 1) AS violation_rate,
               ROUND(100 * SUM(vl.violation_type IN ('Noise','Both')) / COUNT(*), 1) AS noise_rate
        FROM Telemetry_Logs t
        JOIN IoT_Sensors s ON s.sensor_id = t.sensor_id AND s.sensor_status = 'Active'
        LEFT JOIN Zones z ON t.latitude  BETWEEN z.min_lat AND z.max_lat
                         AND t.longitude BETWEEN z.min_lng AND z.max_lng
        LEFT JOIN Violations_Log vl ON vl.log_id = t.log_id
        GROUP BY z.zone_id, z.zone_name, z.zone_type, z.max_noise_limit
        ORDER BY violation_rate DESC
    """)
    return jsonify({"zones": zone_rows, "summary": summary_rows, "rates": rates})


@app.get("/api/hotspots")
def hotspots():
    days = int_arg("days", 7, 1, 365)
    limit = int_arg("limit", 10, 1, 100)
    end = dt.datetime.now()
    rows = call_proc("GetZoneHotspots", [end - dt.timedelta(days=days), end, limit])
    for r in rows:  # friendlier label for cells at the known junctions
        near = [name for name, la, ln in JUNCTIONS
                if abs(float(r["grid_lat"]) - la) < 0.0015 and abs(float(r["grid_lng"]) - ln) < 0.0015]
        r["place"] = near[0] if near and r["zone_name"] == "Unzoned" else (
            r["zone_name"] if r["zone_name"] != "Unzoned" else "Outside zones")
    return jsonify(rows)


# --------------------------------------------------------------------------
# Live feed and readings
# --------------------------------------------------------------------------
FEED_SQL = """
    SELECT t.log_id, t.sensor_id, s.sensor_status, v.vehicle_id, v.license_plate, v.engine_type,
           t.co_level, t.no2_level, t.noise_level, t.latitude, t.longitude, t.recorded_at,
           c.max_co_limit, c.max_no2_limit,
           COALESCE((SELECT MIN(z.max_noise_limit) FROM Zones z
                      WHERE t.latitude  BETWEEN z.min_lat AND z.max_lat
                        AND t.longitude BETWEEN z.min_lng AND z.max_lng), c.max_noise_limit) AS noise_limit,
           (SELECT z.zone_name FROM Zones z
             WHERE t.latitude  BETWEEN z.min_lat AND z.max_lat
               AND t.longitude BETWEEN z.min_lng AND z.max_lng
             ORDER BY z.max_noise_limit LIMIT 1) AS zone_name,
           vl.violation_id, vl.violation_type, vl.co_excess, vl.no2_excess, vl.noise_excess,
           vl.fine_amount, vl.status
    FROM Telemetry_Logs t
    JOIN IoT_Sensors s           ON s.sensor_id = t.sensor_id
    JOIN Vehicles v              ON v.vehicle_id = s.vehicle_id
    JOIN Compliance_Thresholds c ON c.engine_type = v.engine_type
    LEFT JOIN Violations_Log vl  ON vl.log_id = t.log_id
"""


def with_outcome(row):
    if row["violation_id"]:
        row["outcome"] = row["violation_type"]
    elif row["sensor_status"] != "Active":
        row["outcome"] = "Ignored"
    else:
        row["outcome"] = "Compliant"
    return row


@app.get("/api/feed")
def feed():
    limit = int_arg("limit", 25, 1, 100)
    after = int_arg("after", 0, 0, 2**62)
    rows = query(FEED_SQL + " WHERE t.log_id > %s ORDER BY t.log_id DESC LIMIT %s", (after, limit))
    return jsonify([with_outcome(r) for r in rows])


def read_number(body, key, lo, hi):
    try:
        v = float(body[key])
    except (KeyError, TypeError, ValueError):
        raise ApiError(f"Enter a number for {key.replace('_', ' ')}")
    if not lo <= v <= hi:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} must be between {lo} and {hi}")
    return v


def insert_reading(sensor_id, co, no2, noise, lat, lng):
    try:
        log_id, _ = execute(
            "INSERT INTO Telemetry_Logs (sensor_id, co_level, no2_level, noise_level, latitude, longitude) "
            "VALUES (%s, %s, %s, %s, %s, %s)", (sensor_id, co, no2, noise, lat, lng))
    except mysql.connector.Error as e:
        if e.errno == 1452:
            raise ApiError(f"Sensor {sensor_id} isn't registered. Choose an existing sensor.")
        if e.errno == 3819:
            raise ApiError("The database rejected this reading because a value is outside the allowed range.")
        raise
    return with_outcome(query(FEED_SQL + " WHERE t.log_id = %s", (log_id,), one=True))


@app.post("/api/readings")
def create_reading():
    body = request.get_json(silent=True) or {}
    try:
        sensor_id = int(body.get("sensor_id"))
    except (TypeError, ValueError):
        raise ApiError("Choose a sensor")
    # Wide limits here; the database CHECK constraint is the real gatekeeper
    co = read_number(body, "co_level", -1000, 100000)
    no2 = read_number(body, "no2_level", -1000, 100000)
    noise = read_number(body, "noise_level", -1000, 1000)
    lat = read_number(body, "latitude", -1000, 1000)
    lng = read_number(body, "longitude", -1000, 1000)
    return jsonify(insert_reading(sensor_id, co, no2, noise, lat, lng)), 201


@app.post("/api/simulate")
def simulate():
    """Insert a burst of realistic random readings (same model as SeedDemoData)."""
    body = request.get_json(silent=True) or {}
    count = max(1, min(int(body.get("count", 5)), 50))
    sensors = query("""SELECT s.sensor_id, v.engine_type FROM IoT_Sensors s
                       JOIN Vehicles v ON v.vehicle_id = s.vehicle_id""")
    zone_rows = query("SELECT min_lat, max_lat, min_lng, max_lng FROM Zones")
    if not sensors:
        raise ApiError("There are no sensors yet. Run the database setup script first.")
    results = []
    for _ in range(count):
        s = random.choice(sensors)
        eng, hot, pick = s["engine_type"], False, random.random()
        if pick < 0.25:
            _, jlat, jlng = random.choice(JUNCTIONS)
            lat, lng, hot = jlat + (random.random() - 0.5) * 0.0008, jlng + (random.random() - 0.5) * 0.0008, True
        elif pick < 0.40 and zone_rows:
            z = random.choice(zone_rows)
            lat = float(z["min_lat"]) + random.random() * float(z["max_lat"] - z["min_lat"])
            lng = float(z["min_lng"]) + random.random() * float(z["max_lng"] - z["min_lng"])
        else:
            lat = CITY_CENTRE[0] + (random.random() - 0.5) * 0.16
            lng = CITY_CENTRE[1] + (random.random() - 0.5) * 0.16
        co = {"Petrol": 120 + random.random() * 110, "Diesel": 60 + random.random() * 80}.get(eng, 30 + random.random() * 60)
        if random.random() < 0.10:
            co *= 1.3 + random.random() * 0.7
        no2 = {"Petrol": 15 + random.random() * 30, "Diesel": 50 + random.random() * 65}.get(eng, 8 + random.random() * 20)
        if random.random() < 0.08:
            no2 *= 1.3 + random.random() * 0.6
        noise = 60 + random.random() * 15 + (5 if hot else 0)
        if random.random() < 0.10:
            noise += 10 + random.random() * 15
        results.append(insert_reading(s["sensor_id"], round(co, 2), round(no2, 2), round(min(noise, 200), 1),
                                      round(lat, 6), round(lng, 6)))
    return jsonify(results), 201


@app.get("/api/sensors")
def sensors():
    return jsonify(query("""
        SELECT h.*, v.vehicle_id, v.engine_type, v.owner_name
        FROM vw_sensor_health h
        JOIN IoT_Sensors s ON s.sensor_id = h.sensor_id
        JOIN Vehicles v    ON v.vehicle_id = s.vehicle_id
        ORDER BY h.sensor_id
    """))


@app.put("/api/sensors/<int:sensor_id>/status")
def set_sensor_status(sensor_id):
    status = (request.get_json(silent=True) or {}).get("sensor_status")
    if status not in ("Active", "Faulty"):
        raise ApiError("Status must be Active or Faulty")
    _, n = execute("UPDATE IoT_Sensors SET sensor_status = %s WHERE sensor_id = %s", (status, sensor_id))
    if n == 0 and not query("SELECT 1 FROM IoT_Sensors WHERE sensor_id = %s", (sensor_id,)):
        raise ApiError("Sensor not found", 404)
    return jsonify({"sensor_id": sensor_id, "sensor_status": status})


# --------------------------------------------------------------------------
# Vehicles, offenders, fines
# --------------------------------------------------------------------------
VEHICLE_SORTS = {
    "pending": "pending_fines DESC", "violations": "total_violations DESC",
    "plate": "license_plate ASC", "recent": "last_violation DESC",
}


@app.get("/api/vehicles")
def vehicles():
    search = (request.args.get("q") or "").strip()[:40]
    sort = VEHICLE_SORTS.get(request.args.get("sort", "pending"), VEHICLE_SORTS["pending"])
    engine = request.args.get("engine")
    page_size = int_arg("size", 20, 5, 100)
    page = int_arg("page", 1, 1, 10000)
    where, params = ["1=1"], []
    if search:
        where.append("(license_plate LIKE %s OR owner_name LIKE %s)")
        params += [f"%{search}%", f"%{search}%"]
    if engine in ("Petrol", "Diesel", "CNG"):
        where.append("engine_type = %s")
        params.append(engine)
    w = " AND ".join(where)
    total = query(f"SELECT COUNT(*) AS n FROM vw_vehicle_compliance WHERE {w}", params, one=True)["n"]
    rows = query(f"SELECT * FROM vw_vehicle_compliance WHERE {w} ORDER BY {sort}, vehicle_id LIMIT %s OFFSET %s",
                 params + [page_size, (page - 1) * page_size])
    return jsonify({"total": total, "page": page, "size": page_size, "rows": rows})


@app.get("/api/vehicles/<int:vehicle_id>")
def vehicle_detail(vehicle_id):
    v = query("SELECT * FROM Vehicles WHERE vehicle_id = %s", (vehicle_id,), one=True)
    if not v:
        raise ApiError("Vehicle not found", 404)
    v["compliance"] = query("SELECT * FROM vw_vehicle_compliance WHERE vehicle_id = %s", (vehicle_id,), one=True)
    v["sensors"] = query("SELECT * FROM IoT_Sensors WHERE vehicle_id = %s", (vehicle_id,))
    v["violations"] = query("""
        SELECT vl.*, z.zone_name, t.co_level, t.no2_level, t.noise_level, t.latitude, t.longitude
        FROM Violations_Log vl
        JOIN Telemetry_Logs t ON t.log_id = vl.log_id
        LEFT JOIN Zones z     ON z.zone_id = vl.zone_id
        WHERE vl.vehicle_id = %s
        ORDER BY vl.occurred_at DESC LIMIT 100
    """, (vehicle_id,))
    return jsonify(v)


@app.post("/api/violations/<int:violation_id>/pay")
def pay_fine(violation_id):
    try:
        call_proc("PayFine", [violation_id])
    except mysql.connector.Error as e:
        if e.errno == 1644:  # SIGNAL from the stored procedure
            raise ApiError(e.msg, 409 if "paid" in e.msg.lower() else 404)
        raise
    return jsonify(query("SELECT violation_id, status, paid_at, fine_amount FROM Violations_Log "
                         "WHERE violation_id = %s", (violation_id,), one=True))


@app.get("/api/offenders")
def offenders():
    days = int_arg("days", 30, 1, 365)
    minimum = int_arg("min", 60, 1, 100000)
    return jsonify(call_proc("GetRepeatOffenders", [days, minimum]))


# --------------------------------------------------------------------------
# Rules: thresholds and zones
# --------------------------------------------------------------------------
@app.get("/api/thresholds")
def thresholds():
    return jsonify(query("SELECT * FROM Compliance_Thresholds ORDER BY FIELD(engine_type,'Petrol','Diesel','CNG')"))


@app.put("/api/thresholds/<engine>")
def update_threshold(engine):
    if engine not in ("Petrol", "Diesel", "CNG"):
        raise ApiError("Unknown engine type", 404)
    body = request.get_json(silent=True) or {}
    fields = {
        "max_co_limit": read_number(body, "max_co_limit", 0.01, 99999),
        "max_no2_limit": read_number(body, "max_no2_limit", 0.01, 99999),
        "max_noise_limit": read_number(body, "max_noise_limit", 1, 200),
        "emission_fine": read_number(body, "emission_fine", 0, 999999),
        "noise_fine": read_number(body, "noise_fine", 0, 999999),
    }
    execute("UPDATE Compliance_Thresholds SET max_co_limit=%s, max_no2_limit=%s, max_noise_limit=%s, "
            "emission_fine=%s, noise_fine=%s WHERE engine_type=%s", (*fields.values(), engine))
    return jsonify(query("SELECT * FROM Compliance_Thresholds WHERE engine_type = %s", (engine,), one=True))


@app.put("/api/zones/<int:zone_id>")
def update_zone(zone_id):
    body = request.get_json(silent=True) or {}
    limit = read_number(body, "max_noise_limit", 1, 200)
    _, n = execute("UPDATE Zones SET max_noise_limit = %s WHERE zone_id = %s", (limit, zone_id))
    row = query("SELECT * FROM Zones WHERE zone_id = %s", (zone_id,), one=True)
    if not row:
        raise ApiError("Zone not found", 404)
    return jsonify(row)


# --------------------------------------------------------------------------
# Query lab: Explain Plan and index toggling
# --------------------------------------------------------------------------
def index_status():
    present = {r["name"] for r in query("""
        SELECT DISTINCT index_name AS name FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'Telemetry_Logs'""")}
    return {name: name in present for name in LAB_INDEXES}


@app.get("/api/lab")
def lab_info():
    return jsonify({"queries": {k: {"title": v["title"], "sql": v["sql"]} for k, v in LAB_QUERIES.items()},
                    "indexes": index_status(),
                    "rows": query("SELECT COUNT(*) AS n FROM Telemetry_Logs", one=True)["n"]})


@app.get("/api/lab/<qid>")
def lab_run(qid):
    q = LAB_QUERIES.get(qid)
    if not q:
        raise ApiError("Unknown query", 404)
    plan = query("EXPLAIN " + q["sql"])
    analyze = query("EXPLAIN ANALYZE " + q["sql"], one=True)
    analyze_text = list(analyze.values())[0] if analyze else ""
    # Wall-clock time of the real query (best of 3, rows discarded)
    conn = connect()
    try:
        cur = conn.cursor()
        best = None
        for _ in range(3):
            t0 = time.perf_counter()
            cur.execute(q["sql"])
            n = len(cur.fetchall())
            ms = (time.perf_counter() - t0) * 1000
            best = ms if best is None else min(best, ms)
        cur.close()
    finally:
        conn.close()
    # Server-side execution time = end time of the top node in EXPLAIN ANALYZE
    m = re.search(r"actual time=[\d.]+\.\.([\d.]+)", analyze_text or "")
    server_ms = float(m.group(1)) if m else None
    examined = [int(x) for x in re.findall(r"actual time=[\d.]+\.\.[\d.]+ rows=(\d+)", analyze_text or "")]
    return jsonify({"id": qid, **q, "plan": plan, "analyze": analyze_text,
                    "rows_returned": n, "rows_examined": max(examined) if examined else None,
                    "server_ms": server_ms, "round_trip_ms": round(best, 2), "indexes": index_status()})


@app.post("/api/lab/indexes")
def lab_indexes():
    action = (request.get_json(silent=True) or {}).get("action")
    status = index_status()
    if action == "create":
        for name, ddl in LAB_INDEXES.items():
            if not status[name]:
                execute(ddl)
    elif action == "drop":
        # When idx_tl_sensor_time exists, MySQL silently removes the implicit
        # foreign-key index on sensor_id and relies on the composite index
        # instead. Recreate a plain sensor_id index first, otherwise the drop
        # fails with error 1553 ("needed in a foreign key constraint").
        has_plain = query("""
            SELECT COUNT(*) AS n FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'Telemetry_Logs'
              AND column_name = 'sensor_id' AND seq_in_index = 1
              AND index_name <> 'idx_tl_sensor_time'""", one=True)["n"]
        if status["idx_tl_sensor_time"] and not has_plain:
            execute("CREATE INDEX fk_log_sensor ON Telemetry_Logs (sensor_id)")
        for name in LAB_INDEXES:
            if status[name]:
                execute(f"DROP INDEX {name} ON Telemetry_Logs")
    else:
        raise ApiError("Action must be create or drop")
    execute("ANALYZE TABLE Telemetry_Logs")
    return jsonify({"indexes": index_status()})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    print(f"\n  Emission monitor running at http://127.0.0.1:{port}\n")
    app.run(host="127.0.0.1", port=port, debug=os.getenv("FLASK_DEBUG") == "1")
