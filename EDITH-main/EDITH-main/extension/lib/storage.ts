// Storage keys for settings and conversations
export const STORAGE_KEYS = {
    API_KEY: 'edith_api_key',
    API_BASE_URL: 'edith_api_base_url',
    MODEL: 'edith_model',
    CONVERSATIONS: 'edith_conversations',
    MCP_SERVERS: 'edith_mcp_servers',
    SCHEDULES: 'edith_schedules',
} as const;

export interface StoredSettings {
    apiKey: string;
    apiBaseUrl: string;
    model: string;
}

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
    timestamp: number;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface Conversation {
    id: string;
    title: string;
    messages: Message[];
    createdAt: number;
    updatedAt: number;
}

export interface MCPServer {
    id: string;
    name: string;
    url: string;
    transport: 'sse' | 'stdio';
    enabled: boolean;
}

export interface ScheduledTask {
    id: string;
    name: string;
    prompt: string;
    cronExpression: string;
    enabled: boolean;
    lastRun?: number;
}

// Get settings from chrome.storage.local
export async function getSettings(): Promise<StoredSettings> {
    return new Promise((resolve) => {
        chrome.storage.local.get(
            [STORAGE_KEYS.API_KEY, STORAGE_KEYS.API_BASE_URL, STORAGE_KEYS.MODEL],
            (result) => {
                resolve({
                    apiKey: result[STORAGE_KEYS.API_KEY] || '',
                    apiBaseUrl: result[STORAGE_KEYS.API_BASE_URL] || 'https://api.openai.com/v1',
                    model: result[STORAGE_KEYS.MODEL] || 'gpt-4o-mini',
                });
            }
        );
    });
}

export async function saveSettings(settings: Partial<StoredSettings>): Promise<void> {
    const data: Record<string, string> = {};
    if (settings.apiKey !== undefined) data[STORAGE_KEYS.API_KEY] = settings.apiKey;
    if (settings.apiBaseUrl !== undefined) data[STORAGE_KEYS.API_BASE_URL] = settings.apiBaseUrl;
    if (settings.model !== undefined) data[STORAGE_KEYS.MODEL] = settings.model;
    return new Promise((resolve) => {
        chrome.storage.local.set(data, resolve);
    });
}

export async function getConversations(): Promise<Conversation[]> {
    return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEYS.CONVERSATIONS, (result) => {
            resolve(result[STORAGE_KEYS.CONVERSATIONS] || []);
        });
    });
}

export async function saveConversation(conv: Conversation): Promise<void> {
    const all = await getConversations();
    const idx = all.findIndex((c) => c.id === conv.id);
    if (idx >= 0) {
        all[idx] = conv;
    } else {
        all.unshift(conv);
    }
    // Keep last 100 conversations
    const trimmed = all.slice(0, 100);
    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEYS.CONVERSATIONS]: trimmed }, resolve);
    });
}

export async function getMCPServers(): Promise<MCPServer[]> {
    return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEYS.MCP_SERVERS, (result) => {
            resolve(result[STORAGE_KEYS.MCP_SERVERS] || []);
        });
    });
}

export async function saveMCPServers(servers: MCPServer[]): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEYS.MCP_SERVERS]: servers }, resolve);
    });
}

export async function getSchedules(): Promise<ScheduledTask[]> {
    return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEYS.SCHEDULES, (result) => {
            resolve(result[STORAGE_KEYS.SCHEDULES] || []);
        });
    });
}

export async function saveSchedules(tasks: ScheduledTask[]): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEYS.SCHEDULES]: tasks }, resolve);
    });
}
