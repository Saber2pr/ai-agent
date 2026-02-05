# 🚀 Saber2pr AI Agent

A high-performance AI Agent toolkit designed for automated code auditing, repository mapping, and architectural analysis. It supports both a lightweight **Standard Edition** for direct API interaction and a powerful **LangChain Edition** for complex multi-step reasoning and private LLM integration.

## ✨ Core Features

* **Dual Mode Support**:
* **Standard Mode**: Lightweight, fast, and uses direct OpenAI-compatible API calls.
* **LangChain Mode**: Orchestrated via ReAct agents, supporting complex tool-chains and custom model extensions.


* **MCP Integration**: Built on the Model Context Protocol to bridge local development environments with AI.
* **Repository Intelligence**: Integrated `PromptEngine` for generating project maps and code skeletons without exhausting tokens.
* **Automated Audit Workflow**: Specialized tools for locating code violations, providing line-specific fixes, and generating structured JSON reports.
* **Private LLM Gateway**: Easily adapt to non-standard API protocols (e.g., Jarvis, internal enterprise gateways) by extending the `BaseChatModel`.

---

## 🛠️ Installation

```bash
sudo npm i -g @saber2pr/ai-agent

# call openapi
sagent

# call third api
sagent-chain

# Clone the repository
git clone https://github.com/saber2pr/ai-agent.git
cd ai-agent

# Install dependencies
npm install

# Build the project
npm run build

```

---

## 🚀 Usage Modes

### 1. Standard Edition (Direct API)

Best for quick scripts and simple chat interactions. It uses a straightforward message-loop logic.

```javascript
const McpAgent = require("./lib/agent").default;

const agent = new McpAgent({
  targetDir: "/path/to/project"
});

await agent.chat("Analyze the directory structure.");

```

### 2. LangChain Edition (Advanced Agent)

Best for complex tasks like "Audit the whole project and fix bugs." It supports autonomous tool usage.

```javascript
const McpAgent = require("./lib/agent-chain").default;
const { MyPrivateLLM } = require("./your-custom-llm");

const agent = new McpAgent({
  apiModel: new MyPrivateLLM(), // Inject custom LLM
  maxIterations: 15,
  targetDir: "/path/to/project"
});

await agent.chat("Scan for hardcoded colors and submit a review report.");

```

---

## 🔧 Extending with Private LLMs

To use your own API protocol, extend the `BaseChatModel` from `@langchain/core`:

```javascript
const { BaseChatModel } = require("@langchain/core/language_models/chat_models");

class MyPrivateLLM extends BaseChatModel {
  async _generate(messages) {
    const lastMessage = messages[messages.length - 1];
    const response = await fetch("https://your-api.com/v1/chat", {
      method: 'POST',
      body: JSON.stringify({ query: lastMessage.content }),
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    return {
      generations: [{ text: data.text, message: { content: data.text, role: "assistant" } }]
    };
  }
  _llmType() { return "private_llm"; }
}

```

---

## 📦 Built-in Toolset

| Tool              | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `generate_review` | Finalizes the process by submitting a structured violation report.       |
| `get_repo_map`    | Generates a high-level map of the project files and exports.             |
| `read_text_file`  | Reads file content with line numbers for precise auditing.               |
| `read_skeleton`   | Extracts class/function signatures without full logic (Token efficient). |

---

## 📋 Audit Rule Configuration

You can pass structured rules via the `extraSystemPrompt`:

```javascript
const agent = new McpAgent({
  extraSystemPrompt: {
    role: "Code Auditor",
    rules: [
      { id: "THEME-001", name: "Theme Check", description: "No hardcoded hex colors." }
    ]
  }
});

```

---

## ⚙️ Configuration

The agent stores API keys and base URLs in `~/.saber2pr-agent.json`.

* `baseURL`: The API endpoint.
* `apiKey`: Your authentication key.
* `model`: The model name (e.g., `gpt-4o`, `claude-3-5-sonnet`).

---

## 📜 License

ISC
