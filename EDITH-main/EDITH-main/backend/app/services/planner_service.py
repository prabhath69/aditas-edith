import os
import httpx
import json
from typing import List, Dict
from app.core.config import settings

class PlannerService:
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
            "You are the Strategic Planner for EDITH, an AI agent with browser automation.\n"
            "Generate GRANULAR, step-by-step plans. Each step = ONE tool call.\n\n"

            "## ABSOLUTE RULES\n"
            "1. NEVER guess URLs. If you don't know the exact URL, plan google_search first.\n"
            "2. NEVER include close_browser in any plan. The browser stays open.\n"
            "3. `open_browser()` ALREADY returns a full snapshot — NEVER plan take_snapshot as the next step after open_browser. The UIDs are already in the open_browser result.\n"
            "4. UIDs are discovered at runtime from take_snapshot. Write steps like "
            "'find the search box uid from snapshot, then type_text into it'.\n"
            "5. Plans MUST be autonomous end-to-end. NEVER plan a step that asks the user.\n"
            "6. After fill/type_text → press_key('Enter') → THEN take_snapshot to see results.\n\n"

            "## BROWSER STEP FORMAT\n"
            "Each browser step must be ONE of:\n"
            "- open_browser(url) — already returns snapshot, do NOT follow with take_snapshot\n"
            "- take_snapshot() — ONLY to observe after an action (click/fill/navigate), NOT right after open_browser\n"
            "- extract_text() — to read page content\n"
            "- click(uid) — uid from latest snapshot\n"
            "- type_text(text, uid) — for search boxes\n"
            "- fill(uid, value) — for form fields\n"
            "- press_key('Enter') — to submit\n"
            "- scroll_page('down') — to see more\n"
            "- hover(uid) — for dropdown menus\n"
            "- Other tools: navigate_page, fill_form, select_option, wait_for, etc.\n\n"

            "## EXAMPLE 1: 'Search YouTube for VS Code tutorial'\n"
            "```json\n"
            '{\n'
            '  "reasoning": "open_browser returns snapshot with UIDs. Find search box UID, type, press Enter, read results.",\n'
            '  "steps": [\n'
            '    "open_browser(\'https://www.youtube.com\') — returns snapshot with all element UIDs",\n'
            '    "type_text(\'VS Code tutorial\', uid) into the search box UID found in the open_browser snapshot",\n'
            '    "press_key(\'Enter\') to submit the search",\n'
            '    "take_snapshot() to observe search results",\n'
            '    "click(first_video_uid) to play the top result",\n'
            '    "Report done to user"\n'
            '  ]\n'
            '}\n'
            "```\n\n"

            "## EXAMPLE 2: 'Fill out a form at some-website.com/apply'\n"
            "```json\n"
            '{\n'
            '  "reasoning": "Need to navigate to the form, take snapshot to discover fields, fill each one, then submit.",\n'
            '  "steps": [\n'
            '    "open_browser(\'https://some-website.com/apply\') to go to the application form",\n'
            '    "take_snapshot() to discover all form fields and their uids",\n'
            '    "fill(uid, value) for each form field found in the snapshot",\n'
            '    "take_snapshot() to verify all fields are filled correctly",\n'
            '    "click(submit_uid) to submit the form",\n'
            '    "take_snapshot() to verify form submission success",\n'
            '    "extract_text() to read the confirmation message"\n'
            '  ]\n'
            '}\n'
            "```\n\n"

            "## EXAMPLE 3: 'Find the price of iPhone 16 online'\n"
            "```json\n"
            '{\n'
            '  "reasoning": "Don\\\'t know exact URL, so use google_search first, then browse the top result.",\n'
            '  "steps": [\n'
            '    "google_search(\'iPhone 16 price India\') to find current pricing",\n'
            '    "Report the price from search results to the user"\n'
            '  ]\n'
            '}\n'
            "```\n\n"

            "## NON-BROWSER TOOLS\n"
            "- google_search(query) — search the web\n"
            "- browse_url(url) — read a webpage\n"
            "- write_file(filename, content) — save data\n"
            "- analyze_data(filename, query) — analyze CSV/Excel\n"
            "- read_pdf(filename) — extract PDF text\n"
            "- draft_email(recipient, subject, body) — draft email\n"
            "- schedule_task(task_description, interval_seconds) — schedule recurring task\n"
            "- read_email(limit) — read inbox\n\n"

            "Output ONLY valid JSON: {\"reasoning\": \"...\", \"steps\": [\"...\"]}\n"
            "NO close_browser. NO guessed URLs. Each step = ONE action."
        )

    async def generate_plan(self, user_input: str) -> Dict:
        """
        Generates a step-by-step plan. Tries OpenAI first, then Groq as fallback.
        """
        for provider in self.providers:
            try:
                async with httpx.AsyncClient() as client:
                    payload = {
                        "model": provider["model"],
                        "messages": [
                            {"role": "system", "content": self.system_prompt},
                            {"role": "user", "content": f"Plan this request: \"{user_input}\""}
                        ],
                        "temperature": 0.0,
                    }
                    # Request JSON output from OpenAI
                    if provider["name"] == "OpenAI":
                        payload["response_format"] = {"type": "json_object"}
                    
                    headers = {
                        "Authorization": f"Bearer {provider['key']}",
                        "Content-Type": "application/json"
                    }

                    print(f"[Planner] Trying {provider['name']}...")
                    response = await client.post(provider["url"], json=payload, headers=headers, timeout=30.0)
                    
                    if response.status_code != 200:
                        print(f"[Planner] ✗ {provider['name']} failed: {response.status_code}")
                        continue  # Try next provider
                    
                    data = response.json()
                    content = data["choices"][0]["message"]["content"]
                    
                    # Clean markdown if present
                    if "```json" in content:
                        content = content.split("```json")[1].split("```")[0].strip()
                    elif "```" in content:
                        content = content.split("```")[1].split("```")[0].strip()
                    
                    result = json.loads(content)
                    
                    # Post-process: Remove any close_browser steps
                    if "steps" in result:
                        result["steps"] = [
                            s for s in result["steps"] 
                            if "close_browser" not in s.lower()
                        ]
                    
                    print(f"[Planner] ✓ {provider['name']}: {len(result.get('steps', []))} steps planned")
                    for i, step in enumerate(result.get('steps', []), 1):
                        print(f"[Planner]   Step {i}: {step[:80]}")
                    return result
            except Exception as e:
                print(f"[Planner] ✗ {provider['name']} error: {e}")
                continue
        
        # All providers failed
        print("[Planner] All providers failed, using direct execution")
        return {
            "reasoning": "Defaulting to direct execution due to planning error.",
            "steps": [user_input]
        }

planner_service = PlannerService()
