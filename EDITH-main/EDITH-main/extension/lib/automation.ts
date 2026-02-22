// Chrome Debugger CDP-based browser automation
// Attaches to the active tab via chrome.debugger and sends CDP commands

export interface SnapshotElement {
    uid: number;
    tag: string;
    role: string;
    name: string;
    href?: string;
    type?: string;
    value?: string;
    placeholder?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isClickable: boolean;
    isInput: boolean;
    isVideo: boolean;
}

export interface PageSnapshot {
    url: string;
    title: string;
    elements: SnapshotElement[];
    rawText: string;
}

let attachedTabId: number | null = null;

async function ensureAttached(tabId: number): Promise<void> {
    if (attachedTabId === tabId) return;

    // Detach from previous tab if needed
    if (attachedTabId !== null) {
        try {
            await chrome.debugger.detach({ tabId: attachedTabId });
        } catch {
            // Ignore errors when detaching
        }
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabId = tabId;

    // Clean up when detached externally (e.g. DevTools opened)
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId === tabId) {
            attachedTabId = null;
        }
    });
}

// Low-level CDP send
async function cdp<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
): Promise<T> {
    return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>;
}

export async function navigateTo(url: string, tabId?: number): Promise<void> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Normalize URL
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('chrome://')) {
        url = 'https://' + url;
    }

    await cdp(id, 'Page.navigate', { url });
    // Wait for page load
    await waitForLoad(id);
}

async function waitForLoad(tabId: number, timeout = 15000): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeout);

        function listener(source: chrome.debugger.Debuggee, method: string) {
            if (source.tabId === tabId && method === 'Page.loadEventFired') {
                clearTimeout(timer);
                chrome.debugger.onEvent.removeListener(listener);
                // Small delay for JS to hydrate the page
                setTimeout(resolve, 800);
            }
        }

        chrome.debugger.onEvent.addListener(listener);
        // Enable Page events
        cdp(tabId, 'Page.enable').catch(() => { });
    });
}

// Build a DOM snapshot using CDP Runtime.evaluate
// Returns structured elements with UIDs for the LLM to reference
export async function takeSnapshot(tabId?: number): Promise<PageSnapshot> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    const result = await cdp<{ result: { value: string } }>(id, 'Runtime.evaluate', {
        expression: `(${snapshotScript.toString()})()`,
        returnByValue: true,
        awaitPromise: false,
    });

    return JSON.parse(result.result.value) as PageSnapshot;
}

// Injected snapshot script — runs inside the page context
const snapshotScript = function () {
    interface El {
        uid: number;
        tag: string;
        role: string;
        name: string;
        href?: string;
        type?: string;
        value?: string;
        placeholder?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        isClickable: boolean;
        isInput: boolean;
        isVideo: boolean;
    }

    const CLICKABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
    const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
    const elements: El[] = [];
    let uidCounter = 1;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);

    function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
            return false;
        return true;
    }

    function getRole(el: Element): string {
        return (
            el.getAttribute('role') ||
            el.tagName.toLowerCase()
        );
    }

    function getName(el: Element): string {
        return (
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            (el as HTMLElement).innerText?.slice(0, 80).trim() ||
            el.getAttribute('alt') ||
            el.getAttribute('name') ||
            ''
        );
    }

    let node: Element | null;
    while ((node = walker.nextNode() as Element | null)) {
        const tag = node.tagName;
        const hasClickHandler = CLICKABLE_TAGS.has(tag) || node.getAttribute('onclick') !== null;
        const hasRole = node.getAttribute('role') !== null;
        const isLink = tag === 'A';
        const isInput = INPUT_TAGS.has(tag);
        const inputType = (node as HTMLInputElement).type?.toLowerCase();
        // SECURITY: Never include password/hidden fields in snapshots sent to the LLM
        if (isInput && (inputType === 'password' || inputType === 'hidden')) continue;
        const isButton = tag === 'BUTTON' || node.getAttribute('role') === 'button';
        const isVideo = tag === 'VIDEO' || node.getAttribute('data-testid')?.includes('video') || false;

        if (!hasClickHandler && !hasRole && !isVideo) continue;
        if (!isVisible(node)) continue;

        const rect = node.getBoundingClientRect();

        elements.push({
            uid: uidCounter++,
            tag: tag.toLowerCase(),
            role: getRole(node),
            name: getName(node),
            href: (node as HTMLAnchorElement).href || undefined,
            type: inputType || undefined,
            // SECURITY: .value intentionally omitted — never send field contents to LLM
            placeholder: node.getAttribute('placeholder') || undefined,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            isClickable: hasClickHandler || isLink || isButton,
            isInput,
            isVideo,
        });
    }

    return JSON.stringify({
        url: location.href,
        title: document.title,
        elements,
        rawText: document.body.innerText.slice(0, 3000),
    });
};

export async function clickElement(
    uid: number,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) {
        return `Error: Element with UID ${uid} not found in snapshot. Take a new snapshot first.`;
    }

    // If it has an href and clicking by coordinates might fail, navigate to href directly
    if (el.href && el.href.startsWith('http')) {
        await ensureAttached(id);
        try {
            const centerX = el.x + el.width / 2;
            const centerY = el.y + el.height / 2;
            await cdp(id, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: centerX,
                y: centerY,
                button: 'left',
                clickCount: 1,
            });
            await cdp(id, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: centerX,
                y: centerY,
                button: 'left',
                clickCount: 1,
            });
        } catch {
            // Fallback: navigate to href directly
            await navigateTo(el.href, id);
        }
        return `Clicked element "${el.name}" (${el.tag})`;
    }

    await ensureAttached(id);
    const centerX = el.x + el.width / 2;
    const centerY = el.y + el.height / 2;

    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: centerX,
        y: centerY,
        button: 'left',
        clickCount: 1,
    });
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: centerX,
        y: centerY,
        button: 'left',
        clickCount: 1,
    });

    return `Clicked element "${el.name}" (${el.tag})`;
}

export async function typeText(
    text: string,
    uid: number,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) return `Error: Element UID ${uid} not found. Take a new snapshot.`;
    if (!el.isInput) return `Error: Element UID ${uid} is not an input field.`;

    await ensureAttached(id);

    // Click to focus first
    const centerX = el.x + el.width / 2;
    const centerY = el.y + el.height / 2;
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: centerX,
        y: centerY,
        button: 'left',
        clickCount: 1,
    });
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: centerX,
        y: centerY,
        button: 'left',
        clickCount: 1,
    });

    // Clear existing content
    await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', modifiers: 0 });
    await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2, // Ctrl
    });
    await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 });
    await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', modifiers: 0 });

    // Type each character using CDP key events
    // IMPORTANT: keyDown must NOT carry `text` — that would insert the char twice.
    // Only the `char` event should carry the text.
    for (const char of text) {
        const vk = char.toUpperCase().charCodeAt(0);
        await cdp(id, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: char,
            code: `Key${char.toUpperCase()}`,
            windowsVirtualKeyCode: vk,
            // No `text` here — avoids double-insert
        });
        await cdp(id, 'Input.dispatchKeyEvent', {
            type: 'char',
            key: char,
            text: char,
            unmodifiedText: char,
            windowsVirtualKeyCode: vk,
        });
        await cdp(id, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: char,
            code: `Key${char.toUpperCase()}`,
            windowsVirtualKeyCode: vk,
        });
        await new Promise((r) => setTimeout(r, 40));
    }

    return `Typed "${text}" into ${el.tag} "${el.name}"`;
}

export async function pressKey(key: string, tabId?: number): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    const keyMap: Record<string, { code: string; vk: number }> = {
        Enter: { code: 'Enter', vk: 13 },
        Tab: { code: 'Tab', vk: 9 },
        Escape: { code: 'Escape', vk: 27 },
        ArrowDown: { code: 'ArrowDown', vk: 40 },
        ArrowUp: { code: 'ArrowUp', vk: 38 },
        Backspace: { code: 'Backspace', vk: 8 },
    };

    const keyInfo = keyMap[key] || { code: key, vk: key.charCodeAt(0) };

    await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.vk,
    });
    await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.vk,
    });

    return `Pressed key: ${key}`;
}

export async function scrollPage(
    direction: 'up' | 'down',
    amount = 500,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    await cdp(id, 'Runtime.evaluate', {
        expression: `window.scrollBy(0, ${direction === 'down' ? amount : -amount})`,
    });

    return `Scrolled ${direction} by ${amount}px`;
}

export async function takeScreenshot(tabId?: number): Promise<string> {
    const id = tabId || (await getActiveTabId());

    // chrome.tabs.captureVisibleTab doesn't need debugger
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(
            { format: 'png', quality: 80 },
            (dataUrl) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(dataUrl);
                }
            },
        );
    });
}

export async function detachDebugger(tabId?: number): Promise<void> {
    const id = tabId || attachedTabId;
    if (id === null) return;
    try {
        await chrome.debugger.detach({ tabId: id });
    } catch {
        // Ignore
    }
    if (id === attachedTabId) attachedTabId = null;
}

// Get the current active tab ID
export async function getActiveTabId(): Promise<number> {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length === 0 || tabs[0].id === undefined) {
                reject(new Error('No active tab found'));
            } else {
                resolve(tabs[0].id!);
            }
        });
    });
}

// Open a new tab or update to a URL
export async function openBrowser(url: string): Promise<number> {
    // Normalize URL
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('chrome://')) {
        url = 'https://' + url;
    }

    return new Promise((resolve) => {
        chrome.tabs.create({ url, active: true }, (tab) => {
            resolve(tab.id!);
        });
    });
}
