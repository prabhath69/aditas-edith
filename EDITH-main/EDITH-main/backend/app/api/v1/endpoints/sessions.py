from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.db import models
from app.db.database import get_db
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

router = APIRouter()

class MessageCreate(BaseModel):
    role: str
    content: str

class ChatSessionResponse(BaseModel):
    id: int
    title: Optional[str]
    created_at: datetime
    updated_at: datetime

class ChatMessageResponse(BaseModel):
    id: int
    role: str
    content: str
    timestamp: datetime

@router.get("/", response_model=List[ChatSessionResponse])
def list_sessions(db: Session = Depends(get_db)):
    """List all chat sessions, newest first."""
    sessions = db.query(models.ChatSession).order_by(models.ChatSession.updated_at.desc()).limit(20).all()
    return sessions

@router.post("/", response_model=ChatSessionResponse)
def create_session(title: Optional[str] = None, db: Session = Depends(get_db)):
    """Create a new chat session."""
    session = models.ChatSession(title=title or "New Chat")
    db.add(session)
    db.commit()
    db.refresh(session)
    return session

@router.get("/{session_id}/messages", response_model=List[ChatMessageResponse])
def get_messages(session_id: int, db: Session = Depends(get_db)):
    """Get all messages for a session."""
    messages = db.query(models.ChatMessage).filter(
        models.ChatMessage.session_id == session_id
    ).order_by(models.ChatMessage.timestamp).all()
    return messages

@router.post("/{session_id}/messages")
def add_message(session_id: int, message: MessageCreate, db: Session = Depends(get_db)):
    """Add a message to a session."""
    db_message = models.ChatMessage(
        session_id=session_id,
        role=message.role,
        content=message.content
    )
    db.add(db_message)
    
    # Update session timestamp and auto-generate title from first user message
    session = db.query(models.ChatSession).filter(models.ChatSession.id == session_id).first()
    if session:
        if message.role == "user" and (not session.title or session.title == "New Chat"):
            # Use first 40 chars of first user message as title
            session.title = message.content[:40] + ("..." if len(message.content) > 40 else "")
        session.updated_at = datetime.now()
    
    db.commit()
    db.refresh(db_message)
    return db_message
