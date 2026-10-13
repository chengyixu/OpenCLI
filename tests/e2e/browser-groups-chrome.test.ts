import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Command, Result } from '../../extension/src/protocol';

// Native extension harness, following browser-ax-chrome.test.ts. Each run uses
// a fresh profile and a random bridge port, leaving existing browsers untouched.
describe('real Chrome task groups', () => {
  const server = createServer((_req, res) => {
    if (_req.url?.startsWith('/fixture')) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Hiring jobs</title><button>Review candidates</button>');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, daemonVersion: 'test' }));
  });
  const wss = new WebSocketServer({ server });
  const pending = new Map<string, (value: Result) => void>();
  let socket: WebSocket | undefined;
  let browser: ChildProcess | undefined;
  let directory = '';
  let serial = 0;
  let stderr = '';
  let fixtureUrl = '';

  function send(fields: Omit<Command, 'id'>): Promise<Result> {
    const id = `groups-chrome-${++serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Command ${fields.action} timed out`)); }, 20_000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
      socket!.send(JSON.stringify({ id, ...fields }));
    });
  }

  beforeAll(async () => {
    const executable = [process.env.CHROME_PATH, process.env.GOOGLE_CHROME_BIN,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
      .find(candidate => candidate && fs.existsSync(candidate));
    if (!executable) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium binary.');
    await new Promise<void>(resolve => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Bridge server did not start');
    fixtureUrl = `http://127.0.0.1:${address.port}/fixture`;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-task-groups-'));
    const extension = path.join(directory, 'extension');
    fs.cpSync(path.resolve('extension'), extension, { recursive: true, filter: source => !source.includes('node_modules') && !source.includes('/src') });
    const background = path.join(extension, 'dist/background.js');
    const bundle = fs.readFileSync(background, 'utf8');
    if (!bundle.includes('19825')) throw new Error('Build the extension before running this test.');
    fs.writeFileSync(background, bundle.replace(/\b19825\b/g, String(address.port)));
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome extension did not connect. ${stderr.slice(-3000)}`)), 35_000);
      wss.on('connection', client => {
        socket = client;
        client.on('message', raw => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'hello') { clearTimeout(timer); resolve(); }
          else if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
        });
      });
    });
    browser = spawn(executable, [
      // Run headed (under xvfb in CI): Chrome's last-focused-window semantics
      // differ in headless mode, and this test verifies native window/tab focus.
      `--user-data-dir=${path.join(directory, 'profile')}`, `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-sandbox', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000); });
    await connected;
  }, 45_000);

  afterAll(async () => {
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([new Promise(resolve => browser!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates, discovers, borrows, renames and dissolves groups while retaining user tabs', async () => {
    const hiring = { session: 'hiring', surface: 'browser' as const };
    const created = await send({ action: 'groups', groupOp: 'create', groupName: 'Hiring', ...hiring });
    expect(created.ok, created.error).toBe(true);
    const group = created.data as { id: number; windowId: number };
    const extra = await send({ action: 'tabs', op: 'new', url: fixtureUrl, ...hiring });
    expect(extra.ok, extra.error).toBe(true);
    const settled = await send({ action: 'navigate', url: fixtureUrl, page: extra.page, ...hiring });
    expect(settled.ok, settled.error).toBe(true);
    const listed = await send({ action: 'groups', groupOp: 'list', ...hiring });
    expect(listed.ok, listed.error).toBe(true);
    const details = (listed.data as any[]).find(item => item.id === group.id);
    expect(details.title).toBe('Hiring');
    expect(details.tabs).toHaveLength(2);
    expect(details.tabs.some((tab: any) => tab.url === fixtureUrl)).toBe(true);

    const unrelated = await send({ action: 'navigate', url: `${fixtureUrl}?finance`, session: 'unrelated', surface: 'browser' });
    expect(unrelated.ok, unrelated.error).toBe(true);
    const stillListed = await send({ action: 'groups', groupOp: 'list', ...hiring });
    expect((stillListed.data as any[]).find(item => item.id === group.id).title).toBe('Hiring');

    await send({ action: 'close-window', ...hiring });
    const borrowed = await send({ action: 'groups', groupOp: 'use', groupName: 'Hiring', ...hiring });
    expect(borrowed.ok, borrowed.error).toBe(true);
    const tabs = await send({ action: 'tabs', op: 'list', ...hiring });
    expect(tabs.data).toHaveLength(2);
    const selected = await send({ action: 'tabs', op: 'select', page: extra.page, ...hiring });
    expect(selected.ok, selected.error).toBe(true);
    const title = await send({ action: 'exec', code: 'document.title', page: extra.page, ...hiring });
    expect(title.ok, title.error).toBe(true);
    expect(title.data).toBe('Hiring jobs');

    const renamed = await send({ action: 'groups', groupOp: 'rename', groupId: group.id, groupName: 'Recruiting', ...hiring });
    expect(renamed.ok, renamed.error).toBe(true);
    expect((renamed.data as any).title).toBe('Recruiting');
    const duplicate = await send({ action: 'groups', groupOp: 'create', groupName: 'Recruiting', session: 'duplicate', surface: 'browser' });
    expect(duplicate.ok, duplicate.error).toBe(true);
    const ambiguous = await send({ action: 'groups', groupOp: 'use', groupName: 'Recruiting', session: 'ambiguous', surface: 'browser' });
    expect(ambiguous.errorCode).toBe('tab_group_ambiguous');

    await send({ action: 'tabs', op: 'select', page: extra.page, ...hiring });
    const removed = await send({ action: 'groups', groupOp: 'delete', groupId: group.id, ...hiring });
    expect(removed.ok, removed.error).toBe(true);
    expect((removed.data as any).tabsUngrouped).toBe(2);
    const remaining = await send({ action: 'groups', groupOp: 'list', ...hiring });
    expect((remaining.data as any[]).some(item => item.id === group.id)).toBe(false);
    // Explicitly bind the surviving browser tab to prove delete preserved content.
    const bound = await send({ action: 'bind', ...hiring });
    expect(bound.ok, bound.error).toBe(true);
    expect(bound.page).toBe(extra.page);
    const survived = await send({ action: 'exec', code: 'document.title', ...hiring });
    expect(survived.data).toBe('Hiring jobs');
  }, 90_000);
});
