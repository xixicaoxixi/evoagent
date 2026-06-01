const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema == null || typeof schema !== "object") {
    return EMPTY_OBJECT_SCHEMA;
  }
  const schemaDef = (schema as { readonly _def?: { readonly shape?: () => Record<string, unknown> } })._def;
  const shapeFactory = schemaDef?.shape;
  if (typeof shapeFactory !== "function") {
    return EMPTY_OBJECT_SCHEMA;
  }

  const shape = shapeFactory();
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const fieldDef = field as {
      readonly _def?: {
        readonly typeName?: string;
        readonly innerType?: unknown;
        readonly defaultValue?: unknown;
        readonly description?: string;
      };
      readonly description?: string;
    };
    const normalized = unwrapZodField(fieldDef);
    const propertySchema = mapZodFieldToJsonSchema(normalized.field);
    const description = normalized.description;
    properties[key] = description ? { ...propertySchema, description } : propertySchema;
    if (!normalized.optional) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function unwrapZodField(field: {
  readonly _def?: {
    readonly typeName?: string;
    readonly innerType?: unknown;
    readonly defaultValue?: unknown;
    readonly description?: string;
  };
  readonly description?: string;
}): { readonly field: unknown; readonly optional: boolean; readonly description?: string } {
  let current: unknown = field;
  let optional = false;
  let description = field.description ?? field._def?.description;

  while (true) {
    const currentDef = (current as { readonly _def?: { readonly typeName?: string; readonly innerType?: unknown; readonly description?: string } })._def;
    const typeName = currentDef?.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodDefault") {
      optional = true;
      if (currentDef?.description && description === undefined) {
        description = currentDef.description;
      }
      current = currentDef?.innerType;
      continue;
    }
    if (typeName === "ZodNullable") {
      optional = true;
      current = currentDef?.innerType;
      continue;
    }
    break;
  }

  return { field: current, optional, ...(description !== undefined ? { description } : {}) };
}

function mapZodFieldToJsonSchema(field: unknown): Record<string, unknown> {
  const def = (field as {
    readonly _def?: {
      readonly typeName?: string;
      readonly checks?: readonly { readonly kind?: string; readonly value?: number }[];
      readonly description?: string;
      readonly values?: readonly unknown[];
      readonly innerType?: unknown;
      readonly shape?: () => Record<string, unknown>;
      readonly valueType?: unknown;
      readonly options?: readonly unknown[];
    };
  })._def;

  switch (def?.typeName) {
    case "ZodString": {
      const result: Record<string, unknown> = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") {
          result.minLength = check.value;
        }
        if (check.kind === "max") {
          result.maxLength = check.value;
        }
      }
      return result;
    }
    case "ZodNumber": {
      const result: Record<string, unknown> = { type: "number" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") result.minimum = check.value;
        if (check.kind === "max") result.maximum = check.value;
        if (check.kind === "int") result.type = "integer";
      }
      return result;
    }
    case "ZodBoolean": {
      return { type: "boolean" };
    }
    case "ZodArray": {
      const innerType = def.innerType;
      if (innerType !== undefined) {
        return { type: "array", items: mapZodFieldToJsonSchema(innerType) };
      }
      return { type: "array" };
    }
    case "ZodObject": {
      const shapeFactory = def.shape;
      if (typeof shapeFactory === "function") {
        return zodToJsonSchema(field);
      }
      return { type: "object" };
    }
    case "ZodEnum": {
      const values = def.values;
      if (Array.isArray(values)) {
        return { type: "string", enum: values };
      }
      return { type: "string" };
    }
    case "ZodLiteral": {
      const value = (def as { readonly value?: unknown }).value;
      if (typeof value === "string") {
        return { type: "string", const: value };
      }
      if (typeof value === "number") {
        return { type: "number", const: value };
      }
      if (typeof value === "boolean") {
        return { type: "boolean", const: value };
      }
      return {};
    }
    case "ZodUnion": {
      const options = def.options;
      if (Array.isArray(options)) {
        return {
          anyOf: options.map((opt: unknown) => mapZodFieldToJsonSchema(opt)),
        };
      }
      return {};
    }
    case "ZodRecord": {
      const valueType = def.valueType;
      if (valueType !== undefined) {
        return {
          type: "object",
          additionalProperties: mapZodFieldToJsonSchema(valueType),
        };
      }
      return { type: "object", additionalProperties: {} };
    }
    case "ZodTuple": {
      const items = (def as { readonly items?: readonly unknown[] }).items;
      if (Array.isArray(items)) {
        return {
          type: "array",
          items: items.map((item: unknown) => mapZodFieldToJsonSchema(item)),
        };
      }
      return { type: "array" };
    }
    default:
      return {};
  }
}

export { zodToJsonSchema, unwrapZodField, mapZodFieldToJsonSchema, EMPTY_OBJECT_SCHEMA };
