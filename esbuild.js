const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Build-time secrets. Never hardcoded in `src/` — see `.env.example`. */
const INJECTED = ['AGM_OAUTH_CLIENT_ID', 'AGM_OAUTH_CLIENT_SECRET'];

/**
 * Reads `.env` from the repo root. The file is git-ignored, so a fresh clone
 * builds fine — the result just has no built-in OAuth client, and sign-in then
 * needs the `antigravityMaestro.oauth.*` settings.
 */
function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) {
      continue;
    }
    values[match[1]] = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return values;
}

/** `process.env.X` replacements, so the values land in the bundle, not in git. */
function buildDefines() {
  // A real environment variable wins, so CI can supply the secrets instead.
  const env = { ...loadEnvFile(), ...process.env };
  const defines = {};

  for (const name of INJECTED) {
    const value = (env[name] ?? '').trim();
    if (value === '' && production) {
      console.warn(`[build] ${name} is not set — this build has no built-in OAuth client.`);
    }
    defines[`process.env.${name}`] = JSON.stringify(value);
  }
  return defines;
}

/** Reports esbuild problems in a format VS Code's problem matcher understands. */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    define: buildDefines(),
    logLevel: 'silent',
    plugins: [problemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
