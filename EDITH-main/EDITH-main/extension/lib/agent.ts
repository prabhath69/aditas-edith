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

ELEMENT STATES IN SNAPSHOTS:
- CHECKBOX elements show [checked] or [unchecked] — click to toggle.
- RADIO elements show [selected] or [unselected].
- SELECT elements show the currently selected option and list available options.
  Use select_option(uid, "value or text") to change the selection — do NOT use click().
- Elements with [expanded] have their sub-menus/panels visible.
- [disabled] elements cannot be interacted with — skip them.

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

FILTER / DROPDOWN PATTERN (Amazon, Flipkart, e-commerce):
1. take_snapshot() — the filter sidebar shows CHECKBOXes and SELECT dropdowns.
2. For checkbox filters (brand, rating, etc.): click(uid) on the checkbox element.
3. For <select> dropdowns (e.g. "Sort by"): use select_option(uid, "option text or value").
4. After clicking ANY filter or changing a select: call wait_for_page_update() — pages update via AJAX without full navigation.
5. take_snapshot() — verify the filtered results appear.
6. NEVER re-navigate to the page after clicking a filter. The page updates in-place.
7. For price range filters: use set_value(uid, "amount") on the min/max input fields, then click "Go".
8. When scrolling through filter options, look for "See more" links to expand the filter list.

HOVER MENUS:
- Some navigation menus require hovering to reveal sub-menus (e.g. Amazon departments).
- Use hover(uid) to trigger mouseover, then take_snapshot() to see the revealed menu items.
- Click the desired item from the revealed menu.

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
     - For <select> size dropdowns, use select_option(uid, "size value").
  2. If a COLOR SELECTOR is visible, click the desired color swatch.
  3. Then click "Add to Cart", "ADD TO BAG", or "Buy Now" to add the item.
  4. take_snapshot() to confirm the item was added (look for cart confirmation or badge update).
- "ADD TO BAG" is Myntra's add-to-cart button. It works the same as "Add to Cart".
- Product links are labeled PRODUCT in snapshots.
- Do NOT call task_complete until the item is actually added to the cart/bag.
- For sorting results: find the sort-by SELECT dropdown and use select_option(uid, "Sort option text").
  Then call wait_for_page_update() and take_snapshot() to see sorted results.

GMAIL / EMAIL COMPOSE:
- After clicking "Compose", ALWAYS call take_snapshot() — the compose popup needs time to fully render.
- The "To" recipients field is a contenteditable div. Look for an INPUT element labeled "To", "Recipients", or with placeholder "Recipients".
- After typing the recipient email address into the To field, ALWAYS press_key("Tab") to confirm it (this converts the text into a recipient chip).
- Then find the "Subject" INPUT field and type the subject line.
- The email body is a large contenteditable div — look for it labeled "Message Body" or similar. Type your message there.
- Finally, click the "Send" button (usually labeled "Send" with a tooltip).
- CORRECT ORDER: type_text(To, email) → press_key("Tab") → type_text(Subject, text) → type_text(Body, text) → click(Send).
- If the To field shows 0 elements or looks empty after clicking Compose, wait and take_snapshot() again.

ELEMENT NOT FOUND:
- If you can't find the element you need, try scroll("down") then take_snapshot().
- Some elements may be below the fold and need scrolling to become visible.
- For filters that are collapsed, look for an element with [collapsed] and click it to expand.

TASK COMPLETION:
- "search for X" → DONE ONLY when URL contains "/results", "/search", or "/s?k=" AND results are visible.
- "play a video" → DONE when a video page is open (URL contains "/watch").
- "send message to X" → DONE when message is sent.
- "find product X" → DONE when product page or results are visible.
- "order X" / "add X to cart" / "add X to bag" → DONE only AFTER clicking "Add to Cart" / "ADD TO BAG" and confirming it was added.
- "filter by X" → DONE only AFTER clicking the filter AND wait_for_page_update() AND verifying filtered results.
- "sort by X" → DONE only AFTER select_option on sort dropdown AND wait_for_page_update() AND verifying sorted results.
- NEVER call task_complete if the URL still looks like a homepage.
- NEVER keep browsing after the goal is met.`;

// Format snapshot — flat list with context, includes rawText for page understanding
// BrowserOS-level: shows element states (checked, disabled, expanded), select options,
// and uses more specific type labels (CHECKBOX, SELECT, RADIO)
// Smart prioritization: inputs → buttons/checkboxes → products → links
export function formatSnapshot(snapshot: PageSnapshot): string {
    const lines = [
        `PAGE: ${snapshot.url}`,
        `TITLE: ${snapshot.title}`,
    ];

    // Add page text summary so LLM understands what's on screen
    if (snapshot.rawText && snapshot.rawText.length > 0) {
        const textPreview = snapshot.rawText.slice(0, 800).replace(/\n{2,}/g, '\n').trim();
        lines.push(``, `PAGE TEXT (first 800 chars):`, textPreview);
    }

    lines.push(``, `ELEMENTS (${snapshot.elements.length} total):`);

    if (snapshot.elements.length === 0) {
        lines.push('  (none — page may still be loading, call take_snapshot again)');
    } else {
        const productPattern = /\/(dp|gp\/product|gp\/aw|p\/itm)\/|myntra\.com\/.+\/\d+\/buy|\/p\/[a-zA-Z0-9]+/i;

        // Classify elements into priority tiers
        type Tier = { el: typeof snapshot.elements[0]; typeLabel: string; label: string; state: string; ctx: string };
        const tier1: Tier[] = []; // Inputs, selects, textareas (highest priority)
        const tier2: Tier[] = []; // Buttons, checkboxes, radios
        const tier3: Tier[] = []; // Products, videos
        const tier4: Tier[] = []; // Other links

        for (const el of snapshot.elements) {
            // Determine type label
            let typeLabel = 'LINK';
            if (el.isSelect || el.tag === 'select') typeLabel = 'SELECT';
            else if (el.type === 'checkbox' || el.role === 'checkbox' || el.role === 'switch') typeLabel = 'CHECKBOX';
            else if (el.type === 'radio' || el.role === 'radio') typeLabel = 'RADIO';
            else if (el.isInput) typeLabel = 'INPUT';
            else if (el.isVideo || el.href?.includes('watch')) typeLabel = 'VIDEO';
            else if (el.href && productPattern.test(el.href)) typeLabel = 'PRODUCT';
            else if (!el.href && el.isClickable) typeLabel = 'BUTTON';

            // Build label
            let label = el.name?.slice(0, 100) || el.placeholder || el.href?.slice(0, 80) || el.tag;
            if (el.isInput && el.value) {
                label += ` (current: "${el.value.slice(0, 40)}")`;
            }

            // Add element state annotations
            let state = '';
            if (el.checked === true) state += ' [checked]';
            else if (el.checked === false && (typeLabel === 'CHECKBOX' || typeLabel === 'RADIO')) state += ' [unchecked]';
            if (el.disabled) state += ' [disabled]';
            if (el.ariaExpanded === 'true') state += ' [expanded]';
            else if (el.ariaExpanded === 'false') state += ' [collapsed]';

            const ctx = el.context ? ` [in: ${el.context}]` : '';

            const item: Tier = { el, typeLabel, label, state, ctx };

            // Sort into priority tiers
            if (typeLabel === 'INPUT' || typeLabel === 'SELECT') tier1.push(item);
            else if (typeLabel === 'BUTTON' || typeLabel === 'CHECKBOX' || typeLabel === 'RADIO') tier2.push(item);
            else if (typeLabel === 'PRODUCT' || typeLabel === 'VIDEO') tier3.push(item);
            else tier4.push(item);
        }

        // Combine tiers with priority ordering, cap total at 150
        const maxShow = 150;
        const ordered = [...tier1, ...tier2, ...tier3, ...tier4];
        const shown = ordered.slice(0, maxShow);

        // Add action hints if we detect specific page patterns
        const hasCheckboxes = tier2.some(t => t.typeLabel === 'CHECKBOX');
        const hasSelects = tier1.some(t => t.typeLabel === 'SELECT');
        const hasProducts = tier3.length > 0;
        if (hasCheckboxes || hasSelects) {
            lines.push(`  💡 FILTERS DETECTED: ${hasCheckboxes ? 'Use click(uid) on CHECKBOX to filter. ' : ''}${hasSelects ? 'Use select_option(uid, "text") on SELECT to sort/filter. ' : ''}After filtering, call wait_for_page_update().`);
        }
        if (hasProducts) {
            lines.push(`  💡 ${tier3.length} PRODUCTS found — click a PRODUCT link to view details.`);
        }

        for (const item of shown) {
            lines.push(`  ${item.el.uid} | ${item.typeLabel} | "${item.label}"${item.state}${item.ctx}`);

            // For SELECT elements, list available options (up to 8)
            if (item.el.options && item.el.options.length > 0) {
                const optionsList = item.el.options.slice(0, 8)
                    .map(o => `${o.selected ? '→ ' : '  '}"${o.text}"`)
                    .join(', ');
                lines.push(`        options: [${optionsList}${item.el.options.length > 8 ? `, ... +${item.el.options.length - 8} more` : ''}]`);
            }
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
    // ─── BrowserOS-level tools ───
    {
        name: 'select_option',
        description: 'Select an option from a <select> dropdown by value or visible text. Use this instead of click() for SELECT elements (e.g. sort-by dropdowns, size selectors).',
        parameters: {
            type: 'object',
            properties: {
                uid: { type: 'number', description: 'UID of the <select> element from snapshot' },
                value: { type: 'string', description: 'Option value or visible text to select' },
            },
            required: ['uid', 'value'],
        },
    },
    {
        name: 'hover',
        description: 'Hover over an element to reveal dropdown menus, tooltips, or sub-menus. Use for navigation mega-menus.',
        parameters: {
            type: 'object',
            properties: {
                uid: { type: 'number', description: 'UID of element to hover over' },
            },
            required: ['uid'],
        },
    },
    {
        name: 'set_value',
        description: 'Set the value of an input field directly. Use for price range fields, quantity selectors, etc. More reliable than type_text for numeric inputs.',
        parameters: {
            type: 'object',
            properties: {
                uid: { type: 'number', description: 'UID of the input element' },
                value: { type: 'string', description: 'Value to set' },
            },
            required: ['uid', 'value'],
        },
    },
    {
        name: 'wait_for_page_update',
        description: 'Wait for the page to finish loading after AJAX/filter changes. ALWAYS call this after clicking a filter, changing a select option, or any action that triggers a page update without navigation.',
        parameters: { type: 'object', properties: {} },
    },
];
