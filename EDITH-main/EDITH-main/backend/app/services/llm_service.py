import os
import httpx
import json
import itertools
from typing import List, Dict, Optional, Any
from app.core.config import settings

class LLMService:
    def __init__(self):
        # ---------------------------------------------------------
        # 1. API Keys & Configuration (Supporting Rotation)
        # ---------------------------------------------------------
        
        # Gemini Keys (Multiple support for "Wallet" and quota management)
        self.gemini_keys = [
            os.getenv("GOOGLE_API_KEY"),
        ]
        self.gemini_keys = [k for k in self.gemini_keys if k] # Filter out None
        self.gemini_cycle = itertools.cycle(self.gemini_keys)
        
        # Fallback Providers
        self.groq_key = os.getenv("GROQ_API_KEY") or settings.GROQ_API_KEY
        self.openai_key = os.getenv("OPENAI_API_KEY")
        
        # ---------------------------------------------------------
        # 2. Provider Map (Priority Order)
        # ---------------------------------------------------------
        self.providers = [
            {
                "name": "Gemini",
                "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                "model": "gemini-2.5-flash-lite",
                "active": True
            },
            # {
            #     "name": "Groq",
            #     "base_url": "https://api.groq.com/openai/v1/chat/completions",
            #     "model": "openai/gpt-oss-20b",
            #     "active": False # Set to True to enable Groq fallback
            # },
            {
                "name": "OpenAI",
                "base_url": "https://api.openai.com/v1/chat/completions",
                "model": "gpt-5-nano",
                "active": False # Set to True to enable OpenAI fallback
            }
        ]

        self.system_instruction = (
            "You are EDITH, a General Intelligence Agent designed for elite personal and enterprise assistance. "
            "Your objective is to solve any user request by intelligently orchestrating your available tools.\n\n"
            "### COMMAND CORE:\n"
            "1. **Autonomous Orchestration**: You are not limited to one tool at a time. Chain tools to complete complex tasks (e.g., Search -> Browse -> Format -> Email).\n"
            "2. **Adaptive Tool Choice**: \n"
            "   - Use 'google_search' for broad discovery and finding specific links.\n"
            "   - Use 'browse_url' (Playwright) for interactive sites, shopping, dynamic content, and deep research. This browser is visible to the user.\n"
            "   - Use 'analyze_data' (Pandas) for interpreting data files.\n"
            "   - Use 'schedule_task' for any activity that needs to happen in the future or repeatedly.\n"
            "3. **Verification First**: For actions with real-world impact (Sending Emails, Overwriting Files), ALWAYS present a preview or plan and seek user confirmation unless they have explicitly pre-approved.\n"
            "4. **Proactive Problem Solving**: If a tool fails or provides incomplete data, do not stop. Use your search tools to find alternative methods or data sources.\n"
            "5. **Token Efficiency**: Every token costs money. Be extremely concise. Avoid filler text ('Certainly!', 'I understand'). Provide direct headers and structured data directly.\n"
            "6. **Trust Tool Responses**: When a tool returns a success message (✅), ACCEPT IT AS TRUTH. Do NOT ask for tokens, credentials, or confirmation. Do NOT retry the same action.\n"
            "7. **No Duplicate Actions**: NEVER call the same tool twice for a single user request unless the first attempt failed or the user explicitly asks to retry.\n"
            "8. **LinkedIn Posting**: If 'post_to_linkedin' returns '✅ Successfully posted', the post is LIVE. Do NOT ask for OAuth tokens or re-post.\n"
            "9. **Professional Communication**: Your output should be structured, high-value, and precise. Use Markdown formatting for clarity.\n"
            "10. **Uploaded Images**: If the user uploads an image and asks to post it to LinkedIn, use the `post_to_linkedin` tool with the provided file path. DO NOT claim you cannot analyze images. DO NOT ask for a description. JUST POST IT.\n\n"
            "### BROWSER AUTOMATION PROTOCOL (For Forms, Navigation, Menus, and Full Web Interaction):\n"
            "When a user asks you to fill out a form, navigate a website, interact with menus, or do any web task:\n"
            "1. **START with 'open_browser'**: Navigate to the target URL first.\n"
            "2. **DISCOVER with 'get_page_elements'**: See ALL interactive elements grouped by category.\n"
            "3. **MATCH user's EXACT words**: Find elements whose text EXACTLY matches what the user said.\n"
            "4. **FILL fields with 'fill_input'**: Enter text into input fields using the selector.\n"
            "5. **SELECT options with 'click_element' or 'select_option'**: For dropdowns, radio buttons, checkboxes, and tabs.\n"
            "6. **HOVER with 'hover_element'**: For menu items that reveal hidden dropdowns or submenus on hover.\n"
            "7. **WAIT with 'wait_for_element'**: After hovering or clicking, wait for dynamic elements to appear.\n"
            "8. **NAVIGATE with 'navigate_to'**: Move to new pages within the same browser session.\n"
            "9. **SCROLL with 'scroll_page'**: Reveal content below the fold.\n"
            "10. **SUBMIT with 'submit_form'**: Click the submit button when all fields are filled.\n"
            "11. **SCREENSHOT with 'take_page_screenshot'**: Capture the current page state for verification.\n"
            "12. **CLOSE with 'close_browser'**: Clean up the browser session when done.\n"
            "13. **REPORT the result**: Tell the user what was done and whether it was successful.\n\n"
            "### ⚠️ PRECISION RULES (CRITICAL - READ CAREFULLY):\n"
            "1. **USE THE USER'S EXACT WORDS**: If user says 'click on Research', use hover_element(selector=\"Research\") "
            "or click_element(selector=\"Research\"). Do NOT click 'About', 'Home', or any other element.\n"
            "2. **HOVER BEFORE CLICK for menus**: If an element is a navigation menu with dropdown sub-items, "
            "ALWAYS use hover_element FIRST, then read the dropdown items, then click_element on the specific sub-item.\n"
            "3. **TEXT-BASED SELECTORS**: You can pass plain text as selectors. "
            "hover_element(selector=\"Research\") will find the element with text 'Research' on the page.\n"
            "4. **NEVER GUESS**: Only interact with elements the user specifically mentioned. "
            "If the user says 'Research' → 'Overview', hover on 'Research' first, then click 'Overview'.\n"
            "5. **READ ELEMENT CATEGORIES**: get_page_elements groups elements by type. "
            "Look in NAVIGATION MENU ITEMS and HOVER DROPDOWN MENUS for menu interactions.\n"
            "6. **FOLLOW USER'S SEQUENCE**: If user says 'click A then go to B', do A first, then B. Never reorder.\n\n"
            "CRITICAL: For Google Forms, fields often use 'aria-label' attributes. Match field labels to user data intelligently.\n"
            "CRITICAL: A visible cursor is automatically injected — it moves to elements before interacting to appear human-like."
        )

    async def get_raw_response(
        self, 
        user_input: str, 
        history: List[Dict[str, Any]] = None,
        tools: List[Dict[str, Any]] = None
    ) -> Any:
        # Construct messages once
        messages = [{"role": "system", "content": self.system_instruction}]
        processed_history = (history[-12:]) if history and len(history) > 12 else history
        
        if processed_history:
            for entry in processed_history:
                role = entry.get("role")
                if role == "model": role = "assistant"
                parts = entry.get("parts", [])
                content = ""
                tool_calls = []
                tool_responses = []
                for p in parts:
                    if "text" in p: content += p["text"]
                    if "function_call" in p:
                        fn = p["function_call"]
                        tool_calls.append({"id": fn.get("id"), "type": "function", "function": {"name": fn["name"], "arguments": json.dumps(fn["args"])}})
                    if "function_response" in p:
                        fr = p["function_response"]
                        tool_responses.append({"role": "tool", "tool_call_id": fr.get("id"), "name": fr.get("name"), "content": json.dumps(fr.get("response"))})
                
                # Always add assistant message first (with or without tool_calls)
                if role in ("assistant", "user"):
                    msg = {"role": role, "content": content or None}
                    if tool_calls: msg["tool_calls"] = tool_calls
                    messages.append(msg)
                
                # Then add tool responses AFTER the assistant message
                for tr in tool_responses:
                    messages.append(tr)
        if not history and user_input:
            messages.append({"role": "user", "content": user_input})

        # Tool definitions
        openapi_tools = []
        if tools:
            for t_group in tools:
                for decl in t_group.get("function_declarations", []):
                    openapi_tools.append({"type": "function", "function": {"name": decl["name"], "description": decl["description"], "parameters": decl["parameters"]}})

        # ---------------------------------------------------------
        # TRY PROVIDERS WITH FALLBACK
        # ---------------------------------------------------------
        
        # List of candidate configs to try
        configs_to_try = []
        
        # 1. Primary: Gemini (with Key Rotation)
        if self.gemini_keys:
            # We will try up to the number of Gemini keys we have
            for _ in range(len(self.gemini_keys)):
                configs_to_try.append({
                    "name": f"Gemini (Key Cycle)",
                    "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                    "model": "gemini-2.5-flash-lite",
                    "key": next(self.gemini_cycle)
                })
        
        # 2. Fallbacks: Groq then OpenAI
        if self.groq_key: 
            configs_to_try.append({"name": "Groq Fallback", "url": "https://api.groq.com/openai/v1/chat/completions", "model": "llama-3.3-70b-versatile", "key": self.groq_key})
        if self.openai_key:
            configs_to_try.append({"name": "OpenAI Fallback", "url": "https://api.openai.com/v1/chat/completions", "model": "gpt-4o", "key": self.openai_key})

        async with httpx.AsyncClient() as client:
            for config in configs_to_try:
                try:
                    payload = {"model": config["model"], "messages": messages, "temperature": 0.0}
                    if openapi_tools: payload["tools"] = openapi_tools
                    
                    headers = {"Authorization": f"Bearer {config['key']}", "Content-Type": "application/json"}
                    
                    response = await client.post(config["url"], json=payload, headers=headers, timeout=30.0)
                    
                    if response.status_code == 200:
                        return response.json()
                    else:
                        print(f"Provider {config['name']} failed with {response.status_code}: {response.text}")
                        continue # Try next config
                except Exception as e:
                    print(f"Network error with {config['name']}: {e}")
                    continue

        # Final Fail
        return {
            "choices": [{"message": {"role": "assistant", "content": "I apologize, but all my intelligence providers are currently unavailable. Please check your API keys or connection."}}]
        }

    async def get_response(self, user_input: str, history: List[Dict[str, str]] = None) -> str:
        raw = await self.get_raw_response(user_input, history)
        return raw["choices"][0]["message"].get("content", "Task processed.")

llm_service = LLMService()
