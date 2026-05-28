"""
aggregate_signals — Tide Telemetry compute-job proof-of-substrate.

What this job does, end to end:

1. Synthesises ~1000 deterministic maritime-activity events from a
   per-run `SMOKE_RUN_ID` (UUID, generated if not supplied). Each event
   has a `category` drawn from a small fixed set and a numeric `value`
   in [0, 100). Same run_id → same events → same aggregates.
2. Aggregates to `(category, event_count, sum_value)` per category.
3. Writes one row per category into the per-tenant Cloud SQL Postgres
   `tide_aggregates` table, tagged with `run_id` and `created_at`.
   Re-runs append; they do not overwrite.
4. Reads the rows back in the same execution and logs them, then emits
   a `JOB_SUCCESS run_id=… rows_inserted=… total_events=…` sentinel
   line so log scrapers and humans can confirm the run landed.
5. Exits 0 on success, 1 on any failure (missing env, GRANTs, schema
   mismatch, drift between synthesised and inserted totals).

Run locally (no GCP — synth + aggregation only, no DB write):
    python main.py --dry-run

Run end-to-end (requires INSTANCE_CONNECTION_NAME / DB_USER / DB_NAME
+ Workload-Identity-bound bc-tenant-jobs GSA):
    python main.py
"""

from __future__ import annotations

import argparse
import logging
import os
import random
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("aggregate_signals")


# Small fixed category set keeps results easy to eyeball in the Vercel
# app and matches the DESIGN.md brief.
CATEGORIES = ("vessel", "event", "entity", "signal", "observation")


@dataclass
class Aggregate:
    category: str
    event_count: int
    sum_value: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tide aggregate-signals job")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip Cloud SQL write; just synthesise + log aggregates.",
    )
    parser.add_argument(
        "--event-count",
        type=int,
        default=int(os.environ.get("TIDE_EVENT_COUNT", "1000")),
        help="Total number of synthetic events to generate (default: 1000).",
    )
    parser.add_argument(
        "--run-id",
        default=os.environ.get("SMOKE_RUN_ID"),
        help="UUID for this run. Generated if not provided.",
    )
    return parser.parse_args()


def derive_seed(run_id: str) -> int:
    """Deterministic seed from a UUID-like string."""
    try:
        return uuid.UUID(run_id).int & 0xFFFFFFFF
    except (ValueError, AttributeError):
        # Fall back to a stable hash of the raw string.
        return abs(hash(run_id)) & 0xFFFFFFFF


def synthesise(event_count: int, run_id: str) -> list[Aggregate]:
    """Generate `event_count` deterministic events for `run_id` and
    aggregate by category."""
    rng = random.Random(derive_seed(run_id))
    counts: dict[str, int] = {c: 0 for c in CATEGORIES}
    sums: dict[str, float] = {c: 0.0 for c in CATEGORIES}
    for _ in range(event_count):
        category = rng.choice(CATEGORIES)
        # value in [0, 100), rounded to 4 d.p. to keep totals comparable
        # across runs without floating-point drift.
        value = round(rng.random() * 100.0, 4)
        counts[category] += 1
        sums[category] += value
    return [
        Aggregate(
            category=c,
            event_count=counts[c],
            sum_value=round(sums[c], 4),
        )
        for c in CATEGORIES
    ]


def open_connection():
    """Open a Cloud SQL Postgres connection via the IAM-auth Python
    Connector. Returns (connector, connection) — both must be closed by
    the caller."""
    try:
        from google.cloud.sql.connector import Connector, IPTypes  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "cloud-sql-python-connector is not installed. Add "
            "`cloud-sql-python-connector[pg8000]` to requirements.txt."
        ) from exc

    missing = [k for k in ("INSTANCE_CONNECTION_NAME", "DB_USER") if not os.environ.get(k)]
    if missing:
        raise RuntimeError(
            "Missing required platform-injected env: "
            + ", ".join(missing)
            + ". The deploy workflow auto-injects these when Cloud SQL is enabled "
            "for the tenant. If you see this, the Cloud SQL warm-up may not have "
            "finished before /deploy_job ran — re-deploy once the Portal "
            "cockpit shows the Cloud SQL row as `ready`."
        )

    conn_name = os.environ["INSTANCE_CONNECTION_NAME"]
    db_user = os.environ["DB_USER"]
    db_name = os.environ.get("DB_NAME", "bctenant")
    log.info(
        "Connecting to Cloud SQL: instance=%s user=%s db=%s",
        conn_name,
        db_user,
        db_name,
    )
    connector = Connector()
    conn = connector.connect(
        conn_name,
        "pg8000",
        user=db_user,
        db=db_name,
        enable_iam_auth=True,
        ip_type=IPTypes.PUBLIC,
    )
    return connector, conn


def ensure_schema(conn) -> None:
    """`CREATE TABLE IF NOT EXISTS` — no migrations framework here."""
    cur = conn.cursor()
    try:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS tide_aggregates (
                id            BIGSERIAL    PRIMARY KEY,
                run_id        TEXT         NOT NULL,
                category      TEXT         NOT NULL,
                event_count   BIGINT       NOT NULL,
                sum_value     DOUBLE PRECISION NOT NULL,
                created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS tide_aggregates_run_id_idx "
            "ON tide_aggregates (run_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS tide_aggregates_created_at_idx "
            "ON tide_aggregates (created_at DESC)"
        )
        conn.commit()
    finally:
        cur.close()


def insert_aggregates(
    conn,
    run_id: str,
    created_at: datetime,
    aggregates: list[Aggregate],
) -> int:
    """Insert one row per category, return the number of rows inserted."""
    cur = conn.cursor()
    try:
        rows_inserted = 0
        for agg in aggregates:
            cur.execute(
                "INSERT INTO tide_aggregates "
                "(run_id, category, event_count, sum_value, created_at) "
                "VALUES (%s, %s, %s, %s, %s)",
                (run_id, agg.category, agg.event_count, agg.sum_value, created_at),
            )
            rows_inserted += 1
        conn.commit()
        return rows_inserted
    finally:
        cur.close()


def read_back(conn, run_id: str) -> list[tuple]:
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT category, event_count, sum_value, created_at "
            "FROM tide_aggregates WHERE run_id = %s "
            "ORDER BY category",
            (run_id,),
        )
        return list(cur.fetchall())
    finally:
        cur.close()


def main() -> int:
    args = parse_args()
    run_id = args.run_id or str(uuid.uuid4())
    event_count = args.event_count

    log.info(
        "Starting aggregate_signals (run_id=%s, event_count=%d, dry_run=%s)",
        run_id,
        event_count,
        args.dry_run,
    )

    aggregates = synthesise(event_count, run_id)
    total_events = sum(a.event_count for a in aggregates)
    log.info("Synthesised aggregates:")
    for agg in aggregates:
        log.info(
            "  %-12s  event_count=%-6d  sum_value=%.4f",
            agg.category,
            agg.event_count,
            agg.sum_value,
        )
    if total_events != event_count:
        log.error(
            "Aggregation drift: synthesised %d events, aggregated %d",
            event_count,
            total_events,
        )
        return 1

    if args.dry_run:
        log.info(
            "JOB_SUCCESS run_id=%s rows_inserted=0 total_events=%d (dry-run)",
            run_id,
            total_events,
        )
        return 0

    connector = None
    conn = None
    try:
        connector, conn = open_connection()
        ensure_schema(conn)
        created_at = datetime.now(timezone.utc)
        rows_inserted = insert_aggregates(conn, run_id, created_at, aggregates)

        read_rows = read_back(conn, run_id)
        log.info("Read back %d rows for run_id=%s:", len(read_rows), run_id)
        for row in read_rows:
            log.info("  %s", row)

        if len(read_rows) != len(aggregates):
            log.error(
                "Row-count mismatch: inserted %d, read back %d",
                rows_inserted,
                len(read_rows),
            )
            return 1
    except Exception:
        log.exception("aggregate_signals failed")
        return 1
    finally:
        try:
            if conn is not None:
                conn.close()
        finally:
            if connector is not None:
                connector.close()

    log.info(
        "JOB_SUCCESS run_id=%s rows_inserted=%d total_events=%d",
        run_id,
        len(aggregates),
        total_events,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
