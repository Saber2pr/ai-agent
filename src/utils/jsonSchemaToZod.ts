import { z } from "zod";
import { zodToJsonSchema } from 'zod-to-json-schema';

export const zodObjectToJsonSchema = (zodObject: z.ZodObject<any>, name: string) => {
  return zodToJsonSchema(zodObject, name)?.definitions?.[name] || zodObject;
}

export function jsonSchemaToZod(parameters: any): z.ZodObject<any> {
  if (!parameters || typeof parameters !== 'object') {
    return z.object({}).passthrough();
  }

  // 辅助函数：递归转换单个属性
  function convertProp(prop: any): z.ZodTypeAny {
    let schema: z.ZodTypeAny = z.any();

    if (prop.type === "string") {
      schema = z.string();
    } else if (prop.type === "number") {
      schema = z.number();
    } else if (prop.type === "boolean") {
      schema = z.boolean();
    } else if (prop.type === "array") {
      // 递归处理数组项
      if (prop.items) {
        schema = z.array(convertProp(prop.items));
      } else {
        schema = z.array(z.any());
      }
    } else if (prop.type === "object") {
      // 递归处理嵌套对象
      const nestedObj: any = {};
      if (prop.properties) {
        for (const key in prop.properties) {
          nestedObj[key] = convertProp(prop.properties[key]);
        }
      }
      schema = z.object(nestedObj).passthrough();
    }

    if (prop.description) {
      schema = schema.describe(prop.description);
    }

    return schema;
  }

  const obj: any = {};
  const properties = parameters.properties || {};

  for (const key in properties) {
    const prop = properties[key];
    let schema = convertProp(prop);

    // 处理必填项
    const isRequired = parameters.required?.includes(key);
    obj[key] = isRequired ? schema : schema.optional();
  }

  // 使用 passthrough 或 loose 以增加容错性
  return z.object(obj).passthrough();
}