/**
 * Display names derived from model ids.
 *
 * The names the upstream reports drift from the ids it serves — several
 * distinct ids come back sharing one label ("Gemini 3.1 Flash Lite" for
 * `gemini-2.5-flash`, `gemini-2.5-flash-lite` and `gemini-3.1-flash-lite`
 * alike), which makes a model list impossible to read and a model impossible to
 * find by name. The id is the part that is actually authoritative — it is what
 * every request carries — so the name is built from it.
 */

/**
 * Name a whole model list at once.
 *
 * A label the upstream uses for exactly one id is the name the Antigravity
 * client shows for it, so it is kept — that is the name the user is looking
 * for. A label shared by several ids says nothing about which one is which, so
 * every model under it falls back to the name derived from its id.
 *
 * A kept label can still disagree with the id it belongs to —
 * `gemini-3-flash-agent` is offered as "Gemini 3.5 Flash (High)" — and that is
 * left as it is. Every surface that shows a name shows the id beside it (the
 * model pickers list both, and the panel prints the id under each card), so
 * repeating the id inside the name only reads as a stutter.
 */
export function displayNamesFor(
  models: readonly { modelId: string; displayName?: string }[],
): Record<string, string> {
  const uses = new Map<string, number>();
  for (const model of models) {
    const label = model.displayName?.trim() || undefined;
    if (label) {
      uses.set(label, (uses.get(label) ?? 0) + 1);
    }
  }

  const names: Record<string, string> = {};
  for (const model of models) {
    const label = model.displayName?.trim() || undefined;
    if (label && uses.get(label) === 1) {
      names[model.modelId] = label;
      continue;
    }
    names[model.modelId] = displayNameFor(model.modelId) ?? label ?? model.modelId;
  }
  return names;
}

/** Trailing tokens that name an effort or mode rather than the model. */
const MODES: Record<string, string> = {
  thinking: 'Thinking',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  'extra-low': 'Extra low',
  minimal: 'Minimal',
  tiered: 'Tiered',
  agent: 'Agent',
};

/** Words whose casing does not follow from the id. */
const WORDS: Record<string, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  gpt: 'GPT',
  oss: 'OSS',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  pro: 'Pro',
  flash: 'Flash',
  lite: 'Lite',
  image: 'Image',
  imagen: 'Imagen',
  preview: 'Preview',
  exp: 'Experimental',
};

/**
 * `gemini-3.5-flash-high` → `Gemini 3.5 Flash (High)`,
 * `claude-opus-4-6-thinking` → `Claude Opus 4.6 (Thinking)`,
 * `gpt-oss-120b-medium` → `GPT-OSS 120B (Medium)`.
 *
 * Returns undefined for an id with nothing recognisable in it, so the caller
 * can fall back to whatever the upstream called it.
 */
export function displayNameFor(modelId: string): string | undefined {
  const id = modelId.trim().replace(/^models\//i, '').toLowerCase();
  if (id === '') {
    return undefined;
  }

  const { base, mode } = splitMode(id);
  const words = nameWords(base);
  if (words.length === 0) {
    return undefined;
  }

  const name = joinVendor(words);
  return mode ? `${name} (${mode})` : name;
}

/** Peel the effort suffix off the id — `extra-low` before `low`. */
function splitMode(id: string): { base: string; mode?: string } {
  for (const suffix of Object.keys(MODES).sort((a, b) => b.length - a.length)) {
    if (id.endsWith(`-${suffix}`)) {
      return { base: id.slice(0, -(suffix.length + 1)), mode: MODES[suffix] };
    }
  }
  return { base: id };
}

function nameWords(base: string): string[] {
  const tokens = base.split('-').filter((token) => token !== '');
  const words: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    // Claude spells its versions with dashes: `claude-opus-4-6` is 4.6.
    if (/^\d+$/.test(token) && /^\d+$/.test(tokens[index + 1] ?? '')) {
      words.push(`${token}.${tokens[index + 1]}`);
      index++;
      continue;
    }

    const known = WORDS[token];
    if (known) {
      words.push(known);
      continue;
    }

    // A version (3.5) or a size (120b) stays as it reads, upper-cased.
    if (/^\d/.test(token)) {
      words.push(token.toUpperCase());
      continue;
    }

    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }

  return words;
}

/** GPT and OSS read as one vendor word rather than two. */
function joinVendor(words: string[]): string {
  if (words[0] === 'GPT' && words[1] === 'OSS') {
    return ['GPT-OSS', ...words.slice(2)].join(' ');
  }
  return words.join(' ');
}
