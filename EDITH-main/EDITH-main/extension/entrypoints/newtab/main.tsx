import React, { useState, useEffect } from 'react';
import '../../assets/global.css';
import { createRoot } from 'react-dom/client';

function NewTab() {
    const [time, setTime] = useState(new Date());
    const [input, setInput] = useState('');

    useEffect(() => {
        const t = setInterval(() => setTime(new Date()), 1000);
        return () => clearInterval(t);
    }, []);

    const openSidepanel = () => {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    };

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;
        // Open sidepanel with the query as an agent task
        chrome.runtime.sendMessage({ type: 'QUICK_TASK', prompt: input.trim() });
        openSidepanel();
    };

    const greetingHour = time.getHours();
    const greeting =
        greetingHour < 12 ? 'Good morning' : greetingHour < 18 ? 'Good afternoon' : 'Good evening';

    return (
        <div
            className="min-h-screen flex flex-col items-center justify-center"
            style={{
                background: 'linear-gradient(135deg, #0f1117 0%, #1a1d27 50%, #0f1117 100%)',
                color: 'var(--text-primary)',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            }}
        >
            {/* Accent blob */}
            <div
                style={{
                    position: 'fixed',
                    top: '20%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '600px',
                    height: '300px',
                    background: 'radial-gradient(ellipse, rgba(92,115,242,0.12) 0%, transparent 70%)',
                    pointerEvents: 'none',
                }}
            />

            {/* Logo */}
            <div className="flex items-center gap-3 mb-8">
                <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl font-bold"
                    style={{ background: 'var(--accent)', color: '#fff', boxShadow: '0 0 40px rgba(92,115,242,0.3)' }}
                >
                    E
                </div>
                <span className="text-3xl font-bold tracking-tight">EDITH</span>
            </div>

            {/* Time */}
            <div className="text-5xl font-extralight mb-2 tabular-nums">
                {time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
            </div>
            <div className="text-sm mb-10" style={{ color: 'var(--text-secondary)' }}>
                {greeting} ·{' '}
                {time.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>

            {/* Quick task input */}
            <form onSubmit={handleSearch} className="w-full max-w-lg px-4">
                <div
                    className="flex items-center gap-2 rounded-2xl px-4 py-3"
                    style={{
                        background: 'rgba(30,33,48,0.8)',
                        border: '1px solid var(--border)',
                        backdropFilter: 'blur(10px)',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                    }}
                >
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
                    >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Ask EDITH anything or give it a task..."
                        className="flex-1 bg-transparent outline-none text-sm"
                        style={{ color: 'var(--text-primary)' }}
                    />
                    <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg text-xs font-medium"
                        style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                        Go
                    </button>
                </div>
            </form>

            <p className="text-xs mt-4" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
                Opens EDITH sidepanel · Agent Mode automatically enabled
            </p>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(
    <React.StrictMode>
        <NewTab />
    </React.StrictMode>,
);
