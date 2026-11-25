#!/usr/bin/env node
'use strict';
/*
 * sapnote-cli — Portable CLI for SAP Notes / KBA
 *
 * Architecture decision (why this file is thin):
 *   All hard parts (Playwright SAML login, MFA handling, Coveo search,
 *   OData fallbacks, HTML->text) are reused 0-modified from the npm package
 *   `sap-note-search-mcp` (Apache-2.0, by marianfoo, monorepo sap-mcp-servers).
 *   We only swap the transport layer: MCP/stdio -> plain argv/stdout.
 *   Upstream upgrades come via `npm update sap-note-search-mcp`, no git merge.
 *
 * Output contract (agent-native):
 *   --json        structured output on stdout (logs always go to stderr)
 *   exit code     0 = success, 1 = runtime/data error, 2 = usage error
 */

// Quiet + mojibake-safe by default. Upstream logger.js reads LOG_LEVEL and
// TTY state AT REQUIRE TIME (line 18 below), so env must be set first — hence
// these lines sit physically above the requires.
//   MCP_MODE=true  -> upstream switches to its plain stderr logger (no pino,
//                     no emoji INFO lines); only warn+ shown. This is what
//                     kills the mojibake you saw (📄/✅ on GBK console).
//   LOG_LEVEL=info -> bring progress logs back if you want them (may show
//                     mojibake emoji on GBK consoles; chcp 65001 fixes that).
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';
if (!process.env.MCP_MODE) process.env.MCP_MODE = 'true';

const { createNotesAuthenticator } = require('sap-note-search-mcp/dist/auth.js');
const { SapNotesApiClient } = require('sap-note-search-mcp/dist/sap-notes-api.js');
const { parseNoteContent } = require('sap-note-search-mcp/dist/html-utils.js');
const { join } = require('path');
const { homedir } = require('os');

// Quiet by default: upstream logs are pino INFO lines with emoji (mojibake on
// GBK consoles) and are noise for CLI use. See block above the requires.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

// ---------------------------------------------------------------------------
// CLI usage text (self-documenting, no dependency)
// ---------------------------------------------------------------------------
const USAGE = `sapnote - search and read SAP Notes / KB articles (uses your SAP S-User)

Usage:
  sapnote search <query> [-n <max>]     Search notes by keywords/error code/note id
  sapnote get <id> [-c]                 Full content + metadata of one note
                                        -c  also fetch ABAP correction details (slower)
  sapnote --json <command> ...          Structured JSON output (for AI pipelines)
  sapnote help                          This help

Environment / config:
  Credentials come from a .env file next to cli.js (recommended, travels
  with the folder) or from environment variables (env wins over .env):
    SAP_USERNAME    SAP S-User email
    SAP_PASSWORD    S-User password   (never written to disk)
  .env example:
    SAP_USERNAME=you@company.com
    SAP_PASSWORD=yourpassword
  Optional: SAP_NOTES_TOKEN_CACHE_FILE  cookie cache path
                  (default: <homedir>/.sapnote-cli/token-cache.json)

Notes:
  - First run opens a headless browser to log in to me.sap.com (~20s).
  - Session cookies are cached for ~12h; afterwards queries are pure HTTP.
  - To clear the session: delete the token cache file shown in 'sapnote help'.

Examples:
  sapnote search "OData 415 error CAP"
  sapnote get 2744792
  sapnote --json get 2744792 -c
`;

// ---------------------------------------------------------------------------
// Arg parsing (hand-rolled, zero deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { json: false, corrections: false, max: 10, positional: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--json' || a === '-j') opts.json = true;
    else if (a === '-c' || a === '--corrections') opts.corrections = true;
    else if (a === '-n' || a === '--max') { opts.max = parseInt(argv[++i], 10); if (!opts.max || opts.max < 1) usageErr('-n needs a positive number'); }
    else if (a === '--') { opts.positional.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('-')) usageErr(`unknown option: ${a}`);
    else opts.positional.push(a);
    i++;
  }
  return opts;
}

function usageErr(msg) {
  process.stderr.write(`sapnote: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Output helpers: JSON to stdout, human/log text to stderr (pipe-safe)
// ---------------------------------------------------------------------------
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

// Minimal .env loader (KEY=VALUE lines, # comments, optional quotes).
// Zero-dependency on purpose; only sets vars not already in the environment.
// Upstream uses the dotenv package for the same file format.
function loadDotEnv(file) {
  let text;
  try { text = require('fs').readFileSync(file, 'utf8'); } catch { return; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip one pair of matching quotes; keep inner # (passwords like "My#Pass")
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q) && val.length >= 2) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function printNoteHuman(n) {
  out(`SAP Note ${n.id}  [${n.language || 'EN'}]`);
  out(`Title   : ${n.title}`);
  if (n.component) out(`Component: ${n.component}`);
  if (n.releaseDate) out(`Released : ${n.releaseDate}`);
  if (n.version != null) out(`Version  : ${n.version}`);
  if (n.status) out(`Status   : ${n.status}`);
  out(`URL     : ${n.url || `https://me.sap.com/notes/${n.id}`}`);
  out('');
  out(n.content || '');
}

// ---------------------------------------------------------------------------
// Core: build config, authenticate (cached), run one command, cleanup
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return 0;
  }

  const opts = parseArgs(argv);
  const cmd = opts.positional[0];
  if (!cmd) usageErr('missing command (search|get)');

  // --- credential resolution (same precedence as upstream mcp-server.js) ---
  // .env file next to cli.js (portable, follows the folder) -> process env.
  // Environment variables win over .env, matching dotenv convention.
  loadDotEnv(join(__dirname, '.env'));
  const username = process.env.SAP_USERNAME;
  const password = process.env.SAP_PASSWORD;
  if (!username || !password) {
    err('sapnote: SAP_USERNAME / SAP_PASSWORD not set.');
    err('Create a .env file next to cli.js:');
    err('  SAP_USERNAME=you@company.com');
    err('  SAP_PASSWORD=yourpassword');
    err('(or set the same environment variables — env wins over .env)');
    return 2;
  }

  const config = {
    authMethod: 'password',
    sapUsername: username,
    sapPassword: password,
    pfxPath: '',
    pfxPassphrase: '',
    // Session TTL in hours. Upstream server defaults this to 12 via env
    // MAX_JWT_AGE_H; without it expiresAt becomes NaN/null and the cookie
    // cache never validates (re-login on every run). CLI fixes it at 12.
    maxJwtAgeH: 12,
    // Cookie cache lives outside the repo/folder: safe to move the folder, safe for git
    tokenCacheFile: process.env.SAP_NOTES_TOKEN_CACHE_FILE
      || join(homedir(), '.sapnote-cli', 'token-cache.json'),
  };

  const auth = createNotesAuthenticator(config);
  const client = new SapNotesApiClient(config);
  let exitCode = 0;

  try {
    // Same call sequence as upstream mcp-server.js (verified in probes)
    const session = await auth.ensureSession();
    const token = session.cookieHeader || '';

    if (cmd === 'search') {
      const q = opts.positional.slice(1).join(' ').trim();
      if (!q) usageErr('search needs a query, e.g. sapnote search "OData 415 error"');
      const r = await client.searchNotes(q, token, opts.max);
      if (opts.json) {
        out(JSON.stringify({ query: r.query ?? q, totalResults: r.totalResults, results: r.results }, null, 2));
      } else {
        err(`found ${r.totalResults} note(s) for "${q}"`);
        for (const n of r.results) {
          out(`SAP Note ${n.id}  ${n.releaseDate || ''}`);
          out(`  ${n.title}`);
          if (n.component) err(`  component: ${n.component}`);
          out(`  ${n.url || `https://me.sap.com/notes/${n.id}`}`);
          out('');
        }
      }
    } else if (cmd === 'get') {
      const id = opts.positional[1];
      if (!id || !/^\d+$/.test(id)) usageErr('get needs a numeric note id, e.g. sapnote get 2744792');
      const detail = await client.getNote(id, token);

      // Optional ABAP correction details — same wiring as upstream server:
      // getCorrectionDetails(id, correctionsSummary, token), non-fatal on error.
      let corrections = null;
      if (opts.corrections && Array.isArray(detail.corrections) && detail.corrections.length) {
        try {
          corrections = await client.getCorrectionDetails(id, detail.corrections, token);
        } catch (e) {
          err(`sapnote: correction details failed (non-fatal): ${e.message}`);
        }
      }

      // Mirror upstream server output shape; plain text instead of raw HTML
      const parsed = parseNoteContent(detail.content);
      const note = {
        id: detail.id,
        title: detail.title,
        summary: detail.summary,
        component: detail.component || null,
        priority: detail.priority || null,
        category: detail.category || null,
        version: detail.version != null ? String(detail.version) : null,
        status: detail.status || null,
        releaseDate: detail.releaseDate,
        language: detail.language,
        url: detail.url,
        content: parsed.plainText || detail.content,
      };
      if (detail.validity?.length) note.validity = detail.validity;
      if (detail.supportPackages?.length) note.supportPackages = detail.supportPackages;
      if (detail.references?.length) note.references = detail.references;
      if (detail.corrections?.length) note.correctionsSummary = detail.corrections;
      if (corrections) note.corrections = corrections;

      // Upstream fallback returns a stub (title = "SAP Note <id>", content =
      // "No content available") for nonexistent notes instead of an error.
      // Detect it so AI pipelines get a truthful exit code, not a fake success.
      const looksLikeStub = (note.title === `SAP Note ${note.id}` || note.title === String(note.id))
        && /no content available/i.test(note.content || '');
      if (looksLikeStub) {
        err(`sapnote: note ${id} not found (upstream returned an empty stub)`);
        return 1;
      }

      if (opts.json) out(JSON.stringify(note, null, 2));
      else printNoteHuman(note);
    } else {
      usageErr(`unknown command: ${cmd} (expected search|get|help)`);
    }
  } catch (e) {
    // SESSION_EXPIRED: upstream semantic = our cached cookies are stale; retry once
    // with freshly invalidated auth, exactly like mcp-server.js does.
    if (String(e.message).includes('SESSION_EXPIRED')) {
      err('sapnote: session expired, re-authenticating once...');
      try {
        auth.invalidateAuth();
        const session = await auth.ensureSession();
        const token = session.cookieHeader || '';
        // simple retry of the same command with fresh token
        if (cmd === 'get') {
          const detail = await client.getNote(opts.positional[1], token);
          const parsed = parseNoteContent(detail.content);
          if (opts.json) out(JSON.stringify({ ...detail, content: parsed.plainText || detail.content }, null, 2));
          else printNoteHuman({ ...detail, content: parsed.plainText || detail.content });
        } else {
          const q = opts.positional.slice(1).join(' ').trim();
          const r = await client.searchNotes(q, token, opts.max);
          if (opts.json) out(JSON.stringify(r, null, 2));
          else { for (const n of r.results) out(`SAP Note ${n.id}  ${n.title}`); }
        }
        return 0;
      } catch (e2) {
        err(`sapnote: failed after re-auth: ${e2.message}`);
        return 1;
      }
    }
    err(`sapnote: ${e.message}`);
    exitCode = 1;
  } finally {
    // Upstream keeps a persistent browser; always release it
    try { await auth.destroy(); } catch {}
    try { await client.cleanup(); } catch {}
  }
  return exitCode;
}

main().then((code) => process.exit(code)).catch((e) => {
  err(`sapnote: unexpected: ${e.stack || e.message}`);
  process.exit(1);
});
