import { z } from 'zod';
import { convertJsonSchemaToZod } from 'zod-from-json-schema';

export function jsonSchemaToZod(parameters: any): z.ZodObject<any> {
  return convertJsonSchemaToZod(parameters) as any;
}
