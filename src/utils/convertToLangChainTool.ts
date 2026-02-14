import { DynamicStructuredTool } from '@langchain/core/tools';

import { ToolInfo } from '../types/type';

export function convertToLangChainTool(info: ToolInfo) {
  return new DynamicStructuredTool({
    name: info.function.name,
    description: info.function.description || '',
    schema: info.function.parameters,
    func: async args => {
      if (info._handler) return await info._handler(args);
      if (info._client && info._originalName) {
        const result = await info._client.callTool({
          name: info._originalName,
          arguments: args as unknown as Record<string, unknown>,
        });
        return JSON.stringify(result);
      }
      return 'Error: No tool execution handler found.';
    },
  });
}
