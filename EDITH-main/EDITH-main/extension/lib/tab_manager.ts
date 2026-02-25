// Multi-tab management layer for concurrent browser automation.
// Replaces the old global `attachedTabId` singleton with a class
// that tracks multiple tabs, each with its own debugger attachment.

export interface TabState {
    tabId: number;
    attached: boolean;
    url: string;
    title: string;
    taskDescription: string;
    status: 'pending' | 'running' | 'extracting' | 'done' | 'error';
    extractedData: string;
    error?: string;
}

class TabManager {
    private tabs = new Map<number, TabState>();

    /** Create a new tab and register it */
    async createTab(url: string, taskDescription: string): Promise<number> {
        // Normalize URL
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('chrome://')) {
            url = 'https://' + url;
        }

        return new Promise((resolve) => {
            chrome.tabs.create({ url, active: false }, (tab) => {
                const tabId = tab.id!;
                this.tabs.set(tabId, {
                    tabId,
                    attached: false,
                    url,
                    title: '',
                    taskDescription,
                    status: 'pending',
                    extractedData: '',
                });
                resolve(tabId);
            });
        });
    }

    /** Attach the Chrome debugger to a specific tab */
    async attach(tabId: number): Promise<void> {
        const state = this.tabs.get(tabId);
        if (state?.attached) return; // Already attached

        await chrome.debugger.attach({ tabId }, '1.3');

        if (state) {
            state.attached = true;
        } else {
            // Tab was created externally; register it
            this.tabs.set(tabId, {
                tabId,
                attached: true,
                url: '',
                title: '',
                taskDescription: '',
                status: 'running',
                extractedData: '',
            });
        }
    }

    /** Detach debugger from a specific tab */
    async detach(tabId: number): Promise<void> {
        const state = this.tabs.get(tabId);
        if (!state?.attached) return;

        try {
            await chrome.debugger.detach({ tabId });
        } catch {
            // Tab may have already been closed
        }
        state.attached = false;
    }

    /** Detach from all tabs and clear state */
    async detachAll(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const [tabId, state] of this.tabs) {
            if (state.attached) {
                promises.push(
                    chrome.debugger.detach({ tabId }).catch(() => { })
                );
            }
        }
        await Promise.allSettled(promises);
        this.tabs.clear();
    }

    /** Close a specific tab */
    async closeTab(tabId: number): Promise<void> {
        await this.detach(tabId);
        try {
            await chrome.tabs.remove(tabId);
        } catch {
            // Tab may have already been closed
        }
        this.tabs.delete(tabId);
    }

    /** Close all managed tabs */
    async closeAll(): Promise<void> {
        const tabIds = [...this.tabs.keys()];
        await this.detachAll();
        for (const tabId of tabIds) {
            try {
                await chrome.tabs.remove(tabId);
            } catch {
                // Ignore
            }
        }
    }

    /** Update the state for a tab */
    updateState(tabId: number, update: Partial<TabState>): void {
        const state = this.tabs.get(tabId);
        if (state) {
            Object.assign(state, update);
        }
    }

    /** Get state for a specific tab */
    getState(tabId: number): TabState | undefined {
        return this.tabs.get(tabId);
    }

    /** Check if a tab is attached */
    isAttached(tabId: number): boolean {
        return this.tabs.get(tabId)?.attached ?? false;
    }

    /** Get all managed tab states */
    getAllStates(): TabState[] {
        return [...this.tabs.values()];
    }

    /** Get active tab count */
    get size(): number {
        return this.tabs.size;
    }
}

// Singleton instance shared across the extension background
export const tabManager = new TabManager();
