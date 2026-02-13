import React, { useEffect, useState } from "react";
import { Settings, Plus, MessageSquare } from "lucide-react";
import axios from "axios";

const Sidebar = ({ onSettingsClick, onNewChat, onChatClick }) => {
  const [chatHistory, setChatHistory] = useState([]);

  useEffect(() => {
    fetchChatHistory();
    const interval = setInterval(fetchChatHistory, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchChatHistory = async () => {
    try {
      const res = await axios.get(
        "http://localhost:8000/api/v1/logs/?limit=10"
      );
      setChatHistory(res.data);
    } catch (e) {
      console.error("Failed to fetch chat history", e);
    }
  };

  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="logo-container">
        <div className="logo-icon">E2</div>
        <div className="logo-text">EDITH v2.0</div>
      </div>

      {/* New Chat Button */}
      <button className="new-chat-btn" onClick={onNewChat}>
        <Plus size={18} />
        <span>New Chat</span>
      </button>

      {/* Chat History */}
      <div className="chat-history-section">
        <h2>Recent Chats</h2>
        {chatHistory.length === 0 ? (
          <p className="empty-state">No chat history yet</p>
        ) : (
          chatHistory.map((session) => (
            <div
              key={session.id}
              className="chat-history-item"
              onClick={() => onChatClick(session.id)}
            >
              <MessageSquare size={16} />
              <div className="chat-info">
                <span className="chat-title">
                  {session.title || "Untitled Chat"}
                </span>
                <span className="chat-time">
                  {new Date(session.updated_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Settings at Bottom */}
      <div className="sidebar-footer">
        <div className="nav-item" onClick={onSettingsClick}>
          <Settings size={18} />
          <span>System Settings</span>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
