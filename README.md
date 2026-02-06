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
import McpAgent from "@saber2pr/ai-agent";

const agent = new McpAgent({
  targetDir: "/path/to/project"
});

await agent.chat("Analyze the directory structure.");

```

### 2. LangChain Edition (Advanced Agent)

Best for complex tasks like "Audit the whole project and fix bugs." It supports autonomous tool usage.

```javascript
import { McpChainAgent } from "@saber2pr/ai-agent";
import { MyPrivateLLM } from "./your-custom-llm";

const agent = new McpChainAgent({
  apiModel: new MyPrivateLLM(), // Inject custom LLM
  maxIterations: 15,
  targetDir: "/path/to/project"
});

await agent.chat("Scan for hardcoded colors and submit a review report.");

```

---

## 🔧 Extending with Private LLMs

### Using AgentChainModel (Recommended)

For LangChain mode, extend `AgentChainModel` which provides a simplified interface for integrating custom LLMs:

```javascript
import { AgentChainModel } from "@saber2pr/ai-agent";

class MyPrivateLLM extends AgentChainModel {
  constructor(fields) { 
    super(fields || {}); 
  }

  async generateAgentChainResponse(messages) {
    const lastMessage = messages[messages.length - 1];
    const queryText = lastMessage.content;
    
    const response = await fetch("https://your-api-gateway.com/api/completions", {
      method: 'POST',
      body: JSON.stringify({ query: queryText, stream: false }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer YOUR_API_KEY`,
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP Error: ${response.status}, ${errorText}`);
    }

    const data = await response.json();
    let text = data.text || "";
    
    // Handle special response formats if needed
    if (text.includes("Action:") && text.includes("Final Answer:")) {
      text = text.split("Final Answer:")[0].trim();
    }
    
    return text;
  }
}
```

**Key Points:**
- `AgentChainModel` abstracts away LangChain's internal message handling
- You only need to implement `generateAgentChainResponse(messages)` which receives an array of messages
- The method should return a plain string response
- The base class handles conversion to LangChain's expected format

---

## 📦 Built-in Toolset

The toolkit provides a comprehensive set of built-in tools organized into two categories: **Filesystem Tools** and **Code Analysis Tools**. All tools operate within the `targetDir` scope for security.

### Filesystem Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_text_file` | Read complete file contents as text. Supports `head` and `tail` parameters for partial reading. Handles various text encodings. | `path` (required), `head?`, `tail?` |
| `read_multiple_files` | Read multiple files simultaneously for efficient batch analysis. Individual failures won't stop the operation. | `paths` (array, required) |
| `write_file` | Create a new file or completely overwrite an existing file. Use with caution as it overwrites without warning. | `path` (required), `content` (required) |
| `edit_file` | Make line-based edits to a text file. Replaces exact line sequences with new content. Returns git-style diff. Supports `dryRun` mode for preview. | `path` (required), `edits` (array, required), `dryRun?` |
| `get_directory_tree` | Get a recursive tree view of files and directories as JSON. Supports `excludePatterns` for filtering (minimatch patterns). Essential for understanding project structure. | `path` (required), `excludePatterns?` (array) |
| `list_directory` | List all files and directories in a specified path. Results distinguish files and directories with `[FILE]` and `[DIR]` prefixes. | `path` (required) |
| `list_directory_with_sizes` | List directory contents with file sizes. Supports sorting by name or size. Includes summary statistics. | `path` (required), `sortBy?` ("name" \| "size") |
| `search_files` | Search for files matching a glob pattern. Supports exclude patterns for filtering. | `path` (required), `pattern` (required), `excludePatterns?` (array) |
| `move_file` | Move or rename files and directories. Can move between directories and rename in a single operation. | `source` (required), `destination` (required) |
| `create_directory` | Create a new directory or ensure it exists. Can create multiple nested directories recursively. | `path` (required) |
| `get_file_info` | Get detailed metadata about a file: size, last modified time, type, etc. | `path` (required) |

### Code Analysis Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_repo_map` | Generate a high-level map of project files and exports. Extracts export definitions to understand module relationships. Use this first to understand project structure. | None |
| `read_skeleton` | Extract structural definitions (interfaces, classes, method signatures) without implementation details. Token-efficient for code analysis. | `filePath` (required) |
| `analyze_deps` | Analyze dependency relationships for a specific file. Supports TypeScript path alias resolution via tsconfig. | `filePath` (required) |
| `get_method_body` | Get the complete implementation code for a specific method or function within a file. | `filePath` (required), `methodName` (required) |

### Tool Usage Tips

1. **Start with `get_directory_tree`**: Always begin by understanding the project structure before reading files.
2. **Use `read_skeleton` before `read_text_file`**: Extract signatures first to save tokens, then read full content only when needed.
3. **Leverage `excludePatterns`**: Use minimatch patterns to exclude `node_modules`, `.git`, build artifacts, etc.
4. **Batch operations**: Use `read_multiple_files` when analyzing multiple files to improve efficiency.
5. **Preview changes**: Use `edit_file` with `dryRun: true` to preview changes before applying them.

---

## 📋 Audit Rule Configuration

You can pass structured rules via the `extraSystemPrompt`:

```javascript
import McpAgent from "@saber2pr/ai-agent";

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
