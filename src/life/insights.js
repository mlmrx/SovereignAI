/**
 * The two flagship joins over life records — pure functions, `now` injected
 * for testability, estimates labeled as estimates.
 *
 * Subscription audit: recurring merchants inferred from ≥2 sightings with a
 * plausible cadence. Renewals radar: everything with a detected future date.
 * Both answer questions no single vendor can, because no single vendor holds
 * the records — see docs/WHY.md.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Group receipts/subscriptions by merchant and surface the recurring ones. */
export function subscriptionAudit(records, { now = new Date() } = {}) {
  const groups = new Map();
  for (const record of records) {
    if (record.kind !== 'receipt' && record.kind !== 'subscription') continue;
    if (!record.occurred_at) continue;
    const key = record.merchant.trim().toLowerCase() || record.sender;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const recurring = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const intervals = [];
    for (let index = 1; index < sorted.length; index++) {
      intervals.push((Date.parse(sorted[index].occurred_at) - Date.parse(sorted[index - 1].occurred_at)) / DAY_MS);
    }
    const cadenceDays = median(intervals);
    const declaredSubscription = sorted.some((record) => record.kind === 'subscription');
    const amounts = sorted.map((record) => record.amount).filter((amount) => Number.isFinite(amount));
    const steadyAmounts = amounts.length >= 2 && (Math.max(...amounts) - Math.min(...amounts)) <= 0.2 * Math.max(...amounts);
    if (!declaredSubscription && !steadyAmounts) continue;
    if (!(cadenceDays >= 20 && cadenceDays <= 400)) continue;

    const cadence = cadenceDays <= 45 ? 'monthly' : cadenceDays >= 300 ? 'yearly' : 'irregular';
    const amount = amounts.length ? median(amounts) : null;
    const monthlyEstimate = amount === null ? null : cadence === 'monthly' ? amount : cadence === 'yearly' ? amount / 12 : null;
    recurring.push({
      merchant: sorted.at(-1).merchant,
      occurrences: sorted.length,
      cadence,
      amount,
      currency: sorted.find((record) => record.currency)?.currency ?? null,
      monthlyEstimate: monthlyEstimate === null ? null : Math.round(monthlyEstimate * 100) / 100,
      lastSeen: sorted.at(-1).occurred_at,
      daysSinceLastSeen: Math.floor((now.getTime() - Date.parse(sorted.at(-1).occurred_at)) / DAY_MS),
      confidence: declaredSubscription ? 'high' : 'medium',
    });
  }
  recurring.sort((a, b) => (b.monthlyEstimate ?? 0) - (a.monthlyEstimate ?? 0));
  const estimatedMonthly = Math.round(recurring.reduce((sum, item) => sum + (item.monthlyEstimate ?? 0), 0) * 100) / 100;
  return { recurring, estimatedMonthly };
}

/** Everything with a detected renewal/expiry date coming up (or just past). */
export function upcomingRenewals(records, { now = new Date(), withinDays = 90 } = {}) {
  const horizon = now.getTime() + withinDays * DAY_MS;
  const grace = now.getTime() - 7 * DAY_MS; // a just-missed renewal is worth seeing too
  const upcoming = records
    .filter((record) => record.renews_at)
    .map((record) => ({ ...record, at: Date.parse(record.renews_at) }))
    .filter((record) => Number.isFinite(record.at) && record.at >= grace && record.at <= horizon)
    .sort((a, b) => a.at - b.at)
    .map(({ at, ...record }) => ({
      merchant: record.merchant,
      renews_at: record.renews_at,
      daysAway: Math.ceil((at - now.getTime()) / DAY_MS),
      amount: record.amount,
      currency: record.currency,
      subject: record.subject,
      confidence: record.confidence,
    }));
  const undated = records.filter((record) => record.kind === 'renewal' && !record.renews_at).length;
  return { upcoming, undated };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
