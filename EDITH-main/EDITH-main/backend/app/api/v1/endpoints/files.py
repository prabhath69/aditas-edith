from fastapi import APIRouter, UploadFile, File, HTTPException
import shutil
import os

router = APIRouter()

# Define the storage location
UPLOAD_DIR = os.path.join(os.getcwd(), "agent_files")
os.makedirs(UPLOAD_DIR, exist_ok=True)

@router.post("/upload/")
async def upload_file(file: UploadFile = File(...)):
    try:
        # Create the file path
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        
        # Save the file
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        return {
            "filename": file.filename,
            "message": f"File '{file.filename}' uploaded successfully.",
            "path": file_path
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
