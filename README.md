# CodeForge

Multi-Agent Code Generation and Audit System powered by LLMs.

## Overview

CodeForge is a sophisticated system that uses multiple AI agents to generate, audit, and refine code. It employs a multi-iteration workflow where:

1. **Coder Agents** generate code based on specifications
2. **Tester Agents** audit the code for issues
3. **Summarizer Agents** consolidate audit feedback
4. **Coders** respond to feedback and improve code
5. **Finalizer Agent** selects the best version and generates documentation

## Features

- **Multi-Provider LLM Support**: OpenAI, Anthropic, Google, xAI/Grok, Ollama
- **Parallel Agent Execution**: Multiple coders and testers work simultaneously
- **Real-time WebSocket Updates**: Live progress visualization
- **Interactive Workflow Graph**: Visual representation of the agent pipeline
- **User Interventions**: Guide the process with human feedback
- **Code Execution Sandbox**: Test generated code in isolated Docker containers
- **Cost Tracking**: Monitor token usage and API costs
- **Customizable Prompts**: Tailor agent behavior with custom templates

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Sessions │  │  Graph   │  │  Code    │  │   Interventions  │ │
│  │   List   │  │  View    │  │  Viewer  │  │      Panel       │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                      Backend (FastAPI)                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Orchestrator                           │   │
│  │  ┌────────┐  ┌────────┐  ┌──────────┐  ┌──────────┐      │   │
│  │  │ Coder  │  │ Tester │  │Summarizer│  │ Finalizer│      │   │
│  │  │ Agent  │  │ Agent  │  │  Agent   │  │  Agent   │      │   │
│  │  └────────┘  └────────┘  └──────────┘  └──────────┘      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    LLM Router                             │   │
│  │  ┌────────┐  ┌──────────┐  ┌────────┐  ┌──────┐ ┌──────┐ │   │
│  │  │ OpenAI │  │ Anthropic│  │ Google │  │ Grok │ │Ollama│ │   │
│  │  └────────┘  └──────────┘  └────────┘  └──────┘ └──────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL  │  Docker Sandbox  │                               │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- At least one LLM API key (OpenAI, Anthropic, etc.)

### Setup

1. Clone and configure:
```bash
git clone <repository>
cd codeforge
cp .env.example .env
# Edit .env with your API keys
```

2. Start services:
```bash
docker-compose up -d
```

3. Access the application:
- Frontend: http://localhost:3000
- API: http://localhost:8000
- API Docs: http://localhost:8000/docs

### Build Sandbox Image

```bash
cd sandbox
docker build -t codeforge-python-sandbox:latest .
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | See .env.example |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `GOOGLE_API_KEY` | Google AI API key | - |
| `GROK_API_KEY` | xAI Grok API key | - |
| `OLLAMA_BASE_URL` | Ollama server URL | http://localhost:11434 |
| `RATE_LIMIT_*` | Rate limits per provider | 10 req/min |
| `EXECUTION_TIMEOUT` | Code execution timeout | 60 seconds |
| `MAX_MEMORY_MB` | Max memory for sandbox | 512 MB |

## API Endpoints

### Sessions

- `GET /api/sessions` - List all sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/{id}` - Get session details
- `POST /api/sessions/{id}/start` - Start workflow
- `POST /api/sessions/{id}/pause` - Pause workflow
- `POST /api/sessions/{id}/resume` - Resume workflow
- `POST /api/sessions/{id}/cancel` - Cancel workflow

### Code

- `GET /api/code/{session_id}/versions` - Get code versions
- `GET /api/code/{session_id}/audits` - Get audits
- `GET /api/code/{session_id}/final` - Get final result

### WebSocket

Connect to `/ws/{session_id}` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:8000/ws/session-id');
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  // Handle: workflow_started, agent_started, agent_completed, etc.
};
```

## Development

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Database Migrations

```bash
cd backend
alembic upgrade head
```

## Supported LLM Models

### OpenAI
- gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o1-mini

### Anthropic
- claude-3-5-sonnet-20241022, claude-3-opus-20240229, claude-3-haiku-20240307

### Google
- gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash-exp

### xAI
- grok-2, grok-2-mini

### Ollama
- Any locally available model

## Workflow Customization

### Custom Prompts

Create custom prompt templates in the UI or API:

```json
POST /api/prompts
{
  "name": "My Custom Coder",
  "agent_type": "coder",
  "template_text": "Your custom Jinja2 template...",
  "description": "Custom prompt for specific use case"
}
```

### Agent Configuration

Configure agents per session:

```json
POST /api/sessions
{
  "name": "My Project",
  "specification": "Build a REST API...",
  "agent_configs": [
    {"agent_type": "coder", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-3-5-sonnet-20241022"},
    {"agent_type": "coder", "agent_index": 1, "llm_provider": "openai", "llm_model": "gpt-4o"},
    {"agent_type": "tester", "agent_index": 0, "llm_provider": "openai", "llm_model": "gpt-4o"},
    {"agent_type": "tester", "agent_index": 1, "llm_provider": "anthropic", "llm_model": "claude-3-haiku-20240307"}
  ]
}
```

## License

MIT License
