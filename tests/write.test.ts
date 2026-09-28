import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, issueSession, verifyToken, authenticateUser, requireWrite, SCOPES } from '../lib/auth';
import { issueConfirm, readConfirm, type Plan } from '../lib/confirm';
import { applyPlan, planBudget, planCreateCampaign, planRsaUpdate, toMicros, writableAccount } from '../lib/ads-write';
import { validateRange } from '../lib/sheets';

const ADS_ENV = { GOOGLE_ADS_CLIENT_ID: 'x', GOOGLE_ADS_CLIENT_SECRET: 'x',
  GOOGLE_ADS_REFRESH_TOKEN: 'x', GOOGLE_ADS_DEVELOPER_TOKEN: 'x' };

/** Swaps env and global fetch for one test, then restores both. */
async function withMock(env: Record<string, string | undefined>,
  route: (url: string, body: any) => unknown, run: (calls: { url: string; body: any }[]) => Promise<void>) {
  const keys = Object.keys(env), saved = keys.map(k => process.env[k]);
  const priorFetch = globalThis.fetch;
  const calls: { url: string; body: any }[] = [];
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'mock', expires_in: 3600 });
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return Response.json(route(url, body) ?? {});
  }) as typeof fetch;
  try { await run(calls); } finally {
    globalThis.fetch = priorFetch;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}

const CAMPAIGN_ROW = { results: [{
  campaign: { id: '55', name: 'Brand', status: 'ENABLED', campaignBudget: 'customers/1234567890/campaignBudgets/99' },
  campaignBudget: { name: 'Brand budget', amountMicros: '10000000', explicitlyShared: false },
  customer: { currencyCode: 'USD' },
}] };

test('passwords are hashed, verified and never stored in plaintext', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!hash.includes('correct horse battery'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong password!!', hash), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  await assert.rejects(() => hashPassword('short'));
});

test('login issues a session that carries the user role, and a removed user stops working', async () => {
  const keys = ['MCP_USERS_JSON', 'SESSION_SECRET', 'MCP_API_KEYS_JSON', 'OAUTH_ISSUER'];
  const saved = keys.map(k => process.env[k]);
  try {
    const hash = await hashPassword('a-long-enough-password');
    process.env.SESSION_SECRET = 's'.repeat(32);
    process.env.MCP_API_KEYS_JSON = '{}';
    delete process.env.OAUTH_ISSUER;
    process.env.MCP_USERS_JSON = JSON.stringify({ jana: { password_hash: hash, role: 'write' }, tom: { password_hash: hash, role: 'read' } });

    assert.equal((await authenticateUser('jana', 'a-long-enough-password'))?.role, 'write');
    assert.equal(await authenticateUser('jana', 'wrong-password-here'), undefined);
    assert.equal(await authenticateUser('ghost', 'a-long-enough-password'), undefined);

    const request = new Request('http://localhost/api/mcp');
    const write = await issueSession('jana', 'write'), read = await issueSession('tom', 'read');
    assert.deepEqual((await verifyToken(request, write.token))?.scopes, SCOPES.write);
    assert.deepEqual((await verifyToken(request, read.token))?.scopes, SCOPES.read);
    assert.equal((await verifyToken(request, write.token))?.clientId, 'jana');

    // Read-only users cannot reach a write tool.
    assert.throws(() => requireWrite({ token: read.token, clientId: 'tom', scopes: SCOPES.read }), /read-only/);
    // Revocation without a database: drop the user from the env list.
    process.env.MCP_USERS_JSON = JSON.stringify({ tom: { password_hash: hash, role: 'read' } });
    assert.equal(await verifyToken(request, write.token), undefined);
    // A token signed with another secret is rejected.
    process.env.SESSION_SECRET = 'd'.repeat(32);
    assert.equal(await verifyToken(request, read.token), undefined);
  } finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
});

test('confirmation tokens carry the plan and are bound to one user and one tool', async () => {
  const prior = process.env.SESSION_SECRET;
  try {
    process.env.SESSION_SECRET = 'c'.repeat(32);
    const plan: Plan = { tool: 'google_ads_set_campaign_budget', customer_id: '1234567890', target: 'campaignBudgets',
      summary: 'set budget', changes: { a: 1 }, operations: [{ update: { amountMicros: '5000000' } }] };
    const { confirm_token } = await issueConfirm(plan, 'jana');

    const back = await readConfirm(confirm_token, 'jana', 'google_ads_set_campaign_budget');
    assert.deepEqual(back.operations, plan.operations);
    await assert.rejects(() => readConfirm(confirm_token, 'tom', 'google_ads_set_campaign_budget'), /different user/);
    await assert.rejects(() => readConfirm(confirm_token, 'jana', 'google_ads_set_status'), /belongs to/);
    await assert.rejects(() => readConfirm(confirm_token.slice(0, -4) + 'aaaa', 'jana', 'google_ads_set_campaign_budget'), /invalid/);
    // A session token must not work as a confirmation, and vice versa.
    const session = await issueSession('jana', 'write');
    await assert.rejects(() => readConfirm(session.token, 'jana', 'google_ads_set_campaign_budget'), /invalid/);
  } finally { if (prior === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prior; }
});

test('writes require their own allowlist, which is empty by default', () => {
  const prior = process.env.GOOGLE_ADS_WRITE_CUSTOMER_IDS;
  try {
    delete process.env.GOOGLE_ADS_WRITE_CUSTOMER_IDS;
    assert.throws(() => writableAccount('1234567890'), /No account is write-enabled/);
    process.env.GOOGLE_ADS_WRITE_CUSTOMER_IDS = '123-456-7890';
    assert.equal(writableAccount('1234567890'), '1234567890');
    assert.throws(() => writableAccount('9999999999'), /not write-enabled/);
  } finally { if (prior === undefined) delete process.env.GOOGLE_ADS_WRITE_CUSTOMER_IDS; else process.env.GOOGLE_ADS_WRITE_CUSTOMER_IDS = prior; }
});

test('budget amounts convert to whole-cent micros', () => {
  assert.equal(toMicros(12), '12000000');
  assert.equal(toMicros(12.345), '12350000');
  assert.equal(toMicros(0.01), '10000');
  assert.throws(() => toMicros(-1));
  assert.throws(() => toMicros(Number.NaN));
});

test('budget guardrails reject oversized and oversized-percentage changes', async () => {
  await withMock({ ...ADS_ENV, MAX_DAILY_BUDGET: '1000', MAX_BUDGET_CHANGE_PERCENT: '50' },
    () => CAMPAIGN_ROW, async () => {
      const plan = await planBudget('1234567890', '55', 12);
      assert.match(plan.summary, /from 10 to 12 USD/);
      assert.deepEqual(plan.operations, [{ update: { resourceName: 'customers/1234567890/campaignBudgets/99', amountMicros: '12000000' }, updateMask: 'amount_micros' }]);
      await assert.rejects(() => planBudget('1234567890', '55', 100), /MAX_BUDGET_CHANGE_PERCENT/);
      await assert.rejects(() => planBudget('1234567890', '55', 5000), /MAX_DAILY_BUDGET/);
      await assert.rejects(() => planBudget('1234567890', '55', 10), /already 10 USD/);
      await assert.rejects(() => planBudget('1234567890', 'abc', 12), /numeric Google Ads ID/);
    });
});

test('a shared budget is flagged with the campaigns it would affect', async () => {
  const shared = { results: [{ ...CAMPAIGN_ROW.results[0], campaignBudget: { ...CAMPAIGN_ROW.results[0].campaignBudget, explicitlyShared: true } }] };
  await withMock({ ...ADS_ENV }, (_url, body) => /campaign.campaign_budget =/.test(body?.query || '')
    ? { results: [{ campaign: { name: 'Brand' } }, { campaign: { name: 'Generic' } }] } : shared,
    async () => {
      const plan = await planBudget('1234567890', '55', 12);
      assert.match(plan.warnings!.join(' '), /SHARED budget used by 2 campaigns: Brand, Generic/);
    });
});

test('the preview validates against Google without applying, and only apply mutates', async () => {
  await withMock({ ...ADS_ENV }, () => CAMPAIGN_ROW, async calls => {
    const plan = await planBudget('1234567890', '55', 12);
    calls.length = 0;
    await applyPlan(plan, true);
    assert.match(calls[0].url, /\/customers\/1234567890\/campaignBudgets:mutate$/);
    assert.equal(calls[0].body.validateOnly, true);
    assert.equal(calls[0].body.partialFailure, false);
    await applyPlan(plan, false);
    assert.equal(calls[1].body.validateOnly, false);
  });
});

test('new campaigns are always created paused, atomically with their budget', async () => {
  await withMock({ ...ADS_ENV, MAX_DAILY_BUDGET: '1000' }, () => ({ results: [] }), async () => {
    const plan = await planCreateCampaign('1234567890', { name: 'New Search', daily_budget: 25, bidding_strategy: 'MANUAL_CPC' });
    assert.equal(plan.target, 'atomic');
    const [budgetOp, campaignOp] = plan.operations as any[];
    assert.equal(budgetOp.campaignBudgetOperation.create.amountMicros, '25000000');
    assert.equal(campaignOp.campaignOperation.create.status, 'PAUSED');
    assert.equal(campaignOp.campaignOperation.create.campaignBudget, budgetOp.campaignBudgetOperation.create.resourceName);
    assert.equal(campaignOp.campaignOperation.create.networkSettings.targetSearchNetwork, false);
    await assert.rejects(() => planCreateCampaign('1234567890', { name: 'x', daily_budget: 25, bidding_strategy: 'MANUAL_CPC' }), /2 to 120/);
    await assert.rejects(() => planCreateCampaign('1234567890', { name: 'New Search', daily_budget: 5000, bidding_strategy: 'MANUAL_CPC' }), /MAX_DAILY_BUDGET/);
    await assert.rejects(() => planCreateCampaign('1234567890', { name: 'New Search', daily_budget: 25, bidding_strategy: 'SPRAY' as never }), /bidding_strategy/);
  });
});

test('ad copy edits are bounded and only apply to responsive search ads', async () => {
  const rsa = (type = 'RESPONSIVE_SEARCH_AD') => ({ results: [{
    adGroupAd: { status: 'ENABLED', ad: { id: '77', type, finalUrls: ['https://example.com'],
      responsiveSearchAd: { headlines: [{ text: 'A', pinnedField: 'HEADLINE_1' }], descriptions: [{ text: 'D' }] } } },
    adGroup: { name: 'Group' }, campaign: { name: 'Brand' } }] });
  await withMock({ ...ADS_ENV }, () => rsa(), async () => {
    const plan = await planRsaUpdate('1234567890', '77', { headlines: [{ text: 'One' }, { text: 'Two' }, { text: 'Three', pinned_field: 'HEADLINE_3' }] });
    const op = plan.operations[0] as any;
    assert.equal(op.updateMask, 'responsive_search_ad.headlines');
    assert.equal(op.update.responsiveSearchAd.headlines[2].pinnedField, 'HEADLINE_3');
    assert.match(JSON.stringify(plan.changes), /"pinnedField":"HEADLINE_1"/); // current pins are shown
    assert.match(plan.warnings!.join(' '), /replaces the whole list/);
    await assert.rejects(() => planRsaUpdate('1234567890', '77', {}), /at least one of/);
    await assert.rejects(() => planRsaUpdate('1234567890', '77', { headlines: [{ text: 'Only one' }] }), /3 to 15 headlines/);
    await assert.rejects(() => planRsaUpdate('1234567890', '77', { headlines: [{ text: 'x'.repeat(31) }, { text: 'b' }, { text: 'c' }] }), /1 to 30 characters/);
    await assert.rejects(() => planRsaUpdate('1234567890', '77', { final_urls: ['javascript:alert(1)'] }), /plain http\(s\) URL/);
  });
  await withMock({ ...ADS_ENV }, () => rsa('TEXT_AD'), async () => {
    await assert.rejects(() => planRsaUpdate('1234567890', '77', { path1: 'shoes' }), /only RESPONSIVE_SEARCH_AD/);
  });
});

test('sheet ranges accept A1 notation and reject anything else', () => {
  for (const good of ['Budget', "'MCP Audit Log'!A1:G50", 'Budget!A1', 'Budget!A:D', 'A1:C9']) {
    assert.equal(validateRange(good), good);
  }
  for (const bad of ['', 'Budget!A1:C9!D1', '../other', 'Budget;DROP', 'Tab!!A1', 'x'.repeat(300)]) {
    assert.throws(() => validateRange(bad));
  }
});
