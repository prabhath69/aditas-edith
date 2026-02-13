from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from app.services.scheduler_service import SchedulerService

router = APIRouter()
scheduler_service = SchedulerService()

class JobCreate(BaseModel):
    task: str
    interval_seconds: int

class JobResponse(BaseModel):
    id: str
    name: str
    next_run: Optional[str]

@router.get("/", response_model=List[JobResponse])
def list_jobs():
    """List all active scheduled jobs."""
    return scheduler_service.list_jobs()

@router.post("/", response_model=dict)
def create_job(job: JobCreate):
    """Schedule a new recurring task."""
    job_id = scheduler_service.add_job(
        task_description=job.task,
        trigger_type="interval",
        trigger_value=str(job.interval_seconds)
    )
    if not job_id:
        raise HTTPException(status_code=400, detail="Failed to schedule job")
    return {"id": job_id, "message": "Task scheduled successfully"}

@router.delete("/{job_id}")
def delete_job(job_id: str):
    """Cancel a scheduled task."""
    success = scheduler_service.remove_job(job_id)
    if not success:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"message": "Job removed"}
