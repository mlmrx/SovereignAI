// SovereignAI access-request intake. The landing form (land.js) POSTs here;
// each lead is emailed to LEADS_TO via Resend with Reply-To set to the
// applicant, so granting access is a reply. Without RESEND_API_KEY this
// returns 503 and the form falls back to its mailto path — no lead is lost.
//
// Env: RESEND_API_KEY (required to be live), LEADS_TO (default below),
//      LEADS_FROM (default Resend onboarding sender until the domain is
//      verified in Resend — then set to e.g. "SovereignAI <access@mysovereign.ai>").

// Mirror of FREE_MAIL in land.js — the client check is UX, this one is the gate.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru',
  'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io',
  'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com',
]);

const oneLine = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') {
    res.statusCode = 400;
    return res.json({ error: 'invalid payload' });
  }

  // Honeypot: humans never see the "website" field. Pretend success, drop silently.
  if (oneLine(body.website, 100)) return res.json({ ok: true });

  const email = oneLine(body.email, 320).toLowerCase();
  const name = oneLine(body.name, 200);
  const company = oneLine(body.company, 200);
  const use = oneLine(body.use, 200);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.statusCode = 400;
    return res.json({ error: 'invalid email' });
  }
  if (FREE_MAIL.has(email.split('@')[1])) {
    res.statusCode = 400;
    return res.json({ error: 'work email required' });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    res.statusCode = 503;
    return res.json({ error: 'intake not configured' });
  }

  const to = process.env.LEADS_TO || 'hr@unifydynamics.com';
  const from = process.env.LEADS_FROM || 'SovereignAI Access <onboarding@resend.dev>';
  const text = [
    'New access request from the landing page.',
    '',
    `Work email:  ${email}`,
    `Name:        ${name || '—'}`,
    `Company:     ${company || '—'}`,
    `Use:         ${use || '—'}`,
    '',
    'Reply to this email to respond to the applicant directly.',
  ].join('\n');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: [email],
      subject: `Access request — ${email}`,
      text,
    }),
  });

  if (!r.ok) {
    res.statusCode = 502;
    return res.json({ error: 'delivery failed' });
  }
  return res.json({ ok: true });
};
