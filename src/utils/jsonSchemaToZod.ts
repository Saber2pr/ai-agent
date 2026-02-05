import { z } from "zod";

// 将 JSON Schema 转换为 Zod Schema 的简易转换器
export function jsonSchemaToZod(parameters: any) {
  if (!parameters || !parameters.properties) {
    return z.object({}).loose();
  }

  const obj: any = {};
  const properties = parameters.properties;

  for (const key in properties) {
    const prop = properties[key];
    let schema: z.ZodTypeAny = z.any();

    if (prop.type === "string") {
      schema = z.string();
    } else if (prop.type === "number") {
      schema = z.number();
    } else if (prop.type === "boolean") {
      schema = z.boolean();
    }

    if (prop.description) {
      schema = schema.describe(prop.description);
    }

    // 默认都设为 optional 以防 Agent 报错，除非在 JSON Schema 的 required 数组中
    const isRequired = parameters.required?.includes(key);
    obj[key] = isRequired ? schema : schema.optional();
  }

  return z.object(obj).loose();
}