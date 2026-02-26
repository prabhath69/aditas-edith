// Chrome Debugger CDP-based browser automation
// Attaches to the active tab via chrome.debugger and sends CDP commands

export interface SnapshotElement {
    uid: number;
    tag: string;
    role: string;
    name: string;
    context?: string;
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
    // ─── BrowserOS-level additions ───
    checked?: boolean;       // checkbox / radio checked state
    selected?: boolean;      // <option> selected state
    disabled?: boolean;      // disabled attribute
    ariaExpanded?: string;   // "true" | "false" — for collapsible sections
    options?: Array<{ value: string; text: string; selected: boolean }>; // <select> options
    isSelect?: boolean;      // true for <select> elements
}

export interface PageSnapshot {
    url: string;
    title: string;
    elements: SnapshotElement[];
    rawText: string;
}

// Track multiple attached tabs concurrently for multi-tab research
const attachedTabs = new Set<number>();

// Legacy compat: track the "last single-tab" for functions that omit tabId
let lastSingleTabId: number | null = null;

async function ensureAttached(tabId: number): Promise<void> {
    if (attachedTabs.has(tabId)) return;

    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);

    // Clean up when detached externally (e.g. DevTools opened)
    const onDetach = (source: chrome.debugger.Debuggee) => {
        if (source.tabId === tabId) {
            attachedTabs.delete(tabId);
            chrome.debugger.onDetach.removeListener(onDetach);
        }
    };
    chrome.debugger.onDetach.addListener(onDetach);
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

// ─── Snapshot script as RAW JavaScript string ───────────────────────────────
// CRITICAL: This MUST be a raw string, NOT a TypeScript function with .toString().
// esbuild compiles/minifies TypeScript functions, mangling variable names and
// injecting module-scoped helpers. When .toString() is called on the compiled
// function and injected into the page via Runtime.evaluate, those helpers don't
// exist in the page context, causing silent crashes and 0 elements captured.
//
// Enhancements:
//   - Captures <select> options (value, text, selected state)
//   - Captures checkbox/radio checked state
//   - Reads aria-expanded, aria-selected, aria-checked, aria-disabled
//   - Traverses shadow DOM roots
//   - Captures disabled state
//   - Increased rawText from 3000 → 5000 chars
const SNAPSHOT_JS = `(function() {
    try {
        var CLICKABLE_TAGS = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
        var INPUT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
        var elements = [];
        var viewportH = window.innerHeight || document.documentElement.clientHeight;
        var viewportW = window.innerWidth || document.documentElement.clientWidth;

        // Stable UIDs: find highest existing UID so new elements get unique IDs
        var maxUid = 0;
        var existing = document.querySelectorAll('[data-edith-uid]');
        for (var i = 0; i < existing.length; i++) {
            var u = parseInt(existing[i].getAttribute('data-edith-uid'), 10);
            if (u > maxUid) maxUid = u;
        }
        var uidCounter = maxUid + 1;

        // NOISE ROLES — these are layout/decorative, NOT interactive.
        // Amazon uses hundreds of these; capturing them floods the LLM.
        var NOISE_ROLES = ['presentation','none','img','list','listitem','group',
            'row','rowgroup','cell','gridcell','columnheader','rowheader',
            'definition','term','directory','figure','separator','math',
            'note','status','log','marquee','timer','tooltip','feed',
            'application','document','article','paragraph','generic'];

        // ACTIONABLE ROLES — these are the ones worth capturing
        var ACTIONABLE_ROLES = ['button','link','tab','menuitem','menuitemcheckbox',
            'menuitemradio','option','treeitem','switch','checkbox','radio',
            'combobox','searchbox','textbox','slider','spinbutton','scrollbar',
            'progressbar','tabpanel','dialog','alertdialog','navigation','search',
            'banner','complementary','form','region','heading'];

        function isVisible(el) {
            var rect = el.getBoundingClientRect();
            if (rect.width < 3 || rect.height < 3) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return true;
        }

        // Check if element is anywhere near the viewport (within 2x viewport above/below)
        function isNearViewport(rect) {
            if (rect.bottom < -viewportH) return false;  // Way above viewport
            if (rect.top > viewportH * 3) return false;   // Way below viewport
            if (rect.right < -100) return false;           // Off-screen left
            if (rect.left > viewportW + 100) return false; // Off-screen right
            return true;
        }

        function getRole(el) {
            return el.getAttribute('role') || el.tagName.toLowerCase();
        }

        function getName(el) {
            // For <select>, show the currently selected option text
            if (el.tagName === 'SELECT' && el.selectedIndex >= 0 && el.options && el.options.length > 0) {
                var selText = el.options[el.selectedIndex].text || '';
                var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || '';
                return label ? label + ' (selected: "' + selText.slice(0, 40) + '")' : selText.slice(0, 80);
            }
            // For checkboxes/radios, include label from associated <label> element
            if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                var lbl = el.getAttribute('aria-label') || el.getAttribute('title') || '';
                if (!lbl) {
                    var id = el.id;
                    if (id) {
                        var labelEl = document.querySelector('label[for="' + id + '"]');
                        if (labelEl) lbl = (labelEl.innerText || '').slice(0, 80).trim();
                    }
                    if (!lbl) {
                        var parentLabel = el.closest('label');
                        if (parentLabel) lbl = (parentLabel.innerText || '').slice(0, 80).trim();
                    }
                }
                return lbl || el.getAttribute('name') || el.type;
            }
            return el.getAttribute('aria-label')
                || el.getAttribute('title')
                || el.getAttribute('placeholder')
                || (el.innerText ? el.innerText.slice(0, 120).trim() : '')
                || el.getAttribute('alt')
                || el.getAttribute('name')
                || '';
        }

        function getContext(el) {
            var p = el.parentElement;
            var maxUp = 5;
            while (p && maxUp-- > 0) {
                var label = p.getAttribute('aria-label');
                if (label) return label.slice(0, 50);
                var heading = p.querySelector('h1,h2,h3,h4,[role=heading]');
                if (heading && heading !== el) {
                    var ht = (heading.innerText || '').slice(0, 50).trim();
                    if (ht) return ht;
                }
                var role = p.getAttribute('role');
                if (role && ['navigation','main','search','banner','complementary','dialog','alertdialog','form','region','listbox','menu','menubar','toolbar','tablist','tree','treegrid'].indexOf(role) >= 0) {
                    var rl = p.getAttribute('aria-label') || role;
                    return rl.slice(0, 50);
                }
                var pt = p.tagName;
                if (pt === 'NAV' || pt === 'HEADER' || pt === 'MAIN' || pt === 'ASIDE' || pt === 'FOOTER' || pt === 'SECTION') {
                    var al = p.getAttribute('aria-label');
                    return (al || pt.toLowerCase()).slice(0, 50);
                }
                p = p.parentElement;
            }
            return '';
        }

        // Track parent clickable elements to deduplicate nested links/buttons
        var processedParents = new Set();

        function processElement(node) {
          try {
            var tag = node.tagName;
            if (!tag) return;
            var isClickableTag = CLICKABLE_TAGS.indexOf(tag) >= 0;
            var hasOnClick = node.getAttribute('onclick') !== null;
            var elRole = node.getAttribute('role');
            var isLink = tag === 'A';
            var isContentEditable = node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('contenteditable') === '';
            var isInput = INPUT_TAGS.indexOf(tag) >= 0 || isContentEditable;
            // FIX: node.type can be a non-string object (SVGAnimatedEnumeration on SVG elements)
            // This was causing "TypeError: node.type.toLowerCase is not a function" and crashing
            // the ENTIRE snapshot on Amazon, returning 0 elements.
            var inputType = (typeof node.type === 'string') ? node.type.toLowerCase() : '';
            if (!isContentEditable && isInput && (inputType === 'password' || inputType === 'hidden')) return;
            var isButton = tag === 'BUTTON' || elRole === 'button';
            var isVideo = tag === 'VIDEO' || (node.getAttribute('data-testid') || '').indexOf('video') >= 0;
            var hasActionableRole = elRole && ACTIONABLE_ROLES.indexOf(elRole) >= 0;
            var hasNoiseRole = elRole && NOISE_ROLES.indexOf(elRole) >= 0;

            // CRITICAL FIX: Skip elements that ONLY have a noise/decorative role
            // Amazon has 300+ elements with role=presentation, role=img, role=list etc.
            // These are NOT interactive and flood the snapshot.
            if (hasNoiseRole && !isClickableTag && !hasOnClick && !isInput && !isVideo) return;

            // Only capture elements that are actually useful:
            // 1. Clickable HTML tags (A, BUTTON, INPUT, SELECT, TEXTAREA, LABEL)
            // 2. Elements with onclick handlers
            // 3. Elements with actionable ARIA roles
            // 4. Content-editable elements
            // 5. Video elements
            // SKIP: tabindex-only divs/spans (container wrappers, not real actions)
            var isTabIndexOnly = !isClickableTag && !hasOnClick && !isInput && !isVideo && !hasActionableRole && node.getAttribute('tabindex') !== null;
            if (isTabIndexOnly && (tag === 'DIV' || tag === 'SPAN' || tag === 'LI')) return;

            if (!isClickableTag && !hasOnClick && !hasActionableRole && !isVideo && !isContentEditable && !isInput) return;
            if (!isInput && !isVisible(node)) return;

            var rect = node.getBoundingClientRect();

            // CRITICAL FIX: Skip elements way off-screen
            if (!isNearViewport(rect)) return;

            // CRITICAL FIX: Deduplicate nested clickable elements
            // Amazon product cards: <a> wraps <span> wraps <img> — all clickable.
            // Keep only the most specific (deepest) clickable OR the one with the best name.
            if (isLink || isButton) {
                // Check if this element contains another link/button (prefer child)
                var childLink = node.querySelector('a, button, [role=button], [role=link]');
                if (childLink && childLink !== node && isVisible(childLink)) {
                    // Skip this parent — the child will be captured instead
                    // UNLESS this is a <label> wrapping an input
                    if (tag !== 'LABEL') {
                        processedParents.add(node);
                    }
                }
                // Check if parent is already a processed link/button
                var parentClickable = node.parentElement;
                var skip = false;
                var maxCheck = 3;
                while (parentClickable && maxCheck-- > 0) {
                    if (processedParents.has(parentClickable)) {
                        // Parent was skipped in favor of us — we're the preferred child
                        break;
                    }
                    parentClickable = parentClickable.parentElement;
                }
            }

            // Stable UIDs
            var uid;
            var existingUid = node.getAttribute('data-edith-uid');
            if (existingUid) {
                uid = parseInt(existingUid, 10);
            } else {
                uid = uidCounter++;
                try { node.setAttribute('data-edith-uid', String(uid)); } catch(e) {}
            }

            var val = undefined;
            if (isInput) {
                try { val = node.value || ''; } catch(e) {}
            }

            // Collect <select> options
            var selectOptions = undefined;
            var isSelect = tag === 'SELECT';
            if (isSelect) {
                selectOptions = [];
                try {
                    for (var oi = 0; oi < node.options.length && oi < 30; oi++) {
                        var opt = node.options[oi];
                        selectOptions.push({
                            value: opt.value || '',
                            text: (opt.text || '').slice(0, 60),
                            selected: opt.selected
                        });
                    }
                } catch(e) {}
            }

            // Checkbox / radio checked state
            var checked = undefined;
            if (inputType === 'checkbox' || inputType === 'radio') {
                checked = !!node.checked;
            }
            var ariaChecked = node.getAttribute('aria-checked');
            if (ariaChecked === 'true') checked = true;
            else if (ariaChecked === 'false') checked = false;

            var disabled = node.disabled || node.getAttribute('aria-disabled') === 'true' || undefined;
            var ariaExpanded = node.getAttribute('aria-expanded') || undefined;

            var name = getName(node);

            // CRITICAL FIX: Skip elements with empty names UNLESS they are inputs/selects
            // Empty-named links/buttons are useless to the LLM — it can't reference them.
            if (!name && !isInput && !isSelect && !isVideo) {
                // Last resort: check for img alt inside the element
                var innerImg = node.querySelector('img[alt]');
                if (innerImg) {
                    name = innerImg.getAttribute('alt') || '';
                }
                if (!name) return; // Skip entirely
            }

            elements.push({
                uid: uid,
                tag: tag.toLowerCase(),
                role: getRole(node),
                name: name,
                context: getContext(node),
                href: node.href || undefined,
                type: inputType || undefined,
                value: val,
                placeholder: node.getAttribute('placeholder') || undefined,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                isClickable: isClickableTag || hasOnClick || isButton || isLink || !!hasActionableRole,
                isInput: isInput,
                isVideo: isVideo,
                checked: checked,
                selected: undefined,
                disabled: disabled || undefined,
                ariaExpanded: ariaExpanded,
                options: selectOptions,
                isSelect: isSelect || undefined
            });
          } catch(e) { /* skip this element if anything fails — don't crash entire snapshot */ }
        }

        // Walk main document tree
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            processElement(node);
            if (node.shadowRoot) {
                var shadowWalker = document.createTreeWalker(node.shadowRoot, NodeFilter.SHOW_ELEMENT);
                var shadowNode;
                while ((shadowNode = shadowWalker.nextNode())) {
                    processElement(shadowNode);
                }
            }
        }

        return JSON.stringify({
            url: location.href,
            title: document.title,
            elements: elements,
            rawText: (document.body.innerText || '').slice(0, 5000)
        });
    } catch(err) {
        return JSON.stringify({
            url: location.href || 'unknown',
            title: document.title || 'unknown',
            elements: [],
            rawText: 'Snapshot error: ' + String(err)
        });
    }
})()`;

// Build a DOM snapshot using CDP Runtime.evaluate
// Returns structured elements with UIDs for the LLM to reference
export async function takeSnapshot(tabId?: number): Promise<PageSnapshot> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Wait for page to be ready before snapshotting
    await waitForDocReady(id);

    const attempt = async (): Promise<PageSnapshot> => {
        const result = await cdp<{ result: { value?: string; type?: string; description?: string } }>(id, 'Runtime.evaluate', {
            expression: SNAPSHOT_JS,
            returnByValue: true,
            awaitPromise: false,
        });

        const raw = result?.result?.value;
        if (typeof raw !== 'string') {
            throw new Error(`Snapshot returned ${typeof raw} instead of string`);
        }
        return JSON.parse(raw) as PageSnapshot;
    };

    try {
        return await attempt();
    } catch {
        // Retry once after a delay — heavy pages (Amazon) may not be hydrated yet
        await new Promise((r) => setTimeout(r, 1500));
        try {
            return await attempt();
        } catch {
            // Return empty snapshot so the agent loop doesn't crash
            const fallbackUrl = await cdp<{ result: { value: string } }>(id, 'Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true,
            }).then((r) => r.result.value).catch(() => 'unknown');
            const fallbackTitle = await cdp<{ result: { value: string } }>(id, 'Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            }).then((r) => r.result.value).catch(() => 'unknown');
            return {
                url: fallbackUrl,
                title: fallbackTitle,
                elements: [],
                rawText: '',
            };
        }
    }
}

// Wait for document.readyState to be 'complete' (up to 3s)
async function waitForDocReady(tabId: number, timeout = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const r = await cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', {
                expression: 'document.readyState',
                returnByValue: true,
            });
            if (r.result.value === 'complete') return;
        } catch {
            // Page might be navigating — ignore
        }
        await new Promise((res) => setTimeout(res, 300));
    }
}

export interface ClickResult {
    message: string;
    newTabId?: number; // Set when click opens a new tab (target=_blank)
}

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

    await ensureAttached(id);

    // Record existing tabs before click to detect new-tab opens
    const tabsBefore = await new Promise<chrome.tabs.Tab[]>((resolve) => {
        chrome.tabs.query({}, (tabs) => resolve(tabs));
    });
    const tabIdsBefore = new Set(tabsBefore.map((t) => t.id));

    // Step 1: Scroll element into view
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (el) {
                    el.scrollIntoView({block: 'center', behavior: 'instant'});
                    return true;
                }
                return false;
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });
        await new Promise((r) => setTimeout(r, 250));
    } catch { /* non-critical */ }

    // Step 2: PRIMARY — JS .click() on element found by data-edith-uid
    // This is MORE RELIABLE than CDP coordinates because:
    //   - Works regardless of sticky headers, overlays, CSS transforms
    //   - Triggers all native click handlers
    //   - Works for both real links and JS-driven elements
    let clicked = false;
    try {
        const result = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return 'not_found';
                // Focus the element first
                try { el.focus(); } catch(e) {}
                // For links with target=_blank, remove it temporarily to stay in same tab
                var hadBlank = false;
                if (el.tagName === 'A' && el.target === '_blank') {
                    hadBlank = true;
                    el.removeAttribute('target');
                }
                // Click
                el.click();
                // Restore target if we removed it
                if (hadBlank) {
                    setTimeout(function() { try { el.setAttribute('target', '_blank'); } catch(e) {} }, 100);
                }
                return 'clicked';
            })()`,
            returnByValue: true,
        });
        clicked = result?.result?.value === 'clicked';
    } catch { /* fallback to CDP */ }

    // Step 3: FALLBACK — CDP coordinate click (for elements that need real mouse events)
    if (!clicked) {
        try {
            // Get fresh coordinates
            const freshRect = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
                expression: `(function() {
                    var el = document.querySelector('[data-edith-uid="${uid}"]');
                    if (!el) return '';
                    var r = el.getBoundingClientRect();
                    return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
                })()`,
                returnByValue: true,
            });

            if (freshRect?.result?.value) {
                const r = JSON.parse(freshRect.result.value);
                const cx = r.x + r.w / 2;
                const cy = r.y + r.h / 2;

                await cdp(id, 'Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
                });
                await cdp(id, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
                });
                clicked = true;
            }
        } catch { /* next fallback */ }
    }

    // Step 4: FALLBACK — Full synthetic event dispatch
    if (!clicked) {
        try {
            await cdp(id, 'Runtime.evaluate', {
                expression: `(function() {
                    var el = document.querySelector('[data-edith-uid="${uid}"]');
                    if (!el) return false;
                    var rect = el.getBoundingClientRect();
                    var opts = {bubbles: true, cancelable: true, view: window,
                        clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2};
                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                    el.dispatchEvent(new MouseEvent('click', opts));
                    return true;
                })()`,
                returnByValue: true,
            });
            clicked = true;
        } catch { /* last resort */ }
    }

    // Step 5: LAST RESORT — Direct navigation for <a> links
    if (!clicked && el.href && el.href.startsWith('http')) {
        await navigateTo(el.href, id);
    }

    // Step 6: Check if a new tab was opened (target=_blank links)
    await new Promise((r) => setTimeout(r, 500));
    const tabsAfter = await new Promise<chrome.tabs.Tab[]>((resolve) => {
        chrome.tabs.query({}, (tabs) => resolve(tabs));
    });
    const newTabs = tabsAfter.filter((t) => t.id && !tabIdsBefore.has(t.id));

    if (newTabs.length > 0) {
        const newTab = newTabs[newTabs.length - 1];
        // Switch to the new tab and attach debugger
        if (newTab.id) {
            try {
                await chrome.tabs.update(newTab.id, { active: true });
                await ensureAttached(newTab.id);
                lastSingleTabId = newTab.id;
            } catch { /* non-critical */ }
            return `Clicked "${el.name}" (${el.tag}) — opened in new tab (switched to tab ${newTab.id}).\n__NEW_TAB__:${newTab.id}`;
        }
    }

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
    if (!el.isInput) {
        // Allow typing into contenteditable elements (WhatsApp, Telegram, etc.)
        // The snapshot may not always detect them as isInput, so we attempt anyway
        console.warn(`Element UID ${uid} not flagged as input — attempting type anyway (may be contenteditable).`);
    }

    await ensureAttached(id);

    // Scroll into view first
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (el) el.scrollIntoView({block: 'center', behavior: 'instant'});
            })()`,
            awaitPromise: false,
        });
        await new Promise((r) => setTimeout(r, 150));
    } catch { /* non-critical */ }

    // Get fresh coordinates after scroll
    let cx = el.x + el.width / 2;
    let cy = el.y + el.height / 2;
    try {
        const freshRect = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return '';
                var r = el.getBoundingClientRect();
                return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
            })()`,
            returnByValue: true,
        });
        if (freshRect?.result?.value) {
            const r = JSON.parse(freshRect.result.value);
            cx = r.x + r.w / 2;
            cy = r.y + r.h / 2;
        }
    } catch { /* use original coords */ }

    // Click to focus
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
    });
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 100));

    // Use JS to focus + clear (more reliable than Ctrl+A on contenteditable)
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return;
                el.focus();
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
                    el.value = '';
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                } else if (el.isContentEditable || el.getAttribute('contenteditable') !== null) {
                    // Use Selection API to clear — preserves Gmail/complex contenteditable DOM structure.
                    // Setting textContent='' destroys internal spans, chip containers, placeholder elements
                    // that apps like Gmail rely on for their compose fields.
                    var sel = window.getSelection();
                    if (sel) {
                        sel.selectAllChildren(el);
                        sel.deleteFromDocument();
                    }
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                } else {
                    el.focus();
                }
            })()`,
            awaitPromise: false,
        });
    } catch { /* fallback: Ctrl+A to select all */
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', modifiers: 0 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', modifiers: 0 });
    }

    // CDP-level focus fallback — ensures browser focus is on the element,
    // which is critical for Gmail's compose contenteditable fields that
    // may not accept Input.insertText without true browser focus.
    try {
        const nodeResult = await cdp<{ result: { value?: number } }>(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return -1;
                el.focus();
                return 0;
            })()`,
            returnByValue: true,
        });
    } catch { /* non-critical */ }

    await new Promise((r) => setTimeout(r, 150));

    // Use Input.insertText — works on <input>, <textarea>, AND contenteditable
    // This is the CDP equivalent of pasting text and works with React & modern frameworks
    await cdp(id, 'Input.insertText', { text });

    // Dispatch additional events to ensure frameworks (React, YouTube, etc.) pick up the change.
    // Input.insertText fires a basic 'input' event, but many sites also need 'change',
    // 'keydown', 'keyup', or React's synthetic event system to update internal state.
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return;
                // Fire input event with data to satisfy React's onChange
                var inputEv = new InputEvent('input', {bubbles: true, data: '${text.replace(/'/g, "\\'")}', inputType: 'insertText'});
                el.dispatchEvent(inputEv);
                // Fire change event for good measure
                el.dispatchEvent(new Event('change', {bubbles: true}));
                // Fire a keydown event (generic) so YouTube/autocomplete systems activate
                el.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Unidentified'}));
                el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true, key: 'Unidentified'}));
            })()`,
            awaitPromise: false,
        });
    } catch { /* non-critical — insertText already set the value */ }

    return `Typed "${text}" into ${el.tag} "${el.name}"`;
}

// Capture current URL — used to detect navigation after key presses
async function getCurrentUrl(tabId: number): Promise<string> {
    try {
        const r = await cdp<{ result: { value: string } }>(tabId, 'Runtime.evaluate', {
            expression: 'location.href',
            returnByValue: true,
        });
        return r.result.value || '';
    } catch {
        return '';
    }
}

// Wait for URL to change (navigation) — polls every 300ms up to timeout.
// Returns true if nav detected, false if timed out (no nav).
async function waitForNavigation(tabId: number, urlBefore: string, timeout = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 300));
        const urlNow = await getCurrentUrl(tabId);
        if (urlNow && urlNow !== urlBefore) {
            // URL changed — navigation occurred. Wait for page to settle.
            await waitForLoad(tabId, 8000);
            return true;
        }
    }
    return false;
}

export async function pressKey(key: string, tabId?: number): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Capture URL before the key press to detect navigation
    const urlBefore = await getCurrentUrl(id);

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

    // For Enter key: check if navigation occurred (e.g. search form submission)
    // This is critical for YouTube, Google, Amazon etc. where Enter triggers page nav
    if (key === 'Enter') {
        const navigated = await waitForNavigation(id, urlBefore, 3000);
        if (navigated) {
            return `Pressed Enter — page navigated to new URL.`;
        }
    }

    return `Pressed key: ${key}`;
}

export async function scrollPage(
    direction: 'up' | 'down',
    amount = 500,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    // Use CDP wheel event for more realistic scroll that triggers
    // lazy-loading IntersectionObservers (Amazon product grids, etc.)
    try {
        await cdp(id, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: 400,
            y: 300,
            deltaX: 0,
            deltaY: direction === 'down' ? amount : -amount,
        });
    } catch {
        // Fallback to JS scrollBy if wheel event isn't supported
        await cdp(id, 'Runtime.evaluate', {
            expression: `window.scrollBy(0, ${direction === 'down' ? amount : -amount})`,
        });
    }

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

// ─── BrowserOS-level interaction tools ──────────────────────────────────────

/**
 * Select an option from a native <select> dropdown.
 * CDP Input.dispatchMouseEvent doesn't open native <select> menus,
 * so we use Runtime.evaluate to set the value directly + fire events.
 */
export async function selectOption(
    uid: number,
    value: string,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) return `Error: Element UID ${uid} not found. Take a new snapshot.`;
    if (!el.isSelect && el.tag !== 'select') {
        return `Error: Element UID ${uid} is a ${el.tag}, not a <select>. Use click() instead.`;
    }

    await ensureAttached(id);

    // Escape single quotes in value for JS injection
    const safeValue = value.replace(/'/g, "\\'");

    const result = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
        expression: `(function() {
            var el = document.querySelector('[data-edith-uid="${uid}"]');
            if (!el) return 'Element not found in DOM';
            if (el.tagName !== 'SELECT') return 'Not a select element';
            // Try matching by value first, then by visible text
            var found = false;
            for (var i = 0; i < el.options.length; i++) {
                if (el.options[i].value === '${safeValue}' || el.options[i].text.trim().toLowerCase() === '${safeValue}'.toLowerCase()) {
                    el.selectedIndex = i;
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Partial match
                for (var i = 0; i < el.options.length; i++) {
                    if (el.options[i].text.trim().toLowerCase().indexOf('${safeValue}'.toLowerCase()) >= 0) {
                        el.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
            }
            if (!found) return 'Option not found: ${safeValue}. Available: ' + Array.from(el.options).map(function(o) { return o.text; }).join(', ');
            // Fire events to notify frameworks
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            return 'Selected: ' + el.options[el.selectedIndex].text;
        })()`,
        returnByValue: true,
    });

    return result?.result?.value || 'select_option completed';
}

/**
 * Hover over an element — triggers CSS :hover and JS mouseenter/mouseover.
 * Essential for sites with hover-triggered menus (Amazon mega-menu, etc.)
 */
export async function hoverElement(
    uid: number,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) return `Error: Element UID ${uid} not found. Take a new snapshot.`;

    await ensureAttached(id);

    // Scroll into view
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (el) el.scrollIntoView({block: 'center', behavior: 'instant'});
            })()`,
            awaitPromise: false,
        });
        await new Promise((r) => setTimeout(r, 150));
    } catch { /* non-critical */ }

    // Get fresh coordinates
    let cx = el.x + el.width / 2;
    let cy = el.y + el.height / 2;
    try {
        const freshRect = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return '';
                var r = el.getBoundingClientRect();
                return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
            })()`,
            returnByValue: true,
        });
        if (freshRect?.result?.value) {
            const r = JSON.parse(freshRect.result.value);
            cx = r.x + r.w / 2;
            cy = r.y + r.h / 2;
        }
    } catch { /* use original coords */ }

    // Move mouse to element center (triggers CSS :hover and JS mouseover/mouseenter)
    await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cx,
        y: cy,
    });

    // Also dispatch synthetic events for frameworks that listen to them
    try {
        await cdp(id, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.querySelector('[data-edith-uid="${uid}"]');
                if (!el) return;
                el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true, clientX: ${cx}, clientY: ${cy}}));
                el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, clientX: ${cx}, clientY: ${cy}}));
            })()`,
            awaitPromise: false,
        });
    } catch { /* non-critical */ }

    // Wait for hover effects to render (CSS transitions, JS handlers)
    await new Promise((r) => setTimeout(r, 500));

    return `Hovered over "${el.name}" (${el.tag})`;
}

/**
 * Set value of an input directly via JS — bypasses React/framework input handling.
 * Useful for price range fields, quantity selectors, date pickers, etc.
 */
export async function setValue(
    uid: number,
    value: string,
    snapshot: PageSnapshot,
    tabId?: number,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    const el = snapshot.elements.find((e) => e.uid === uid);

    if (!el) return `Error: Element UID ${uid} not found. Take a new snapshot.`;

    await ensureAttached(id);

    const safeValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

    const result = await cdp<{ result: { value?: string } }>(id, 'Runtime.evaluate', {
        expression: `(function() {
            var el = document.querySelector('[data-edith-uid="${uid}"]');
            if (!el) return 'Element not found';
            // Use Object.getOwnPropertyDescriptor to bypass React's synthetic value setter
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            var nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            var setter = (el.tagName === 'TEXTAREA' && nativeTextareaValueSetter) ? nativeTextareaValueSetter.set : (nativeInputValueSetter ? nativeInputValueSetter.set : null);
            if (setter) {
                setter.call(el, '${safeValue}');
            } else {
                el.value = '${safeValue}';
            }
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            el.dispatchEvent(new InputEvent('input', {bubbles: true, data: '${safeValue}', inputType: 'insertText'}));
            return 'Set value to: ${safeValue}';
        })()`,
        returnByValue: true,
    });

    return result?.result?.value || `Set value on element ${uid}`;
}

/**
 * Wait for AJAX/network activity to settle after an interaction.
 * Essential for Amazon filters, search results, and any page that updates via XHR.
 * Uses CDP Network domain to track pending requests.
 */
export async function waitForNetworkIdle(
    tabId?: number,
    timeout = 5000,
): Promise<string> {
    const id = tabId || (await getActiveTabId());
    await ensureAttached(id);

    try {
        // Enable network tracking
        await cdp(id, 'Network.enable');
    } catch { /* may already be enabled */ }

    let pendingRequests = 0;
    let lastActivityTime = Date.now();
    const IDLE_THRESHOLD = 500; // ms of no network activity = "idle"

    return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve(`Network idle (timeout after ${timeout}ms, ${pendingRequests} requests still pending)`);
        }, timeout);

        function onEvent(source: chrome.debugger.Debuggee, method: string) {
            if (source.tabId !== id) return;

            if (method === 'Network.requestWillBeSent') {
                pendingRequests++;
                lastActivityTime = Date.now();
            } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
                pendingRequests = Math.max(0, pendingRequests - 1);
                lastActivityTime = Date.now();

                // Check if we've gone idle
                if (pendingRequests === 0) {
                    setTimeout(() => {
                        if (pendingRequests === 0 && Date.now() - lastActivityTime >= IDLE_THRESHOLD) {
                            cleanup();
                            resolve('Network idle — page update complete.');
                        }
                    }, IDLE_THRESHOLD);
                }
            }
        }

        function cleanup() {
            clearTimeout(timer);
            chrome.debugger.onEvent.removeListener(onEvent);
            // Don't disable Network — it may be needed for subsequent actions
        }

        chrome.debugger.onEvent.addListener(onEvent);

        // If no network activity happens at all within 1s, resolve early
        setTimeout(() => {
            if (pendingRequests === 0 && Date.now() - lastActivityTime >= IDLE_THRESHOLD) {
                cleanup();
                resolve('Network idle — no pending requests.');
            }
        }, 1000);
    });
}

export async function detachDebugger(tabId?: number): Promise<void> {
    const id = tabId || lastSingleTabId;
    if (id === null || id === undefined) return;
    try {
        await chrome.debugger.detach({ tabId: id });
    } catch {
        // Ignore
    }
    attachedTabs.delete(id);
    if (id === lastSingleTabId) lastSingleTabId = null;
}

/** Detach from ALL tabs — used when research completes or aborts */
export async function detachAllDebuggers(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const tabId of attachedTabs) {
        promises.push(
            chrome.debugger.detach({ tabId }).catch(() => { })
        );
    }
    await Promise.allSettled(promises);
    attachedTabs.clear();
    lastSingleTabId = null;
}

// Get the current active tab ID
export async function getActiveTabId(): Promise<number> {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length === 0 || tabs[0].id === undefined) {
                reject(new Error('No active tab found'));
            } else {
                lastSingleTabId = tabs[0].id!;
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
