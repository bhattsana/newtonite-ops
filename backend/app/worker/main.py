import logging
import re
import signal
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert

from app.database import SessionLocal
from app.models import Notification, OutboxJob

logger = logging.getLogger("newtonite.worker")
MAX_ATTEMPTS = 5
LEASE_SECONDS = 60
MAX_BACKOFF_SECONDS = 300
stopping = False


class PermanentJobError(Exception):
    pass


def redact_error(error: Exception) -> str:
    message = str(error)
    message = re.sub(r"(\w+://)[^@\s/]+@", r"\1***@", message)
    message = re.sub(
        r"(secret|token|password|passwd|apikey|key)=\S+", r"\1=***", message, flags=re.IGNORECASE
    )
    return message[:200]


def notify(job: OutboxJob) -> None:
    reference = job.payload.get("reference")
    if not isinstance(reference, str):
        raise PermanentJobError("outbox item is missing a reference")
    with SessionLocal.begin() as db:
        db.execute(
            insert(Notification)
            .values(job_id=job.id, message=f"{job.event_type}: {reference}")
            .on_conflict_do_nothing(index_elements=[Notification.job_id])
        )


def run_once(handler: Callable[[OutboxJob], None] = notify) -> bool:
    now = datetime.now(UTC)
    with SessionLocal() as db:
        with db.begin():
            db.execute(
                update(OutboxJob)
                .where(
                    OutboxJob.status == "PROCESSING",
                    OutboxJob.locked_at < now - timedelta(seconds=LEASE_SECONDS),
                    OutboxJob.attempts >= MAX_ATTEMPTS,
                )
                .values(
                    status="FAILED",
                    locked_at=None,
                    last_error="worker lease expired after the maximum number of attempts",
                    updated_at=func.now(),
                )
            )
            job = db.scalar(
                select(OutboxJob)
                .where(
                    or_(
                        (OutboxJob.status == "PENDING") & (OutboxJob.available_at <= now),
                        (OutboxJob.status == "PROCESSING")
                        & (OutboxJob.locked_at < now - timedelta(seconds=LEASE_SECONDS)),
                    )
                )
                .order_by(OutboxJob.id)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if job is None:
                return False
            job.status = "PROCESSING"
            job.locked_at = now
            job.attempts += 1
            db.flush()
            job_id = job.id
    try:
        with SessionLocal() as db:
            job = db.get(OutboxJob, job_id)
            if job is None:
                raise RuntimeError("claimed outbox job disappeared")
            handler(job)
        with SessionLocal.begin() as db:
            db.execute(
                update(OutboxJob)
                .where(OutboxJob.id == job_id)
                .values(
                    status="DONE",
                    processed_at=func.now(),
                    locked_at=None,
                    updated_at=func.now(),
                )
            )
    except Exception as error:
        permanent = isinstance(error, PermanentJobError)
        with SessionLocal.begin() as db:
            job = db.get(OutboxJob, job_id)
            if job is None:
                raise RuntimeError("claimed outbox job disappeared while recording failure") from error
            failed = permanent or job.attempts >= MAX_ATTEMPTS
            wait_seconds = min(2**job.attempts, MAX_BACKOFF_SECONDS)
            job.status = "FAILED" if failed else "PENDING"
            job.last_error = redact_error(error)
            job.locked_at = None
            job.available_at = datetime.now(UTC) + timedelta(seconds=wait_seconds)
            job.updated_at = datetime.now(UTC)
        logger.warning(
            "Outbox job failed",
            extra={
                "job_id": job_id,
                "permanent": permanent,
                "will_retry": not failed,
                "error": redact_error(error),
            },
        )
    return True


def request_shutdown(_signum: int, _frame: object) -> None:
    global stopping
    stopping = True


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    while not stopping:
        if not run_once():
            time.sleep(1)


if __name__ == "__main__":
    main()
