import { PromptEngine } from "@saber2pr/ts-context-mcp";

let lastRepoMapContent = '';

export const getIncrementalRepoMapPrompt = (targetDir: string, isFirstTurn: boolean) => {
  try {
    const engine = new PromptEngine(targetDir);
    const currentContent = engine.getRepoMap();

    // 1. 第一轮对话：必须全量发送
    if (isFirstTurn || !lastRepoMapContent) {
      lastRepoMapContent = currentContent;
      return `\n# Initial Project Repository Map\n\`\`\`text\n${currentContent}\n\`\`\``;
    }

    // 2. 如果完全没变：发送静默占位符
    if (currentContent === lastRepoMapContent) {
      return "\n\n(Note: Project structure remains unchanged.)";
    }

    // 3. 如果变了：计算增量 (Incremental Diff)
    const lastLines = lastRepoMapContent.split('\n');
    const currentLines = currentContent.split('\n');

    // 找出发生变化的行 (简单示例：找出在 current 中但不在 last 中的行)
    const changes = currentLines.filter(line => !lastLines.includes(line));

    lastRepoMapContent = currentContent;

    if (changes.length > 0) {
      return `
# 🆕 Project Map Updates (Incremental)
The project structure has changed. Key updates:
\`\`\`text
${changes.join('\n')}
\`\`\`
*(Refer to previous messages for the rest of the map)*`;
    }

    return "\n\n(Note: Minor internal structure changes detected.)";
  } catch (error) {
    return '';
  }
};