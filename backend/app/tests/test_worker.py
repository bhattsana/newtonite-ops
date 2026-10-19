from sqlalchemy import func, select

from app.models import Notification, OutboxJob
from app.tests.conftest import TestSession
from app.worker.main import notify, run_once


def test_worker_completes_outbox_job_and_notification_is_idempotent():
    with TestSession.begin() as db:
        job = OutboxJob(
            event_type="ITEM_CREATED",
            payload={"itemId": 987654321, "reference": "OPS-WORKER-TEST"},
        )
        db.add(job)
        db.flush()
        job_id = job.id

    for _ in range(100):
        with TestSession() as db:
            job = db.get(OutboxJob, job_id)
            if job.status == "DONE":
                break
        assert run_once(), "Worker found no pending job before the test job was handled."
    else:
        raise AssertionError("Worker did not complete the test outbox job.")

    with TestSession() as db:
        completed = db.get(OutboxJob, job_id)
        assert completed.status == "DONE"
        assert completed.attempts == 1
        assert db.scalar(
            select(func.count()).select_from(Notification).where(Notification.job_id == job_id)
        ) == 1
        notification_job = db.get(OutboxJob, job_id)
        notify(notification_job)
        notify(notification_job)
        assert db.scalar(
            select(func.count()).select_from(Notification).where(Notification.job_id == job_id)
        ) == 1
