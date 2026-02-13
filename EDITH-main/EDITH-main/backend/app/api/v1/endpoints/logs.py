from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
from app.db.database import get_db
from app.db import models
from pydantic import BaseModel
from datetime import datetime

router = APIRouter()

class AuditLogSchema(BaseModel):
    id: int
    user_id: Optional[int] = None
    action_type: str
    description: str
    timestamp: datetime
    details: Optional[dict] = None

    class Config:
        from_attributes = True

@router.get("/", response_model=List[AuditLogSchema])
def get_logs(skip: int = 0, limit: int = 20, db: Session = Depends(get_db)):
    logs = db.query(models.AuditLog).order_by(models.AuditLog.timestamp.desc()).offset(skip).limit(limit).all()
    return logs

@router.get("/{log_id}", response_model=AuditLogSchema)
def get_log_detail(log_id: int, db: Session = Depends(get_db)):
    log = db.query(models.AuditLog).filter(models.AuditLog.id == log_id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Log not found")
    return log
