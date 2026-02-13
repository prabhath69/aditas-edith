import os
import httpx
import json
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta
from app.db.database import SessionLocal
from app.db.models import SystemSetting

class LinkedInService:
    def __init__(self):
        # Try to get credentials from database first, fallback to env
        self.client_id = self._get_setting("LINKEDIN_CLIENT_ID") or os.getenv("LINKEDIN_CLIENT_ID")
        self.client_secret = self._get_setting("LINKEDIN_CLIENT_SECRET") or os.getenv("LINKEDIN_CLIENT_SECRET")
        self.redirect_uri = self._get_setting("LINKEDIN_REDIRECT_URI") or os.getenv("LINKEDIN_REDIRECT_URI", "http://localhost:8000/api/v1/linkedin/callback")
        
        # OAuth endpoints
        self.auth_url = "https://www.linkedin.com/oauth/v2/authorization"
        self.token_url = "https://www.linkedin.com/oauth/v2/accessToken"
        
        # API endpoints (LinkedIn API v2)
        self.api_base = "https://api.linkedin.com/rest"
        self.images_url = f"{self.api_base}/images?action=initializeUpload"
        self.posts_url = f"{self.api_base}/posts"
        
        # Load token from database if available
        self.access_token = self._get_setting("LINKEDIN_ACCESS_TOKEN")
        token_expiry_str = self._get_setting("LINKEDIN_TOKEN_EXPIRY")
        self.token_expiry = datetime.fromisoformat(token_expiry_str) if token_expiry_str else None
        self.user_id = self._get_setting("LINKEDIN_USER_ID")

    def get_authorization_url(self, state: str = "random_state") -> str:
        """Generate OAuth authorization URL for user to authenticate"""
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "state": state,
            "scope": "openid profile w_member_social"
        }
        
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        return f"{self.auth_url}?{query_string}"

    async def exchange_code_for_token(self, code: str) -> Dict[str, Any]:
        """Exchange authorization code for access token"""
        async with httpx.AsyncClient() as client:
            data = {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "client_id": self.client_id,
                "client_secret": self.client_secret
            }
            
            response = await client.post(
                self.token_url,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"}
            )
            
            if response.status_code == 200:
                token_data = response.json()
                self.access_token = token_data.get("access_token")
                expires_in = token_data.get("expires_in", 5184000)  # Default 60 days
                self.token_expiry = datetime.now() + timedelta(seconds=expires_in)
                
                # Get user profile to obtain user ID
                await self._get_user_profile()
                
                # Save tokens to database for persistence
                self._save_setting("LINKEDIN_ACCESS_TOKEN", self.access_token)
                self._save_setting("LINKEDIN_TOKEN_EXPIRY", self.token_expiry.isoformat())
                self._save_setting("LINKEDIN_USER_ID", self.user_id)
                
                return {
                    "success": True,
                    "access_token": self.access_token,
                    "expires_in": expires_in
                }
            else:
                return {
                    "success": False,
                    "error": f"Token exchange failed: {response.text}"
                }

    async def _get_user_profile(self) -> Optional[str]:
        """Get user profile to obtain user ID (sub)"""
        async with httpx.AsyncClient() as client:
            headers = {
                "Authorization": f"Bearer {self.access_token}",
                "LinkedIn-Version": "202411",
                "X-Restli-Protocol-Version": "2.0.0"
            }
            
            response = await client.get(
                "https://api.linkedin.com/v2/userinfo",
                headers=headers
            )
            
            if response.status_code == 200:
                profile = response.json()
                self.user_id = profile.get("sub")
                return self.user_id
            return None

    def is_authenticated(self) -> bool:
        """Check if user is authenticated and token is valid"""
        if not self.access_token or not self.token_expiry:
            return False
        return datetime.now() < self.token_expiry

    async def upload_image(self, image_path: str) -> Optional[str]:
        """Upload image to LinkedIn and return image URN"""
        try:
            async with httpx.AsyncClient() as client:
                # Step 1: Initialize upload
                headers = {
                    "Authorization": f"Bearer {self.access_token}",
                    "LinkedIn-Version": "202411",
                    "X-Restli-Protocol-Version": "2.0.0",
                    "Content-Type": "application/json"
                }
                
                init_payload = {
                    "initializeUploadRequest": {
                        "owner": f"urn:li:person:{self.user_id}"
                    }
                }
                
                init_response = await client.post(
                    self.images_url,
                    headers=headers,
                    json=init_payload
                )
                
                if init_response.status_code != 200:
                    print(f"Image init failed: {init_response.text}")
                    return None
                
                init_data = init_response.json()
                upload_url = init_data["value"]["uploadUrl"]
                image_urn = init_data["value"]["image"]
                
                # Step 2: Upload binary data
                with open(image_path, "rb") as f:
                    image_data = f.read()
                
                upload_response = await client.put(
                    upload_url,
                    content=image_data,
                    headers={"Content-Type": "application/octet-stream"}
                )
                
                if upload_response.status_code in [200, 201]:
                    return image_urn
                else:
                    print(f"Image upload failed: {upload_response.text}")
                    return None
                    
        except Exception as e:
            print(f"Image upload error: {str(e)}")
            return None

    async def create_post(self, text: str, image_urns: List[str] = None) -> Dict[str, Any]:
        """Create a LinkedIn post with optional images"""
        try:
            async with httpx.AsyncClient() as client:
                headers = {
                    "Authorization": f"Bearer {self.access_token}",
                    "LinkedIn-Version": "202411",
                    "X-Restli-Protocol-Version": "2.0.0",
                    "Content-Type": "application/json"
                }
                
                # Build post payload
                post_payload = {
                    "author": f"urn:li:person:{self.user_id}",
                    "commentary": text,
                    "visibility": "PUBLIC",
                    "distribution": {
                        "feedDistribution": "MAIN_FEED",
                        "targetEntities": [],
                        "thirdPartyDistributionChannels": []
                    },
                    "lifecycleState": "PUBLISHED",
                    "isReshareDisabledByAuthor": False
                }
                
                # Add images if provided
                if image_urns:
                    post_payload["content"] = {
                        "media": {
                            "title": "Image Post",
                            "id": image_urns[0] if len(image_urns) == 1 else None
                        }
                    }
                    
                    if len(image_urns) > 1:
                        post_payload["content"]["multiImage"] = {
                            "images": [{"id": urn} for urn in image_urns]
                        }
                
                response = await client.post(
                    self.posts_url,
                    headers=headers,
                    json=post_payload
                )
                
                if response.status_code in [200, 201]:
                    post_id = response.headers.get("x-restli-id", "unknown")
                    post_url = f"https://www.linkedin.com/feed/update/{post_id}/"
                    return {
                        "success": True,
                        "post_id": post_id,
                        "post_url": post_url,
                        "message": "Post created successfully!"
                    }
                else:
                    return {
                        "success": False,
                        "error": f"Post creation failed: {response.text}"
                    }
                    
        except Exception as e:
            return {
                "success": False,
                "error": f"Post creation error: {str(e)}"
            }

    def _get_setting(self, key: str) -> Optional[str]:
        """Get setting value from database"""
        try:
            db = SessionLocal()
            setting = db.query(SystemSetting).filter(SystemSetting.key == key).first()
            db.close()
            return setting.value if setting else None
        except:
            return None

    def _save_setting(self, key: str, value: str):
        """Save setting value to database"""
        try:
            db = SessionLocal()
            setting = db.query(SystemSetting).filter(SystemSetting.key == key).first()
            if setting:
                setting.value = value
            else:
                setting = SystemSetting(key=key, value=value)
                db.add(setting)
            db.commit()
            db.close()
        except Exception as e:
            print(f"Error saving setting: {e}")

linkedin_service = LinkedInService()
