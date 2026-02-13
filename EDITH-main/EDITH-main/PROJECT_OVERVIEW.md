# EDITH v2.0 (Elite Edition) - Complete Project Overview

## 📋 Table of Contents

1. [Project Introduction](#project-introduction)
2. [System Architecture](#system-architecture)
3. [Core Features](#core-features)
4. [Technology Stack](#technology-stack)
5. [Project Structure](#project-structure)
6. [Setup & Installation](#setup--installation)
7. [API Documentation](#api-documentation)
8. [Database Schema](#database-schema)
9. [Key Components Deep Dive](#key-components-deep-dive)
10. [Usage Guide](#usage-guide)
11. [Development Workflow](#development-workflow)
12. [Future Enhancements](#future-enhancements)

---

## 🎯 Project Introduction

**EDITH** (Elite Digital Intelligence & Task Handler) is an advanced AI-powered agentic system designed to make university management and personal productivity tasks seamless and user-friendly. Built with a focus on intelligent automation, EDITH combines natural language understanding, multi-tool orchestration, and autonomous task execution to serve as a comprehensive digital assistant.

### Mission Statement

To create a super user-friendly system that makes it easy for universities to manage their operations while providing powerful AI-driven automation capabilities for everyday tasks.

### Key Objectives

- **Intelligent Task Automation**: Automatically detect user intent and execute complex multi-step tasks
- **Seamless Communication**: Integrate email, scheduling, and LinkedIn automation
- **Document Processing**: Handle PDFs, Excel, Word, PowerPoint with AI-powered analysis
- **Web Automation**: Browse websites, take screenshots, and extract information
- **Transparent Operations**: Provide detailed audit logs and reasoning traces for all actions

---

## 🏗️ System Architecture

EDITH follows a modern **client-server architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (React)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Chat   │  │  Audit   │  │ Settings │  │ Scheduler│   │
│  │  Window  │  │  Panel   │  │  Panel   │  │  Panel   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↕ HTTP/REST API
┌─────────────────────────────────────────────────────────────┐
│                    Backend (FastAPI)                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              API Endpoints Layer                      │  │
│  │  Auth | Chat | Files | Logs | Settings | Scheduler   │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Service Layer                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │  │
│  │  │   LLM    │  │   MCP    │  │ Planner  │           │  │
│  │  │ Service  │  │ Service  │  │ Service  │           │  │
│  │  └──────────┘  └──────────┘  └──────────┘           │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │  │
│  │  │  Intent  │  │Scheduler │  │ LinkedIn │           │  │
│  │  │ Detector │  │ Service  │  │ Service  │           │  │
│  │  └──────────┘  └──────────┘  └──────────┘           │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Database Layer (SQLite)                  │  │
│  │  Users | AuditLogs | Settings | Sessions | Messages  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────┐
│                  External Integrations                       │
│  Google Gemini | Groq | Tavily | Serper | LinkedIn API     │
└─────────────────────────────────────────────────────────────┘
```

### Architecture Highlights

1. **Frontend**: Single-page React application with real-time chat interface
2. **Backend**: FastAPI-based REST API with async support
3. **AI Engine**: Multi-provider LLM support (Google Gemini, Groq) with function calling
4. **Tool System**: MCP (Model Context Protocol) service with 20+ integrated tools
5. **Database**: SQLite with SQLAlchemy ORM for persistence
6. **Scheduler**: APScheduler for recurring task automation

---

## ✨ Core Features

### 1. **Intelligent Chat Interface**

- Natural language conversation with context awareness
- Real-time message streaming
- Session management with history
- Multi-turn dialogue support

### 2. **Agentic Task Execution**

EDITH uses an advanced agentic loop that:

- Detects user intent (CHAT, TASK, HYBRID)
- Generates execution plans for complex tasks
- Autonomously selects and executes appropriate tools
- Provides transparent reasoning and audit trails
- Handles up to 12 iterations of tool calls per request

### 3. **Tool Ecosystem (20+ Tools)**

#### 📧 Communication Tools

- **Email Management**: Draft, send, and read emails via SMTP/IMAP
- **LinkedIn Integration**: Generate and post professional content
- **Slack Integration**: Send notifications (configurable)

#### 📄 Document Processing

- **PDF Operations**: Read, create, and format PDFs with Markdown support
- **Word Documents**: Create DOCX files with rich formatting
- **PowerPoint**: Generate presentations programmatically
- **Excel**: Create and analyze spreadsheets with styling

#### 🌐 Web Automation

- **Web Search**: Real search via Tavily and Serper APIs
- **URL Browsing**: Playwright-based web scraping with JavaScript support
- **Screenshot Capture**: Automated screenshot generation
- **Data Extraction**: Intelligent content parsing

#### 📊 Data Analysis

- **CSV/Excel Analysis**: Pandas-powered data analysis
- **Query Processing**: Natural language data queries
- **Statistical Summaries**: Automated insights generation

#### ⏰ Scheduling & Automation

- **Task Scheduling**: Recurring task automation
- **Interval Triggers**: Second/minute/hour-based scheduling
- **Date Triggers**: One-time scheduled tasks
- **Job Management**: List and cancel scheduled jobs

#### 🗂️ File Operations

- **File Writing**: Create text files programmatically
- **File Reading**: Access and process local files
- **Multi-format Support**: Handle various file types

### 4. **Planning & Reasoning**

- **Intent Detection**: Automatically classify user requests
- **Plan Generation**: Create step-by-step execution plans
- **Reasoning Logs**: Detailed audit trails for transparency
- **Error Recovery**: Graceful handling of failures

### 5. **Audit & Monitoring**

- Comprehensive logging of all actions
- Real-time process visualization
- Detailed execution traces
- Performance metrics tracking

---

## 🛠️ Technology Stack

### Frontend

| Technology         | Version | Purpose                  |
| ------------------ | ------- | ------------------------ |
| **React**          | 19.2.0  | UI framework             |
| **Vite**           | 7.2.4   | Build tool & dev server  |
| **Axios**          | 1.13.2  | HTTP client              |
| **Lucide React**   | 0.562.0 | Icon library             |
| **React Markdown** | 10.1.0  | Markdown rendering       |
| **Remark GFM**     | 4.0.1   | GitHub Flavored Markdown |

### Backend

| Technology       | Purpose                    |
| ---------------- | -------------------------- |
| **FastAPI**      | Modern async web framework |
| **Uvicorn**      | ASGI server                |
| **Pydantic**     | Data validation            |
| **SQLAlchemy**   | ORM & database toolkit     |
| **Python-Jose**  | JWT authentication         |
| **Passlib**      | Password hashing           |
| **HTTPX**        | Async HTTP client          |
| **Google GenAI** | Gemini LLM integration     |
| **Playwright**   | Browser automation         |
| **APScheduler**  | Task scheduling            |
| **Pandas**       | Data analysis              |
| **PyPDF**        | PDF processing             |
| **Python-DOCX**  | Word document creation     |
| **Python-PPTX**  | PowerPoint generation      |
| **OpenPyXL**     | Excel operations           |
| **ReportLab**    | PDF generation             |

### External APIs

- **Google Gemini**: Primary LLM provider
- **Groq**: Alternative LLM provider
- **Tavily**: Web search API
- **Serper**: Google search API
- **LinkedIn API**: Social media integration

---

## 📁 Project Structure

```
EDITH/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   └── v1/
│   │   │       └── endpoints/
│   │   │           ├── auth.py          # Authentication endpoints
│   │   │           ├── chat.py          # Main chat & agentic loop
│   │   │           ├── files.py         # File upload/download
│   │   │           ├── linkedin.py      # LinkedIn OAuth & posting
│   │   │           ├── logs.py          # Audit log retrieval
│   │   │           ├── scheduler.py     # Task scheduling
│   │   │           ├── sessions.py      # Chat session management
│   │   │           └── settings.py      # System configuration
│   │   ├── core/
│   │   │   └── config.py                # Application settings
│   │   ├── db/
│   │   │   ├── database.py              # Database connection
│   │   │   └── models.py                # SQLAlchemy models
│   │   └── services/
│   │       ├── intent_service.py        # Intent classification
│   │       ├── linkedin_service.py      # LinkedIn integration
│   │       ├── llm_service.py           # LLM provider abstraction
│   │       ├── mcp_service.py           # Tool execution engine
│   │       ├── planner_service.py       # Task planning
│   │       └── scheduler_service.py     # Job scheduling
│   ├── agent_files/                     # File storage
│   ├── main.py                          # Application entry point
│   ├── requirements.txt                 # Python dependencies
│   ├── .env                             # Environment variables
│   └── sql_app.db                       # SQLite database
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuditPanel.jsx           # Process log viewer
│   │   │   ├── ChatWindow.jsx           # Chat interface
│   │   │   ├── SchedulerPanel.jsx       # Task scheduler UI
│   │   │   ├── SettingsPanel.jsx        # Configuration UI
│   │   │   └── Sidebar.jsx              # Navigation sidebar
│   │   ├── App.jsx                      # Main application
│   │   ├── App.css                      # Component styles
│   │   ├── index.css                    # Global styles
│   │   └── main.jsx                     # React entry point
│   ├── public/                          # Static assets
│   ├── index.html                       # HTML template
│   ├── package.json                     # Node dependencies
│   └── vite.config.js                   # Vite configuration
│
└── PROJECT_OVERVIEW.md                  # This file
```

---

## 🚀 Setup & Installation

### Prerequisites

- **Python**: 3.9 or higher
- **Node.js**: 16 or higher
- **npm**: 8 or higher

### Backend Setup

1. **Navigate to backend directory**

   ```bash
   cd backend
   ```

2. **Create virtual environment**

   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**

   ```bash
   pip install -r requirements.txt
   ```

4. **Install Playwright browsers**

   ```bash
   playwright install
   ```

5. **Configure environment variables**

   Edit `.env` file with your API keys:

   ```env
   # Security
   SECRET_KEY=your_secret_key_here
   ALGORITHM=HS256
   ACCESS_TOKEN_EXPIRE_MINUTES=30

   # Database
   DATABASE_URL=sqlite:///./sql_app.db

   # AI Providers
   GOOGLE_API_KEY=your_google_api_key
   GROQ_API_KEY=your_groq_api_key

   # Search APIs
   SERPER_API_KEY=your_serper_key
   TAVILY_API_KEY=your_tavily_key

   # Communication
   SMTP_EMAIL=your_email@gmail.com
   SMTP_PASSWORD=your_app_password
   SLACK_WEBHOOK_URL=your_slack_webhook

   # LinkedIn
   LINKEDIN_CLIENT_ID=your_client_id
   LINKEDIN_CLIENT_SECRET=your_client_secret
   LINKEDIN_REDIRECT_URI=http://localhost:8000/api/v1/linkedin/callback
   ```

6. **Run the backend server**

   ```bash
   python main.py
   ```

   Server will start at: `http://localhost:8000`

### Frontend Setup

1. **Navigate to frontend directory**

   ```bash
   cd frontend
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start development server**

   ```bash
   npm run dev
   ```

   Application will open at: `http://localhost:5173`

### Verification

1. Open browser to `http://localhost:5173`
2. You should see EDITH's chat interface
3. Try sending a message: "Hello, what can you do?"
4. Check the audit panel on the right for process logs

---

## 📡 API Documentation

### Base URL

```
http://localhost:8000/api/v1
```

### Authentication Endpoints

#### POST `/auth/register`

Register a new user.

**Request Body:**

```json
{
  "username": "string",
  "password": "string",
  "full_name": "string"
}
```

#### POST `/auth/login`

Login and receive JWT token.

**Request Body:**

```json
{
  "username": "string",
  "password": "string"
}
```

**Response:**

```json
{
  "access_token": "string",
  "token_type": "bearer"
}
```

### Chat Endpoints

#### POST `/chat/`

Send a message and receive AI response.

**Request Body:**

```json
{
  "message": "string",
  "history": [
    {
      "role": "user|model",
      "parts": [{ "text": "string" }]
    }
  ]
}
```

**Response:**

```json
{
  "response": "string",
  "log_id": 123,
  "intent": "CHAT|TASK|HYBRID",
  "actions": ["action1", "action2"]
}
```

### Session Endpoints

#### GET `/sessions/`

List all chat sessions.

#### POST `/sessions/`

Create a new chat session.

#### GET `/sessions/{session_id}/messages`

Get messages for a specific session.

### Scheduler Endpoints

#### POST `/scheduler/schedule`

Schedule a recurring task.

**Request Body:**

```json
{
  "task_description": "Check emails every hour",
  "trigger_type": "interval",
  "trigger_value": "3600"
}
```

#### GET `/scheduler/jobs`

List all scheduled jobs.

#### DELETE `/scheduler/jobs/{job_id}`

Cancel a scheduled job.

### Settings Endpoints

#### GET `/settings/`

Get all system settings.

#### PUT `/settings/{key}`

Update a system setting.

### Logs Endpoints

#### GET `/logs/{log_id}`

Get detailed audit log by ID.

### LinkedIn Endpoints

#### GET `/linkedin/auth`

Initiate LinkedIn OAuth flow.

#### GET `/linkedin/callback`

OAuth callback handler.

#### POST `/linkedin/post`

Post content to LinkedIn.

---

## 🗄️ Database Schema

### Users Table

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username VARCHAR UNIQUE NOT NULL,
    hashed_password VARCHAR NOT NULL,
    full_name VARCHAR,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Audit Logs Table

```sql
CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action_type VARCHAR,  -- CHAT, TASK, AUTH
    description VARCHAR,
    details JSON,  -- Stores plan, steps, results
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### System Settings Table

```sql
CREATE TABLE system_settings (
    key VARCHAR PRIMARY KEY,
    value VARCHAR,
    description VARCHAR,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Chat Sessions Table

```sql
CREATE TABLE chat_sessions (
    id INTEGER PRIMARY KEY,
    title VARCHAR,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Chat Messages Table

```sql
CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES chat_sessions(id),
    role VARCHAR,  -- user, assistant
    content VARCHAR,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🔍 Key Components Deep Dive

### 1. LLM Service (`llm_service.py`)

**Purpose**: Abstraction layer for multiple LLM providers with function calling support.

**Key Features**:

- Multi-provider support (Google Gemini, Groq)
- Automatic API key rotation
- Function/tool calling capability
- Streaming support
- Error handling and retries

**System Instruction**:

```
You are EDITH v2.0 (Elite Edition), an advanced AI agent with 16 intelligence pillars:
1. Natural Language Understanding
2. Task Planning & Decomposition
3. Tool Selection & Execution
4. Memory & Context Management
5. Error Recovery
6. Learning from Feedback
... and more
```

### 2. MCP Service (`mcp_service.py`)

**Purpose**: Model Context Protocol implementation - the tool execution engine.

**Architecture**:

- **Tool Definitions**: JSON schema for each tool
- **Tool Execution**: Dynamic dispatch to appropriate handlers
- **State Management**: Maintains context between tool calls
- **Error Handling**: Graceful degradation

**Available Tools** (20+):

1. `draft_email` - Compose emails with approval workflow
2. `confirm_send_email` - Send drafted emails
3. `read_email` - Fetch unread emails via IMAP
4. `search` - Web search via Tavily/Serper
5. `browse_url` - Playwright-based web browsing
6. `take_screenshot` - Capture webpage screenshots
7. `write_file` - Create text files
8. `analyze_data` - Pandas-based data analysis
9. `read_pdf` - Extract text from PDFs
10. `create_pdf` - Generate formatted PDFs
11. `create_docx` - Create Word documents
12. `create_ppt` - Generate PowerPoint presentations
13. `create_excel` - Create Excel spreadsheets
14. `schedule_task` - Schedule recurring tasks
15. `list_scheduled_tasks` - View active jobs
16. `cancel_task` - Remove scheduled tasks
17. `generate_linkedin_post` - AI-powered LinkedIn content
18. `post_to_linkedin` - Publish to LinkedIn

### 3. Intent Service (`intent_service.py`)

**Purpose**: Classify user requests to determine execution strategy.

**Intent Types**:

- **CHAT**: Conversational queries (no tools needed)
- **TASK**: Action-oriented requests (requires tools)
- **HYBRID**: Mixed conversation + action

**Classification Logic**:
Uses LLM to analyze:

- Presence of action verbs
- Request for information vs. execution
- Complexity of the request

### 4. Planner Service (`planner_service.py`)

**Purpose**: Generate step-by-step execution plans for complex tasks.

**Process**:

1. Analyze user request
2. Break down into atomic steps
3. Identify required tools for each step
4. Generate reasoning for the plan
5. Return structured plan object

**Example Plan**:

```json
{
  "reasoning": "User wants to analyze sales data and email results",
  "steps": [
    "Read the sales.csv file",
    "Analyze data for trends",
    "Create summary report",
    "Draft email with findings",
    "Send email to stakeholders"
  ]
}
```

### 5. Scheduler Service (`scheduler_service.py`)

**Purpose**: Persistent task scheduling with APScheduler.

**Features**:

- **Interval Triggers**: Execute every N seconds/minutes/hours
- **Date Triggers**: One-time execution at specific time
- **Cron Triggers**: Complex scheduling patterns (future)
- **Persistence**: Jobs survive server restarts
- **Job Management**: List, pause, resume, cancel

**Use Cases**:

- Periodic email checks
- Daily report generation
- Scheduled social media posts
- Automated backups

### 6. Agentic Loop (in `chat.py`)

**Purpose**: Core reasoning and execution engine.

**Flow**:

```
1. Receive user message
2. Detect intent (CHAT/TASK/HYBRID)
3. Generate plan (if TASK/HYBRID)
4. Create audit log entry
5. Enter agentic loop (max 12 iterations):
   a. Send conversation to LLM with tools
   b. LLM decides: respond OR call tool(s)
   c. If tool call:
      - Execute tool via MCP service
      - Add result to conversation
      - Update audit log
      - Continue loop
   d. If response:
      - Return to user
      - Exit loop
6. Save final response
7. Return to frontend
```

**Key Advantages**:

- Autonomous multi-step execution
- Dynamic tool selection
- Context preservation
- Transparent reasoning

---

## 📖 Usage Guide

### Basic Chat

```
User: "Hello, what can you help me with?"
EDITH: "I can help you with emails, scheduling, document creation,
        web research, data analysis, and much more!"
```

### Email Management

```
User: "Draft an email to john@example.com about the project update"
EDITH: [Drafts email and shows preview]
       "I've drafted the email. Would you like me to send it?"
User: "Yes, send it"
EDITH: [Sends email]
       "Email sent successfully!"
```

### Data Analysis

```
User: "Analyze the sales data in sales.csv and tell me the top products"
EDITH: [Reads CSV, analyzes data]
       "Based on the analysis:
       1. Product A: $50,000 in sales
       2. Product B: $35,000 in sales
       3. Product C: $28,000 in sales"
```

### Web Research

```
User: "Search for the latest AI trends and summarize them"
EDITH: [Performs web search, reads articles]
       "Here are the top AI trends for 2026:
       1. Multimodal AI systems
       2. AI agents and automation
       3. Responsible AI practices
       ..."
```

### Document Creation

```
User: "Create a PDF report with our Q4 results"
EDITH: [Generates formatted PDF]
       "I've created the Q4 report PDF with charts and analysis.
       Saved as: Q4_Report_2026.pdf"
```

### Task Scheduling

```
User: "Schedule a task to check my emails every hour"
EDITH: [Creates scheduled job]
       "I've scheduled an hourly email check.
       Job ID: email_check_123"
```

### LinkedIn Automation

```
User: "Generate a LinkedIn post about our new product launch"
EDITH: [Generates professional post]
       "Here's a LinkedIn post draft:

       🚀 Excited to announce the launch of...

       Would you like me to post this?"
```

---

## 👨‍💻 Development Workflow

### Adding a New Tool

1. **Define tool in `mcp_service.py`**:

   ```python
   {
       "name": "my_new_tool",
       "description": "What this tool does",
       "parameters": {
           "type": "object",
           "properties": {
               "param1": {
                   "type": "string",
                   "description": "Parameter description"
               }
           },
           "required": ["param1"]
       }
   }
   ```

2. **Implement handler**:

   ```python
   async def _my_new_tool(self, param1: str):
       # Implementation
       return result
   ```

3. **Add to execute_tool dispatcher**:
   ```python
   elif name == "my_new_tool":
       return await self._my_new_tool(**arguments)
   ```

### Adding a New API Endpoint

1. **Create endpoint in appropriate file** (`backend/app/api/v1/endpoints/`)
2. **Define request/response models** with Pydantic
3. **Implement business logic**
4. **Register router in `main.py`**

### Frontend Component Development

1. **Create component** in `frontend/src/components/`
2. **Import in `App.jsx`**
3. **Add styling** in component CSS or `index.css`
4. **Connect to backend** via Axios

### Testing

**Backend**:

```bash
# Run server
python main.py

# Test endpoint
curl -X POST http://localhost:8000/api/v1/chat/ \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "history": []}'
```

**Frontend**:

```bash
# Development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

---

## 🔮 Future Enhancements

### Planned Features

1. **Enhanced AI Capabilities**

   - Multi-modal support (image, audio, video)
   - Long-term memory with vector database
   - Personalization and learning from user preferences

2. **University Management Features**

   - Student enrollment automation
   - Grade management system
   - Attendance tracking
   - Course scheduling
   - Parent-teacher communication

3. **Advanced Integrations**

   - Calendar integration (Google Calendar, Outlook)
   - Cloud storage (Google Drive, Dropbox)
   - CRM systems
   - Payment gateways

4. **Collaboration Features**

   - Multi-user support
   - Team workspaces
   - Shared task lists
   - Real-time collaboration

5. **Analytics & Insights**

   - Usage analytics dashboard
   - Performance metrics
   - Cost tracking for API usage
   - User behavior insights

6. **Mobile Application**

   - React Native mobile app
   - Push notifications
   - Offline mode

7. **Security Enhancements**
   - Role-based access control (RBAC)
   - Two-factor authentication
   - Audit trail encryption
   - Compliance features (GDPR, FERPA)

---

## 🤝 Contributing

This project is designed to be easily extensible. Key areas for contribution:

1. **New Tools**: Add more integrations and capabilities
2. **UI/UX**: Improve the frontend experience
3. **Documentation**: Enhance guides and tutorials
4. **Testing**: Add unit and integration tests
5. **Performance**: Optimize database queries and API calls

---

## 📄 License

This project is proprietary software developed for university management and personal productivity automation.

---

## 🙏 Acknowledgments

- **Google Gemini**: For powerful LLM capabilities
- **FastAPI**: For the excellent async web framework
- **React**: For the robust frontend framework
- **Playwright**: For reliable browser automation
- **APScheduler**: For flexible task scheduling

---

## 📞 Support

For questions, issues, or feature requests, please refer to the project documentation or contact the development team.

---

**EDITH v2.0 Elite Edition** - Making university management and productivity effortless through intelligent automation.

_Last Updated: January 2026_
