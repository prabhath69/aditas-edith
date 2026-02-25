import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, Conversation, StoredSettings } from '../../lib/storage';
import { getSettings, saveSettings, getConversations } from '../../lib/storage';

type View = 'chat' | 'settings' | 'history';
type ChatMode = 'chat' | 'agent' | 'research';

export default function App() {
    const [view, setView] = useState<View>('chat');
    const [settings, setSettings] = useState<StoredSettings>({
        apiKey: '',
        apiBaseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
    });
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [mode, setMode] = useState<ChatMode>('chat');
    const [isRunning, setIsRunning] = useState(false);
    const [progressLog, setProgressLog] = useState<string[]>([]);
    const [statusText, setStatusText] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Load initial data
    useEffect(() => {
        getSettings().then(setSettings);
        getConversations().then(setConversations);
    }, []);

    // Listen for background events (agent progress, done, error)
    useEffect(() => {
        const listener = (msg: Record<string, unknown>) => {
            if (msg.type === 'agent_progress') {
                setProgressLog((prev) => [...prev.slice(-30), msg.text as string]);
            } else if (msg.type === 'agent_done') {
                setIsRunning(false);
                setProgressLog([]);
                setStatusText('');
                // Reload conversation from storage
                getConversations().then((convs) => {
                    setConversations(convs);
                    const conv = convs.find((c) => c.id === msg.conversationId);
                    if (conv) {
                        setActiveConvId(conv.id);
                        setMessages(conv.messages);
                    }
                });
            } else if (msg.type === 'agent_error') {
                setIsRunning(false);
                setProgressLog([]);
                setStatusText('');
                const errMsg: Message = {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: `❌ ${msg.error as string}`,
                    timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, errMsg]);
            }
        };

        chrome.runtime.onMessage.addListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
        return () => chrome.runtime.onMessage.removeListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
    }, []);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, progressLog]);

    const activeConv = conversations.find((c) => c.id === activeConvId);

    const startNewConversation = () => {
        setActiveConvId(null);
        setMessages([]);
        setProgressLog([]);
        setStatusText('');
    };

    const loadConversation = (conv: Conversation) => {
        setActiveConvId(conv.id);
        setMessages(conv.messages);
        setProgressLog([]);
        setStatusText('');
        setView('chat');
    };

    const sendMessage = useCallback(async () => {
        if (!input.trim() || isRunning) return;
        const prompt = input.trim();
        setInput('');
        setIsRunning(true);
        setProgressLog([]);
        setStatusText(mode === 'agent' ? 'Starting agent...' : mode === 'research' ? 'Starting research...' : 'Thinking...');

        // Optimistically show user message
        const userMsg: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: prompt,
            timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);

        try {
            if (mode === 'agent') {
                // Fire-and-forget: background will push events back via broadcastEvent
                await chrome.runtime.sendMessage({
                    type: 'AGENT_RUN',
                    prompt,
                    conversationId: activeConvId,
                });
                // isRunning stays true until agent_done or agent_error event arrives
            } else if (mode === 'research') {
                // Multi-tab research mode
                await chrome.runtime.sendMessage({
                    type: 'RESEARCH_RUN',
                    prompt,
                    conversationId: activeConvId,
                });
            } else {
                // Chat: background responds synchronously
                const response = await chrome.runtime.sendMessage({
                    type: 'CHAT',
                    prompt,
                    conversationId: activeConvId,
                }) as { ok: boolean; conversationId?: string; error?: string };

                if (!response?.ok) throw new Error(response?.error || 'Unknown error');

                const convs = await getConversations();
                setConversations(convs);
                const updatedConv = convs.find((c) => c.id === response.conversationId);
                if (updatedConv) {
                    setActiveConvId(updatedConv.id);
                    setMessages(updatedConv.messages);
                }
                setIsRunning(false);
                setStatusText('');
            }
        } catch (err) {
            setIsRunning(false);
            setStatusText('');
            const errMsg: Message = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `❌ Error: ${String(err)}`,
                timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, errMsg]);
        }
    }, [input, isRunning, mode, activeConvId]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const stopAgent = useCallback(async () => {
        try {
            await chrome.runtime.sendMessage({ type: 'AGENT_STOP' });
        } catch {
            // Ignore if background is not reachable
        }
        setIsRunning(false);
        setProgressLog([]);
        setStatusText('');
        const stopMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '⏹ Automation stopped by user.',
            timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, stopMsg]);
    }, []);

    const saveAppSettings = async () => {
        await saveSettings(settings);
        setView('chat');
    };

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100vh',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                fontSize: '14px',
            }}
        >
            {/* ─── Header ─── */}
            <header
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    background: 'var(--bg-secondary)',
                    borderBottom: '1px solid var(--border)',
                    flexShrink: 0,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                        style={{
                            width: 28, height: 28,
                            borderRadius: 8,
                            background: 'var(--accent)',
                            color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 700, fontSize: 13,
                        }}
                    >
                        E
                    </div>
                    <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '0.03em' }}>EDITH</span>
                    {activeConvId && activeConv && (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {activeConv.title}
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                    <IconBtn onClick={startNewConversation} title="New chat">＋</IconBtn>
                    <IconBtn onClick={() => setView('history')} title="History" active={view === 'history'}>☰</IconBtn>
                    <IconBtn onClick={() => setView('settings')} title="Settings" active={view === 'settings'}>⚙</IconBtn>
                </div>
            </header>

            {/* ─── Settings ─── */}
            {view === 'settings' && (
                <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12, fontWeight: 600 }}>SETTINGS</p>
                    <Field label="API Key">
                        <input
                            type="password"
                            value={settings.apiKey}
                            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                            placeholder="sk-..."
                            style={inputStyle}
                        />
                    </Field>
                    <Field label="API Base URL">
                        <input
                            type="text"
                            value={settings.apiBaseUrl}
                            onChange={(e) => setSettings({ ...settings, apiBaseUrl: e.target.value })}
                            placeholder="https://api.openai.com/v1"
                            style={inputStyle}
                        />
                    </Field>
                    <Field label="Model">
                        <input
                            type="text"
                            value={settings.model}
                            onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                            placeholder="gpt-4o-mini"
                            style={inputStyle}
                        />
                        <p style={{ fontSize: 11, marginTop: 4, color: 'var(--text-secondary)' }}>
                            Any OpenAI-compatible model: gpt-4o-mini, gpt-5-nano, llama3, etc.
                        </p>
                    </Field>
                    <button
                        onClick={saveAppSettings}
                        style={{
                            width: '100%', padding: '9px', borderRadius: 8,
                            background: 'var(--accent)', color: '#fff',
                            border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
                        }}
                    >
                        Save Settings
                    </button>
                </div>
            )}

            {/* ─── History ─── */}
            {view === 'history' && (
                <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 600 }}>CONVERSATIONS</p>
                    {conversations.length === 0 && (
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 32 }}>No conversations yet</p>
                    )}
                    {conversations.map((conv) => (
                        <button
                            key={conv.id}
                            onClick={() => loadConversation(conv)}
                            style={{
                                width: '100%', textAlign: 'left', padding: '10px 12px',
                                marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                                background: conv.id === activeConvId ? 'var(--accent-dim)' : 'var(--bg-card)',
                                border: `1px solid ${conv.id === activeConvId ? 'var(--accent)' : 'var(--border)'}`,
                                color: 'var(--text-primary)',
                            }}
                        >
                            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.title}</div>
                            <div style={{ fontSize: 11, marginTop: 2, color: 'var(--text-secondary)' }}>
                                {new Date(conv.updatedAt).toLocaleDateString()} · {conv.messages.length} messages
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {/* ─── Chat ─── */}
            {view === 'chat' && (
                <>
                    <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {messages.length === 0 && !isRunning && (
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 20px' }}>
                                <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, color: '#fff', marginBottom: 14, boxShadow: '0 0 30px rgba(92,115,242,0.35)' }}>E</div>
                                <p style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>EDITH</p>
                                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
                                    Your AI browser agent. Use <strong style={{ color: 'var(--accent)' }}>🤖 Agent Mode</strong> to automate any browser task.
                                </p>
                                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {['Go to YouTube and search for Coldplay music', 'Search Amazon for wireless headphones under $50', 'Compare AAPL stock on Yahoo Finance vs Google Finance'].map((s) => (
                                        <button key={s} onClick={() => setInput(s)} style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {messages.map((msg) => <MsgBubble key={msg.id} msg={msg} />)}

                        {/* Agent progress log */}
                        {isRunning && progressLog.length > 0 && (
                            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>
                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1.5s infinite' }} />
                                        Agent running...
                                    </div>
                                    <button
                                        onClick={stopAgent}
                                        style={{
                                            padding: '2px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                                            background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444',
                                            border: '1px solid rgba(239, 68, 68, 0.3)',
                                        }}
                                    >
                                        ⏹ Stop
                                    </button>
                                </div>
                                {progressLog.map((log, i) => (
                                    <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', paddingLeft: 14 }}>{log}</div>
                                ))}
                            </div>
                        )}

                        {isRunning && progressLog.length === 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                                <span style={{ width: 16, height: 16, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                                {statusText || 'Thinking...'}
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>

                    {/* ─── Input Area ─── */}
                    <div style={{ flexShrink: 0, padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                        {/* Mode toggle */}
                        <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                            {(['chat', 'agent', 'research'] as ChatMode[]).map((m) => (
                                <button
                                    key={m}
                                    onClick={() => setMode(m)}
                                    style={{
                                        padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 500,
                                        background: mode === m ? 'var(--accent)' : 'var(--bg-card)',
                                        color: mode === m ? '#fff' : 'var(--text-secondary)',
                                        border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`,
                                    }}
                                >
                                    {m === 'agent' ? '🤖 Agent' : m === 'research' ? '🔬 Research' : '💬 Chat'}
                                </button>
                            ))}
                            {mode === 'agent' && (
                                <span style={{ fontSize: 11, color: 'var(--warning)' }}>Controls your browser</span>
                            )}
                            {mode === 'research' && (
                                <span style={{ fontSize: 11, color: 'var(--warning)' }}>Multi-tab parallel</span>
                            )}
                        </div>

                        <div style={{ display: 'flex', gap: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '8px 10px', alignItems: 'flex-end' }}>
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={mode === 'agent' ? 'Give EDITH a browser task...' : mode === 'research' ? 'What do you want to research across sites?' : 'Ask EDITH anything...'}
                                rows={1}
                                disabled={isRunning}
                                style={{
                                    flex: 1, resize: 'none', background: 'transparent', border: 'none', outline: 'none',
                                    color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                                    maxHeight: 100, overflowY: 'auto',
                                }}
                            />
                            {isRunning ? (
                                <button
                                    onClick={stopAgent}
                                    title="Stop automation"
                                    style={{
                                        width: 32, height: 32, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
                                        background: '#ef4444',
                                        border: 'none', color: '#fff',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: 14,
                                    }}
                                >
                                    ⏹
                                </button>
                            ) : (
                                <button
                                    onClick={sendMessage}
                                    disabled={!input.trim()}
                                    style={{
                                        width: 32, height: 32, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
                                        background: !input.trim() ? 'rgba(92,115,242,0.3)' : 'var(--accent)',
                                        border: 'none', color: '#fff',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    }}
                                >
                                    ➤
                                </button>
                            )}
                        </div>
                        <p style={{ fontSize: 10, marginTop: 6, textAlign: 'center', color: 'var(--text-secondary)', opacity: 0.6 }}>
                            Enter to send · Shift+Enter for new line
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}

// ─── Components ───────────────────────────────────────────────────────────────

function MsgBubble({ msg }: { msg: Message }) {
    const isUser = msg.role === 'user';
    const isTool = msg.role === 'tool';

    if (isTool) {
        return (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 11, fontFamily: 'monospace' }}>
                <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>🔧 {msg.toolName}</div>
                <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>{msg.content}</div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', alignItems: 'flex-start', gap: 8 }}>
            {!isUser && (
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>E</div>
            )}
            <div
                style={{
                    maxWidth: '78%', padding: '8px 12px', fontSize: 13, lineHeight: 1.5,
                    borderRadius: isUser ? '14px 14px 4px 14px' : '4px 14px 14px 14px',
                    background: isUser ? 'var(--accent)' : 'var(--bg-card)',
                    color: isUser ? '#fff' : 'var(--text-primary)',
                    border: isUser ? 'none' : '1px solid var(--border)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
            >
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div style={{ marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {msg.toolCalls.map((tc) => (
                            <span key={tc.id} style={{ fontSize: 11, background: 'rgba(92,115,242,0.2)', color: 'var(--accent)', padding: '2px 6px', borderRadius: 4 }}>
                                🔧 {tc.name}
                            </span>
                        ))}
                    </div>
                )}
                {msg.content}
            </div>
        </div>
    );
}

function IconBtn({ children, onClick, title, active }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean }) {
    return (
        <button
            onClick={onClick}
            title={title}
            style={{
                width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
            }}
        >
            {children}
        </button>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4, fontWeight: 500 }}>{label}</label>
            {children}
        </div>
    );
}

const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
};
