import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

export function formatSchema(schema: z.ZodObject<any>) {
  const jsonSchema = zodToJsonSchema(schema) as any;

  // 递归处理函数
  const processProperties = (properties: any, required: string[] = [], level: number = 0): string => {
    if (!properties || typeof properties !== 'object') return '';
    
    const indent = '  '.repeat(level);
    const lines = [];

    for (const key in properties) {
      const prop = properties[key];
      const isRequired = required.includes(key);
      
      // 1. 基础描述
      let line = `${indent}- ${key}: ${prop.type || 'any'}${isRequired ? ' (required)' : ''}`;
      if (prop.description) line += ` - ${prop.description}`;
      lines.push(line);

      // 2. 递归处理数组 (Items)
      if (prop.type === 'array' && prop.items) {
        lines.push(`${indent}  Items:`);
        if (prop.items.type === 'object' && prop.items.properties) {
          lines.push(processProperties(prop.items.properties, prop.items.required, level + 2));
        } else {
          lines.push(`${indent}    - Type: ${prop.items.type || 'any'}`);
        }
      }

      // 3. 递归处理嵌套对象 (Object)
      if (prop.type === 'object' && prop.properties) {
        lines.push(processProperties(prop.properties, prop.required, level + 1));
      }
    }

    return lines.join('\n');
  };

  if (jsonSchema.properties) {
    const result = processProperties(jsonSchema.properties, jsonSchema.required, 2); // 保持你原来的缩进感
    return result || 'No parameters';
  }

  const keys = Object.keys(schema.shape);
  return keys.length > 0 ? keys.join(', ') : 'No parameters';
}