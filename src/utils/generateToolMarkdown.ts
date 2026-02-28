import { cleanToolDefinition } from './cleanToolDefinition';
import { getArray } from './kit';

/**
 * 将工具定义从 Zod Schema 转换为极简 Markdown 格式
 * 目的：显著节省 System Prompt 的 Token，同时保持 LLM 理解力
 */
/**
 * 递归解析 JSON Schema 并生成简化的 Markdown
 */
function parseSchemaRecursive(schema: any, indent: string = ''): string {
  if (!schema) return '';
  let res = '';

  // 1. 处理对象类型 (Object)
  if (schema.type === 'object' && schema.properties) {
    Object.entries(schema.properties).forEach(([key, val]: [string, any]) => {
      const isReq = schema.required?.includes(key);
      const type = val.type || (val.anyOf ? 'any' : 'unknown');
      const desc = val.description ? `: ${val.description}` : '';
      
      res += `${indent}- \`${key}\` (${type}${isReq ? ', required' : ''})${desc}\n`;
      // 递归处理嵌套对象或数组
      res += parseSchemaRecursive(val, indent + '  ');
    });
  } 
  // 2. 处理数组类型 (Array)
  else if (schema.type === 'array' && schema.items) {
    // 标注数组项的结构
    res += `${indent}  *Items:* \n${parseSchemaRecursive(schema.items, indent + '    ')}`;
  }

  return res;
}

export function generateToolMarkdown(tools: any[]): string {
  let markdown = "## Tool Definitions\n\n";

  getArray(tools).forEach((tool) => {
    // 假设 cleanToolDefinition 返回的是符合 JSON Schema 规范的对象
    const { name, description, parameters } = cleanToolDefinition(tool);
    markdown += `- **${name}**: ${description}\n`;

    // 从根部开始递归解析参数
    if (parameters && parameters.type === 'object') {
      markdown += parseSchemaRecursive(parameters, '  ');
    }

    markdown += "\n";
  });

  return markdown;
}