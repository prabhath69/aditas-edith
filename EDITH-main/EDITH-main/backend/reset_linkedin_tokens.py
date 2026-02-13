from app.db.database import SessionLocal
from app.db.models import SystemSetting

def reset_linkedin_tokens():
    db = SessionLocal()
    try:
        keys_to_delete = [
            "LINKEDIN_ACCESS_TOKEN",
            "LINKEDIN_TOKEN_EXPIRY",
            "LINKEDIN_USER_ID"
        ]
        
        for key in keys_to_delete:
            setting = db.query(SystemSetting).filter(SystemSetting.key == key).first()
            if setting:
                db.delete(setting)
                print(f"Deleted {key}")
            else:
                print(f"{key} not found")
                
        db.commit()
        print("LinkedIn tokens cleared successfully!")
    except Exception as e:
        print(f"Error executing reset: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    reset_linkedin_tokens()
