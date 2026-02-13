# Bajaj HackRx - LLM-Powered Document Query System

A FastAPI-based intelligent document processing and query-answering system that leverages Large Language Models (LLM) and vector embeddings to extract insights from various document formats.

## 🚀 Features

### Document Processing

- **Multi-format Support**: PDF, DOCX, PPTX, Excel (XLSX/XLS), Images (JPG, PNG, etc.)
- **OCR Integration**: Extract text from images and embedded images in presentations
- **API Data Fetching**: Process data from REST APIs and web endpoints
- **Intelligent Caching**: Persistent document and embedding cache for faster responses

### AI-Powered Query Processing

- **Vector Similarity Search**: FAISS-based semantic search for relevant content retrieval
- **Multi-LLM Support**: Primary Gemini 2.5 Flash with OpenAI GPT-4 fallback
- **Interactive Reasoning Agent**: LangGraph-powered agent for complex multi-step reasoning
- **Concurrent Processing**: Multi-threaded question processing for batch queries
- **Context-Aware Responses**: Retrieval-Augmented Generation (RAG) for accurate answers
- **Web Scraping Integration**: Automated data fetching from external URLs and APIs

### Enterprise Features

- **Token-Based Authentication**: Secure API access with Bearer token validation
- **Comprehensive Logging**: Request tracking, API usage, and debug logs
- **Performance Monitoring**: Response time tracking and resource usage metrics
- **Error Handling**: Graceful fallbacks and detailed error reporting

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Document      │───▶│   Text Parser    │───▶│   Embeddings    │
│   Input         │    │   (Multi-format) │    │   (Sentence-T)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                         │
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Query         │───▶│   Vector Search  │◀───│   FAISS Index   │
│   Processing    │    │   (Similarity)   │    │   (Cached)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                ▼
                       ┌──────────────────┐
                       │ Document Analysis│
                       │ (Interactive?)   │
                       └──────────────────┘
                    ┌───────────┴───────────┐
                    ▼                       ▼
          ┌──────────────────┐    ┌──────────────────┐
          │ Standard RAG     │    │ Interactive Agent│
          │ Pipeline         │    │   (LangGraph)    │
          └──────────────────┘    └──────────────────┘
                    │                       ▼
                    │              ┌─────────────────┐
                    │              │  Web Scraper    │
                    │              │     Tool        │
                    │              └─────────────────┘
                    └───────────┬───────────┘
                                ▼
                       ┌──────────────────┐
                       │   LLM Response   │
                       │ (Gemini/OpenAI)  │
                       └──────────────────┘
```

## 📋 Prerequisites

- Python 3.8+
- pip package manager
- Tesseract OCR (for image text extraction)
- API Keys for Gemini and/or OpenAI
- LangChain and LangGraph dependencies

### Install Tesseract OCR

**macOS:**

```bash
brew install tesseract
```

**Ubuntu/Debian:**

```bash
sudo apt-get install tesseract-ocr
```

**Windows:**
Download from: https://github.com/UB-Mannheim/tesseract/wiki

## 🛠️ Installation & Setup

### 1. Clone Repository

```bash
git clone <repository-url>
cd bajaj_hackrx
```

### 2. Install Dependencies

```bash
pip install -r requirements.txt

**Key Dependencies:**
- FastAPI & Uvicorn for web framework
- LangChain & LangGraph for agent orchestration
- Sentence Transformers for embeddings
- FAISS for vector similarity search
- BeautifulSoup4 for web scraping
- OpenAI & Google Generative AI for LLM integration
```

### 3. Environment Configuration

Create a `.env` file in the project root:

```env
# Gemini API Keys (multiple for load balancing)
GEMINI_API_KEY1=your_gemini_key_1
GEMINI_API_KEY2=your_gemini_key_2
GEMINI_API_KEY3=your_gemini_key_3

# OpenAI API Key (fallback)
OPENAI_API_KEY=your_openai_key

# GROQ API Key
GROQ_API_KEY=your_groq_key
```

### 4. Start the Server

**Development Mode:**

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Production Mode:**

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 5. Public Access (Optional)

Expose your local server using ngrok:

```bash
ngrok http 8000
```

## 🐳 Docker Deployment

### Quick Start with Docker

```bash
# Build the image
docker build -t hackrx-llm-sys .

# Run the container
docker run -it -p 8000:8000 --env-file .env hackrx-llm-sys
```

### Access Points

- **Main API Endpoint**: http://localhost:8000/api/v1/hackrx/run

## 📡 API Documentation

### Authentication

All requests require a Bearer token in the Authorization header:

```
Authorization: Bearer 6474bf54ce9dc3d156827448363ba8f461b0366cb1e1d8e41aae7e6157a30ce0
```

### Endpoint: Process Document Query

**POST** `/api/v1/hackrx/run`

**Request Body:**

```json
{
  "documents": "https://example.com/document.pdf",
  "questions": [
    "What is the main topic of this document?",
    "Summarize the key findings",
    "What are the recommendations?"
  ]
}
```

**Response:**

```json
{
  "answers": [
    "The main topic is...",
    "Key findings include...",
    "The recommendations are..."
  ]
}
```

**Supported Document URLs:**

- Direct file URLs (PDF, DOCX, PPTX, XLSX, images)
- API endpoints returning JSON data
- Public cloud storage links (Google Drive, Dropbox, etc.)

### Example Usage

```bash
curl -X POST "http://localhost:8000/api/v1/hackrx/run" \
  -H "Authorization: Bearer 6474bf54ce9dc3d156827448363ba8f461b0366cb1e1d8e41aae7e6157a30ce0" \
  -H "Content-Type: application/json" \
  -d '{
    "documents": "https://example.com/report.pdf",
    "questions": ["What is the executive summary?"]
  }'
```

## 🤖 Interactive Reasoning Agent

The system includes an advanced interactive reasoning agent powered by LangGraph that is **automatically activated when documents contain interactive instructions or tasks**. The agent can:

### Key Features

- **Multi-Step Reasoning**: Follow complex instructions from documents to complete tasks
- **Tool Integration**: Seamlessly use document retrieval and web scraping tools
- **External Data Fetching**: Automatically fetch data from URLs and APIs as instructed
- **Intelligent Workflow**: Analyze instructions, execute steps, and combine information

### Agent Tools

1. **Document Retriever Tool**: Search and retrieve relevant information from loaded documents
2. **Web Scraper Tool**: Fetch content from external URLs, APIs, and web pages
   - Supports PDF documents, JSON APIs, and HTML content
   - Automatic content type detection
   - Comprehensive error handling

### Activation & Usage Pattern

**Automatic Activation**: The interactive agent is triggered only when the system detects that the input document contains:
- Step-by-step instructions requiring external data fetching
- References to URLs, APIs, or external resources to be processed
- Multi-step tasks that require reasoning across different data sources

**Agent Workflow** (when activated):
1. Load and analyze instruction documents using the document retriever
2. Identify required external data sources from the instructions
3. Use web scraper tool to fetch data from specified URLs/APIs
4. Combine and reason over all collected information
5. Provide comprehensive answers based on retrieved data

**Standard Processing**: For regular documents without interactive instructions, the system uses the standard RAG pipeline with vector similarity search.

### Implementation

The interactive agent is implemented in `intractive_agent.py` and uses:
- **LangGraph**: For agent orchestration and tool management
- **OpenAI GPT-4**: As the reasoning engine
- **Custom Tools**: Document retrieval and web scraping capabilities
- **Async Processing**: For efficient concurrent operations

## 📁 Project Structure

```
bajaj_hackrx/
├── app/
│   ├── main.py              # FastAPI application and routes
│   ├── document_parser.py   # Multi-format document parsers
│   ├── embeddings.py        # Sentence transformer embeddings
│   ├── retrieval.py         # RAG pipeline and LLM integration
│   ├── intractive_agent.py  # Interactive reasoning agent with LangGraph
│   ├── prompt_template.py   # LLM prompt templates
│   └── utils.py            # Utility functions
├── logs/                   # Application logs
│   ├── api_requests.log    # API request tracking
│   ├── api_details.log     # Detailed API responses
│   ├── usage.log          # General usage logs
│   └── parser_debug.log   # Document parsing debug info
├── pdf_cache/             # Cached document embeddings
├── .env                   # Environment variables
├── .gitignore            # Git ignore rules
├── requirements.txt      # Python dependencies
├── Dockerfile           # Docker container definition
└── README.md           # This file
```

## 🔧 Configuration

### Environment Variables

- `GEMINI_API_KEY1-3`: Google Gemini API keys for load balancing
- `OPENAI_API_KEY`: OpenAI API key for fallback

### Performance Tuning

- **Cache Directory**: `pdf_cache/` stores processed document embeddings
- **Thread Pool**: Configurable concurrent question processing
- **Model Loading**: Warm-up on startup for faster first requests
- **Memory Management**: Automatic cleanup of large document caches
- **Agent Optimization**: Efficient tool calling and response streaming
- **Web Scraping**: Intelligent content type detection and parsing

## 📊 Monitoring & Logging

### Log Files

- **api_requests.log**: HTTP request/response tracking
- **api_details.log**: LLM API calls and token usage
- **usage.log**: General application events
- **parser_debug.log**: Document parsing diagnostics
- **requests.json**: Structured request data for analytics

### Health Check

```bash
curl http://localhost:8000/docs
```

## 🚨 Troubleshooting

### Common Issues

1. **Tesseract not found**

   ```bash
   # Install Tesseract OCR
   brew install tesseract  # macOS
   sudo apt-get install tesseract-ocr  # Ubuntu
   ```

2. **API Key errors**

   - Verify `.env` file exists and contains valid API keys
   - Check API key permissions and quotas

3. **Document parsing failures**

   - Check `logs/parser_debug.log` for detailed error information
   - Ensure document URLs are publicly accessible

4. **Memory issues with large documents**
   - Monitor `pdf_cache/` directory size
   - Clear cache periodically: `rm -rf pdf_cache/*`

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

**For support or questions, please check the log files or contact the development team.**
