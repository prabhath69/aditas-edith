import React, { useState } from "react";
import { Terminal, ChevronDown, ChevronRight, Eraser } from "lucide-react";

const AuditPanel = ({ logs, onClear }) => {
  const [expandedLog, setExpandedLog] = useState(null);

  const toggleExpand = (id) => {
    setExpandedLog(expandedLog === id ? null : id);
  };

  return (
    <div className="audit-panel">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "24px",
          paddingBottom: "16px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Terminal size={14} color="#94a3b8" />
          <h2>Process Log</h2>
        </div>
        <button onClick={onClear} className="clear-btn" title="Clear All Logs">
          <Eraser size={14} />
        </button>
      </div>

      <div className="logs-container" style={{ flex: 1, overflowY: "auto" }}>
        {logs.map((log) => (
          <div
            key={log.id}
            className={`log-entry ${log.type}`}
            onClick={() => log.details && toggleExpand(log.id)}
            style={{ cursor: log.details ? "pointer" : "default" }}
          >
            <div
              style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
            >
              {log.details &&
                (expandedLog === log.id ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                ))}
              <span
                style={{
                  color:
                    log.type === "error"
                      ? "#f87171"
                      : log.type === "success"
                      ? "#4ade80"
                      : log.type === "thinking"
                      ? "#60a5fa"
                      : "#cbd5e1",
                }}
              >
                {`> ${log.text}`}
              </span>
            </div>

            {expandedLog === log.id && log.details && (
              <div className="log-payload">
                <div className="payload-header">Context Data</div>
                <pre>{JSON.stringify(log.details, null, 2)}</pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AuditPanel;
