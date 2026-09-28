import { SafeError } from './errors';
import { adsMutate, adsMutateAtomic, searchRows } from './google-ads';
import { customerId } from './csv';
import type { Plan } from './confirm';

export const MAX_OPERATIONS = 50;
export type Status = 'ENABLED' | 'PAUSED';
export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';

/** Writes need their own allowlist, which is narrower than the read allowlist. */
export function writableAccount(input: string) {
  const id = customerId(input);
  const allowed = (process.env.GOOGLE_ADS_WRITE_CUSTOMER_IDS || '').split(',').filter(Boolean).map(customerId);
  if (!allowed.length) throw new SafeError('No account is write-enabled on this deployment. GOOGLE_ADS_WRITE_CUSTOMER_IDS is empty.');
  if (!allowed.includes(id)) throw new SafeError('Account is not write-enabled on this deployment.');
  return id;
}
function numericId(value: string, label: string) {
  if (!/^\d{1,20}$/.test(String(value))) throw new SafeError(`${label} must be a numeric Google Ads ID.`);
  return String(value);
}
function limitOps(count: number) {
  if (count < 1) throw new SafeError('Provide at least one item to change.');
  if (count > MAX_OPERATIONS) throw new SafeError(`At most ${MAX_OPERATIONS} items per call; split the change into batches.`);
}
/** Google rejects amounts that are not a whole currency cent, so round before converting. */
export function toMicros(amount: number, label = 'Amount') {
  if (!Number.isFinite(amount) || amount < 0) throw new SafeError(`${label} must be a non-negative number.`);
  if (amount > 1_000_000) throw new SafeError(`${label} is implausibly large; refusing.`);
  return String(Math.round(amount * 100) * 10_000);
}
export const fromMicros = (micros: unknown) => Number(micros || 0) / 1_000_000;
function numberEnv(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function keywordText(text: string) {
  const value = String(text).trim();
  if (!value || value.length > 80 || /[\r\n\t]/.test(value)) throw new SafeError('Keyword text must be 1 to 80 characters on a single line.');
  return value;
}
function matchType(value: string): MatchType {
  if (value !== 'EXACT' && value !== 'PHRASE' && value !== 'BROAD') throw new SafeError('Match type must be EXACT, PHRASE or BROAD.');
  return value;
}
async function one(cid: string, query: string, missing: string) {
  const rows = await searchRows(cid, query);
  if (!rows.length) throw new SafeError(missing);
  return rows[0];
}

/* ------------------------------------------------------------------ budgets */

export async function planBudget(cid: string, campaign_id: string, new_daily_budget: number): Promise<Plan> {
  const id = numericId(campaign_id, 'campaign_id');
  const row = await one(cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget,
    campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, customer.currency_code
    FROM campaign WHERE campaign.id = ${id} LIMIT 1`, `Campaign ${id} was not found in account ${cid}.`);
  const current = fromMicros(row.campaignBudget?.amountMicros);
  const target = Math.round(new_daily_budget * 100) / 100;
  const currency = row.customer?.currencyCode || 'unknown currency';

  const cap = numberEnv('MAX_DAILY_BUDGET', 1000);
  if (target > cap) throw new SafeError(`Requested daily budget ${target} exceeds the MAX_DAILY_BUDGET cap of ${cap}. Raise the cap deliberately or make a smaller change.`);
  const maxPercent = numberEnv('MAX_BUDGET_CHANGE_PERCENT', 50);
  const percent = current > 0 ? Math.abs(target - current) / current * 100 : null;
  if (percent !== null && percent > maxPercent) {
    throw new SafeError(`That is a ${percent.toFixed(1)}% budget change, over the MAX_BUDGET_CHANGE_PERCENT limit of ${maxPercent}%. Current daily budget is ${current} ${currency}. Make a smaller change or raise the limit deliberately.`);
  }
  if (target === current) throw new SafeError(`Daily budget is already ${current} ${currency}.`);

  const warnings: string[] = [];
  if (row.campaignBudget?.explicitlyShared) {
    const sharing = await searchRows(cid, `SELECT campaign.id, campaign.name FROM campaign
      WHERE campaign.campaign_budget = '${row.campaign.campaignBudget}' LIMIT 50`);
    warnings.push(`This is a SHARED budget used by ${sharing.length} campaigns: ${sharing.map(s => s.campaign?.name).filter(Boolean).join(', ')}. Changing it affects all of them.`);
  }
  return {
    tool: 'google_ads_set_campaign_budget', customer_id: cid, target: 'campaignBudgets', warnings,
    summary: `Set daily budget of campaign "${row.campaign?.name}" from ${current} to ${target} ${currency}`,
    changes: { campaign: { id, name: row.campaign?.name, status: row.campaign?.status },
      budget_name: row.campaignBudget?.name, currency,
      current_daily_budget: current, new_daily_budget: target,
      change_percent: percent === null ? null : Number(percent.toFixed(2)),
      shared_budget: !!row.campaignBudget?.explicitlyShared },
    operations: [{ update: { resourceName: row.campaign.campaignBudget, amountMicros: toMicros(target, 'Daily budget') }, updateMask: 'amount_micros' }],
  };
}

/* ------------------------------------------------------------------ statuses */

export async function planStatus(cid: string, level: 'campaign' | 'ad_group' | 'ad', entity_id: string, status: Status): Promise<Plan> {
  const id = numericId(entity_id, 'entity_id');
  if (status !== 'ENABLED' && status !== 'PAUSED') throw new SafeError('Status must be ENABLED or PAUSED. Removing entities is not supported.');
  const queries = {
    campaign: [`SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${id} LIMIT 1`, 'campaigns'],
    ad_group: [`SELECT ad_group.id, ad_group.name, ad_group.status, campaign.name FROM ad_group WHERE ad_group.id = ${id} LIMIT 1`, 'adGroups'],
    ad: [`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group.name, campaign.name FROM ad_group_ad WHERE ad_group_ad.ad.id = ${id} LIMIT 1`, 'adGroupAds'],
  } as const;
  const [query, target] = queries[level];
  const row = await one(cid, query, `No ${level.replace('_', ' ')} with ID ${id} in account ${cid}.`);
  const entity = level === 'campaign' ? row.campaign : level === 'ad_group' ? row.adGroup : row.adGroupAd;
  const resourceName = level === 'ad' ? row.adGroupAd.resourceName : entity.resourceName
    ?? `customers/${cid}/${target === 'campaigns' ? 'campaigns' : 'adGroups'}/${id}`;
  const label = level === 'ad' ? `ad ${id} in ad group "${row.adGroup?.name}"` : `${level.replace('_', ' ')} "${entity?.name}"`;
  if (entity?.status === status) throw new SafeError(`That ${level.replace('_', ' ')} is already ${status}.`);
  return {
    tool: 'google_ads_set_status', customer_id: cid, target,
    summary: `Set ${label} from ${entity?.status} to ${status}`,
    changes: { level, id, name: entity?.name ?? null, campaign: row.campaign?.name ?? null,
      ad_group: row.adGroup?.name ?? null, current_status: entity?.status, new_status: status },
    operations: [{ update: { resourceName, status }, updateMask: 'status' }],
  };
}

/* ------------------------------------------------------------------ keywords */

type KeywordInput = { text: string; match_type: string; cpc_bid?: number };
export async function planKeywordsAdd(cid: string, ad_group_id: string, keywords: KeywordInput[]): Promise<Plan> {
  const adGroupId = numericId(ad_group_id, 'ad_group_id');
  limitOps(keywords.length);
  const row = await one(cid, `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.name FROM ad_group WHERE ad_group.id = ${adGroupId} LIMIT 1`,
    `Ad group ${adGroupId} was not found in account ${cid}.`);
  const adGroup = `customers/${cid}/adGroups/${adGroupId}`;
  const planned = keywords.map(k => ({ text: keywordText(k.text), match_type: matchType(k.match_type), cpc_bid: k.cpc_bid ?? null }));
  const seen = new Set<string>();
  for (const k of planned) {
    const key = `${k.text.toLowerCase()}|${k.match_type}`;
    if (seen.has(key)) throw new SafeError(`Duplicate keyword in this request: ${k.text} (${k.match_type}).`);
    seen.add(key);
  }
  return {
    tool: 'google_ads_add_keywords', customer_id: cid, target: 'adGroupCriteria',
    summary: `Add ${planned.length} keyword(s) to ad group "${row.adGroup?.name}" in campaign "${row.campaign?.name}"`,
    changes: { ad_group: { id: adGroupId, name: row.adGroup?.name, status: row.adGroup?.status },
      campaign: row.campaign?.name, keywords_added: planned },
    warnings: ['New keywords are created ENABLED and can begin serving as soon as the ad group and campaign are active.'],
    operations: planned.map(k => ({ create: { adGroup, status: 'ENABLED',
      keyword: { text: k.text, matchType: k.match_type },
      ...(k.cpc_bid == null ? {} : { cpcBidMicros: toMicros(k.cpc_bid, 'cpc_bid') }) } })),
  };
}

async function existingCriteria(cid: string, adGroupId: string, criterionIds: string[]) {
  const ids = criterionIds.map(id => numericId(id, 'criterion_id'));
  const rows = await searchRows(cid, `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
    ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group.name
    FROM ad_group_criterion WHERE ad_group_criterion.ad_group = 'customers/${cid}/adGroups/${adGroupId}'
    AND ad_group_criterion.criterion_id IN (${ids.join(',')}) LIMIT ${MAX_OPERATIONS}`);
  const found = new Map(rows.map(r => [String(r.adGroupCriterion?.criterionId), r]));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) throw new SafeError(`These criterion IDs are not in ad group ${adGroupId}: ${missing.join(', ')}.`);
  return { ids, rows, found };
}

export async function planKeywordsRemove(cid: string, ad_group_id: string, criterion_ids: string[]): Promise<Plan> {
  const adGroupId = numericId(ad_group_id, 'ad_group_id');
  limitOps(criterion_ids.length);
  const { ids, rows } = await existingCriteria(cid, adGroupId, criterion_ids);
  return {
    tool: 'google_ads_remove_keywords', customer_id: cid, target: 'adGroupCriteria',
    summary: `Remove ${ids.length} keyword(s) from ad group "${rows[0]?.adGroup?.name}"`,
    changes: { ad_group: { id: adGroupId, name: rows[0]?.adGroup?.name },
      keywords_removed: rows.map(r => ({ criterion_id: r.adGroupCriterion?.criterionId,
        text: r.adGroupCriterion?.keyword?.text, match_type: r.adGroupCriterion?.keyword?.matchType })) },
    warnings: ['Removing a keyword is permanent: its historical statistics stay in reports but the keyword cannot be restored, only added again as a new keyword.'],
    operations: ids.map(id => ({ remove: `customers/${cid}/adGroupCriteria/${adGroupId}~${id}` })),
  };
}

export async function planKeywordBids(cid: string, ad_group_id: string, bids: { criterion_id: string; cpc_bid: number }[]): Promise<Plan> {
  const adGroupId = numericId(ad_group_id, 'ad_group_id');
  limitOps(bids.length);
  const { found, rows } = await existingCriteria(cid, adGroupId, bids.map(b => b.criterion_id));
  const changes = bids.map(b => {
    const current = found.get(numericId(b.criterion_id, 'criterion_id'));
    return { criterion_id: String(b.criterion_id), text: current?.adGroupCriterion?.keyword?.text,
      current_cpc_bid: fromMicros(current?.adGroupCriterion?.cpcBidMicros) || null, new_cpc_bid: Math.round(b.cpc_bid * 100) / 100 };
  });
  return {
    tool: 'google_ads_set_keyword_bids', customer_id: cid, target: 'adGroupCriteria',
    summary: `Change the max CPC bid of ${bids.length} keyword(s) in ad group "${rows[0]?.adGroup?.name}"`,
    changes: { ad_group: { id: adGroupId, name: rows[0]?.adGroup?.name }, bids: changes },
    operations: bids.map(b => ({ update: { resourceName: `customers/${cid}/adGroupCriteria/${adGroupId}~${numericId(b.criterion_id, 'criterion_id')}`,
      cpcBidMicros: toMicros(b.cpc_bid, 'cpc_bid') }, updateMask: 'cpc_bid_micros' })),
  };
}

export async function planNegativeKeywords(cid: string, level: 'campaign' | 'ad_group', parent_id: string,
  keywords: { text: string; match_type: string }[]): Promise<Plan> {
  const parentId = numericId(parent_id, 'parent_id');
  limitOps(keywords.length);
  const planned = keywords.map(k => ({ text: keywordText(k.text), match_type: matchType(k.match_type) }));
  if (level === 'campaign') {
    const row = await one(cid, `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id = ${parentId} LIMIT 1`,
      `Campaign ${parentId} was not found in account ${cid}.`);
    return {
      tool: 'google_ads_add_negative_keywords', customer_id: cid, target: 'campaignCriteria',
      summary: `Add ${planned.length} negative keyword(s) to campaign "${row.campaign?.name}"`,
      changes: { level, campaign: { id: parentId, name: row.campaign?.name }, negatives_added: planned },
      operations: planned.map(k => ({ create: { campaign: `customers/${cid}/campaigns/${parentId}`,
        negative: true, keyword: { text: k.text, matchType: k.match_type } } })),
    };
  }
  const row = await one(cid, `SELECT ad_group.id, ad_group.name, campaign.name FROM ad_group WHERE ad_group.id = ${parentId} LIMIT 1`,
    `Ad group ${parentId} was not found in account ${cid}.`);
  return {
    tool: 'google_ads_add_negative_keywords', customer_id: cid, target: 'adGroupCriteria',
    summary: `Add ${planned.length} negative keyword(s) to ad group "${row.adGroup?.name}"`,
    changes: { level, ad_group: { id: parentId, name: row.adGroup?.name }, campaign: row.campaign?.name, negatives_added: planned },
    // A negative ad group criterion must not carry a status field.
    operations: planned.map(k => ({ create: { adGroup: `customers/${cid}/adGroups/${parentId}`,
      negative: true, keyword: { text: k.text, matchType: k.match_type } } })),
  };
}

/* ----------------------------------------------------------------- ad copy */

type TextAsset = { text: string; pinned_field?: string };
const PINS = new Set(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3', 'DESCRIPTION_1', 'DESCRIPTION_2']);
function assets(items: TextAsset[], max: number, label: string) {
  return items.map(item => {
    const text = String(item.text ?? '').trim();
    if (!text || text.length > max) throw new SafeError(`Each ${label} must be 1 to ${max} characters; "${text.slice(0, 40)}" is ${text.length}.`);
    if (item.pinned_field && !PINS.has(item.pinned_field)) throw new SafeError(`pinned_field must be one of ${[...PINS].join(', ')}.`);
    return { text, ...(item.pinned_field ? { pinnedField: item.pinned_field } : {}) };
  });
}
export async function planRsaUpdate(cid: string, ad_id: string, edits: {
  headlines?: TextAsset[]; descriptions?: TextAsset[]; final_urls?: string[]; path1?: string; path2?: string;
}): Promise<Plan> {
  const adId = numericId(ad_id, 'ad_id');
  const row = await one(cid, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name, ad_group_ad.status,
    ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
    ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group.name, campaign.name
    FROM ad_group_ad WHERE ad_group_ad.ad.id = ${adId} LIMIT 1`, `Ad ${adId} was not found in account ${cid}.`);
  const ad = row.adGroupAd?.ad || {};
  if (ad.type !== 'RESPONSIVE_SEARCH_AD') throw new SafeError(`Ad ${adId} is a ${ad.type || 'unknown'} ad; only RESPONSIVE_SEARCH_AD copy can be edited here.`);

  const rsa: Record<string, unknown> = {}, mask: string[] = [], warnings: string[] = [];
  const current = ad.responsiveSearchAd || {};
  if (edits.headlines) {
    if (edits.headlines.length < 3 || edits.headlines.length > 15) throw new SafeError('Provide 3 to 15 headlines; the list replaces every existing headline.');
    rsa.headlines = assets(edits.headlines, 30, 'headline'); mask.push('responsive_search_ad.headlines');
  }
  if (edits.descriptions) {
    if (edits.descriptions.length < 2 || edits.descriptions.length > 4) throw new SafeError('Provide 2 to 4 descriptions; the list replaces every existing description.');
    rsa.descriptions = assets(edits.descriptions, 90, 'description'); mask.push('responsive_search_ad.descriptions');
  }
  for (const key of ['path1', 'path2'] as const) {
    if (edits[key] === undefined) continue;
    const value = String(edits[key]);
    if (value.length > 15 || /[\s/]/.test(value)) throw new SafeError(`${key} must be at most 15 characters with no spaces or slashes.`);
    rsa[key] = value; mask.push(`responsive_search_ad.${key}`);
  }
  const update: Record<string, unknown> = { resourceName: `customers/${cid}/ads/${adId}` };
  if (Object.keys(rsa).length) update.responsiveSearchAd = rsa;
  if (edits.final_urls) {
    if (!edits.final_urls.length || edits.final_urls.length > 10) throw new SafeError('Provide 1 to 10 final URLs.');
    for (const url of edits.final_urls) {
      if (!/^https?:\/\/[^\s"'<>]{3,2000}$/i.test(url)) throw new SafeError(`Final URL must be a plain http(s) URL: ${String(url).slice(0, 60)}`);
    }
    update.finalUrls = edits.final_urls; mask.push('final_urls');
  }
  if (!mask.length) throw new SafeError('Provide at least one of headlines, descriptions, final_urls, path1 or path2.');
  if (rsa.headlines || rsa.descriptions) warnings.push('Replacing headlines or descriptions replaces the whole list, including any pins. Carry over the pinned_field values shown under current_ad to keep them.');
  warnings.push('Edited ads re-enter Google policy review and lose their existing asset performance history.');

  return {
    tool: 'google_ads_update_ad_copy', customer_id: cid, target: 'ads', warnings,
    summary: `Update ${mask.length} field(s) of responsive search ad ${adId} in ad group "${row.adGroup?.name}"`,
    changes: { ad_id: adId, ad_group: row.adGroup?.name, campaign: row.campaign?.name, ad_status: row.adGroupAd?.status,
      current_ad: { headlines: current.headlines || [], descriptions: current.descriptions || [],
        path1: current.path1 ?? null, path2: current.path2 ?? null, final_urls: ad.finalUrls || [] },
      new_values: { ...rsa, ...(update.finalUrls ? { finalUrls: update.finalUrls } : {}) }, updated_fields: mask },
    operations: [{ update, updateMask: mask.join(',') }],
  };
}

/* ------------------------------------------------------------------ creates */

const BIDDING = {
  MANUAL_CPC: { manualCpc: { enhancedCpcEnabled: false } },
  MAXIMIZE_CLICKS: { targetSpend: {} },
  MAXIMIZE_CONVERSIONS: { maximizeConversions: {} },
} as const;
function isoDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw new SafeError(`${label} must be a valid YYYY-MM-DD date.`);
  return value;
}
export async function planCreateCampaign(cid: string, input: {
  name: string; daily_budget: number; bidding_strategy: keyof typeof BIDDING;
  start_date?: string; end_date?: string; include_search_partners?: boolean;
}): Promise<Plan> {
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 120 || /[\r\n]/.test(name)) throw new SafeError('Campaign name must be 2 to 120 characters on one line.');
  const bidding = BIDDING[input.bidding_strategy];
  if (!bidding) throw new SafeError(`bidding_strategy must be one of ${Object.keys(BIDDING).join(', ')}.`);
  const cap = numberEnv('MAX_DAILY_BUDGET', 1000);
  const budget = Math.round(input.daily_budget * 100) / 100;
  if (budget > cap) throw new SafeError(`Daily budget ${budget} exceeds the MAX_DAILY_BUDGET cap of ${cap}.`);
  if (budget <= 0) throw new SafeError('Daily budget must be greater than zero.');
  const existing = await searchRows(cid, `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.name = '${name.replaceAll("'", "\\'")}' LIMIT 1`);
  if (existing.length) throw new SafeError(`Account ${cid} already has a campaign named "${name}" (ID ${existing[0].campaign?.id}).`);

  const budgetResource = `customers/${cid}/campaignBudgets/-1`;
  const campaign: Record<string, unknown> = {
    name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budgetResource,
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: !!input.include_search_partners,
      targetContentNetwork: false, targetPartnerSearchNetwork: false },
    ...bidding,
  };
  if (input.start_date) campaign.startDateTime = `${isoDate(input.start_date, 'start_date')} 00:00:00`;
  if (input.end_date) campaign.endDateTime = `${isoDate(input.end_date, 'end_date')} 23:59:59`;
  if (input.start_date && input.end_date && input.start_date > input.end_date) throw new SafeError('start_date must precede end_date.');

  return {
    tool: 'google_ads_create_campaign', customer_id: cid, target: 'atomic',
    summary: `Create PAUSED search campaign "${name}" with a ${budget} per day budget`,
    warnings: ['New campaigns are always created PAUSED and spend nothing until someone enables them with google_ads_set_status.',
      'The budget and the campaign are created together: if either is rejected, neither is created.'],
    changes: { campaign_name: name, status: 'PAUSED', channel: 'SEARCH', daily_budget: budget,
      bidding_strategy: input.bidding_strategy, search_partners: !!input.include_search_partners,
      start_date: input.start_date ?? 'today', end_date: input.end_date ?? 'none (runs indefinitely)' },
    operations: [
      { campaignBudgetOperation: { create: { resourceName: budgetResource, name: `${name} budget`,
        amountMicros: toMicros(budget, 'Daily budget'), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
      { campaignOperation: { create: campaign } },
    ],
  };
}

export async function planCreateAdGroup(cid: string, campaign_id: string, name: string, cpc_bid?: number): Promise<Plan> {
  const id = numericId(campaign_id, 'campaign_id');
  const label = String(name ?? '').trim();
  if (label.length < 2 || label.length > 120 || /[\r\n]/.test(label)) throw new SafeError('Ad group name must be 2 to 120 characters on one line.');
  const row = await one(cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${id} LIMIT 1`,
    `Campaign ${id} was not found in account ${cid}.`);
  const clash = await searchRows(cid, `SELECT ad_group.id FROM ad_group WHERE ad_group.campaign = 'customers/${cid}/campaigns/${id}'
    AND ad_group.name = '${label.replaceAll("'", "\\'")}' LIMIT 1`);
  if (clash.length) throw new SafeError(`Campaign "${row.campaign?.name}" already has an ad group named "${label}".`);
  return {
    tool: 'google_ads_create_ad_group', customer_id: cid, target: 'adGroups',
    summary: `Create PAUSED ad group "${label}" in campaign "${row.campaign?.name}"`,
    warnings: ['New ad groups are created PAUSED. Enable them with google_ads_set_status once keywords and ads are in place.'],
    changes: { campaign: { id, name: row.campaign?.name, status: row.campaign?.status },
      ad_group_name: label, status: 'PAUSED', max_cpc_bid: cpc_bid ?? null },
    operations: [{ create: { name: label, campaign: `customers/${cid}/campaigns/${id}`, status: 'PAUSED',
      type: 'SEARCH_STANDARD', ...(cpc_bid == null ? {} : { cpcBidMicros: toMicros(cpc_bid, 'cpc_bid') }) } }],
  };
}

/* -------------------------------------------------------------------- apply */

/** `validateOnly` asks Google to check the exact operations and change nothing. */
export async function applyPlan(plan: Plan, validateOnly: boolean) {
  return plan.target === 'atomic'
    ? adsMutateAtomic(plan.customer_id, plan.operations, validateOnly)
    : adsMutate(plan.customer_id, plan.target, plan.operations, validateOnly);
}
