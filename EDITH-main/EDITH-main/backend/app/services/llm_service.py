import os
import httpx
import json
import asyncio
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
        ]

        self.system_instruction = (
            "You are EDITH, an autonomous AI agent. You have a task — execute it end-to-end using tools. "
            "NEVER ask the user for clarification. NEVER ask what to do next. Just do the task.\n\n"

            "## CRITICAL RULES\n"
            "1. **NEVER call close_browser.** EVER.\n"
            "2. **`open_browser()` ALREADY returns a snapshot.** UIDs are immediately usable. "
            "NEVER call take_snapshot() right after open_browser.\n"
            "3. **Snapshot has elements → ACT IMMEDIATELY.** "
            "Find the UID you need → call fill/type_text/click. Do NOT call take_snapshot before acting.\n"
            "4. **UIDs are STABLE.** They do NOT change when you call take_snapshot again.\n"
            "5. **Only browser tools** when browser is open. NEVER google_search mid-browser-task.\n"
            "6. **call take_snapshot() ONLY after**: click(), navigate_page(), press_key(). "
            "NOT after fill() or type_text() — those should be followed by press_key('Enter') next.\n"
            "7. **Complete the FULL task end-to-end.** Never stop halfway. Never ask anything.\n\n"

            "## SEARCH → PLAY WORKFLOW (exact sequence)\n"
            "```\n"
            "Step 1: open_browser(url)\n"
            "        → snapshot shows: [X_Y] <searchbox> \"Search\" in the TYPE INTO THESE section\n"
            "Step 2: type_text('your query', 'X_Y')   ← use UID from Step 1\n"
            "Step 3: press_key('Enter')\n"
            "Step 4: take_snapshot()                   ← see results (page changed)\n"
            "        → snapshot shows: 📹 VIDEO RESULTS section with UIDs\n"
            "Step 5: click(first_video_uid)            ← pick from VIDEO RESULTS section, NOT nav links\n"
            "Step 6: take_snapshot()                   ← confirm video loaded\n"
            "Step 7: Report done\n"
            "```\n\n"

            "## READING THE SNAPSHOT\n"
            "- **'TYPE INTO THESE'** section → these are search/input boxes → use type_text()\n"
            "- **'📹 VIDEO RESULTS'** section → these are video links → click() one to play\n"
            "- **🗂→** prefix on links = navigation (YouTube logo, sidebar, etc.) → AVOID these\n"
            "- **📹→** prefix on links = video watch link → PREFER these for playing videos\n\n"

            "## 🚫 PROHIBITIONS\n"
            "- NEVER call close_browser\n"
            "- NEVER call take_snapshot immediately after open_browser\n"
            "- NEVER call take_snapshot twice in a row without acting in between\n"
            "- NEVER click a 🗂 nav link when you want to play a video — use 📹 links\n"
            "- NEVER guess a UID — always read UIDs from the snapshot\n"
            "- NEVER ask the user anything — just do the task\n"
        )

    async def get_raw_response(
        self, 
        user_input: str, 
        history: List[Dict[str, Any]] = None,
        tools: List[Dict[str, Any]] = None,
        system_override: str = None
    ) -> Any:
        # Construct messages once (use override if provided, e.g. with plan context injected)
        messages = [{"role": "system", "content": system_override if system_override else self.system_instruction}]
        processed_history = (history[-12:]) if history and len(history) > 12 else history

        # GUARD: Strip orphaned tool messages from the start of the window.
        # When history is sliced, the first entry might be a tool response without
        # its preceding assistant tool_calls — OpenAI rejects this with 400.
        if processed_history:
            while processed_history and processed_history[0].get("role") == "tool":
                processed_history = processed_history[1:]

        if processed_history:
            # Count total tool responses to identify which are "old" vs "recent"
            total_tool_responses = sum(
                1 for entry in processed_history
                for p in entry.get("parts", []) if "function_response" in p
            )
            tool_response_idx = 0

            # PRE-PASS: Build a call_id_map so tool responses can reference correct call IDs.
            # Key = (fn_name, occurrence_index), Value = call_id string
            # This handles the case where the same function is called multiple times in one turn.
            call_id_map = {}  # (fn_name, n) -> call_id for the nth call to fn_name
            fn_occurrence = {}  # fn_name -> occurrence count so far
            for entry in processed_history:
                if entry.get("role") not in ("model", "assistant"):
                    continue
                for p in entry.get("parts", []):
                    if "function_call" in p:
                        fn = p["function_call"]
                        fn_name = fn["name"]
                        n = fn_occurrence.get(fn_name, 0) + 1
                        fn_occurrence[fn_name] = n
                        # Use API-provided id if present, else generate unique fallback
                        call_id = fn.get("id") or f"call_{fn_name}_{n}"
                        call_id_map[(fn_name, n)] = call_id
                        # Store on fn dict so assistant pass can retrieve it
                        fn["_resolved_id"] = call_id

            # Response occurrence counters (for matching parallel calls)
            resp_occurrence = {}

            for entry in processed_history:
                role = entry.get("role")
                parts = entry.get("parts", [])

                # --- USER message ---
                if role == "user":
                    content = "".join(p.get("text", "") for p in parts)
                    messages.append({"role": "user", "content": content or None})

                # --- ASSISTANT / MODEL message (may include tool_calls) ---
                elif role in ("model", "assistant"):
                    content = ""
                    tool_calls = []
                    for p in parts:
                        if "text" in p:
                            content += p["text"]
                        if "function_call" in p:
                            fn = p["function_call"]
                            call_id = fn.get("_resolved_id") or fn.get("id") or f"call_{fn['name']}_1"
                            tool_calls.append({
                                "id": call_id,
                                "type": "function",
                                "function": {"name": fn["name"], "arguments": json.dumps(fn["args"])}
                            })
                    msg = {"role": "assistant", "content": content or None}
                    if tool_calls:
                        msg["tool_calls"] = tool_calls
                    messages.append(msg)

                # --- TOOL response message (must follow assistant message with tool_calls) ---
                elif role == "tool":
                    for p in parts:
                        if "function_response" in p:
                            fr = p["function_response"]
                            resp_content = json.dumps(fr.get("response"))

                            # TOKEN SAVINGS: Truncate older tool responses (keep last 4 in full)
                            is_old = tool_response_idx < (total_tool_responses - 4)
                            if is_old and len(resp_content) > 500:
                                resp_content = resp_content[:500] + '..."}'
                            tool_response_idx += 1

                            # Match call_id using name+occurrence to handle duplicate function calls
                            fn_name = fr.get("name", "unknown")
                            n = resp_occurrence.get(fn_name, 0) + 1
                            resp_occurrence[fn_name] = n
                            call_id = (
                                fr.get("id")
                                or call_id_map.get((fn_name, n))
                                or f"call_{fn_name}_{n}"
                            )
                            # OpenAI: role=tool, tool_call_id, content only (NO "name" field)
                            messages.append({
                                "role": "tool",
                                "tool_call_id": call_id,
                                "content": resp_content
                            })

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
        
        # 2. Fallback: Groq (tool-use model)
        if self.groq_key: 
            configs_to_try.append({"name": "Groq Fallback", "url": "https://api.groq.com/openai/v1/chat/completions", "model": "llama-3.3-70b-versatile", "key": self.groq_key})

        async with httpx.AsyncClient() as client:
            for config in configs_to_try:
                # Retry each provider up to 2 times with backoff
                max_retries = 2 if "OpenAI" in config["name"] else 1
                for attempt in range(max_retries):
                    try:
                        payload = {"model": config["model"], "messages": messages}
                        if openapi_tools:
                            payload["tools"] = openapi_tools
                            payload["tool_choice"] = "auto"
                        
                        headers = {"Authorization": f"Bearer {config['key']}", "Content-Type": "application/json"}
                        print(f"[LLM] Trying {config['name']} (model={config['model']}, attempt={attempt+1}/{max_retries})")
                        
                        response = await client.post(config["url"], json=payload, headers=headers, timeout=90.0)
                        
                        if response.status_code == 200:
                            result = response.json()
                            print(f"[LLM] ✓ {config['name']} responded successfully")
                            return result
                        elif response.status_code == 429:
                            # Rate limited — wait and retry
                            wait_time = 2 ** (attempt + 1)
                            print(f"[LLM] Rate limited by {config['name']}, waiting {wait_time}s...")
                            await asyncio.sleep(wait_time)
                            continue
                        else:
                            print(f"[LLM] ✗ {config['name']} failed with {response.status_code}: {response.text[:200]}")
                            break  # Don't retry non-retryable errors, try next provider
                    except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as e:
                        # Network errors — retry with backoff
                        wait_time = 2 ** attempt
                        print(f"[LLM] ✗ Network error with {config['name']}: {e}. Retrying in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                        continue
                    except Exception as e:
                        print(f"[LLM] ✗ Error with {config['name']}: {e}")
                        break  # Try next provider

        # Final Fail
        return {
            "choices": [{"message": {"role": "assistant", "content": "I apologize, but all my intelligence providers are currently unavailable. Please check your API keys or connection."}}]
        }

    async def get_response(self, user_input: str, history: List[Dict[str, str]] = None) -> str:
        raw = await self.get_raw_response(user_input, history)
        return raw["choices"][0]["message"].get("content", "Task processed.")

llm_service = LLMService()
