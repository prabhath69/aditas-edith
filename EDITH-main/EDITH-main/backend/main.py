import logging
import sys
import os
import asyncio

# ─── WINDOWS EVENT LOOP FIX ─────────────────────────────────────────────────
# nodriver uses subprocess to launch Chrome. On Windows, only ProactorEventLoop
# supports subprocesses. This MUST be set before any async imports.
# NOTE: uvicorn with reload=True spawns a child process that resets the loop,
#       so we also enforce it via a loop_factory below.
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
# ─────────────────────────────────────────────────────────────────────────────

# Add the current directory to sys.path to allow imports from 'app'
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.v1.endpoints import auth, chat, logs, files, settings, sessions, scheduler, linkedin
from app.db import models
from app.db.database import engine

# Create DB tables on startup
models.Base.metadata.create_all(bind=engine)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="EDITH API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1/auth", tags=["Auth"])
app.include_router(chat.router, prefix="/api/v1/chat", tags=["Chat"])
app.include_router(logs.router, prefix="/api/v1/logs", tags=["Logs"])
app.include_router(files.router, prefix="/api/v1/files", tags=["Files"])
app.include_router(settings.router, prefix="/api/v1/settings", tags=["Settings"])
app.include_router(sessions.router, prefix="/api/v1/sessions", tags=["Sessions"])
app.include_router(scheduler.router, prefix="/api/v1/scheduler", tags=["Scheduler"])
app.include_router(linkedin.router, prefix="/api/v1/linkedin", tags=["LinkedIn"])

@app.get("/")
async def root():
    return {"message": "Welcome to EDITH"}

if __name__ == "__main__":
    import uvicorn

    if sys.platform == 'win32':
        # Re-apply ProactorEventLoop policy — uvicorn reload mode may reset it
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        # Create and set a fresh ProactorEventLoop explicitly
        loop = asyncio.ProactorEventLoop()
        asyncio.set_event_loop(loop)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,        # reload=True spawns subprocess that loses ProactorLoop
        loop="asyncio",      # Tell uvicorn to use asyncio (respects our policy)
        log_level="info",
    )

