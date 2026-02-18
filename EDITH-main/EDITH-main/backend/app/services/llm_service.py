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
        
        # OpenAI Keys (Primary provider)
        self.openai_keys = [
            os.getenv("OPENAI_API_KEY"),
        ]
        self.openai_keys = [k for k in self.openai_keys if k]  # Filter out None
        self.openai_cycle = itertools.cycle(self.openai_keys)
        
        # Fallback Providers
        self.groq_key = os.getenv("GROQ_API_KEY") or settings.GROQ_API_KEY
        self.gemini_key = os.getenv("GOOGLE_API_KEY")
        
        # ---------------------------------------------------------
        # 2. Provider Map (Priority Order)
        # ---------------------------------------------------------
        self.providers = [
            {
                "name": "OpenAI",
                "base_url": "https://api.openai.com/v1/chat/completions",
                "model": "gpt-5-nano",
                "active": True
            },
            # {
            #     "name": "Groq",
            #     "base_url": "https://api.groq.com/openai/v1/chat/completions",
            #     "model": "llama-3.3-70b-versatile",
            #     "active": False # Set to True to enable Groq fallback
            # },
            {
                "name": "Gemini",
                "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                "model": "gemini-2.5-flash-lite",
                "active": False  # Set to True to enable Gemini fallback
            }
        ]

        self.system_instruction = (
            "You are EDITH, a General Intelligence Agent. "
            "Solve user requests by orchestrating tools autonomously.\n\n"
            "### CORE RULES:\n"
            "1. **AUTONOMOUS EXECUTION**: Complete the ENTIRE user request end-to-end without stopping to ask for confirmation. NEVER present options or ask 'what would you like to do next?' during browser tasks. JUST DO IT.\n"
            "2. **Chain tools** to complete complex tasks (Search -> Browse -> Extract -> Report).\n"
            "3. **Confirmation ONLY for**: sending emails, deleting files, or financial transactions. Browser navigation/clicking/searching NEVER needs confirmation.\n"
            "4. **If a tool fails**, try an alternative approach. Don't stop.\n"
            "5. **Be CONCISE**: Max 2-3 sentences when reporting results. No filler text. No option menus. No bullet-point lists of 'what I can do next'.\n"
            "6. **Trust tool responses**: When a tool returns success, accept it and move on.\n"
            "7. **No duplicate calls**: Don't call the same tool twice unless the first failed.\n\n"
            "### BROWSER AUTOMATION PROTOCOL:\n"
            "When doing ANY web task, follow this flow WITHOUT stopping to ask:\n"
            "1. open_browser(url) → get_page_elements() → interact → extract_text() → report\n"
            "2. For search: type_text(text, selector) → press_key('Enter') → extract_text()\n"
            "3. For menus: hover_element first → then click_element on sub-item\n"
            "4. For navigation: click/navigate → extract_text() to read the new page\n"
            "5. **KEEP browser open** after task so user can verify. NEVER call close_browser unless user explicitly asks to close it.\n"
            "6. For YouTube: use youtube_transcript_search(video_url, phrase) to find timestamps WITHOUT reading full transcript. Then navigate to video_url?t=seconds\n\n"
            "### AVAILABLE BROWSER TOOLS:\n"
            "open_browser, get_page_elements, extract_text, extract_structured_data, fill_input, type_text, "
            "click_element, hover_element, press_key, select_option, wait_for_element, wait_for_navigation, "
            "navigate_to, go_back, go_forward, get_page_info, open_new_tab, switch_tab, close_tab, "
            "scroll_page, scroll_to_element, take_page_screenshot, submit_form, upload_file, "
            "execute_javascript, drag_and_drop, switch_to_frame, switch_to_main, handle_dialog, close_browser\n\n"
            "### ⚠️ PRECISION RULES:\n"
            "1. **USE THE USER'S EXACT WORDS** as selectors. User says 'click Research' → hover_element(selector=\"Research\").\n"
            "2. **HOVER BEFORE CLICK** for navigation menus with dropdowns.\n"
            "3. Plain text works as selectors: click_element(selector=\"Resources\")\n"
            "4. **NEVER GUESS** element names. Only interact with what user mentioned.\n"
            "5. **FOLLOW USER'S SEQUENCE**: If user says 'do A then B', do A first, then B.\n"
            "6. For Google Forms, match aria-label attributes to user data.\n\n"
            "### 🚫 NEVER DO THIS:\n"
            "- NEVER say 'What would you like to do next?' during a browser task\n"
            "- NEVER present numbered options (Option A, Option B...)\n"
            "- NEVER ask 'Please confirm' for browser navigation\n"
            "- NEVER describe what you COULD do — just DO the task\n"
            "- NEVER repeat tool results back verbatim — summarize in 1-2 sentences"
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
            # Count total tool responses to identify which are "old" vs "recent"
            total_tool_responses = sum(
                1 for entry in processed_history
                for p in entry.get("parts", []) if "function_response" in p
            )
            tool_response_idx = 0
            
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
                        resp_content = json.dumps(fr.get("response"))
                        
                        # TOKEN SAVINGS: Truncate older tool responses (keep last 4 in full)
                        is_old = tool_response_idx < (total_tool_responses - 4)
                        if is_old and len(resp_content) > 500:
                            resp_content = resp_content[:500] + '..."}'
                        tool_response_idx += 1
                        
                        tool_responses.append({"role": "tool", "tool_call_id": fr.get("id"), "name": fr.get("name"), "content": resp_content})
                
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
        
        # 1. Primary: OpenAI (with Key Rotation)
        if self.openai_keys:
            # We will try up to the number of OpenAI keys we have
            for _ in range(len(self.openai_keys)):
                configs_to_try.append({
                    "name": f"OpenAI (Key Cycle)",
                    "url": "https://api.openai.com/v1/chat/completions",
                    "model": "gpt-5-nano",
                    "key": next(self.openai_cycle)
                })
        
        # 2. Fallbacks: Groq then Gemini
        if self.groq_key: 
            configs_to_try.append({"name": "Groq Fallback", "url": "https://api.groq.com/openai/v1/chat/completions", "model": "llama-3.3-70b-versatile", "key": self.groq_key})
        if self.gemini_key:
            configs_to_try.append({"name": "Gemini Fallback", "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "model": "gemini-2.5-flash-lite", "key": self.gemini_key})

        async with httpx.AsyncClient() as client:
            for config in configs_to_try:
                try:
                    payload = {"model": config["model"], "messages": messages}
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
