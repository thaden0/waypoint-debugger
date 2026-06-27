import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { introspectExpressRoutes } from '../src/express/routes.js';

describe('express route introspection (JS RouteProvider)', () => {
  it('finds app/router METHOD routes, normalizes :params, flags handlers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp-express-'));
    writeFileSync(path.join(dir, 'app.js'), [
      "const express = require('express');",
      'const app = express();',
      "app.get('/health', (req,res)=>res.send('ok'));",
      "app.post('/users', (req,res)=>{});",
      'const router = express.Router();',
      "router.get('/users/:id', auth, (req,res)=>{});",
      "router.delete('/users/:id', (req,res)=>{});",
    ].join('\n'));
    const routes = introspectExpressRoutes(dir);
    const uris = routes.map((r) => `${r.methods[0]} ${r.uri}`);
    expect(uris).toContain('GET /health');
    expect(uris).toContain('POST /users');
    expect(uris).toContain('GET /users/{id}');
    expect(uris).toContain('DELETE /users/{id}');
    const byId = routes.find((r) => r.uri === '/users/{id}' && r.methods[0] === 'GET')!;
    expect(byId.params).toEqual(['id']);
    expect(byId.middleware.length).toBeGreaterThan(0);
  });
});
