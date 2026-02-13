import React, { useState, useEffect } from "react";
import axios from "axios";
import { X, Clock, Trash2, Plus, Play } from "lucide-react";

const SchedulerPanel = ({ onClose }) => {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newTask, setNewTask] = useState("");
  const [interval, setInterval] = useState("60");

  useEffect(() => {
    fetchJobs();
    const timer = setInterval(fetchJobs, 5000); // Poll every 5s
    return () => clearInterval(timer);
  }, []);

  const fetchJobs = async () => {
    try {
      const res = await axios.get("http://localhost:8000/api/v1/scheduler/");
      setJobs(res.data);
    } catch (err) {
      console.error("Failed to fetch jobs", err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddJob = async () => {
    if (!newTask) return;
    try {
      await axios.post("http://localhost:8000/api/v1/scheduler/", {
        task: newTask,
        interval_seconds: parseInt(interval),
      });
      setNewTask("");
      fetchJobs();
    } catch (err) {
      console.error("Failed to add job", err);
    }
  };

  const handleDeleteJob = async (id) => {
    try {
      await axios.delete(`http://localhost:8000/api/v1/scheduler/${id}`);
      fetchJobs();
    } catch (err) {
      console.error("Failed to delete job", err);
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Automation Scheduler</h2>
        <button onClick={onClose} className="close-btn">
          <X size={20} />
        </button>
      </div>

      <div className="settings-content">
        {/* Create Job Form */}
        <div className="schedule-form">
          <h3>Schedule New Task</h3>
          <div className="form-row">
            <input
              type="text"
              placeholder="Task Description (e.g. 'Check email')"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              className="task-input"
            />
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="interval-select"
            >
              <option value="60">Every 1 Minute</option>
              <option value="300">Every 5 Minutes</option>
              <option value="3600">Every 1 Hour</option>
              <option value="86400">Every 24 Hours</option>
            </select>
            <button onClick={handleAddJob} className="add-job-btn">
              <Plus size={16} />
              Add
            </button>
          </div>
        </div>

        {/* Jobs List */}
        <div className="jobs-list">
          <h3>Active Jobs ({jobs.length})</h3>
          {loading ? (
            <p>Loading...</p>
          ) : jobs.length === 0 ? (
            <p className="empty-state">No scheduled tasks running.</p>
          ) : (
            jobs.map((job) => (
              <div key={job.id} className="job-item">
                <div className="job-info">
                  <span className="job-name">{job.name}</span>
                  <span className="job-meta">
                    <Clock size={12} /> Next run:{" "}
                    {job.next_run
                      ? new Date(job.next_run).toLocaleTimeString()
                      : "Pending"}
                  </span>
                </div>
                <button
                  onClick={() => handleDeleteJob(job.id)}
                  className="delete-btn"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default SchedulerPanel;
