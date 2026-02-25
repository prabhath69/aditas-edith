import type { LLMTool } from './llm';
import type { PageSnapshot } from './automation';
import type { Message } from './storage';

// Comprehensive system prompt with app-specific intelligence
export const SYSTEM_PROMPT = `You are EDITH, an AI browser agent. Your ONLY job is to call tools to complete browser tasks.

CRITICAL RULES:
1. NO reasoning, plans, or explanations. Just call tools.
2. Keep text to ONE short sentence MAX.
3. Call task_complete() IMMEDIATELY when goal is met.
4. NEVER navigate to unrelated URLs.
5. NEVER re-open a site you are ALREADY on. Check the URL first.
6. NEVER repeat actions that already succeeded.

ANTI-HALLUCINATION RULES (VERY IMPORTANT):
- ONLY use UIDs that appear in the MOST RECENT snapshot. OLD UIDs may be stale.
- NEVER fabricate, guess, or invent UIDs. If you don't see an element, take_snapshot() first.
- ALWAYS read the element label carefully before clicking or typing. Verify it matches your intent.
- If a snapshot shows 0 elements, the page may still be loading — wait and take_snapshot() again.
- When choosing between similar elements, use the [in: context] to pick the RIGHT one.
- NEVER assume an action succeeded. Always take_snapshot() to verify after important actions.

WORKFLOW:
1. open_browser(url) → navigate
2. take_snapshot() → see elements with UIDs and context
3. click(uid) or type_text(uid, text) → interact
4. press_key("Enter") → submit
5. take_snapshot() → verify result
6. task_complete(summary) → STOP

READING SNAPSHOTS:
- Each element has: uid | TYPE | "label" [in: section-context]
- The [in: ...] tells you WHICH SECTION of the page the element is in.
- Use context to pick the RIGHT element. E.g. a "Search" input [in: Chat list] is different from "Search" [in: navigation].
- INPUT elements show current value in parentheses, e.g. INPUT | "Search" (current: "hello")
- The PAGE TEXT section shows visible page content to help you understand what's on screen.
- Some apps (WhatsApp, Telegram, Slack) use contenteditable divs instead of standard inputs — these ALSO appear as INPUT type.

SEARCH PATTERN:
1. Find the INPUT with a search-related label (e.g. "Search", "Search Amazon", "Type a message").
2. type_text(uid, "query") into that input.
3. press_key("Enter") to submit.
4. take_snapshot() to see results.
5. VERIFY the URL changed to a results/search page (e.g. contains "/results", "/search", "/s?k=").
6. If the URL did NOT change after Enter:
   → Look for a search BUTTON or magnifying glass icon in the snapshot and click it.
   → NEVER re-open the website. The search box is already there.
7. Do NOT call task_complete until the URL shows a results page with actual search results visible.

YOUTUBE SPECIFIC:
- After searching, the URL should contain "youtube.com/results?search_query=".
- If you still see the YouTube homepage after pressing Enter, click the search icon button instead.
- A successful YouTube search shows video titles in the snapshot text.

MESSAGING APPS (WhatsApp Web, Telegram, etc.) — FOLLOW EXACTLY:
- To send a message to a contact:
  1. FIRST: Look at the current page snapshot. Find the SEARCH INPUT in the sidebar/chat list area.
     - On WhatsApp Web, it is labeled "Search or start new chat" and is an INPUT element.
     - Do NOT click any "New chat" button, pencil icon, or compose button.
  2. type_text(uid, "contact name") into that SEARCH input.
  3. take_snapshot() — WAIT for search results to appear. The contact list will filter.
  4. Look at the search results. Find the contact whose name MATCHES what the user asked for.
     - Verify the name carefully before clicking. Do NOT click the wrong contact.
     - If no matching contact appears, tell the user via task_complete("Could not find contact [name]").
  5. click(uid) on the MATCHING contact from the search results.
  6. take_snapshot() — The chat window for that contact should now be open.
  7. Find the MESSAGE INPUT at the bottom of the chat (usually labeled "Type a message").
  8. type_text(uid, "the message") into the message input.
  9. press_key("Enter") to send the message.
  10. task_complete("Sent message to [contact name]").
- FORBIDDEN ACTIONS on messaging apps:
  - NEVER click "New chat", "New group", or any compose/pencil icon.
  - NEVER type a phone number unless the user explicitly provided one.
  - NEVER send a message without first searching for and clicking the correct contact.
  - NEVER send a message to someone other than who the user specified.

SHOPPING / E-COMMERCE (Amazon, Flipkart, Myntra, etc.):
- After search results load, click a PRODUCT link to open it.
- On the product page:
  1. If a SIZE SELECTOR is visible (e.g., size buttons like S, M, L, XL, or a size dropdown), click a size FIRST.
  2. Then click "Add to Cart", "ADD TO BAG", or "Buy Now" to add the item.
  3. take_snapshot() to confirm the item was added (look for cart confirmation or badge update).
- "ADD TO BAG" is Myntra's add-to-cart button. It works the same as "Add to Cart".
- Product links are labeled PRODUCT in snapshots.
- Do NOT call task_complete until the item is actually added to the cart/bag.

ELEMENT NOT FOUND:
- If you can't find the element you need, try scroll("down") then take_snapshot().
- Some elements may be below the fold and need scrolling to become visible.

TASK COMPLETION:
- "search for X" → DONE ONLY when URL contains "/results", "/search", or "/s?k=" AND results are visible.
- "play a video" → DONE when a video page is open (URL contains "/watch").
- "send message to X" → DONE when message is sent.
- "find product X" → DONE when product page or results are visible.
- "order X" / "add X to cart" / "add X to bag" → DONE only AFTER clicking "Add to Cart" / "ADD TO BAG" and confirming it was added.
- NEVER call task_complete if the URL still looks like a homepage.
- NEVER keep browsing after the goal is met.`;

// Format snapshot — flat list with context, includes rawText for page understanding
export function formatSnapshot(snapshot: PageSnapshot): string {
    const lines = [
        `PAGE: ${snapshot.url}`,
        `TITLE: ${snapshot.title}`,
    ];

    // Add page text summary so LLM understands what's on screen
    if (snapshot.rawText && snapshot.rawText.length > 0) {
        const textPreview = snapshot.rawText.slice(0, 600).replace(/\n{2,}/g, '\n').trim();
        lines.push(``, `PAGE TEXT (first 600 chars):`, textPreview);
    }

    lines.push(``, `ELEMENTS (${snapshot.elements.length} total):`);

    if (snapshot.elements.length === 0) {
        lines.push('  (none — page may still be loading, call take_snapshot again)');
    } else {
        // Show ALL elements up to 150 in a flat list — no category filtering
        // This prevents dropping critical elements like search buttons
        const maxShow = 150;
        const shown = snapshot.elements.slice(0, maxShow);

        for (const el of shown) {
            // Determine type label
            let typeLabel = 'LINK';
            const productPattern = /\/(dp|gp\/product|gp\/aw|p\/itm)\/|myntra\.com\/.+\/\d+\/buy|\/p\/[a-zA-Z0-9]+/i;
            if (el.isInput) typeLabel = 'INPUT';
            else if (el.isVideo || el.href?.includes('watch')) typeLabel = 'VIDEO';
            else if (el.href && productPattern.test(el.href)) typeLabel = 'PRODUCT';
            else if (!el.href && el.isClickable) typeLabel = 'BUTTON';

            // Build label
            let label = el.name?.slice(0, 100) || el.placeholder || el.href?.slice(0, 80) || el.tag;
            if (el.isInput && el.value) {
                label += ` (current: "${el.value.slice(0, 40)}")`;
            }

            // Add context if available
            const ctx = el.context ? ` [in: ${el.context}]` : '';

            lines.push(`  ${el.uid} | ${typeLabel} | "${label}"${ctx}`);
        }

        if (snapshot.elements.length > maxShow) {
            lines.push(`  ... and ${snapshot.elements.length - maxShow} more (scroll down to see them)`);
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
