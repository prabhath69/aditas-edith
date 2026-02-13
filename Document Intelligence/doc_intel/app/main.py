from fastapi import FastAPI, HTTPException, Depends, Header, Request
from starlette.requests import Request as StarletteRequest
from pydantic import BaseModel
from embeddings import get_embeddings
from retrieval import process_and_answer
import logging
import warnings
import json
import time
import os
from datetime import datetime

# Suppress various library warnings
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ["GRPC_VERBOSITY"] = "ERROR"
os.environ["GLOG_minloglevel"] = "2"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

# Create logs directory
os.makedirs("logs", exist_ok=True)

logging.basicConfig(level=logging.INFO, filename="logs/usage.log", format="%(asctime)s - %(message)s")

# JSON request logger
json_logger = logging.getLogger("json_requests")
json_logger.setLevel(logging.INFO)
json_handler = logging.FileHandler("logs/requests.json", mode='a')
json_handler.setFormatter(logging.Formatter('%(message)s'))
json_logger.addHandler(json_handler)

app = FastAPI(title="LLM-Powered Query-Retrieval System")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    
    # Capture request data
    body = await request.body()
    try:
        body_text = body.decode() if body else None
    except UnicodeDecodeError:
        body_text = "<binary data>"
    
    request_data = {
        "timestamp": datetime.utcnow().isoformat(),
        "method": request.method,
        "url": str(request.url),
        "headers": dict(request.headers),
        "body": body_text,
        "client_ip": request.client.host
    }
    
    # Create a new request with the consumed body so it can be read again
    async def receive():
        return {"type": "http.request", "body": body}
    
    request = Request(request.scope, receive)
    
    # Process request
    response = await call_next(request)
    
    # Add response data
    request_data.update({
        "status_code": response.status_code,
        "response_time_ms": round((time.time() - start_time) * 1000, 2)
    })
    
    # Log as JSON
    json_logger.info(json.dumps(request_data))
    
    return response


@app.on_event("startup")
def warmup():
    get_embeddings(("warmup",))  # Load model

VALID_TOKEN = "6474bf54ce9dc3d156827448363ba8f461b0366cb1e1d8e41aae7e6157a30ce0"

def verify_token(authorization: str = Header()):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ")[1]
    if token != VALID_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token

class QueryRequest(BaseModel):
    documents: str
    questions: list[str]

@app.post("/api/v1/hackrx/run")
def run_query(req: QueryRequest, token: str = Depends(verify_token)):
    try:
        answers = process_and_answer(None, req.questions, req.documents)
        return {"answers": answers}
    except Exception as e:
        logging.error(f"Failed to process request: {e}")
        return {"answers": ["The document is not supported"] * len(req.questions)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

