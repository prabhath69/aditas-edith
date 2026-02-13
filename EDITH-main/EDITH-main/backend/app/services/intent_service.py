import os
import httpx
import json
from typing import Dict
from app.core.config import settings

class IntentDetector:
    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY") or settings.GROQ_API_KEY
        self.base_url = "https://api.groq.com/openai/v1/chat/completions"
        self.model_id = "llama3-8b-8192"  # Free Groq model
        
        self.system_prompt = (
            "You are the Intent Classifier for EDITH, an advanced AI Agent. "
            "Analyze the User Input and classify it into one of these categories:\n"
            "1. CHAT: Greetings, general conversation, or simple questions that DON'T require external data or actions.\n"
            "2. TASK: Requests requiring tools like:\n"
            "   - 'google_search' (real-time info)\n"
            "   - 'browse_url' (reading websites)\n"
            "   - 'write_file' (saving data)\n"
            "   - 'open_browser', 'fill_input', 'click_element', 'hover_element', 'navigate_to', 'scroll_page', 'submit_form' (BROWSER AUTOMATION - filling forms, clicking buttons, hovering menus, navigating pages, web interactions)\n"
            "   - Any request involving URLs, forms, websites, or web automation\n"
            "3. HYBRID: A mix of both (e.g., 'Hello, can you find the price of Bitcoin and save it?').\n"
            "\n"
            "IMPORTANT: If the user asks to fill a form, go to a URL, click something, submit something, "
            "apply to a job, or interact with a website in any way - that is ALWAYS a TASK!\n"
            "\n"
            "You MUST output ONLY a valid JSON object: "
            "{\"intent\": \"CHAT\" | \"TASK\" | \"HYBRID\", \"reason\": \"...\"}"
        )

    async def detect(self, user_input: str) -> Dict:
        """
        Classifies the user intent using Groq.
        """
        try:
            async with httpx.AsyncClient() as client:
                payload = {
                    "model": self.model_id,
                    "messages": [
                        {"role": "system", "content": self.system_prompt},
                        {"role": "user", "content": f"User Input: \"{user_input}\""}
                    ],
                    "temperature": 0.0,
                    # Note: Not all models support json_mode, but we provide the prompt instruction.
                }
                headers = {
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                }
                
                response = await client.post(self.base_url, json=payload, headers=headers)
                if response.status_code != 200:
                    print(f"DEBUG Intent Error: {response.text}")
                    raise Exception(f"Groq API Error: {response.text}")
                
                data = response.json()
                content = data["choices"][0]["message"]["content"]
                # Clean markdown if model is chatty
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0].strip()
                elif "```" in content:
                    content = content.split("```")[1].split("```")[0].strip()
                
                return json.loads(content)
        except Exception as e:
            print(f"Intent Detection Error: {e}")
            # Fallback to CHAT to be safe
            return {"intent": "CHAT", "reason": "System fallback due to detection error."}

intent_detector = IntentDetector()
