import { getSettings, getConversations, saveConversation, getSchedules } from '../../lib/storage';
import { callLLM } from '../../lib/llm';
import type { Message } from '../../lib/storage';
import {
    openBrowser,
    navigateTo,
    takeSnapshot,
    clickElement,
    typeText,
    pressKey,
    scrollPage,
    takeScreenshot,
    detachDebugger,
} from '../../lib/automation';
import { SYSTEM_PROMPT, formatSnapshot, BROWSER_TOOLS, pruneHistory, TASK_COMPLETE_SIGNAL } from '../../lib/agent';

export default defineBackground(() => {
    // Open sidepanel when toolbar icon is clicked
    chrome.action.onClicked.addListener((tab) => {
        chrome.sidePanel.open({ windowId: tab.windowId! });
    });

    // Message handler — receives messages from the sidepanel
    // IMPORTANT: For async tasks, we return a quick ack and use storage+events for progress
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type === 'CHAT') {
            // Chat: relatively fast, can reply directly
            handleChat(message)
                .then((result) => sendResponse({ ok: true, ...result }))
                .catch((err) => sendResponse({ ok: false, error: String(err) }));
            return true; // Keep channel open for async
        }

        if (message.type === 'AGENT_RUN') {
            // Agent: long-running — ack immediately, run in background, push events
            sendResponse({ ok: true, conversationId: message.conversationId ?? null });
            runAgent(message).catch((err) => {
                broadcastEvent({ type: 'agent_error', error: String(err), conversationId: message.conversationId });
            });
            return false; // Channel already closed via sendResponse
        }

        if (message.type === 'GET_CONVERSATIONS') {
            getConversations().then((convs) => sendResponse({ ok: true, conversations: convs }));
            return true;
        }
    });

    // Scheduled task handler via chrome.alarms
    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (!alarm.name.startsWith('edith_schedule_')) return;
        const taskId = alarm.name.replace('edith_schedule_', '');
        const schedules = await getSchedules();
        const task = schedules.find((s) => s.id === taskId);
        if (!task || !task.enabled) return;
        await runAgent({ prompt: task.prompt, conversationId: null });
    });
});

// Broadcast an event to any open extension pages (sidepanel, popup, etc.)
function broadcastEvent(data: Record<string, unknown>) {
    chrome.runtime.sendMessage(data).catch(() => {
        // Sidepanel might not be open — that's fine
    });
}

// ─── Simple Chat (no browser tools) ─────────────────────────────────────────

async function handleChat(message: { conversationId?: string | null; prompt: string }) {
    const settings = await getSettings();

    if (!settings.apiKey) {
        throw new Error('No API key set. Open Settings and add your OpenAI API key.');
    }

    const conversations = await getConversations();
    let conv = conversations.find((c) => c.id === message.conversationId);

    if (!conv) {
        conv = {
            id: crypto.randomUUID(),
            title: message.prompt.slice(0, 60),
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }

    const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message.prompt,
        timestamp: Date.now(),
    };
    conv.messages.push(userMsg);

    const response = await callLLM(settings, SYSTEM_PROMPT, conv.messages, []);

    const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
    };
    conv.messages.push(assistantMsg);
    conv.updatedAt = Date.now();
    await saveConversation(conv);

    return { conversationId: conv.id };
}

// ─── Agent Run (with browser automation) ──────────────────────────────────────

async function runAgent(message: { prompt: string; conversationId?: string | null }) {
    const settings = await getSettings();

    if (!settings.apiKey) {
        broadcastEvent({
            type: 'agent_error',
            error: 'No API key set. Open Settings ⚙️ and add your OpenAI API key.',
            conversationId: message.conversationId,
        });
        return;
    }

    const conversations = await getConversations();
    let conv = conversations.find((c) => c.id === message.conversationId);

    if (!conv) {
        conv = {
            id: crypto.randomUUID(),
            title: message.prompt.slice(0, 60),
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }

    const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message.prompt,
        timestamp: Date.now(),
    };
    conv.messages.push(userMsg);

    let lastSnapshot: Awaited<ReturnType<typeof takeSnapshot>> | null = null;
    let activeTabId: number | undefined;
    let stepCount = 0;
    const MAX_STEPS = 30;

    function progress(text: string) {
        broadcastEvent({ type: 'agent_progress', text, conversationId: conv!.id });
    }

    try {
        while (stepCount < MAX_STEPS) {
            stepCount++;

            const response = await callLLM(settings, SYSTEM_PROMPT, pruneHistory(conv.messages), BROWSER_TOOLS);

            if (response.toolCalls.length === 0) {
                // Agent is done
                const finalMsg: Message = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: response.content || 'Task completed.',
                    timestamp: Date.now(),
                };
                conv.messages.push(finalMsg);
                conv.updatedAt = Date.now();
                await saveConversation(conv);

                broadcastEvent({ type: 'agent_done', conversationId: conv.id });
                return;
            }

            // Assistant message with tool calls
            const assistantMsg: Message = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: response.content || '',
                toolCalls: response.toolCalls,
                timestamp: Date.now(),
            };
            conv.messages.push(assistantMsg);

            // Execute each tool call
            for (const toolCall of response.toolCalls) {
                const args = toolCall.arguments as Record<string, unknown>;
                progress(`🔧 ${toolCall.name}: ${JSON.stringify(args).slice(0, 80)}`);

                let toolResult = '';
                try {
                    switch (toolCall.name) {
                        case 'task_complete': {
                            // LLM explicitly signals task is done — stop immediately
                            const summary = (args.summary as string) || 'Task completed.';
                            progress(`✅ Done: ${summary}`);
                            const finalMsg: Message = {
                                id: crypto.randomUUID(),
                                role: 'assistant',
                                content: summary,
                                timestamp: Date.now(),
                            };
                            conv.messages.push(finalMsg);
                            conv.updatedAt = Date.now();
                            await saveConversation(conv);
                            await detachDebugger(activeTabId).catch(() => { });
                            activeTabId = undefined;
                            broadcastEvent({ type: 'agent_done', conversationId: conv.id });
                            return; // Exit entire runAgent function
                        }
                        case 'open_browser': {
                            activeTabId = await openBrowser(args.url as string);
                            await sleep(1500);
                            toolResult = `Opened browser to ${args.url}. Now call take_snapshot to see the page.`;
                            lastSnapshot = null;
                            break;
                        }
                        case 'navigate': {
                            await navigateTo(args.url as string, activeTabId);
                            toolResult = `Navigated to ${args.url}. Call take_snapshot to see the page.`;
                            lastSnapshot = null;
                            break;
                        }
                        case 'take_snapshot': {
                            lastSnapshot = await takeSnapshot(activeTabId);
                            toolResult = formatSnapshot(lastSnapshot);
                            progress(`📸 Snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                            break;
                        }
                        case 'click': {
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await clickElement(args.uid as number, lastSnapshot, activeTabId);
                                await sleep(800);
                                lastSnapshot = null;
                            }
                            break;
                        }
                        case 'type_text': {
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await typeText(
                                    args.text as string,
                                    args.uid as number,
                                    lastSnapshot,
                                    activeTabId,
                                );
                                lastSnapshot = null;
                            }
                            break;
                        }
                        case 'press_key': {
                            toolResult = await pressKey(args.key as string, activeTabId);
                            await sleep(800);
                            lastSnapshot = null;
                            break;
                        }
                        case 'scroll': {
                            toolResult = await scrollPage(
                                args.direction as 'up' | 'down',
                                (args.amount as number) || 500,
                                activeTabId,
                            );
                            break;
                        }
                        case 'screenshot': {
                            await takeScreenshot(activeTabId);
                            toolResult = 'Screenshot taken.';
                            break;
                        }
                        default:
                            toolResult = `Unknown tool: ${toolCall.name}`;
                    }
                } catch (err) {
                    toolResult = `Tool error: ${String(err)}`;
                    progress(`⚠️ Error: ${String(err).slice(0, 100)}`);
                }

                conv.messages.push({
                    id: crypto.randomUUID(),
                    role: 'tool',
                    content: toolResult,
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    timestamp: Date.now(),
                });
            }

            conv.updatedAt = Date.now();
            await saveConversation(conv);
        }

        // Hit max steps
        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'Reached maximum steps. Please try a more specific instruction.',
            timestamp: Date.now(),
        });
        await saveConversation(conv);
        broadcastEvent({ type: 'agent_done', conversationId: conv.id });

    } finally {
        if (activeTabId) await detachDebugger(activeTabId).catch(() => { });
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
