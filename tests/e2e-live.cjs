// Live end-to-end test for the deployed Evidence Desk site.
//
// Run: node tests/e2e-live.cjs
// Requires: Playwright + Chromium (this repo's dev machine uses the shared
// install under ~/workspace/codegeist/video-recorder/node_modules) and an
// OpenRouter key in ~/workspace/cortensor/.env (OPENROUTER_API_KEY).
//
// Phase 0 polls the free-model quota (tiny probe call every 10 min, max ~4h)
// so the script can be launched before the daily reset and run itself when
// calls work again. Phase 1 verifies an IN-COVERAGE claim (UN climate talks
// — 2 sources in the snapshot) and checks the evidence list renders with
// real links. Phase 2 runs the full Citation Mirror peer audit through the
// consent modal.
//
// Key handling: the key is read from the .env file inside this process only.
// Probe calls pass it to curl via a mode-600 --config file deleted right
// after each probe. The key is never logged and never written to the repo.
const { chromium } = require('/home/hatch/workspace/codegeist/video-recorder/node_modules/playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const os = require('os');
const path = require('path');

const SITE = 'https://andipangeranm142.github.io/evidence-desk/';
const OUT = '/tmp/evidence-desk-e2e';
const MODEL = process.env.E2E_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const CLAIM = process.env.E2E_CLAIM || 'The UN climate talks ended without a major deal.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

function readKey() {
  const env = fs.readFileSync('/home/hatch/workspace/cortensor/.env', 'utf8');
  const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
  if (!m) throw new Error('OPENROUTER_API_KEY not found in cortensor .env');
  return m[1].trim();
}

// One tiny probe call. Returns true when free calls work again.
function probeQuota(key) {
  const cfg = path.join(os.tmpdir(), `or-probe-${process.pid}.cfg`);
  try {
    fs.writeFileSync(cfg, `header = "Authorization: Bearer ${key}"\n`, { mode: 0o600 });
    const out = execFileSync('curl', [
      '-s', '-m', '60', 'https://openrouter.ai/api/v1/chat/completions',
      '-K', cfg, '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 5 }),
    ], { encoding: 'utf8', timeout: 70000 });
    const d = JSON.parse(out);
    if (d.error) {
      log('probe: still limited —', String(d.error.message || d.error.code || '').slice(0, 100));
      return false;
    }
    return true;
  } catch (err) {
    log('probe: request failed —', String(err.message || err).slice(0, 120));
    return false;
  } finally {
    try { fs.unlinkSync(cfg); } catch { /* already gone */ }
  }
}

async function waitForQuota(key) {
  const deadline = Date.now() + 4 * 3600 * 1000;
  for (;;) {
    if (probeQuota(key)) {
      log('quota available — proceeding');
      return true;
    }
    if (Date.now() > deadline) {
      log('quota did not reset within 4h — giving up');
      return false;
    }
    log('waiting 10 min before next probe…');
    await sleep(10 * 60 * 1000);
  }
}

async function startForwarder(localPort = 3129) {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || '';
  const u = new URL(raw);
  const target = await dns.lookup(u.hostname, { family: 6 });
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.address, port: Number(u.port) || 3128 });
    client.pipe(upstream);
    upstream.pipe(client);
    const onErr = () => { client.destroy(); upstream.destroy(); };
    client.on('error', onErr);
    upstream.on('error', onErr);
  });
  await new Promise((resolve, reject) => {
    server.listen(localPort, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  return server;
}

async function waitForVisible(page, selector, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
    const noticeVisible = await page.locator('#notice:not([hidden])').isVisible().catch(() => false);
    if (noticeVisible) {
      const notice = await page.locator('#notice').textContent().catch(() => '');
      throw new Error(`run failed early (${label}): ${notice}`);
    }
    const status = await page.locator('#activity-status').textContent().catch(() => '');
    if (/Failed/.test(status || '')) throw new Error(`run failed early (${label}): activity status "${status}"`);
    await sleep(2000);
  }
  throw new Error(`timeout waiting for ${label || selector}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const key = readKey();
  log('live e2e — claim:', JSON.stringify(CLAIM), '| model:', MODEL);
  const quotaOk = await waitForQuota(key);
  if (!quotaOk) process.exit(3);
  const forwarder = await startForwarder();
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:3129' } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const failures = [];
  try {
    // goto can time out when the egress proxy hiccups; retry once.
    let loaded = false;
    for (let attempt = 0; attempt < 2 && !loaded; attempt += 1) {
      try {
        await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        loaded = true;
      } catch (err) {
        log(`goto attempt ${attempt + 1} failed:`, String(err.message || err).slice(0, 120));
        if (attempt === 1) throw err;
        await sleep(5000);
      }
    }
    await page.waitForSelector('#claim-input', { timeout: 30000 });
    // Wait for the app to finish booting (listeners are wired before the
    // snapshot badge updates), otherwise the settings click lands too early.
    let badge = '';
    for (let i = 0; i < 30; i += 1) {
      badge = (await page.locator('#snapshot-badge').textContent()).trim();
      if (/headlines/.test(badge)) break;
      await sleep(2000);
    }
    log('snapshot badge:', JSON.stringify(badge));
    if (!/headlines/.test(badge)) failures.push('snapshot badge did not show headlines');
    await page.click('#settings-btn');
    for (let i = 0; i < 3; i += 1) {
      if (await page.locator('#settings-drawer').isVisible().catch(() => false)) break;
      await sleep(2000);
      await page.click('#settings-btn').catch(() => {});
    }
    await page.waitForSelector('#router-url', { timeout: 15000 });
    if (MODEL !== (await page.locator('#model-name').inputValue())) await page.fill('#model-name', MODEL);
    await page.fill('#api-key', key);
    await page.click('#save-profile');
    await sleep(1500);
    if (!(await page.locator('#settings-drawer').isHidden())) failures.push('settings drawer did not close');

    log('verifying in-coverage claim');
    await page.fill('#claim-input', CLAIM);
    await page.click('#verify-btn');
    const verifyStart = Date.now();
    await waitForVisible(page, '#verdict:not([hidden]) .verdict-badge', 420000, 'verdict badge');
    log('verdict rendered in', Math.round((Date.now() - verifyStart) / 1000), 's');
    const verdict = (await page.locator('.verdict-badge').textContent()).trim();
    const summary = (await page.locator('.verdict-summary').textContent()).trim();
    const evidenceCount = await page.locator('.evidence-list li').count();
    const evidenceLinks = await page.locator('.evidence-list li a').evaluateAll((as) => as.map((a) => a.href));
    const evidenceMeta = await page.locator('.evidence-list .evidence-meta').allInnerTexts();
    log('verdict:', JSON.stringify(verdict));
    log('summary:', JSON.stringify(summary.slice(0, 300)));
    log('evidence items:', evidenceCount, '| links:', JSON.stringify(evidenceLinks));
    log('evidence meta:', JSON.stringify(evidenceMeta));
    if (verdict !== 'supported') failures.push(`expected verdict "supported", got "${verdict}"`);
    if (evidenceCount < 2) failures.push(`expected >=2 evidence items, got ${evidenceCount}`);
    if (evidenceLinks.some((h) => !/^https?:\/\//.test(h))) failures.push('an evidence link is not a valid http(s) URL');
    await page.screenshot({ path: `${OUT}/part2-verdict.png`, fullPage: true });

    log('clicking audit button');
    await page.click('#audit-btn');
    await waitForVisible(page, '#consent-modal:not([hidden])', 120000, 'consent modal');
    const consentOrigin = (await page.locator('#consent-origin').textContent()).trim();
    log('consent origin:', JSON.stringify(consentOrigin));
    if (consentOrigin !== 'https://citation-mirror.vercel.app') failures.push(`unexpected consent origin: ${consentOrigin}`);
    await page.click('#consent-once');
    const auditStart = Date.now();
    await waitForVisible(page, '.audit-box', 600000, 'audit box');
    log('audit rendered in', Math.round((Date.now() - auditStart) / 1000), 's');
    const auditText = (await page.locator('.audit-box').innerText()).trim();
    const activityItems = await page.locator('#activity-list li').allInnerTexts();
    log('audit text:', JSON.stringify(auditText.slice(0, 800)));
    log('audit activity:', JSON.stringify(activityItems.map((s) => s.replace(/\s+/g, ' ').slice(0, 100))));
    if (/could not run/i.test(auditText)) failures.push('audit box reports the audit could not run');
    if (!/spot check/i.test(auditText)) failures.push('audit text does not mention a spot check');
    const peerRan = activityItems.some((s) => s.includes('citation_mirror/spot_checker'));
    if (!peerRan) failures.push('spot_checker did not appear in the activity log');
    await page.screenshot({ path: `${OUT}/part2-audit.png`, fullPage: true });
  } catch (err) {
    failures.push(`exception: ${String(err && err.message ? err.message : err).split('\n')[0]}`);
    try { await page.screenshot({ path: `${OUT}/part2-error.png`, fullPage: true }); } catch { /* ignore */ }
  } finally {
    await browser.close();
    forwarder.close();
  }
  if (failures.length) {
    log('LIVE E2E FAILURES:', JSON.stringify(failures, null, 2));
    process.exit(1);
  }
  log('LIVE E2E ALL CHECKS PASSED');
  process.exit(0);
})().catch((err) => {
  console.log('LIVE E2E harness error:', String(err && err.message ? err.message : err).split('\n')[0]);
  process.exit(2);
});
