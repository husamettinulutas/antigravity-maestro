/**
 * Tool schemas travel through two dialects before they reach a model.
 *
 * Gemini's function declarations accept only a subset of JSON Schema, and the
 * Cloud Code endpoints reject the whole request when an unsupported keyword
 * appears anywhere in a tool's parameters. For Claude models the same
 * declaration is converted upstream into Anthropic's `input_schema`, which is
 * validated against JSON Schema draft 2020-12 — anything OpenAPI-flavoured
 * (`nullable`), Gemini-specific (`propertyOrdering`), or simply malformed (a
 * `type` that is not one of the seven JSON Schema type names, a non-numeric
 * `minimum`) fails there with a 400 that names only the tool index.
 *
 * So the output of this module has to be the intersection of both dialects:
 * an allow-list of keywords, each one validated, and nothing left that only
 * one side understands.
 *
 * This is an allow-list on purpose. Editors keep inventing schema annotations
 * ($comment, enumDescriptions, …) and every unknown one is a 400 that kills the
 * whole request, so anything not known to be accepted is dropped.
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'items',
  'anyOf',
  'oneOf',
  'minimum',
  'maximum',
]);

/** The only values draft 2020-12 accepts for `type`. */
const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

export function sanitizeToolSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const sanitized = sanitizeNode(schema ?? {}) ?? {};

  if (typeof sanitized.type !== 'string') {
    sanitized.type = 'object';
  }
  // An object declaration without `properties` is rejected upstream.
  if (sanitized.type === 'object' && typeof sanitized.properties !== 'object') {
    sanitized.properties = {};
  }
  return sanitized;
}

function sanitizeNode(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  let required: string[] | undefined;
  let union: Record<string, unknown>[] | undefined;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      continue;
    }

    switch (key) {
      case 'properties': {
        // Property *names* are user data, not keywords — never filtered.
        const properties: Record<string, unknown> = {};
        for (const [name, child] of Object.entries((item ?? {}) as Record<string, unknown>)) {
          const sanitizedChild = sanitizeNode(child);
          if (sanitizedChild) {
            properties[name] = sanitizedChild;
          }
        }
        result.properties = properties;
        break;
      }

      case 'items': {
        const items = sanitizeNode(item);
        if (items) {
          result.items = items;
        }
        break;
      }

      case 'anyOf':
      case 'oneOf': {
        // Collected, not emitted: a union node carries no `type` of its own,
        // and a typeless node is what the upstream turns into an unspecified
        // type that Anthropic then rejects. It collapses to one member below.
        const members = Array.isArray(item)
          ? item.map(sanitizeNode).filter((member): member is Record<string, unknown> => !!member)
          : [];
        if (members.length > 0 && !union) {
          union = members;
        }
        break;
      }

      case 'type': {
        // JSON Schema allows a union like ["string", "null"]; Gemini wants one
        // type name. The dropped nullability used to be carried as `nullable`,
        // but that keyword is OpenAPI, not JSON Schema, and Anthropic rejects
        // the schema over it — nullability is advisory, so it goes away.
        const named = typeof item === 'string' ? [item] : Array.isArray(item) ? item : [];
        for (const entry of named) {
          const type = normalizeType(entry);
          if (type && type !== 'null') {
            result.type = type;
            break;
          }
        }
        break;
      }

      case 'enum': {
        // An empty enum matches nothing; upstream treats it as malformed.
        if (Array.isArray(item) && item.length > 0) {
          result.enum = item;
        }
        break;
      }

      case 'required': {
        if (Array.isArray(item)) {
          required = item.filter((entry): entry is string => typeof entry === 'string');
        }
        break;
      }

      case 'description': {
        if (typeof item === 'string') {
          result.description = item;
        }
        break;
      }

      case 'minimum':
      case 'maximum': {
        if (typeof item === 'number' && Number.isFinite(item)) {
          result[key] = item;
        }
        break;
      }

      // No default: every allowed keyword is validated above, and an
      // unvalidated passthrough is exactly what produced malformed schemas.
    }
  }

  // A union stands in for the node it was declared on: the first member with a
  // usable type wins, and the node's own description survives if that member
  // brought none. Keeping the union instead would leave the node typeless.
  if (typeof result.type !== 'string' && union) {
    const chosen = union.find((member) => typeof member.type === 'string') ?? union[0];
    const description = result.description;
    Object.assign(result, chosen);
    if (typeof result.description !== 'string' && typeof description === 'string') {
      result.description = description;
    }
  }

  // Every node has to name a type. Gemini's schema proto defaults an absent one
  // to TYPE_UNSPECIFIED, and the conversion the Cloud Code endpoints run for
  // Claude carries that through to Anthropic, which rejects the whole tool over
  // it — so a type is recovered from the node's shape, and a node with no shape
  // to recover it from is dropped rather than sent untyped.
  if (typeof result.type !== 'string') {
    if (result.properties) {
      result.type = 'object';
    } else if (result.items) {
      result.type = 'array';
    } else if (Array.isArray(result.enum) && result.enum.every((v) => typeof v === 'string')) {
      result.type = 'string';
    } else {
      return undefined;
    }
  }

  // Gemini rejects an array declaration with no `items`, and an empty schema
  // there would be the same untyped node again — so the element type is guessed
  // rather than left open.
  if (result.type === 'array' && !result.items) {
    result.items = { type: 'string' };
  }

  // `required` naming a property that was dropped (or that never existed) is
  // what trips strict tool validation, so it is resolved against what actually
  // survived rather than trusted.
  if (required && required.length > 0) {
    const properties = result.properties as Record<string, unknown> | undefined;
    const present = properties ? required.filter((name) => name in properties) : [];
    if (present.length > 0) {
      result.required = present;
    }
  }

  return result;
}

/** Map a declared type onto a draft 2020-12 type name, or drop it. */
function normalizeType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Gemini's proto spells its types in upper case (`STRING`, `OBJECT`).
  const normalized = value.trim().toLowerCase();
  return JSON_SCHEMA_TYPES.has(normalized) ? normalized : undefined;
}
