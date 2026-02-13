import os
import httpx
import json
from typing import List, Dict
from app.core.config import settings

class PlannerService:
    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY") or settings.GROQ_API_KEY
        self.base_url = "https://api.groq.com/openai/v1/chat/completions"
        self.model_id = "llama-3.3-70b-versatile"  # Free Groq model (replaces decommissioned llama3-8b-8192)
        
        self.system_prompt = (
            "You are the Strategic Planner for EDITH. "
            "Break down user requests into discrete, PRECISE steps. "
            "You have access to the following tools:\n"
            "- google_search(query): Search the web for real-time info.\n"
            "- browse_url(url): Read website content for analysis.\n"
            "- write_file(filename, content): Save data locally.\n"
            "- analyze_data(filename, query): Analyze CSV/Excel files using Pandas.\n"
            "- read_pdf(filename): Extract text from PDF files.\n"
            "- draft_email(recipient, subject, body): Draft email and show preview for approval.\n"
            "- confirm_send_email(confirmed): Send the drafted email after user confirms.\n"
            "- schedule_task(task_description, interval_seconds): Schedule a recurring task.\n"
            "- list_scheduled_tasks(): Show all active scheduled jobs.\n"
            "- read_email(limit): Fetch unread emails from inbox.\n"
            "\n"
            "**BROWSER AUTOMATION TOOLS (for forms, navigation, menus, and full web interaction):**\n"
            "- open_browser(url): Opens a browser. ALWAYS first!\n"
            "- get_page_elements(): Discovers form fields, buttons, links, nav menus, dropdowns, tabs.\n"
            "- fill_input(selector, value): Fills a text field.\n"
            "- click_element(selector): Clicks any element. Accepts CSS selector OR plain text.\n"
            "- hover_element(selector): Hovers to reveal hidden dropdowns. Accepts plain text like 'Research'.\n"
            "- select_option(selector, option_text): Selects a dropdown option.\n"
            "- wait_for_element(selector, timeout): Waits for a dynamic element to appear.\n"
            "- navigate_to(url): Goes to a new URL in the same session.\n"
            "- scroll_page(direction): Scrolls 'up', 'down', 'top', 'bottom'.\n"
            "- take_page_screenshot(): Takes a screenshot.\n"
            "- submit_form(): Submits the form.\n"
            "- close_browser(): Closes browser.\n"
            "\n"
            "**⚠️ CRITICAL PRECISION RULES:**\n"
            "1. Extract the EXACT element names from the user's request and use them as selectors.\n"
            "   - User says 'click on Research' → plan step: hover_element(selector=\"Research\")\n"
            "   - User says 'go to Overview' → plan step: click_element(selector=\"Overview\")\n"
            "2. For navigation menus with dropdowns: ALWAYS plan hover FIRST, then click sub-item.\n"
            "3. NEVER substitute or guess different element names! Use the user's words EXACTLY.\n"
            "4. For multi-step navigation like 'click Research then Overview':\n"
            "   Step 1: open_browser(url)\n"
            "   Step 2: get_page_elements() to discover elements\n"
            "   Step 3: hover_element(selector=\"Research\") to reveal dropdown\n"
            "   Step 4: click_element(selector=\"Overview\") to click sub-item\n"
            "   Step 5: close_browser()\n"
            "\n"
            "**AUTOMATION RULES:**\n"
            "If the user wants to schedule/automate something, use 'schedule_task'.\n"
            "Calculate interval in seconds (1 hour = 3600).\n"
            "\n"
            "You MUST output ONLY a valid JSON object:\n"
            "{\n"
            "  \"reasoning\": \"Explain why you chose these steps.\",\n"
            "  \"steps\": [\"Step 1...\", \"Step 2...\"]\n"
            "}"
        )

    async def generate_plan(self, user_input: str) -> Dict:
        """
        Generates a step-by-step plan for a complex task.
        """
        try:
            async with httpx.AsyncClient() as client:
                payload = {
                    "model": self.model_id,
                    "messages": [
                        {"role": "system", "content": self.system_prompt},
                        {"role": "user", "content": f"User Request: \"{user_input}\""}
                    ],
                    "temperature": 0.0,
                }
                headers = {
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                }
                
                response = await client.post(self.base_url, json=payload, headers=headers)
                if response.status_code != 200:
                    raise Exception(f"Planner API Error: {response.text}")
                
                data = response.json()
                content = data["choices"][0]["message"]["content"]
                
                # Clean markdown if present
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0].strip()
                elif "```" in content:
                    content = content.split("```")[1].split("```")[0].strip()
                
                return json.loads(content)
        except Exception as e:
            print(f"Planning Error: {e}")
            return {
                "reasoning": "Defaulting to direct execution due to planning error.",
                "steps": [user_input]
            }

planner_service = PlannerService()
