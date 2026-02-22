import type { LLMTool } from './llm';
import type { PageSnapshot } from './automation';
import type { Message } from './storage';

// Tight, action-only system prompt — prevents verbose reasoning and policy flags
export const SYSTEM_PROMPT = `You are EDITH, an AI browser agent. Your ONLY job is to call tools to complete browser tasks.

CRITICAL RULES — READ CAREFULLY:
1. DO NOT write reasoning, plans, or explanations while calling tools. Just call the next tool.
2. Keep any text to ONE short sentence MAX when you do write.
3. When the task is complete, call task_complete() IMMEDIATELY. Do NOT keep interacting with the page.
4. Do NOT navigate to any website other than what is needed for the task. Never go to unrelated URLs.
5. Do NOT interact with pages after the task goal is achieved — call task_complete() and stop.
6. Do NOT re-play, re-click, or re-interact with something after it's done.

BROWSER WORKFLOW:
1. open_browser(url) → navigate to the correct site
2. take_snapshot() → see elements with UIDs
3. click(uid) or type_text(uid, text) → interact
4. press_key("Enter") → submit
5. take_snapshot() → confirm result
6. task_complete(summary) → STOP

TASK COMPLETION:
- Once the user's goal is achieved, immediately call task_complete() with a short summary.
- "Go to YouTube and search for X" is DONE when the search results page is showing. Do NOT click videos.
- "Find a product on Amazon" is DONE when the product page or results are visible.
- NEVER keep browsing or clicking after the stated goal is met.`;

// Format snapshot — concise, no value leaks
export function formatSnapshot(snapshot: PageSnapshot): string {
    const lines = [
        `URL: ${snapshot.url}`,
        `Title: ${snapshot.title}`,
        ``,
        `ELEMENTS (uid | type | label):`,
    ];

    if (snapshot.elements.length === 0) {
        lines.push('(none — page may be loading, call take_snapshot again)');
    } else {
        const inputs = snapshot.elements.filter((e) => e.isInput).slice(0, 8);
        const videos = snapshot.elements.filter((e) => e.isVideo || e.href?.includes('watch')).slice(0, 8);
        const buttons = snapshot.elements.filter((e) => !e.isVideo && !e.isInput && !e.href && e.isClickable).slice(0, 8);
        const links = snapshot.elements.filter((e) => !e.isVideo && !e.isInput && !e.href?.includes('watch') && e.href).slice(0, 10);

        for (const el of inputs) {
            lines.push(`  ${el.uid} | INPUT | "${el.placeholder || el.name || el.tag}"`);
        }
        for (const el of videos) {
            lines.push(`  ${el.uid} | VIDEO | ${el.name.slice(0, 70) || el.href}`);
        }
        for (const el of buttons) {
            lines.push(`  ${el.uid} | BUTTON | "${el.name.slice(0, 60)}"`);
        }
        for (const el of links) {
            lines.push(`  ${el.uid} | LINK | ${el.name.slice(0, 60) || el.href}`);
        }
    }

    return lines.join('\n');
}

// Prune conversation history to keep only last N tool exchanges
export function pruneHistory(messages: Message[], maxToolRounds = 6): Message[] {
    const kept = new Set<string>();
    let toolRound = 0;
    const reversed = [...messages].reverse();

    for (const msg of reversed) {
        if (msg.role === 'user') {
            kept.add(msg.id);
        } else if (msg.role === 'tool') {
            if (toolRound < maxToolRounds) kept.add(msg.id);
            toolRound++;
        } else if (msg.role === 'assistant') {
            if (toolRound <= maxToolRounds) kept.add(msg.id);
        }
    }

    return messages.filter((m) => kept.has(m.id));
}

// Sentinel value returned when task_complete is called
export const TASK_COMPLETE_SIGNAL = '__TASK_COMPLETE__';

// All browser automation tools exposed to the LLM
export const BROWSER_TOOLS: LLMTool[] = [
    {
        name: 'task_complete',
        description: 'Call this when the task is fully done. This STOPS the agent. Always call this when the goal is achieved — do not keep browsing.',
        parameters: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description: 'One sentence describing what was accomplished.',
                },
            },
            required: ['summary'],
        },
    },
    {
        name: 'open_browser',
        description: 'Open a URL in a new browser tab.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Full URL, e.g. "https://youtube.com"' },
            },
            required: ['url'],
        },
    },
    {
        name: 'navigate',
        description: 'Navigate current tab to a URL. Only use URLs directly relevant to the task.',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
        },
    },
    {
        name: 'take_snapshot',
        description: 'Get all interactive elements on the current page with UIDs. Call after every navigation or action.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'click',
        description: 'Click an element by its UID from the snapshot.',
        parameters: {
            type: 'object',
            properties: {
                uid: { type: 'number', description: 'UID from snapshot' },
            },
            required: ['uid'],
        },
    },
    {
        name: 'type_text',
        description: 'Type text into an input field by UID.',
        parameters: {
            type: 'object',
            properties: {
                uid: { type: 'number' },
                text: { type: 'string' },
            },
            required: ['uid', 'text'],
        },
    },
    {
        name: 'press_key',
        description: 'Press a keyboard key: Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace.',
        parameters: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
        },
    },
    {
        name: 'scroll',
        description: 'Scroll the page up or down.',
        parameters: {
            type: 'object',
            properties: {
                direction: { type: 'string', enum: ['up', 'down'] },
                amount: { type: 'number', description: 'Pixels, default 500' },
            },
            required: ['direction'],
        },
    },
    {
        name: 'screenshot',
        description: 'Take a screenshot of the current page.',
        parameters: { type: 'object', properties: {} },
    },
];
