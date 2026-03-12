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
    detachAllDebuggers,
    selectOption,
    hoverElement,
    setValue,
    waitForNetworkIdle,
} from '../../lib/automation';
import { SYSTEM_PROMPT, formatSnapshot, BROWSER_TOOLS, pruneHistory, TASK_COMPLETE_SIGNAL } from '../../lib/agent';
import { decomposeTask, runSubTask, aggregateResults } from '../../lib/research';
import type { SubTaskResult, ResearchPlan } from '../../lib/research';
import { tabManager } from '../../lib/tab_manager';
import {
    isLeadGenTask,
    generateSearchQueries,
    buildExtractionPrompt,
    buildSheetEntryPrompt,
    parseExtractedLeads,
} from '../../lib/lead_intelligence';
import type { LeadGenPlan } from '../../lib/lead_intelligence';

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

            // Auto-detect lead generation tasks and route accordingly
            const useLeadGen = isLeadGenTask(message.prompt || '');
            const runner = useLeadGen ? runLeadGen(message) : runAgent(message);
            runner.catch((err) => {
                broadcastEvent({ type: 'agent_error', error: String(err), conversationId: message.conversationId });
            });
            return false; // Channel already closed via sendResponse
        }

        if (message.type === 'RESEARCH_RUN') {
            // Research: multi-tab parallel — ack immediately, run in background
            sendResponse({ ok: true, conversationId: message.conversationId ?? null });
            runResearchFromPrompt(message).catch((err) => {
                broadcastEvent({ type: 'agent_error', error: String(err), conversationId: message.conversationId });
            });
            return false;
        }

        if (message.type === 'AGENT_STOP') {
            // User requested immediate stop
            agentAbortFlag = true;
            sendResponse({ ok: true });
            return false;
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

// Abort flag for stopping the agent mid-run
let agentAbortFlag = false;

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
    agentAbortFlag = false; // Reset abort flag at start

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
    const MAX_STEPS = 50;
    let consecutiveSnapshots = 0; // Track snapshot loop

    function progress(text: string) {
        broadcastEvent({ type: 'agent_progress', text, conversationId: conv!.id });
    }

    try {
        while (stepCount < MAX_STEPS) {
            // Check abort flag at top of each iteration
            if (agentAbortFlag) {
                progress('⏹ Automation stopped by user.');
                const stopMsg: Message = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: '⏹ Automation stopped by user.',
                    timestamp: Date.now(),
                };
                conv.messages.push(stopMsg);
                conv.updatedAt = Date.now();
                await saveConversation(conv);
                await detachDebugger(activeTabId).catch(() => { });
                activeTabId = undefined;
                broadcastEvent({ type: 'agent_done', conversationId: conv.id });
                return;
            }

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
                // Check abort flag before each tool execution
                if (agentAbortFlag) break;

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
                            consecutiveSnapshots = 0;
                            break;
                        }
                        case 'navigate': {
                            await navigateTo(args.url as string, activeTabId);
                            toolResult = `Navigated to ${args.url}. Call take_snapshot to see the page.`;
                            lastSnapshot = null;
                            consecutiveSnapshots = 0;
                            break;
                        }
                        case 'take_snapshot': {
                            consecutiveSnapshots++;
                            lastSnapshot = await takeSnapshot(activeTabId);
                            toolResult = formatSnapshot(lastSnapshot);
                            progress(`📸 Snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                            // Detect snapshot loop
                            if (consecutiveSnapshots >= 3) {
                                toolResult += '\n\n⚠️ You have taken multiple snapshots without acting. Look at the elements above and click one to proceed, or call task_complete if the goal is already met.';
                            }
                            break;
                        }
                        case 'click': {
                            consecutiveSnapshots = 0;
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await clickElement(args.uid as number, lastSnapshot, activeTabId);
                                // Detect new tab opened by click (target=_blank links)
                                if (toolResult.includes('__NEW_TAB__:')) {
                                    const match = toolResult.match(/__NEW_TAB__:(\d+)/);
                                    if (match) {
                                        activeTabId = parseInt(match[1], 10);
                                        progress(`🔀 Switched to new tab ${activeTabId}`);
                                    }
                                }
                                await sleep(1200); // Wait for page load/Gmail compose popup
                                // Auto-snapshot after click
                                try {
                                    lastSnapshot = await takeSnapshot(activeTabId);
                                    const snapText = formatSnapshot(lastSnapshot);
                                    toolResult += `\n\n--- Page after click ---\n${snapText}`;
                                    progress(`📸 Auto-snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            break;
                        }
                        case 'type_text': {
                            consecutiveSnapshots = 0;
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await typeText(
                                    args.text as string,
                                    args.uid as number,
                                    lastSnapshot,
                                    activeTabId,
                                );
                                // Auto-snapshot after typing so LLM sees the result
                                // 1000ms wait gives search/filter results time to appear (e.g. WhatsApp contact search)
                                await sleep(1000);
                                try {
                                    lastSnapshot = await takeSnapshot(activeTabId);
                                    const snapText = formatSnapshot(lastSnapshot);
                                    toolResult += `\n\n--- Page after typing ---\n${snapText}`;
                                    progress(`📸 Auto-snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            break;
                        }
                        case 'press_key': {
                            consecutiveSnapshots = 0;
                            toolResult = await pressKey(args.key as string, activeTabId);
                            // pressKey already waits up to 3s for navigation on Enter.
                            // Add extra settle time if navigation occurred so new page renders fully.
                            const navigated = toolResult.includes('navigated');
                            await sleep(navigated ? 1500 : 300);
                            // Auto-snapshot after key press so LLM sees if page changed
                            try {
                                lastSnapshot = await takeSnapshot(activeTabId);
                                const snapText = formatSnapshot(lastSnapshot);
                                toolResult += `\n\n--- Page after key press ---\n${snapText}`;
                                progress(`📸 Auto-snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                            } catch {
                                lastSnapshot = null;
                            }
                            break;
                        }
                        case 'scroll': {
                            consecutiveSnapshots = 0;
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
                        // ─── BrowserOS-level tools ───
                        case 'select_option': {
                            consecutiveSnapshots = 0;
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await selectOption(
                                    args.uid as number,
                                    args.value as string,
                                    lastSnapshot,
                                    activeTabId,
                                );
                                // Wait for AJAX update after select change
                                await waitForNetworkIdle(activeTabId, 3000).catch(() => { });
                                await sleep(500);
                                try {
                                    lastSnapshot = await takeSnapshot(activeTabId);
                                    const snapText = formatSnapshot(lastSnapshot);
                                    toolResult += `\n\n--- Page after select ---\n${snapText}`;
                                    progress(`📸 Auto-snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            break;
                        }
                        case 'hover': {
                            consecutiveSnapshots = 0;
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await hoverElement(
                                    args.uid as number,
                                    lastSnapshot,
                                    activeTabId,
                                );
                                // Auto-snapshot to show revealed menu
                                try {
                                    lastSnapshot = await takeSnapshot(activeTabId);
                                    const snapText = formatSnapshot(lastSnapshot);
                                    toolResult += `\n\n--- Page after hover ---\n${snapText}`;
                                    progress(`📸 Auto-snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            break;
                        }
                        case 'set_value': {
                            consecutiveSnapshots = 0;
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await setValue(
                                    args.uid as number,
                                    args.value as string,
                                    lastSnapshot,
                                    activeTabId,
                                );
                                await sleep(300);
                                try {
                                    lastSnapshot = await takeSnapshot(activeTabId);
                                    const snapText = formatSnapshot(lastSnapshot);
                                    toolResult += `\n\n--- Page after set_value ---\n${snapText}`;
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            break;
                        }
                        case 'wait_for_page_update': {
                            consecutiveSnapshots = 0;
                            toolResult = await waitForNetworkIdle(activeTabId, 5000);
                            await sleep(500);
                            // Auto-snapshot after wait
                            try {
                                lastSnapshot = await takeSnapshot(activeTabId);
                                const snapText = formatSnapshot(lastSnapshot);
                                toolResult += `\n\n--- Page after update ---\n${snapText}`;
                                progress(`📸 Auto-snapshot: ${lastSnapshot.title} (${lastSnapshot.elements.length} elements)`);
                            } catch {
                                lastSnapshot = null;
                            }
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

// ─── Multi-Tab Research Runner ──────────────────────────────────────────────

import type { Conversation, StoredSettings as Settings } from '../../lib/storage';

/** Entry point for RESEARCH_RUN messages — handles conversation setup + decomposition */
async function runResearchFromPrompt(message: { prompt: string; conversationId?: string | null }) {
    const settings = await getSettings();
    agentAbortFlag = false;

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
            title: `🔬 ${message.prompt.slice(0, 55)}`,
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

    function progress(text: string) {
        broadcastEvent({ type: 'agent_progress', text, conversationId: conv!.id });
    }

    try {
        // Decompose the prompt into sub-tasks
        progress('🔍 Analyzing task and planning research...');
        const plan = await decomposeTask(settings, message.prompt);

        if (!plan.isResearch || plan.subTasks.length < 2) {
            // Not enough sub-tasks for multi-tab — tell user to use Agent mode
            conv.messages.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '⚠️ This task doesn\'t require multiple tabs. Please use 🤖 Agent mode for single-tab tasks.',
                timestamp: Date.now(),
            });
            conv.updatedAt = Date.now();
            await saveConversation(conv);
            broadcastEvent({ type: 'agent_done', conversationId: conv.id });
            return;
        }

        progress(`🔬 Research plan: ${plan.subTasks.length} sources to check in parallel`);
        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `🔬 Research mode: checking ${plan.subTasks.length} sources in parallel...\n\n${plan.subTasks.map((st, i) => `${i + 1}. ${st.url} — ${st.extractionGoal}`).join('\n')}`,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);

        await runResearch(settings, conv, plan);

    } catch (err: unknown) {
        progress(`❌ Research error: ${String(err).slice(0, 100)}`);
        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `❌ Research failed: ${String(err)}`,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);
        broadcastEvent({ type: 'agent_error', error: String(err), conversationId: conv.id });
    }
}

async function runResearch(
    settings: Settings,
    conv: Conversation,
    plan: ResearchPlan,
) {
    const abortSignal = { aborted: false };

    // Listen for abort
    const origAbortCheck = () => agentAbortFlag;

    function progress(text: string) {
        broadcastEvent({ type: 'agent_progress', text, conversationId: conv.id });
    }

    try {
        // ── Phase 1: Open tabs ──
        progress(`📂 Opening ${plan.subTasks.length} tabs...`);

        const tabIds: number[] = [];
        for (const subTask of plan.subTasks) {
            const tabId = await tabManager.createTab(subTask.url, subTask.description);
            tabIds.push(tabId);
            progress(`  📄 Tab ${tabIds.length}: ${subTask.url}`);
        }

        // Small delay for tabs to start loading
        await sleep(2000);

        // ── Phase 2: Run sub-tasks in parallel ──
        progress(`🔄 Running ${plan.subTasks.length} research tasks in parallel...`);

        const resultPromises = plan.subTasks.map((subTask, index) => {
            const tabId = tabIds[index];
            return runSubTask(
                settings,
                subTask,
                tabId,
                (status) => {
                    progress(`  Tab ${index + 1} (${new URL(subTask.url).hostname}): ${status}`);
                    // Check global abort flag
                    if (origAbortCheck()) {
                        abortSignal.aborted = true;
                    }
                },
                abortSignal,
            );
        });

        const results = await Promise.allSettled(resultPromises);

        // Check if aborted
        if (agentAbortFlag) {
            progress('⏹ Research stopped by user.');
            conv.messages.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '⏹ Research stopped by user.',
                timestamp: Date.now(),
            });
            conv.updatedAt = Date.now();
            await saveConversation(conv);
            await tabManager.detachAll();
            broadcastEvent({ type: 'agent_done', conversationId: conv.id });
            return;
        }

        // Collect results
        const subTaskResults: SubTaskResult[] = results.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            return {
                tabId: tabIds[i],
                subTask: plan.subTasks[i],
                status: 'error' as const,
                extractedData: '',
                error: String((r as PromiseRejectedResult).reason),
            };
        });

        // Log per-tab results
        for (const result of subTaskResults) {
            const emoji = result.status === 'success' ? '✅' : result.status === 'timeout' ? '⏰' : '❌';
            progress(`  ${emoji} ${new URL(result.subTask.url).hostname}: ${result.status}`);
        }

        // ── Phase 3: Aggregate results ──
        progress('🧠 Synthesizing research results...');

        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `📊 All ${subTaskResults.length} sources queried. Synthesizing results...`,
            timestamp: Date.now(),
        });
        await saveConversation(conv);

        const synthesis = await aggregateResults(settings, conv.messages[0]?.content || '', subTaskResults);

        // ── Phase 4: Save final answer ──
        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: synthesis,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);

        progress('✅ Research complete!');
        broadcastEvent({ type: 'agent_done', conversationId: conv.id });

    } catch (err) {
        progress(`❌ Research error: ${String(err).slice(0, 100)}`);
        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `❌ Research failed: ${String(err)}`,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);
        broadcastEvent({ type: 'agent_error', error: String(err), conversationId: conv.id });

    } finally {
        // Clean up: detach all debuggers but keep tabs open for user to review
        await tabManager.detachAll();
    }
}

// ─── Lead Generation Orchestrator ───────────────────────────────────────────

/** Entry point for lead generation tasks — auto-detected from AGENT_RUN */
async function runLeadGen(message: { prompt: string; conversationId?: string | null }) {
    const settings = await getSettings();
    agentAbortFlag = false;

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
            title: `🔍 ${message.prompt.slice(0, 55)}`,
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

    function progress(text: string) {
        broadcastEvent({ type: 'agent_progress', text, conversationId: conv!.id });
    }

    try {
        // ── Phase 1: Generate targeted search queries ──
        progress('🧠 Analyzing task and generating targeted search queries...');

        const plan = await generateSearchQueries(settings, message.prompt);

        if (!plan.searchQueries || plan.searchQueries.length === 0) {
            // Fallback to regular agent if no queries generated
            progress('⚠️ Could not generate search queries. Falling back to standard agent...');
            return runAgent(message);
        }

        const queryList = plan.searchQueries
            .map((q, i) => `${i + 1}. [${q.platform}] ${q.query}`)
            .join('\n');

        progress(`📋 Generated ${plan.searchQueries.length} targeted search queries:\n${queryList}`);

        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `🔍 Lead generation mode activated!\n\n**Strategy:** ${plan.reasoning}\n\n**Search queries:**\n${queryList}\n\n🚀 Starting searches...`,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);

        // ── Phase 2: Execute searches and extract leads ──
        progress('🔄 Executing search queries and extracting leads...');

        const abortSignal = { aborted: false };
        const allExtractedData: string[] = [];

        // Open search tabs (limit to 3 at a time to avoid overwhelming)
        const batchSize = 3;
        for (let batchStart = 0; batchStart < plan.searchQueries.length; batchStart += batchSize) {
            if (agentAbortFlag) {
                abortSignal.aborted = true;
                break;
            }

            const batch = plan.searchQueries.slice(batchStart, batchStart + batchSize);
            progress(`🔍 Running search batch ${Math.floor(batchStart / batchSize) + 1}/${Math.ceil(plan.searchQueries.length / batchSize)}...`);

            const tabIds: number[] = [];
            for (const sq of batch) {
                const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(sq.query)}`;
                const tabId = await tabManager.createTab(searchUrl, `Search: ${sq.query}`);
                tabIds.push(tabId);
            }

            // Wait for tabs to load
            await sleep(3000);

            // Run extraction on each tab in parallel
            const extractionPromises = batch.map((sq, idx) => {
                const tabId = tabIds[idx];
                const extractionGoal = buildExtractionPrompt(sq.platform, plan.extractionFields);
                return runSubTask(
                    settings,
                    {
                        description: `Search Google for: ${sq.query} — Then extract lead data from the results.`,
                        url: `https://www.google.com/search?q=${encodeURIComponent(sq.query)}`,
                        extractionGoal,
                    },
                    tabId,
                    (status) => {
                        progress(`  🔎 [${sq.platform}] ${status}`);
                        if (agentAbortFlag) abortSignal.aborted = true;
                    },
                    abortSignal,
                );
            });

            const results = await Promise.allSettled(extractionPromises);

            // Collect extracted data
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                const sq = batch[i];
                if (r.status === 'fulfilled' && r.value.extractedData) {
                    const emoji = r.value.status === 'success' ? '✅' : '⚠️';
                    progress(`  ${emoji} [${sq.platform}] ${r.value.status} — extracted data`);
                    allExtractedData.push(
                        `--- Source: ${sq.platform} (${sq.query}) ---\n${r.value.extractedData}`
                    );
                } else {
                    progress(`  ❌ [${sq.platform}] Failed`);
                }
            }

            // Clean up batch tabs
            for (const tabId of tabIds) {
                await tabManager.detach(tabId);
            }
        }

        // Check if we got any data
        if (allExtractedData.length === 0) {
            conv.messages.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '❌ Could not extract any lead data from the searches. Try being more specific about the industry and location.',
                timestamp: Date.now(),
            });
            conv.updatedAt = Date.now();
            await saveConversation(conv);
            broadcastEvent({ type: 'agent_done', conversationId: conv.id });
            return;
        }

        // Check abort
        if (agentAbortFlag) {
            progress('⏹ Lead generation stopped by user.');
            conv.messages.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '⏹ Lead generation stopped by user.',
                timestamp: Date.now(),
            });
            conv.updatedAt = Date.now();
            await saveConversation(conv);
            await tabManager.detachAll();
            broadcastEvent({ type: 'agent_done', conversationId: conv.id });
            return;
        }

        // Combine all extracted data
        const combinedLeads = allExtractedData.join('\n\n');
        progress(`📊 Extracted leads from ${allExtractedData.length} sources. Processing...`);

        // Use LLM to consolidate and deduplicate the leads
        const consolidationPrompt = `You are a data consolidation assistant. Given raw lead data extracted from multiple search results, consolidate them into a clean, deduplicated list.\n\nFor EACH unique lead, output:\n- Business Name: [name]\n- Platform: [instagram/facebook/etc.]\n- Profile URL: [url]\n- Category: [what they sell/do]\n- Location: [city, country]\n- Contact: [phone/email/WhatsApp or N/A]\n- Has Website: [yes/no]\n- Website: [url or none]\n- Notes: [brief note]\n\nRemove duplicates. Remove non-business results. Format each lead as a separate block separated by a blank line.`;

        const consolidateResponse = await callLLM(settings, consolidationPrompt, [
            {
                id: crypto.randomUUID(),
                role: 'user',
                content: `Consolidate these leads:\n\n${combinedLeads}`,
                timestamp: Date.now(),
            },
        ], []);

        const consolidatedLeads = consolidateResponse.content || combinedLeads;

        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `📋 **Leads gathered:**\n\n${consolidatedLeads}`,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);

        // ── Phase 3: Enter into Google Sheets (if requested) ──
        const promptLower = message.prompt.toLowerCase();
        const wantsSheetEntry = /sheet|spreadsheet|excel|google sheets/i.test(promptLower);

        if (wantsSheetEntry && !agentAbortFlag) {
            progress('📝 Phase 2: Entering leads into Google Sheets...');

            conv.messages.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '📝 Now entering leads into Google Sheets...',
                timestamp: Date.now(),
            });
            await saveConversation(conv);

            // Build the sheet entry prompt and run agent on the sheets tab
            const sheetPrompt = buildSheetEntryPrompt(consolidatedLeads);

            // Find an existing Google Sheets tab, or ask user
            const tabs = await chrome.tabs.query({});
            let sheetsTabId = tabs.find(t =>
                t.url?.includes('docs.google.com/spreadsheets')
            )?.id;

            if (!sheetsTabId) {
                progress('⚠️ No Google Sheet tab found. Opening a new one...');
                sheetsTabId = await openBrowser('https://sheets.google.com');
                await sleep(3000);
            }

            // Run the agent with sheet entry instructions
            // Re-use the main agent loop but with a sheet-specific prompt
            const sheetConvMessages: Message[] = [
                {
                    id: crypto.randomUUID(),
                    role: 'user',
                    content: sheetPrompt,
                    timestamp: Date.now(),
                },
            ];

            let lastSnapshot: Awaited<ReturnType<typeof takeSnapshot>> | null = null;
            let stepCount = 0;
            const SHEET_MAX_STEPS = 40;

            while (stepCount < SHEET_MAX_STEPS && !agentAbortFlag) {
                stepCount++;

                const response = await callLLM(
                    settings,
                    SYSTEM_PROMPT,
                    pruneHistory(sheetConvMessages, 8),
                    BROWSER_TOOLS,
                );

                if (response.toolCalls.length === 0) {
                    progress('✅ Sheet entry complete.');
                    break;
                }

                const assistantMsg: Message = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: response.content || '',
                    toolCalls: response.toolCalls,
                    timestamp: Date.now(),
                };
                sheetConvMessages.push(assistantMsg);

                for (const toolCall of response.toolCalls) {
                    if (agentAbortFlag) break;
                    const args = toolCall.arguments as Record<string, unknown>;
                    let toolResult = '';

                    try {
                        switch (toolCall.name) {
                            case 'task_complete': {
                                progress(`✅ Sheet entry done: ${args.summary || 'Leads entered'}`);
                                stepCount = SHEET_MAX_STEPS; // Break outer loop
                                break;
                            }
                            case 'take_snapshot': {
                                lastSnapshot = await takeSnapshot(sheetsTabId);
                                toolResult = formatSnapshot(lastSnapshot);
                                progress(`📸 Sheet snapshot (${lastSnapshot.elements.length} elements)`);
                                break;
                            }
                            case 'click': {
                                if (!lastSnapshot) { toolResult = 'Error: No snapshot.'; break; }
                                toolResult = await clickElement(args.uid as number, lastSnapshot, sheetsTabId);
                                await sleep(500);
                                try {
                                    lastSnapshot = await takeSnapshot(sheetsTabId);
                                    toolResult += '\n\n--- Page after click ---\n' + formatSnapshot(lastSnapshot);
                                } catch { lastSnapshot = null; }
                                break;
                            }
                            case 'type_text': {
                                if (!lastSnapshot) { toolResult = 'Error: No snapshot.'; break; }
                                toolResult = await typeText(args.text as string, args.uid as number, lastSnapshot, sheetsTabId);
                                await sleep(300);
                                break;
                            }
                            case 'press_key': {
                                toolResult = await pressKey(args.key as string, sheetsTabId);
                                await sleep(300);
                                break;
                            }
                            case 'navigate': {
                                await navigateTo(args.url as string, sheetsTabId);
                                toolResult = `Navigated to ${args.url}.`;
                                lastSnapshot = null;
                                break;
                            }
                            case 'scroll': {
                                toolResult = await scrollPage(args.direction as 'up' | 'down', (args.amount as number) || 500, sheetsTabId);
                                break;
                            }
                            case 'set_value': {
                                if (!lastSnapshot) { toolResult = 'Error: No snapshot.'; break; }
                                toolResult = await setValue(args.uid as number, args.value as string, lastSnapshot, sheetsTabId);
                                await sleep(300);
                                break;
                            }
                            case 'select_option': {
                                if (!lastSnapshot) { toolResult = 'Error: No snapshot.'; break; }
                                toolResult = await selectOption(args.uid as number, args.value as string, lastSnapshot, sheetsTabId);
                                break;
                            }
                            case 'wait_for_page_update': {
                                toolResult = await waitForNetworkIdle(sheetsTabId, 3000);
                                break;
                            }
                            default:
                                toolResult = `Unknown tool: ${toolCall.name}`;
                        }
                    } catch (err) {
                        toolResult = `Tool error: ${String(err)}`;
                    }

                    sheetConvMessages.push({
                        id: crypto.randomUUID(),
                        role: 'tool',
                        content: toolResult,
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        timestamp: Date.now(),
                    });
                }
            }
        }

        // Final message
        const finalContent = wantsSheetEntry
            ? '✅ Lead generation complete! Leads have been gathered and entered into Google Sheets.'
            : '✅ Lead generation complete! Here are the gathered leads above.';

        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: finalContent,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);
        progress(finalContent);
        broadcastEvent({ type: 'agent_done', conversationId: conv.id });

    } catch (err) {
        progress(`❌ Lead generation error: ${String(err).slice(0, 100)}`);
        conv.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `❌ Lead generation failed: ${String(err)}`,
            timestamp: Date.now(),
        });
        conv.updatedAt = Date.now();
        await saveConversation(conv);
        broadcastEvent({ type: 'agent_error', error: String(err), conversationId: conv.id });
    } finally {
        await tabManager.detachAll();
    }
}
