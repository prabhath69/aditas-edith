import React, { useState, useRef, useEffect } from "react";
import { Send, User, Bot, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ChatWindow = ({ messages, onSend, isProcessing }) => {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim() && !isProcessing) {
      onSend(input);
      setInput("");
    }
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://localhost:8000/api/v1/files/upload/", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        onSend(
          `I have uploaded the file: ${data.filename}. Please analyze it.`
        );
      } else {
        alert("Upload failed: " + data.detail);
      }
    } catch (err) {
      console.error(err);
      alert("Error uploading file.");
    }
  };

  return (
    <>
      <div className="messages-list">
        {messages.map((m) => (
          <div key={m.id} className={`message ${m.sender}`}>
            <div className="avatar">
              {m.sender === "user" ? <User size={20} /> : <Bot size={20} />}
            </div>
            <div
              className={`bubble ${m.sender === "ai" ? "markdown-body" : ""}`}
            >
              {m.sender === "ai" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {m.text}
                </ReactMarkdown>
              ) : (
                m.text
              )}
            </div>
          </div>
        ))}
        {isProcessing && (
          <div className="message ai">
            <div className="avatar">
              <Bot size={20} />
            </div>
            <div className="bubble status-dots">
              <span
                className="dot"
                style={{ animation: "pulse 1s infinite" }}
              ></span>
              <span
                className="dot"
                style={{ animation: "pulse 1s infinite 0.2s" }}
              ></span>
              <span
                className="dot"
                style={{ animation: "pulse 1s infinite 0.4s" }}
              ></span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
        <form className="input-wrapper" onSubmit={handleSubmit}>
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            style={{
              marginRight: "8px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "#64748b",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Paperclip size={20} />
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <input
            type="text"
            placeholder="Type a message or command..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isProcessing}
          />
          <button type="submit" disabled={isProcessing || !input.trim()}>
            <Send size={18} />
          </button>
        </form>
      </div>
    </>
  );
};

export default ChatWindow;
