from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import HTMLResponse
from app.services.linkedin_service import linkedin_service

router = APIRouter()

@router.get("/auth")
async def linkedin_auth():
    """Initiate LinkedIn OAuth flow"""
    auth_url = linkedin_service.get_authorization_url()
    return {
        "auth_url": auth_url,
        "message": "Please visit this URL to authorize EDITH to post on your behalf"
    }

@router.get("/callback")
async def linkedin_callback(code: str = Query(None), state: str = Query(None), error: str = Query(None)):
    """Handle LinkedIn OAuth callback"""
    
    # Handle authorization denial
    if error:
        return HTMLResponse(f"""
        <html>
            <head><title>LinkedIn Authorization Failed</title></head>
            <body style="font-family: Arial; padding: 50px; text-align: center;">
                <h1>❌ Authorization Failed</h1>
                <p>You denied EDITH access to LinkedIn.</p>
                <p>Error: {error}</p>
                <button onclick="window.close()">Close Window</button>
            </body>
        </html>
        """)
    
    if not code:
        raise HTTPException(status_code=400, detail="Authorization code not provided")
    
    result = await linkedin_service.exchange_code_for_token(code)
    
    if result.get("success"):
        return HTMLResponse(f"""
        <html>
            <head><title>LinkedIn Connected!</title></head>
            <body style="font-family: Arial; padding: 50px; text-align: center;">
                <h1>✅ Successfully Connected to LinkedIn!</h1>
                <p>EDITH can now post on your behalf.</p>
                <p>You can close this window and return to the chat.</p>
                <button onclick="window.close()" style="padding: 10px 20px; font-size: 16px; cursor: pointer;">Close Window</button>
            </body>
        </html>
        """)
    else:
        return HTMLResponse(f"""
        <html>
            <head><title>LinkedIn Connection Failed</title></head>
            <body style="font-family: Arial; padding: 50px; text-align: center;">
                <h1>❌ Connection Failed</h1>
                <p>{result.get('error')}</p>
                <button onclick="window.close()">Close Window</button>
            </body>
        </html>
        """)

@router.get("/status")
async def linkedin_status():
    """Check LinkedIn authentication status"""
    is_auth = linkedin_service.is_authenticated()
    return {
        "authenticated": is_auth,
        "user_id": linkedin_service.user_id if is_auth else None
    }
