from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db import models
from app.db.database import get_db
from pydantic import BaseModel
from typing import List, Optional

router = APIRouter()

class SettingUpdate(BaseModel):
    key: str
    value: str
    description: Optional[str] = None

class SettingResponse(BaseModel):
    key: str
    value: str # In a real app, you might want to mask this
    description: Optional[str]

@router.get("/", response_model=List[SettingResponse])
def get_settings(db: Session = Depends(get_db)):
    return db.query(models.SystemSetting).all()

@router.post("/", response_model=SettingResponse)
def update_setting(setting: SettingUpdate, db: Session = Depends(get_db)):
    db_setting = db.query(models.SystemSetting).filter(models.SystemSetting.key == setting.key).first()
    if db_setting:
        db_setting.value = setting.value
        if setting.description:
            db_setting.description = setting.description
    else:
        db_setting = models.SystemSetting(
            key=setting.key, 
            value=setting.value, 
            description=setting.description
        )
        db.add(db_setting)
    
    db.commit()
    db.refresh(db_setting)
    return db_setting
