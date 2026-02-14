import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

export function formatSchema(schema: z.ZodObject<any>) {
  const res = zodToJsonSchema(schema) as any;
  if (typeof res.properties === 'object') {
    const requiredKeys = res.required || [];
    const lines = [];

    for (const key in res.properties) {
      lines.push(
        `     - ${key}: ${res.properties[key].type}${
          requiredKeys.includes(key) ? ' (required)' : ''
        }`
      );
    }

    if (lines.length > 0) {
      return lines.join('\n');
    }
    return 'No parameters';
  }

  const keys = Object.keys(schema.shape);
  return keys.join(', ');
}
