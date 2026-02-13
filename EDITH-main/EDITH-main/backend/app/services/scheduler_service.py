from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from datetime import datetime
import logging
import asyncio
from app.db.database import SQLALCHEMY_DATABASE_URL

# Setup Logging
logger = logging.getLogger(__name__)

# Job Store Configuration (Persist to SQLite)
# We need to parse the URL correctly or just pass the url string if compatible
jobstores = {
    'default': SQLAlchemyJobStore(url=SQLALCHEMY_DATABASE_URL)
}

class SchedulerService:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SchedulerService, cls).__new__(cls)
            cls._instance.scheduler = BackgroundScheduler(jobstores=jobstores)
            cls._instance.scheduler.start()
        return cls._instance

    def add_job(self, task_description: str, trigger_type: str, trigger_value: str):
        """
        Adds a job to the scheduler.
        task_description: The text description of the task (e.g., "Check emails")
        trigger_type: 'interval', 'cron', or 'date'
        trigger_value: The value for the trigger (e.g., '60' seconds, '0 8 * * *' cron string)
        """
        try:
            trigger = None
            if trigger_type == 'interval':
                # format: "60" (seconds) or "30m" (minutes - to be parsed)
                # Simple version: assume seconds if int
                try:
                    seconds = int(trigger_value)
                    trigger = IntervalTrigger(seconds=seconds)
                except ValueError:
                    logger.error(f"Invalid interval value: {trigger_value}")
                    return None
            elif trigger_type == 'date':
                # format: ISO string
                run_date = datetime.fromisoformat(trigger_value)
                trigger = DateTrigger(run_date=run_date)
            # Add cron later if needed

            if trigger:
                job = self.scheduler.add_job(
                    execute_scheduled_task,
                    trigger=trigger,
                    args=[task_description],
                    name=task_description,
                    replace_existing=False
                )
                return job.id
        except Exception as e:
            logger.error(f"Failed to schedule job: {e}")
            return None

    def remove_job(self, job_id: str):
        try:
            self.scheduler.remove_job(job_id)
            return True
        except Exception as e:
            logger.error(f"Failed to remove job: {e}")
            return False

    def list_jobs(self):
        jobs = []
        for job in self.scheduler.get_jobs():
           jobs.append({
               "id": job.id,
               "name": job.name,
               "next_run": job.next_run_time.isoformat() if job.next_run_time else None
           })
        return jobs

# The function that actually runs
def execute_scheduled_task(task_description: str):
    """
    Triggers the agent to perform the task and logs the result to the chat.
    """
    logger.info(f"⏰ EXECUTING SCHEDULED TASK: {task_description}")
    
    try:
        from app.db.database import SessionLocal
        from app.db import models
        from app.services.llm_service import llm_service
        from app.services.mcp_service import mcp_service
        import asyncio

        # 1. Run the Agent Logic (Sync wrapper for MVP)
        # For MVP, we need a way to run the async agent logic synchronously here, 
        # or offload to detailed async worker.
        # We will use a simplified direct tool call if possible, or limited agent loop.
        
        async def run_agent_task():
            # Create a localized log entry
            db = SessionLocal()
            try:
                # Find the latest active session or creating a "System" session
                # For simplicity, we just look for the most recent session
                last_session = db.query(models.ChatSession).order_by(models.ChatSession.updated_at.desc()).first()
                session_id = last_session.id if last_session else None
                
                if not session_id:
                    logger.warning("No active chat session found for notification.")
                    return

                # Inject a "System Trigger" message (virtual)
                # Then ask LLM to solve it.
                
                # Simplified: Just check if it's "Read Email" and call tool directly
                # In full version: We would re-instantiate the Chat Flow.
                
                result_text = ""
                if "check" in task_description.lower() and "email" in task_description.lower():
                    result_text = mcp_service._read_email(limit=5)
                else:
                    # Generic: Ask LLM (this is tricky in sync context without full loop)
                    # For now, placeholder or direct tool map
                    result_text = f"Scheduled Task '{task_description}' executed. (Generic placeholder)"

                # Save Result to Chat History
                new_msg = models.ChatMessage(
                    session_id=session_id,
                    role="model",
                    content=f"🔔 **Automated Report:**\n\n{result_text}"
                )
                db.add(new_msg)
                db.commit()
                print(f"Notification saved to session {session_id}")
                
            except Exception as e:
                logger.error(f"Task Execution Error: {e}")
            finally:
                db.close()

        # Run async logic
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(run_agent_task())
        loop.close()

    except Exception as e:
        logger.error(f"Scheduler Fatal Error: {e}")
