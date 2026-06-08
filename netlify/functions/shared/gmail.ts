const USERS_TABLE_ID = 'tblBMyzKhFKmPFX25';
const USERS_BASE_ID  = 'app3plkFpOx28hhmH';
const AIRTABLE_BASE  = 'https://api.airtable.com/v0';

export async function getAccessToken(refreshToken: string): Promise<string | null> {
  const clientId     = Netlify.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Netlify.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

export async function getUserRefreshToken(email: string, airtableKey: string): Promise<string | null> {
  const formula = encodeURIComponent(`{Email}='${email}'`);
  const url = `${AIRTABLE_BASE}/${USERS_BASE_ID}/${USERS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${airtableKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.records?.[0]?.fields?.['Gmail Refresh Token'] || null;
}

export async function getGmailSignature(accessToken: string): Promise<string> {
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) return '';
    const data = await res.json();
    const sendAs: any[] = data.sendAs || [];
    const primary = sendAs.find(s => s.isDefault || s.isPrimary) || sendAs[0];
    return primary?.signature || '';
  } catch { return ''; }
}

export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

export function encodeSubject(subject: string): string {
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  const bytes = new TextEncoder().encode(subject);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export function buildMimeMessage({ to, subject, body, bodyHtml, signature, cc, inReplyTo, references }: {
  to: string; subject: string; body: string; bodyHtml?: string; signature?: string;
  cc?: string[]; inReplyTo?: string; references?: string;
}): string {
  const replySubject = inReplyTo && !subject.toLowerCase().startsWith('re:')
    ? `Re: ${subject}`
    : subject;

  let htmlBody: string;
  if (bodyHtml) {
    const sigBlock = signature ? `<div style="margin:24px 32px 0;padding-top:16px;border-top:1px solid #eee;">${signature}</div>` : '';
    htmlBody = sigBlock
      ? (bodyHtml.includes('</body>') ? bodyHtml.replace('</body>', sigBlock + '</body>') : bodyHtml + sigBlock)
      : bodyHtml;
  } else {
    htmlBody = `<div style="font-family:sans-serif;font-size:14px;">${textToHtml(body)}</div>`
      + (signature ? `<br><div>${signature}</div>` : '');
  }

  const lines = [
    `To: ${to}`,
    ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeSubject(replySubject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references} ${inReplyTo || ''}`.trim()] : inReplyTo ? [`References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
  ];

  const raw = lines.join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
