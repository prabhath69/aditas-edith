import os
import httpx
import json
from typing import Dict
from app.core.config import settings

class IntentDetector:
    def __init__(self):
        self.openai_key = os.getenv("OPENAI_API_KEY")
        self.groq_key = os.getenv("GROQ_API_KEY") or getattr(settings, 'GROQ_API_KEY', None)
        
        # Provider chain: OpenAI first, then Groq
        self.providers = []
        if self.openai_key:
            self.providers.append({
                "name": "OpenAI",
                "url": "https://api.openai.com/v1/chat/completions",
                "model": "gpt-5-nano",
                "key": self.openai_key
            })
        if self.groq_key:
            self.providers.append({
                "name": "Groq",
                "url": "https://api.groq.com/openai/v1/chat/completions",
                "model": "llama-3.3-70b-versatile",
                "key": self.groq_key
            })
        
        self.system_prompt = (
            "You are the Intent Classifier for EDITH, an advanced AI Agent. "
            "Analyze the User Input and classify it into one of these categories:\n"
            "1. CHAT: Greetings, general conversation, or simple questions that DON'T require external data or actions.\n"
            "2. TASK: Requests requiring tools like:\n"
            "   - 'google_search' (real-time info)\n"
            "   - 'browse_url' (reading websites)\n"
            "   - 'write_file' (saving data)\n"
            "   - 'open_browser', 'take_snapshot', 'click', 'hover', 'fill', 'navigate_page', 'scroll_page', 'submit_form' (BROWSER AUTOMATION - filling forms, clicking buttons, hovering menus, navigating pages, web interactions)\n"
            "   - Any request involving URLs, forms, websites, or web automation\n"
            "3. HYBRID: A mix of both (e.g., 'Hello, can you find the price of Bitcoin and save it?').\n"
            "\n"
            "IMPORTANT: If the user asks to fill a form, go to a URL, click something, submit something, "
            "apply to a job, order something, shop online, or interact with a website in any way - that is ALWAYS a TASK!\n"
            "\n"
            "You MUST output ONLY a valid JSON object: "
            "{\"intent\": \"CHAT\" | \"TASK\" | \"HYBRID\", \"reason\": \"...\"}"
        )

    async def detect(self, user_input: str) -> Dict:
        """
        Classifies the user intent. Tries OpenAI first, then Groq as fallback.
        """
        for provider in self.providers:
            try:
                async with httpx.AsyncClient() as client:
                    payload = {
                        "model": provider["model"],
                        "messages": [
                            {"role": "system", "content": self.system_prompt},
                            {"role": "user", "content": f"User Input: \"{user_input}\""}
                        ],
                        "temperature": 0.0,
                    }
                    headers = {
                        "Authorization": f"Bearer {provider['key']}",
                        "Content-Type": "application/json"
                    }
                    
                    print(f"[Intent] Trying {provider['name']}...")
                    response = await client.post(provider["url"], json=payload, headers=headers, timeout=30.0)
                    
                    if response.status_code != 200:
                        print(f"[Intent] ✗ {provider['name']} failed: {response.status_code}")
                        continue  # Try next provider
                    
                    data = response.json()
                    content = data["choices"][0]["message"]["content"]
                    # Clean markdown if model is chatty
                    if "```json" in content:
                        content = content.split("```json")[1].split("```")[0].strip()
                    elif "```" in content:
                        content = content.split("```")[1].split("```")[0].strip()
                    
                    result = json.loads(content)
                    print(f"[Intent] ✓ {provider['name']}: {result.get('intent', 'UNKNOWN')}")
                    return result
            except Exception as e:
                print(f"[Intent] ✗ {provider['name']} error: {e}")
                continue
        
        # All providers failed — fallback to TASK (safer for browser automation)
        print("[Intent] All providers failed, defaulting to TASK")
        return {"intent": "TASK", "reason": "All providers failed — defaulting to TASK for safety."}

intent_detector = IntentDetector()
