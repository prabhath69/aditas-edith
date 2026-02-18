from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.database import get_db
from app.db import models
from app.services.llm_service import llm_service
from app.services.intent_service import intent_detector
from app.services.mcp_service import mcp_service
from app.services.planner_service import planner_service
from pydantic import BaseModel
from typing import List, Optional, Any
import json

router = APIRouter()

class ChatRequest(BaseModel):
    message: str
    history: Optional[List[dict]] = []

class ChatResponse(BaseModel):
    response: str
    log_id: int
    intent: str
    actions: List[str] = []

@router.post("/", response_model=ChatResponse)
async def chat(request: ChatRequest, db: Session = Depends(get_db)):
    # 1. Intent Detection
    try:
        intent_data = await intent_detector.detect(request.message)
    except Exception as e:
        intent_data = {"intent": "CHAT", "reason": f"Detector Error: {str(e)}"}
    
    intent = intent_data.get("intent", "CHAT")

    # 2. Planning (Phase 7)
    plan_data = None
    if intent in ["TASK", "HYBRID"]:
        try:
            plan_data = await planner_service.generate_plan(request.message)
        except Exception as e:
            print(f"Planning failed: {e}")
            plan_data = {"reasoning": "Direct execution due to planning failure.", "steps": [request.message]}

    # 3. Initial Audit Log
    new_log = models.AuditLog(
        user_id=1,
        action_type=intent,
        description=f"User: {request.message[:50]}...",
        details={
            "input": request.message, 
            "intent_analysis": intent_data, 
            "plan": plan_data,
            "steps": []
        }
    )
    db.add(new_log)
    db.commit()
    db.refresh(new_log)

    # 4. Agentic Loop (Tool Calling)
    conversation_history = request.history.copy()
    
    # Inject Plan if available
    context_instruction = llm_service.system_instruction
    if plan_data:
        context_instruction += f"\n\nCURRENT TASK PLAN:\n{json.dumps(plan_data['steps'], indent=2)}"

    # Add user message
    conversation_history.append({"role": "user", "parts": [{"text": request.message}]})
    
    actions_taken = []
    final_response = ""
    max_iterations = 25
    tool_defs = mcp_service.get_tool_definitions()
    print(f"DEBUG TOOLS: {json.dumps(tool_defs, indent=2)}")

    for i in range(max_iterations):
        try:
            # Ask LLM
            llm_raw = await llm_service.get_raw_response(
                user_input="", 
                history=conversation_history,
                tools=tool_defs
            )

            choice = llm_raw["choices"][0]
            message = choice["message"]
            
            # Record assistant msg
            assistant_parts = []
            if message.get("content"):
                assistant_parts.append({"text": message["content"]})
            
            tool_calls = message.get("tool_calls", [])
            for tc in tool_calls:
                # Wrap argument parsing in safety
                try:
                    args = json.loads(tc["function"]["arguments"])
                except:
                    args = {"raw": tc["function"]["arguments"]}
                    
                assistant_parts.append({
                    "function_call": {
                        "id": tc["id"],
                        "name": tc["function"]["name"],
                        "args": args
                    }
                })

            conversation_history.append({"role": "model", "parts": assistant_parts})

            if tool_calls:
                for tc in tool_calls:
                    fn_name = tc["function"]["name"]
                    tc_id = tc["id"]
                    try:
                        fn_args = json.loads(tc["function"]["arguments"])
                    except:
                        fn_args = {}

                    actions_taken.append(f"Action: {fn_name}")
                    
                    steps = list(new_log.details.get("steps", []))
                    steps.append({"iteration": i + 1, "action": fn_name, "args": fn_args})
                    new_log.details = {**new_log.details, "steps": steps}
                    db.commit()

                    try:
                        tool_result = await mcp_service.execute_tool(fn_name, fn_args)
                    except Exception as tool_err:
                        tool_result = f"Error: {str(tool_err)}"
                        if fn_name in ['click_element', 'fill_input', 'hover_element', 'type_text', 
                                       'select_option', 'submit_form', 'scroll_to_element', 'wait_for_element']:
                            try:
                                ss = await mcp_service.execute_tool('take_page_screenshot', {})
                                tool_result += f"\n[Debug screenshot: {ss}]"
                            except:
                                pass

                    conversation_history.append({
                        "role": "tool", 
                        "parts": [{
                            "function_response": {
                                "id": tc_id,
                                "name": fn_name,
                                "response": {"result": tool_result}
                            }
                        }]
                    })
                    
                    steps[-1]["result"] = tool_result
                    new_log.details = {**new_log.details, "steps": steps}
                    db.commit()
            else:
                final_response = message.get("content") or "I've completed the task as requested."
                break
        except Exception as e:
            print(f"Agent Loop Error: {e}")
            final_response = f"I encountered an internal error: {str(e)}. Please check my process log."
            break
    
    if not final_response:
        # If we hit the limit, try one last call to synthesize what we have
        try:
            conversation_history.append({"role": "user", "parts": [{"text": "You have reached your maximum action limit. Please provide a concise summary of what you have accomplished or found so far based on the tool results above."}]})
            llm_raw = await llm_service.get_raw_response(
                user_input="", 
                history=conversation_history,
                tools=tool_defs
            )
            final_response = llm_raw["choices"][0]["message"].get("content") or "I've reached my process limit. Please check the logs for the data gathered."
        except:
            final_response = "I ran out of reasoning steps (max iterations reached). Here is what I found so far. Check the log for details."

    new_log.description = f"Intent: {intent} | Plan: {len(plan_data['steps']) if plan_data else 0} | Actions: {len(actions_taken)}"
    new_log.details = {**new_log.details, "response": final_response, "actions": actions_taken}
    db.commit()

    return ChatResponse(
        response=final_response,
        log_id=new_log.id,
        intent=intent,
        actions=actions_taken
    )
