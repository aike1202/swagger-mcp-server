import { SwaggerDoc } from "../types/swagger.js";

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function jsonSchemaToTs(schema: any, name: string = "Root"): string {
  if (!schema) return "any";

  if (schema.$ref) {
    const parts = schema.$ref.split("/");
    return parts[parts.length - 1];
  }

  switch (schema.type) {
    case "string":
      if (schema.enum) {
        return schema.enum.map((v: string) => `'${v}'`).join(" | ");
      }
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      const itemType = jsonSchemaToTs(schema.items, "Item");
      return `${itemType}[]`;
    case "object":
      if (!schema.properties) return "Record<string, any>";
      const props = Object.entries(schema.properties)
        .map(([key, prop]: [string, any]) => {
          const isRequired = schema.required && schema.required.includes(key);
          const propType = jsonSchemaToTs(prop, capitalize(key));
          return `  ${key}${isRequired ? "" : "?"}: ${propType};`;
        })
        .join("\n");
      return `{\n${props}\n}`;
    default:
      return "any";
  }
}

export function resolveSchema(schema: any, doc: SwaggerDoc, stack: string[] = []): any {
    if (!schema) return schema;
    
    if (schema.$ref) {
      if (stack.includes(schema.$ref)) {
         return { type: "object", description: `[Circular Reference: ${schema.$ref}]` };
      }
      const refPath = schema.$ref.replace("#/", "").split("/");
      let current: any = doc;
      for (const part of refPath) {
        current = current?.[part];
        if (!current) break;
      }
      return resolveSchema(current, doc, [...stack, schema.$ref]);
    }

    if (schema.type === "array" && schema.items) {
      return { ...schema, items: resolveSchema(schema.items, doc, stack) };
    }

    if (schema.properties) {
      const resolvedProps: Record<string, any> = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        resolvedProps[key] = resolveSchema(prop, doc, stack);
      }
      return { ...schema, properties: resolvedProps };
    }
    
    if (schema.allOf) {
      const combined = {};
      for (const subSchema of schema.allOf) {
         Object.assign(combined, resolveSchema(subSchema, doc, stack));
      }
      return combined;
    }

    return schema;
}
