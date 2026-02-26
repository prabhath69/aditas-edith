// Research Orchestrator — coordinates multi-tab parallel research.
// Uses an LLM call to decompose a user prompt into sub-tasks,
// runs independent agent loops per tab, and aggregates results.

import type { StoredSettings, Message } from './storage';
import type { PageSnapshot } from './automation';
import { callLLM } from './llm';
import { tabManager } from './tab_manager';
import {
    takeSnapshot,
    clickElement,
    typeText,
    pressKey,
    scrollPage,
    navigateTo,
    openBrowser,
    detachDebugger,
    selectOption,
    hoverElement,
    setValue,
    waitForNetworkIdle,
} from './automation';
import { formatSnapshot, pruneHistory, BROWSER_TOOLS } from './agent';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SubTask {
    description: string;
    url: string;
    extractionGoal: string;
}

export interface ResearchPlan {
    isResearch: boolean;
    reasoning: string;
    subTasks: SubTask[];
}

export interface SubTaskResult {
    tabId: number;
    subTask: SubTask;
    status: 'success' | 'error' | 'timeout';
    extractedData: string;
    error?: string;
}

export interface ResearchProgress {
    type: 'research_progress';
    phase: 'planning' | 'executing' | 'aggregating' | 'done';
    subTasks: Array<{
        description: string;
        url: string;
        status: string;
    }>;
    conversationId: string;
    summary?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_RESEARCH_TABS = 5;
const SUB_TASK_TIMEOUT_MS = 90_000; // 90 seconds per sub-task
const MAX_SUB_TASK_STEPS = 20;

// ─── Task Decomposition ─────────────────────────────────────────────────────

const DECOMPOSITION_PROMPT = `You are a task analyzer. Given a user prompt, decide if it requires visiting MULTIPLE different websites/platforms to gather and compare information.

ONLY classify as research (isResearch=true) if the task EXPLICITLY requires:
- Comparing the SAME information across DIFFERENT platforms/websites
- Gathering data from MULTIPLE independent sources
- Finding information that requires visiting 2+ different domains

DO NOT classify as research:
- Simple tasks on a single website (search YouTube, order on Amazon, send WhatsApp message)
- Tasks that can be done in one tab
- Tasks where "multiple" refers to multiple items on the same site
- General questions that don't require opening websites

Respond in JSON format ONLY:
{
  "isResearch": boolean,
  "reasoning": "one sentence why",
  "subTasks": [
    {
      "description": "what to do on this tab",
      "url": "starting URL",
      "extractionGoal": "what specific data to extract"
    }
  ]
}

If isResearch is false, return empty subTasks array.`;

/**
 * Analyze a user prompt to determine if it's a multi-tab research task.
 */
export async function decomposeTask(
    settings: StoredSettings,
    prompt: string,
): Promise<ResearchPlan> {
    const messages: Message[] = [
        {
            id: 'decompose-user',
            role: 'user',
            content: prompt,
            timestamp: Date.now(),
        },
    ];

    const response = await callLLM(settings, DECOMPOSITION_PROMPT, messages, []);

    try {
        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = response.content.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();

        const plan = JSON.parse(jsonStr) as ResearchPlan;

        // Enforce max tabs
        if (plan.subTasks.length > MAX_RESEARCH_TABS) {
            plan.subTasks = plan.subTasks.slice(0, MAX_RESEARCH_TABS);
        }

        // Must have at least 2 sub-tasks to be research
        if (plan.subTasks.length < 2) {
            plan.isResearch = false;
            plan.subTasks = [];
        }

        return plan;
    } catch {
        // If parsing fails, treat as non-research
        return { isResearch: false, reasoning: 'Failed to parse decomposition', subTasks: [] };
    }
}

// ─── Sub-Task Agent ─────────────────────────────────────────────────────────

const SUB_TASK_SYSTEM_PROMPT = `You are a research agent assigned to ONE specific tab. Your job is to navigate to a website, find specific information, and extract it.

CRITICAL RULES:
1. NO reasoning, plans, or explanations. Just call tools.
2. Keep text to ONE short sentence MAX.
3. Your ONLY goal is to find the requested information and call extract_data() with it.
4. Call extract_data() as soon as you have the information. This STOPS your execution.
5. NEVER navigate to unrelated URLs.
6. If you cannot find the information after reasonable effort, call extract_data() with whatever you found and a note about what's missing.

WORKFLOW:
1. take_snapshot() → see elements
2. Interact as needed (click, type, press_key) to find the data
3. extract_data(data) → report findings and STOP

READING SNAPSHOTS:
- Each element has: uid | TYPE | "label" [in: section-context]
- INPUT elements show current value
- PAGE TEXT section shows visible content

SEARCH PATTERN:
1. Find a search INPUT.
2. type_text(uid, "query")
3. press_key("Enter")
4. take_snapshot() to see results.
5. Extract the relevant data from the page text.

DO NOT call task_complete — only call extract_data.`;

const SUB_TASK_TOOLS = [
    ...BROWSER_TOOLS.filter((t) => t.name !== 'task_complete' && t.name !== 'open_browser'),
    {
        name: 'extract_data',
        description:
            'Report the extracted data from this tab. Call this when you have found the information you need. This STOPS your execution.',
        parameters: {
            type: 'object',
            properties: {
                data: {
                    type: 'string',
                    description:
                        'The extracted information. Be detailed and include all relevant data points found.',
                },
            },
            required: ['data'],
        },
    },
];

/**
 * Run a single sub-task agent loop on a specific tab.
 * Returns extracted data or error.
 */
export async function runSubTask(
    settings: StoredSettings,
    subTask: SubTask,
    tabId: number,
    onProgress: (status: string) => void,
    abortSignal: { aborted: boolean },
): Promise<SubTaskResult> {
    const messages: Message[] = [
        {
            id: crypto.randomUUID(),
            role: 'user',
            content: `You are on tab for: ${subTask.url}\n\nYour task: ${subTask.description}\n\nExtract this specific data: ${subTask.extractionGoal}\n\nThe page has already been opened for you. Start by calling take_snapshot() to see the page.`,
            timestamp: Date.now(),
        },
    ];

    let lastSnapshot: PageSnapshot | null = null;
    let stepCount = 0;

    // Set up timeout
    const startTime = Date.now();

    try {
        // Attach debugger to this tab
        await tabManager.attach(tabId);
        tabManager.updateState(tabId, { status: 'running' });
        onProgress('Navigating...');

        // Wait for initial page load
        await new Promise((r) => setTimeout(r, 2000));

        while (stepCount < MAX_SUB_TASK_STEPS) {
            // Check abort
            if (abortSignal.aborted) {
                return {
                    tabId,
                    subTask,
                    status: 'error',
                    extractedData: '',
                    error: 'Aborted by user',
                };
            }

            // Check timeout
            if (Date.now() - startTime > SUB_TASK_TIMEOUT_MS) {
                return {
                    tabId,
                    subTask,
                    status: 'timeout',
                    extractedData: lastSnapshot?.rawText?.slice(0, 2000) || 'Timed out before data extraction',
                    error: 'Sub-task timed out',
                };
            }

            stepCount++;

            const response = await callLLM(
                settings,
                SUB_TASK_SYSTEM_PROMPT,
                pruneHistory(messages),
                SUB_TASK_TOOLS,
            );

            if (response.toolCalls.length === 0) {
                // Agent stopped without extracting — use any page text we have
                return {
                    tabId,
                    subTask,
                    status: 'success',
                    extractedData: response.content || lastSnapshot?.rawText?.slice(0, 2000) || 'No data extracted',
                };
            }

            // Record assistant message
            const assistantMsg: Message = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: response.content || '',
                toolCalls: response.toolCalls,
                timestamp: Date.now(),
            };
            messages.push(assistantMsg);

            // Execute tool calls
            for (const toolCall of response.toolCalls) {
                if (abortSignal.aborted) break;

                const args = toolCall.arguments as Record<string, unknown>;
                let toolResult = '';

                try {
                    switch (toolCall.name) {
                        case 'extract_data': {
                            const data = (args.data as string) || '';
                            tabManager.updateState(tabId, {
                                status: 'done',
                                extractedData: data,
                            });
                            onProgress('Data extracted ✓');
                            return {
                                tabId,
                                subTask,
                                status: 'success',
                                extractedData: data,
                            };
                        }
                        case 'take_snapshot': {
                            lastSnapshot = await takeSnapshot(tabId);
                            toolResult = formatSnapshot(lastSnapshot);
                            onProgress(`Reading page (${lastSnapshot.elements.length} elements)`);
                            break;
                        }
                        case 'click': {
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await clickElement(args.uid as number, lastSnapshot, tabId);
                                await new Promise((r) => setTimeout(r, 800));
                                try {
                                    lastSnapshot = await takeSnapshot(tabId);
                                    toolResult += '\n\n--- Page after click ---\n' + formatSnapshot(lastSnapshot);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            onProgress('Interacting...');
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
                                    tabId,
                                );
                                await new Promise((r) => setTimeout(r, 1000));
                                try {
                                    lastSnapshot = await takeSnapshot(tabId);
                                    toolResult += '\n\n--- Page after typing ---\n' + formatSnapshot(lastSnapshot);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            onProgress('Typing...');
                            break;
                        }
                        case 'press_key': {
                            toolResult = await pressKey(args.key as string, tabId);
                            const navigated = toolResult.includes('navigated');
                            await new Promise((r) => setTimeout(r, navigated ? 1500 : 300));
                            try {
                                lastSnapshot = await takeSnapshot(tabId);
                                toolResult += '\n\n--- Page after key press ---\n' + formatSnapshot(lastSnapshot);
                            } catch {
                                lastSnapshot = null;
                            }
                            onProgress('Navigating...');
                            break;
                        }
                        case 'navigate': {
                            await navigateTo(args.url as string, tabId);
                            toolResult = `Navigated to ${args.url}. Call take_snapshot to see the page.`;
                            lastSnapshot = null;
                            onProgress('Navigating...');
                            break;
                        }
                        case 'scroll': {
                            toolResult = await scrollPage(
                                args.direction as 'up' | 'down',
                                (args.amount as number) || 500,
                                tabId,
                            );
                            onProgress('Scrolling...');
                            break;
                        }
                        // ─── BrowserOS-level tools ───
                        case 'select_option': {
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await selectOption(
                                    args.uid as number,
                                    args.value as string,
                                    lastSnapshot,
                                    tabId,
                                );
                                await waitForNetworkIdle(tabId, 3000).catch(() => { });
                                await new Promise((r) => setTimeout(r, 500));
                                try {
                                    lastSnapshot = await takeSnapshot(tabId);
                                    toolResult += '\n\n--- Page after select ---\n' + formatSnapshot(lastSnapshot);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            onProgress('Selecting option...');
                            break;
                        }
                        case 'hover': {
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await hoverElement(
                                    args.uid as number,
                                    lastSnapshot,
                                    tabId,
                                );
                                try {
                                    lastSnapshot = await takeSnapshot(tabId);
                                    toolResult += '\n\n--- Page after hover ---\n' + formatSnapshot(lastSnapshot);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            onProgress('Hovering...');
                            break;
                        }
                        case 'set_value': {
                            if (!lastSnapshot) {
                                toolResult = 'Error: No snapshot. Call take_snapshot first.';
                            } else {
                                toolResult = await setValue(
                                    args.uid as number,
                                    args.value as string,
                                    lastSnapshot,
                                    tabId,
                                );
                                await new Promise((r) => setTimeout(r, 300));
                                try {
                                    lastSnapshot = await takeSnapshot(tabId);
                                    toolResult += '\n\n--- Page after set_value ---\n' + formatSnapshot(lastSnapshot);
                                } catch {
                                    lastSnapshot = null;
                                }
                            }
                            onProgress('Setting value...');
                            break;
                        }
                        case 'wait_for_page_update': {
                            toolResult = await waitForNetworkIdle(tabId, 5000);
                            await new Promise((r) => setTimeout(r, 500));
                            try {
                                lastSnapshot = await takeSnapshot(tabId);
                                toolResult += '\n\n--- Page after update ---\n' + formatSnapshot(lastSnapshot);
                            } catch {
                                lastSnapshot = null;
                            }
                            onProgress('Waiting for update...');
                            break;
                        }
                        default:
                            toolResult = `Unknown tool: ${toolCall.name}`;
                    }
                } catch (err) {
                    toolResult = `Tool error: ${String(err)}`;
                }

                messages.push({
                    id: crypto.randomUUID(),
                    role: 'tool',
                    content: toolResult,
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    timestamp: Date.now(),
                });
            }
        }

        // Hit max steps — return whatever we have
        return {
            tabId,
            subTask,
            status: 'success',
            extractedData: lastSnapshot?.rawText?.slice(0, 2000) || 'Max steps reached, limited data available',
        };
    } catch (err) {
        return {
            tabId,
            subTask,
            status: 'error',
            extractedData: '',
            error: String(err),
        };
    }
}

// ─── Result Aggregation ─────────────────────────────────────────────────────

const AGGREGATION_PROMPT = `You are a research synthesis assistant. You have been given data extracted from multiple web sources in parallel. Your job is to provide a clear, well-organized summary that answers the user's original question.

Rules:
- Combine and compare the data from all sources
- Highlight key differences and similarities
- Be concise but thorough
- Use tables or bullet points for comparisons
- Note if any source had errors or missing data
- Cite which source each piece of information came from`;

/**
 * Aggregate results from all sub-tasks into a unified answer.
 */
export async function aggregateResults(
    settings: StoredSettings,
    originalPrompt: string,
    results: SubTaskResult[],
): Promise<string> {
    // Build a summary of all sub-task results
    const resultsSummary = results
        .map((r, i) => {
            const statusEmoji = r.status === 'success' ? '✅' : r.status === 'timeout' ? '⏰' : '❌';
            return `--- Source ${i + 1}: ${r.subTask.url} (${statusEmoji} ${r.status}) ---\nGoal: ${r.subTask.extractionGoal}\n\n${r.extractedData || r.error || 'No data'}`;
        })
        .join('\n\n');

    const messages: Message[] = [
        {
            id: crypto.randomUUID(),
            role: 'user',
            content: `Original question: ${originalPrompt}\n\nHere are the research results from ${results.length} sources:\n\n${resultsSummary}\n\nPlease synthesize these findings into a clear, comprehensive answer.`,
            timestamp: Date.now(),
        },
    ];

    const response = await callLLM(settings, AGGREGATION_PROMPT, messages, []);
    return response.content || 'Unable to synthesize results.';
}
