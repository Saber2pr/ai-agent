import { cleanToolDefinition } from './cleanToolDefinition';
import { getArray } from './kit';

/**
 * 将工具定义从 Zod Schema 转换为极简 Markdown 格式
 * 目的：显著节省 System Prompt 的 Token，同时保持 LLM 理解力
 */
export function generateToolMarkdown(tools: any[]): string {
  let markdown = "## Tool Definitions\n\n";

  getArray(tools).forEach((tool) => {
    const { name, description, parameters } = cleanToolDefinition(tool);
    markdown += `- **${name}**: ${description}\n`;

    // 提取 Zod 参数
    const shape = parameters.properties || {};
    const requiredFields = parameters.required || [];

    Object.entries(shape).forEach(([paramName, schema]: [string, any]) => {
      const isRequired = requiredFields.includes(paramName);
      const type = schema.type.replace('Zod', '').toLowerCase();
      const desc = schema.description || schema.title || '';

      markdown += `  - \`${paramName}\` (${type}${isRequired ? ', required' : ''})${desc ? `: ${desc}` : ''}\n`;
    });

    markdown += "\n";
  });

  return markdown;
}