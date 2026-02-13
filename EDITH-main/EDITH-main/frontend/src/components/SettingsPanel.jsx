import React, { useState, useEffect } from "react";
import axios from "axios";
import { X, Save, AlertCircle } from "lucide-react";

const SettingsPanel = ({ onClose }) => {
  const [settings, setSettings] = useState({
    USER_NAME: "",
    SMTP_EMAIL: "",
    SMTP_PASSWORD: "",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await axios.get("http://localhost:8000/api/v1/settings/");
      const data = res.data;
      const newSettings = { ...settings };
      data.forEach((item) => {
        if (newSettings.hasOwnProperty(item.key)) {
          newSettings[item.key] = item.value;
        }
      });
      setSettings(newSettings);
    } catch (err) {
      console.error("Failed to load settings", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setMessage(null);
    try {
      for (const [key, value] of Object.entries(settings)) {
        await axios.post("http://localhost:8000/api/v1/settings/", {
          key,
          value,
          description: `Config for ${key}`,
        });
      }
      setMessage({ type: "success", text: "Settings saved successfully!" });
    } catch (err) {
      console.error(err);
      setMessage({ type: "error", text: "Failed to save settings." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Communication Settings</h2>
        <button onClick={onClose} className="close-btn">
          <X size={20} />
        </button>
      </div>

      <div className="settings-content">
        {message && (
          <div className={`settings-alert ${message.type}`}>
            {message.type === "error" && <AlertCircle size={16} />}
            {message.text}
          </div>
        )}

        <div className="setting-group">
          <label>Your Name</label>
          <input
            type="text"
            value={settings.USER_NAME}
            onChange={(e) =>
              setSettings({ ...settings, USER_NAME: e.target.value })
            }
            placeholder="John Doe"
          />
          <span className="help-text">
            Used for personalized communication.
          </span>
        </div>

        <div className="setting-group">
          <label>SMTP Email (Gmail)</label>
          <input
            type="email"
            value={settings.SMTP_EMAIL}
            onChange={(e) =>
              setSettings({ ...settings, SMTP_EMAIL: e.target.value })
            }
            placeholder="your-email@gmail.com"
          />
        </div>

        <div className="setting-group">
          <label>SMTP App Password</label>
          <input
            type="password"
            value={settings.SMTP_PASSWORD}
            onChange={(e) =>
              setSettings({ ...settings, SMTP_PASSWORD: e.target.value })
            }
            placeholder="••••••••••••••••"
          />
          <span className="help-text">
            Use an App Password, not your login password.
          </span>
        </div>

        <div className="settings-divider">
          <h3>LinkedIn Integration</h3>
        </div>

        <div className="setting-group">
          <label>LinkedIn Client ID</label>
          <input
            type="text"
            value={settings.LINKEDIN_CLIENT_ID}
            onChange={(e) =>
              setSettings({ ...settings, LINKEDIN_CLIENT_ID: e.target.value })
            }
            placeholder="Your LinkedIn App Client ID"
          />
          <span className="help-text">
            Get this from your LinkedIn Developer App.
          </span>
        </div>

        <div className="setting-group">
          <label>LinkedIn Client Secret</label>
          <input
            type="password"
            value={settings.LINKEDIN_CLIENT_SECRET}
            onChange={(e) =>
              setSettings({
                ...settings,
                LINKEDIN_CLIENT_SECRET: e.target.value,
              })
            }
            placeholder="••••••••••••••••"
          />
          <span className="help-text">
            Keep this secret! Never share it publicly.
          </span>
        </div>

        <div className="settings-actions">
          <button className="save-btn" onClick={handleSave} disabled={loading}>
            <Save size={16} />
            {loading ? "Saving..." : "Save Configuration"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
