/**
 * Gemini's function declarations accept only a subset of JSON Schema, and the
 * Cloud Code endpoints reject the whole request when an unsupported keyword
 * appears anywhere in a tool's parameters — so agent-supplied schemas are
 * filtered down to the accepted subset before being forwarded.
 *
 * This is an allow-list on purpose. Editors keep inventing schema annotations
 * ($comment, enumDescriptions, …) and every unknown one is a 400 that kills the
 * whole request, so anything not known to be accepted is dropped.
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'anyOf',
  'minimum',
  'maximum',
  'propertyOrdering',
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

      case 'anyOf': {
        const members = Array.isArray(item)
          ? item.map(sanitizeNode).filter((member): member is Record<string, unknown> => !!member)
          : [];
        if (members.length > 0) {
          result.anyOf = members;
        }
        break;
      }

      case 'type': {
        // JSON Schema allows a union like ["string", "null"]; Gemini wants one
        // type name, with nullability carried separately.
        if (typeof item === 'string') {
          result.type = item;
        } else if (Array.isArray(item)) {
          const named = item.filter((entry): entry is string => typeof entry === 'string');
          const concrete = named.find((entry) => entry !== 'null');
          if (concrete) {
            result.type = concrete;
          }
          if (named.includes('null')) {
            result.nullable = true;
          }
        }
        break;
      }

      case 'enum':
      case 'required': {
        if (Array.isArray(item)) {
          result[key] = item;
        }
        break;
      }

      default:
        result[key] = item;
    }
  }

  return result;
}
