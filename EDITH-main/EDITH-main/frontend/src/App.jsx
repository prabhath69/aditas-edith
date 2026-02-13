import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import ChatWindow from "./components/ChatWindow";
import AuditPanel from "./components/AuditPanel";
import Sidebar from "./components/Sidebar";
import SettingsPanel from "./components/SettingsPanel";
import { RotateCcw } from "lucide-react";
import "./index.css";

function App() {
  const [messages, setMessages] = useState([
    {
      id: 1,
      text: "EDITH v2.0 (Elite Edition) Online. All 16 intelligence pillars are being initialized. How can I assist your mission today?",
      sender: "ai",
    },
  ]);
  const [logs, setLogs] = useState([
    {
      id: 1,
      type: "success",
      text: "EDITH v1.0 Core Online. All modules healthy.",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null);

  const loadChatSession = async (sessionId) => {
    try {
      const res = await axios.get(
        `http://localhost:8000/api/v1/sessions/${sessionId}/messages`
      );
      const loadedMessages = res.data.map((msg, idx) => ({
        id: idx + 1,
        text: msg.content,
        sender: msg.role === "user" ? "user" : "ai",
      }));
      setMessages(loadedMessages);
      setCurrentSessionId(sessionId);
    } catch (err) {
      console.error("Failed to load chat session", err);
    }
  };

  const resetSession = () => {
    setMessages([
      {
        id: Date.now(),
        text: "Session Reset. How can I help you now?",
        sender: "ai",
      },
    ]);
    setLogs([
      {
        id: Date.now(),
        type: "success",
        text: "History Cleared. New context initialized.",
      },
    ]);
    setCurrentSessionId(null);
  };

  const handleSendMessage = async (text) => {
    const newUserMsg = { id: Date.now(), text, sender: "user" };
    setMessages((prev) => [...prev, newUserMsg]);

    setIsProcessing(true);
    setLogs((prev) => [
      ...prev,
      { id: Date.now(), type: "thinking", text: `Planning Sequence...` },
    ]);

    try {
      const history = messages.slice(-10).map((m) => ({
        role: m.sender === "user" ? "user" : "model",
        parts: [{ text: m.text }],
      }));

      const response = await axios.post("http://localhost:8000/api/v1/chat/", {
        message: text,
        history: history,
      });

      const { response: aiText, log_id, intent, actions } = response.data;

      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 20, text: aiText, sender: "ai" },
      ]);

      setLogs((prev) => [
        ...prev,
        { id: Date.now() + 1, type: "action", text: `Intent: ${intent}` },
      ]);

      try {
        const logRes = await axios.get(
          `http://localhost:8000/api/v1/logs/${log_id}`
        );
        const logData = logRes.data;

        if (logData.details && logData.details.plan) {
          setLogs((prev) => [
            ...prev,
            {
              id: Date.now() + 2,
              type: "thinking",
              text: "Reasoning: Plan Generated",
              details: logData.details.plan,
            },
          ]);
        }

        if (logData.details && logData.details.steps) {
          logData.details.steps.forEach((step, idx) => {
            setLogs((prev) => [
              ...prev,
              {
                id: Date.now() + 10 + idx,
                type: "action",
                text: `Executing: ${step.action}`,
                details: { arguments: step.args, result: step.result },
              },
            ]);
          });
        }
      } catch (logError) {
        console.warn("Audit logs temporarily unavailable.");
      }

      setLogs((prev) => [
        ...prev,
        {
          id: Date.now() + 60,
          type: "success",
          text: `Sequence Complete (ID: ${log_id})`,
        },
      ]);
    } catch (error) {
      console.error("Chat Error:", error);
      setLogs((prev) => [
        ...prev,
        {
          id: Date.now() + 40,
          type: "error",
          text: "Agent error. Try resetting the session.",
        },
      ]);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 5,
          text: "I encountered an error. Would you like to reset the session?",
          sender: "ai",
        },
      ]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        onSettingsClick={() => setShowSettings(true)}
        onNewChat={resetSession}
        onChatClick={loadChatSession}
      />
      {showSettings && (
        <div className="settings-overlay">
          <SettingsPanel onClose={() => setShowSettings(false)} />
        </div>
      )}
      <div className="chat-area">
        <header>
          <div className="logo-container">
            <div className="logo-icon">E2</div>
            <div className="logo-text">EDITH v2.0 Elite</div>
          </div>

          <button onClick={resetSession} className="reset-btn-glass">
            <RotateCcw size={14} />
            <span>New Session</span>
          </button>
        </header>

        <ChatWindow
          messages={messages}
          onSend={handleSendMessage}
          isProcessing={isProcessing}
        />
      </div>
      <AuditPanel
        logs={logs}
        onClear={() =>
          setLogs([
            { id: Date.now(), type: "success", text: "Process log reset." },
          ])
        }
      />
    </div>
  );
}

export default App;
