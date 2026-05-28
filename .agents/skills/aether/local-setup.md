## Manual / Local Setup

Node 20 is the baseline (pinned in `.nvmrc`). Newer versions generally work.

```bash
npm run init -- --local   # creates .env with dev defaults (no Auth0)
npm install               # all deps are public on npmjs.com -- no tokens needed
npm run dev               # dev server on port 3000
```

For the full interactive wizard (project name, Auth0, query server, etc.):

```bash
npm run init              # interactive, or --non-interactive for CI (see --help)
```
