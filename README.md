# sapnote-cli

Portable command-line tool to **search and read SAP Notes / KBA** with your SAP S-User — built for humans *and* AI agents (`--json`, stable exit codes, pipe-safe output).

```bash
sapnote search "OData 415 error CAP"     # keyword / error-code / note-id search
sapnote get 2744792                      # full content + metadata of one note
sapnote --json get 2744792 -c            # JSON output + ABAP correction details
```

## How it works (architecture)

This CLI is a **thin shell (~200 lines)** over the npm package
[`sap-note-search-mcp`](https://github.com/marianfoo/sap-mcp-servers)
(Apache-2.0 by marianfoo) — **upstream code is reused 0-modified** via npm
dependency; only the transport layer is swapped (MCP/stdio → argv/stdout).

- Authentication: headless-browser SAML login to me.sap.com (Playwright), MFA-aware
- Search: SAP for Me backend / Coveo with fallbacks (upstream multi-tier logic)
- Content: full note text + enriched metadata; optional ABAP correction details

> **Attribution / license**: derived from `sap-note-search-mcp` (Apache-2.0,
> © marianfoo), unmodified, invoked as a library. This repo is Apache-2.0 as well.
> The tool uses SAP's private web endpoints behind authentication — for personal
> use with your own S-User; check SAP ToS before any other usage. No bulk crawling.

## Install

Requirements: Node.js ≥ 22.12, an SAP S-User with Support Portal access.

One-time setup (installs deps into this folder + Chromium into the system cache):

```bat
setup.cmd
```

Or manually:

```bash
npm install
npx playwright install chromium   # one-time browser download (~90 MB)
```

Windows may need a proxy for the browser download: set `HTTPS_PROXY` first.

## Configure

Preferred: create a `.env` file next to `cli.js` (same format as upstream MCP):

```bat
SAP_USERNAME=you@company.com
SAP_PASSWORD=yourpassword
```

- `.env` travels with the folder (portable); it is gitignored — never commit it
- Quote values containing `#`: `SAP_PASSWORD="My#Pass"`
- Environment variables of the same name win over `.env` (dotenv convention)

Credentials live only in process memory; they are never written to disk.
The login session (cookies) is cached at `%USERPROFILE%\.sapnote-cli\token-cache.json`
for ~12 h — delete that file to force re-login. Override the path with
`SAP_NOTES_TOKEN_CACHE_FILE`.

## Exit codes

| code | meaning |
|------|---------|
| 0 | success |
| 1 | runtime / data error (auth failed, note not found, network) |
| 2 | usage error (bad arguments, missing env) |

`--json` prints structured results on **stdout**; all progress logs go to
**stderr**, so pipes stay clean: `sapnote --json get 2744792 | jq .title`

## Moving this folder

Self-contained(portable): `cli.js` + `node_modules` travel together — move the
whole folder anywhere; nothing is installed system-wide. Only the cookie cache
stays in `%USERPROFILE%\.sapnote-cli\`.
