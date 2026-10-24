import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { WebMail, uidOf, parseAddresses, decodeWords, htmlToText, buildMime, parseBatch, recipients } from '../src/kernel/webmail.js';
import { MailService, MailError } from '../src/kernel/mail.js';
import { NotificationService } from '../src/kernel/notifications.js';
import { bootKernel } from '../src/kernel/kernel.js';
import { settle } from './fake-bridge.js';

const REDIRECT = 'https://orion.exemple/os/src/auth.html';
const b64url = (text) => Buffer.from(text).toString('base64url');
const unb64url = (text) => Buffer.from(text, 'base64url').toString('utf8');

/** Réseau imité : `handler(method, url, init)` → { status, body, headers } ; le JSON est décodé comme par NetService. */
function fakeNet(handler) {
  const calls = [];
  return {
    calls,
    async request(url, init = {}) {
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, url, headers: init.headers ?? {}, body: init.body ?? null });
      const r = (await handler(method, new URL(url), init)) ?? { status: 404, body: { error: { message: `inconnu : ${method} ${url}` } } };
      const status = r.status ?? 200;
      const body = init.responseType === 'json' && typeof r.body === 'string' && r.body ? JSON.parse(r.body) : (r.body ?? null);
      return { ok: status < 300, status, url, headers: r.headers ?? {}, body };
    },
  };
}

function memoryStore() {
  const data = new Map();
  return { data, get: async (k) => structuredClone(data.get(k)), put: async (k, v) => data.set(k, structuredClone(v)) };
}

// ───────────── Fausse boîte Gmail ─────────────

function fakeGmail() {
  const msg = (id, date, labels, headers, extra = {}) => ({ id, threadId: `t${id}`, internalDate: String(date), labelIds: labels, snippet: `Aperçu de ${id} &#39;ok&#39;`, sizeEstimate: 1200, payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: b64url(`Corps de ${id}`) } }, ...extra });
  const T = Date.UTC(2026, 9, 20, 9, 0, 0);
  const box = {
    token: 'gtok',
    sent: [],
    modified: [],
    deleted: [],
    revoked: [],
    messages: [
      msg('m5', T + 5000, ['INBOX', 'UNREAD'], { From: '"Martin, Lucas" <lucas@exemple.fr>', To: 'camille@gmail.com', Subject: '=?UTF-8?B?w4l0w6kgw6AgTHlvbg==?=', 'Content-Type': 'text/plain; charset=UTF-8' }),
      msg('m4', T + 4000, ['INBOX', 'STARRED'], { From: 'Léa <lea@exemple.fr>', To: 'camille@gmail.com, Tom <tom@exemple.fr>', Cc: 'nina@exemple.fr', Subject: 'Photos', 'Content-Type': 'multipart/mixed; boundary=x', 'Message-ID': '<m4@exemple.fr>', References: '<m1@exemple.fr>', 'Reply-To': 'lea.pro@exemple.fr' }, {
        payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Léa <lea@exemple.fr>' }, { name: 'To', value: 'camille@gmail.com, Tom <tom@exemple.fr>' }, { name: 'Cc', value: 'nina@exemple.fr' }, { name: 'Subject', value: 'Photos' }, { name: 'Content-Type', value: 'multipart/mixed; boundary=x' }, { name: 'Message-ID', value: '<m4@exemple.fr>' }, { name: 'Reply-To', value: 'lea.pro@exemple.fr' }], parts: [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }], body: { data: Buffer.from('Voilà les photos', 'latin1').toString('base64url') } }, { mimeType: 'image/jpeg', filename: 'lyon.jpg', body: { attachmentId: 'a1', size: 52000 } }] },
      }),
      msg('m3', T + 3000, ['INBOX'], { From: 'news@exemple.fr', Subject: 'Lettre' }, { payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'news@exemple.fr' }, { name: 'Subject', value: 'Lettre' }], body: { data: b64url('<html><style>p{}</style><p>Bonjour&nbsp;Camille</p><p>À <b>bientôt</b> &amp; merci</p></html>') } } }),
      msg('m2', T + 2000, ['INBOX'], { From: 'a@exemple.fr', Subject: 'Deux' }),
      msg('m1', T + 1000, ['SENT'], { From: 'camille@gmail.com', To: 'a@exemple.fr', Subject: 'Un' }),
    ],
  };
  const byId = (id) => box.messages.find((m) => m.id === id);
  const metadata = (m) => ({ ...m, payload: { headers: m.payload.headers } });
  const net = fakeNet((method, url, init) => {
    const path = url.pathname;
    if (url.hostname === 'oauth2.googleapis.com' && path === '/tokeninfo') return { body: { aud: 'gid', azp: 'gid', scope: url.searchParams.get('access_token') === 'gtok-sans-gmail' ? 'email' : 'https://mail.google.com/ email profile', expires_in: 3599 } };
    if (url.hostname === 'oauth2.googleapis.com' && path === '/revoke') return box.revoked.push(url.searchParams.get('token')) && { body: {} };
    if (init.headers.Authorization !== `Bearer ${box.token}`) return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } };
    if (path === '/oauth2/v3/userinfo') return { body: { name: 'Camille Martin', email: 'camille@gmail.com' } };
    const p = path.replace('/gmail/v1/users/me', '');
    if (path === '/batch/gmail/v1') {
      const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
      const parts = init.body.split(`--${boundary}`).filter((x) => x.includes('GET '));
      const out = parts.map((part) => {
        const id = /Content-ID: <(\w+)>/.exec(part)[1];
        const target = new URL(`https://gmail.googleapis.com${/GET (\S+)/.exec(part)[1]}`);
        const sub = target.pathname.replace('/gmail/v1/users/me', '');
        let json = null;
        if (sub.startsWith('/labels/')) json = { id: sub.slice(8), messagesUnread: sub === '/labels/INBOX' ? 1 : 0, messagesTotal: box.messages.filter((m) => m.labelIds.includes(sub.slice(8))).length };
        else if (sub.startsWith('/messages/')) json = byId(sub.slice(10)) && metadata(byId(sub.slice(10)));
        return `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\n${json ? `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}` : 'HTTP/1.1 404 Not Found\r\n\r\n{}'}\r\n`;
      });
      // Les réponses peuvent arriver dans le désordre : l'ordre suit Content-ID.
      return { headers: { 'content-type': 'multipart/mixed; boundary=resp' }, body: `${out.reverse().join('')}--resp--` };
    }
    if (p === '/profile') return { body: { emailAddress: 'Camille@gmail.com' } };
    if (p === '/labels') return { body: { labels: [{ id: 'INBOX', type: 'system', name: 'INBOX' }, { id: 'Label_2', type: 'user', name: 'Voyages/Lyon' }, { id: 'Label_1', type: 'user', name: 'Factures' }] } };
    if (p === '/messages' && method === 'GET') {
      const label = url.searchParams.get('labelIds');
      const q = url.searchParams.get('q') ?? '';
      const before = /before:(\d+)/.exec(q)?.[1];
      let list = box.messages.filter((m) => (!label || m.labelIds.includes(label)) && (!q.includes('is:unread') || m.labelIds.includes('UNREAD')) && (!before || Number(m.internalDate) < before * 1000));
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Number(url.searchParams.get('maxResults'));
      const page = list.slice(start, start + size);
      return { body: { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + size < list.length ? { nextPageToken: String(start + size) } : {}) } };
    }
    if (p.startsWith('/messages/') && method === 'GET' && byId(p.slice(10))) return { body: url.searchParams.get('format') === 'minimal' ? { id: p.slice(10), internalDate: byId(p.slice(10)).internalDate } : byId(p.slice(10)) };
    if (p === '/messages/batchModify') {
      const body = JSON.parse(init.body);
      box.modified.push(body);
      for (const m of box.messages.filter((x) => body.ids.includes(x.id))) m.labelIds = [...new Set([...m.labelIds.filter((l) => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
      return { status: 204, body: '' };
    }
    if (p === '/messages/batchDelete') {
      box.deleted.push(...JSON.parse(init.body).ids);
      return { status: 204, body: '' };
    }
    if (p === '/messages/send') {
      box.sent.push(unb64url(JSON.parse(init.body).raw));
      return { body: { id: 'm9', labelIds: ['SENT'] } };
    }
    return null;
  });
  return { box, net, T };
}

async function gmailAccount({ now = () => Date.UTC(2026, 9, 24, 10, 0, 0), notifications = null } = {}) {
  const { box, net, T } = fakeGmail();
  const store = memoryStore();
  const web = await new WebMail({ store, net, clients: { google: 'gid' }, notifications, now, crypto: webcrypto }).load();
  const { url, pending } = await web.begin('google', { redirectUri: REDIRECT });
  const account = await web.complete(pending, { access_token: 'gtok', expires_in: '3599', token_type: 'Bearer' });
  return { web, box, net, store, url: new URL(url), account, T };
}

test('e-mails par Internet : outils (adresses, en-têtes encodés, HTML, MIME, réponse groupée)', () => {
  assert.deepEqual(parseAddresses('"Martin, Lucas" <lucas@exemple.fr>, nina@exemple.fr, =?UTF-8?Q?L=C3=A9a?= <lea@exemple.fr>, "Dit \\"Tom\\"" <tom@exemple.fr>, pas-une-adresse'), [
    { name: 'Martin, Lucas', address: 'lucas@exemple.fr' },
    { name: '', address: 'nina@exemple.fr' },
    { name: 'Léa', address: 'lea@exemple.fr' },
    { name: 'Dit "Tom"', address: 'tom@exemple.fr' },
  ]);
  assert.equal(decodeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?= =?UTF-8?B?IOKYlQ==?='), 'Café crème ☕');
  assert.equal(htmlToText('<style>a{}</style><p>Un&nbsp;&amp;&#233;</p><ul><li>deux</li></ul><br>trois'), 'Un &é\n• deux\n\ntrois');
  // uid : croissant avec la date, jamais deux fois le même pour une même milliseconde (sauf collision d'empreinte).
  assert.ok(uidOf(1000, 'b') > uidOf(999, 'zzz'));
  assert.ok(Number.isSafeInteger(uidOf(Date.UTC(2100, 0, 1), 'x')));
  assert.notEqual(uidOf(5000, 'a'), uidOf(5000, 'b'));

  const raw = buildMime({ from: { name: 'Camille Martin', address: 'c@gmail.com' }, to: [{ name: 'Léa', address: 'lea@exemple.fr' }], bcc: [{ name: '', address: 'cache@exemple.fr' }], subject: 'Été\r\nBcc: pirate@exemple.fr', text: 'Bonjour 😊\nÀ bientôt', inReplyTo: '<m4@exemple.fr>', references: '<m1@exemple.fr> <m4@exemple.fr>', date: Date.UTC(2026, 9, 24) });
  const [head, body] = raw.split('\r\n\r\n');
  assert.match(head, /^From: "Camille Martin" <c@gmail\.com>\r\nTo: =\?UTF-8\?B\?TMOpYQ==\?= <lea@exemple\.fr>\r\nBcc: cache@exemple\.fr\r\n/);
  assert.equal(head.match(/^Bcc:/gm).length, 1, 'pas d\'en-tête injecté par l\'objet');
  assert.equal(decodeWords(/^Subject: (.*)$/m.exec(head)[1]), 'Été Bcc: pirate@exemple.fr');
  assert.match(head, /In-Reply-To: <m4@exemple\.fr>\r\nReferences: <m1@exemple\.fr> <m4@exemple\.fr>/);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Bonjour 😊\r\nÀ bientôt');
  assert.throws(() => recipients(['pas une adresse']), MailError);
  assert.deepEqual(recipients(['Lucas <lucas@exemple.fr>', { name: 'Léa\r\n', address: 'lea@exemple.fr' }]), [{ name: 'Lucas', address: 'lucas@exemple.fr' }, { name: 'Léa', address: 'lea@exemple.fr' }]);
  assert.deepEqual(parseBatch('--b\r\nContent-ID: <response-i1>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"n":1}\r\n--b\r\nContent-ID: <response-i0>\r\n\r\nHTTP/1.1 404 Not Found\r\n\r\n{"error":{}}\r\n--b--', 'multipart/mixed; boundary=b', 2), [null, { n: 1 }]);
});

test('Gmail : connexion (jeton vérifié), dossiers, messages, pages, lecture', async () => {
  const { web, url, account, net, T } = await gmailAccount();
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(['client_id', 'redirect_uri', 'response_type', 'scope', 'prompt'].map((k) => [k, url.searchParams.get(k)])), { client_id: 'gid', redirect_uri: REDIRECT, response_type: 'token', scope: 'https://mail.google.com/ email profile', prompt: 'select_account' });
  assert.deepEqual({ address: account.address, name: account.name, web: account.web, provider: account.provider, expired: account.expired }, { address: 'camille@gmail.com', name: 'Camille Martin', web: true, provider: 'google', expired: false });
  assert.ok(web.owns(account.id));
  // Jeton émis pour une autre application, ou sans accès aux e-mails : refusé.
  const other = await new WebMail({ net: fakeNet(() => ({ body: { aud: 'autre', azp: 'autre', scope: 'https://mail.google.com/' } })), clients: { google: 'gid' }, crypto: webcrypto }).load();
  await assert.rejects(other.complete({ provider: 'google' }, { access_token: 'x' }), /autre application/);
  await assert.rejects(web.complete({ provider: 'google' }, { access_token: 'gtok-sans-gmail' }), /accès à Gmail/);
  await assert.rejects(web.complete({ provider: 'google' }, { error: 'access_denied' }), /annulée/);

  const folders = await web.folders(account.id);
  assert.deepEqual(folders.map((f) => [f.id, f.name, f.role]), [['INBOX', 'Réception', 'inbox'], ['DRAFT', 'Brouillons', 'drafts'], ['SENT', 'Envoyés', 'sent'], ['ALL', 'Tous les messages', 'all'], ['SPAM', 'Indésirables', 'junk'], ['TRASH', 'Corbeille', 'trash'], ['Label_1', 'Factures', null], ['Label_2', 'Voyages › Lyon', null]]);
  assert.deepEqual([folders[0].unread, folders[0].total], [1, 4]);

  const first = await web.messages(account.id, 'INBOX', { limit: 2 });
  assert.equal(first.more, true);
  assert.deepEqual(first.messages.map((m) => m.subject), ['Été à Lyon', 'Photos']);
  const [m5, m4] = first.messages;
  assert.deepEqual({ from: m5.from, seen: m5.seen, flagged: m5.flagged, preview: m5.preview, date: m5.date }, { from: { name: 'Martin, Lucas', address: 'lucas@exemple.fr' }, seen: false, flagged: false, preview: 'Aperçu de m5 \'ok\'', date: T + 5000 });
  assert.deepEqual({ to: m4.to.map((t) => t.address), cc: m4.cc, flagged: m4.flagged, attachments: m4.attachments }, { to: ['camille@gmail.com', 'tom@exemple.fr'], cc: [{ name: '', address: 'nina@exemple.fr' }], flagged: true, attachments: true });
  assert.ok(m5.uid > m4.uid && Number.isInteger(m4.uid));
  // Page suivante : jeton de page de Gmail, retrouvé par l'uid du dernier message.
  const second = await web.messages(account.id, 'INBOX', { limit: 2, before: m4.uid });
  assert.deepEqual(second.messages.map((m) => m.subject), ['Lettre', 'Deux']);
  assert.equal(new URL(net.calls.filter((c) => c.url.includes('/users/me/messages?')).at(-1).url).searchParams.get('pageToken'), '2');
  assert.equal(second.more, false);
  // Deux requêtes par page (liste + lecture groupée), pas une par message.
  const before = net.calls.length;
  await web.messages(account.id, 'INBOX', { limit: 40 });
  assert.equal(net.calls.length - before, 2);
  assert.deepEqual((await web.messages(account.id, 'INBOX', { filter: 'unread' })).messages.map((m) => m.subject), ['Été à Lyon']);

  const full = await web.message(account.id, 'INBOX', m4.uid);
  assert.deepEqual({ text: full.text, html: full.html, attachments: full.attachments, replyTo: full.replyTo, messageId: full.messageId }, { text: 'Voilà les photos', html: false, attachments: [{ name: 'lyon.jpg', type: 'image/jpeg', size: 52000 }], replyTo: [{ name: '', address: 'lea.pro@exemple.fr' }], messageId: '<m4@exemple.fr>' });
  const letter = await web.message(account.id, 'INBOX', second.messages[0].uid);
  assert.deepEqual([letter.text, letter.html], ['Bonjour Camille\nÀ bientôt & merci', true]);
  // Uid oublié (Orion redémarré) : retrouvé autour de sa date.
  const fresh = await new WebMail({ store: memoryStore(), net, clients: { google: 'gid' }, now: () => Date.UTC(2026, 9, 24, 10), crypto: webcrypto }).load();
  const { pending } = await fresh.begin('google', { redirectUri: REDIRECT });
  const again = await fresh.complete(pending, { access_token: 'gtok', expires_in: '3599' });
  assert.equal((await fresh.message(again.id, 'INBOX', m4.uid)).subject, 'Photos');
  await assert.rejects(fresh.message(again.id, 'INBOX', uidOf(T - 99_000, 'x')), /introuvable/);
});

test('Gmail : drapeaux, déplacement, corbeille, envoi', async () => {
  const { web, box, account } = await gmailAccount();
  const [m5, m4] = (await web.messages(account.id, 'INBOX')).messages;
  await web.setFlags(account.id, 'INBOX', [m5.uid], { add: ['seen', 'flagged'] });
  assert.deepEqual(box.modified.at(-1), { ids: ['m5'], addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] });
  await web.setFlags(account.id, 'INBOX', [m5.uid], { add: ['answered'] }); // pas de drapeau « répondu » chez Gmail
  assert.equal(box.modified.length, 1);
  assert.equal(await web.move(account.id, 'INBOX', [m4.uid], 'archive'), 'ALL');
  assert.deepEqual(box.modified.at(-1), { ids: ['m4'], addLabelIds: [], removeLabelIds: ['INBOX'] });
  assert.equal(await web.move(account.id, 'ALL', [m4.uid], 'Label_1'), 'Label_1');
  assert.deepEqual(box.modified.at(-1), { ids: ['m4'], addLabelIds: ['Label_1'], removeLabelIds: [] });
  assert.equal(await web.remove(account.id, 'INBOX', [m5.uid]), 'TRASH');
  assert.deepEqual(box.modified.at(-1), { ids: ['m5'], addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
  assert.equal(await web.remove(account.id, 'TRASH', [m5.uid]), null);
  assert.deepEqual(box.deleted, ['m5']);

  const sent = await web.send(account.id, { to: ['Léa <lea@exemple.fr>'], cc: [{ name: 'Tom', address: 'tom@exemple.fr' }], subject: 'Re: Photos', text: 'Merci !', inReplyTo: '<m4@exemple.fr>', references: '<m4@exemple.fr>' });
  assert.deepEqual(sent, { ok: true, messageId: '', refused: [], savedTo: 'SENT' });
  assert.match(box.sent[0], /^From: "Camille Martin" <camille@gmail\.com>\r\nTo: "Léa" <lea@exemple\.fr>|^From: "Camille Martin" <camille@gmail\.com>\r\nTo: =\?UTF-8\?B\?TMOpYQ==\?= <lea@exemple\.fr>/);
  assert.match(box.sent[0], /\r\nCc: "Tom" <tom@exemple\.fr>\r\nSubject: Re: Photos\r\n/);
  assert.match(box.sent[0], /In-Reply-To: <m4@exemple\.fr>/);
  await assert.rejects(web.send(account.id, { to: [], text: 'x' }), /destinataire/);
  await assert.rejects(web.send(account.id, { to: ['lea@exemple.fr'], text: 'x'.repeat(100_001) }), /trop long/);
});

test('Gmail : accès expiré au bout d\'une heure, notification, reconnexion', async () => {
  let now = Date.UTC(2026, 9, 24, 10, 0, 0);
  const notifications = new NotificationService({ now: () => now });
  const { web, box, account, store } = await gmailAccount({ now: () => now, notifications });
  assert.equal(store.data.get('accounts')[0].token, 'gtok');
  now += 3600_000;
  assert.equal(web.list()[0].expired, true);
  await assert.rejects(web.folders(account.id), /expirée : reconnectez camille@gmail\.com/);
  await assert.rejects(web.folders(account.id), /expirée/);
  const notes = notifications.list({ appId: 'settings' });
  assert.equal(notes.length, 1, 'une seule notification');
  assert.deepEqual([notes[0].title, notes[0].intent], ['Gmail : reconnexion nécessaire', { app: 'settings', action: 'view', data: { page: 'mail' } }]);
  // Jeton refusé avant son échéance (accès retiré chez Google) : reconnexion aussi.
  const { url, pending } = await web.begin('google', { redirectUri: REDIRECT, account: account.id });
  assert.equal(new URL(url).searchParams.get('login_hint'), 'camille@gmail.com');
  assert.equal(new URL(url).searchParams.get('prompt'), null);
  box.token = 'gtok2';
  await assert.rejects(web.complete(pending, { access_token: 'gtok', expires_in: '3599' }), /Invalid Credentials|expirée/);
  const back = await web.complete(pending, { access_token: 'gtok2', expires_in: '3599' });
  assert.equal(back.expired, false);
  assert.equal(notifications.list({ appId: 'settings' }).length, 0, 'notification retirée');
  assert.equal((await web.folders(account.id))[0].id, 'INBOX');
  assert.equal(web.list().length, 1, 'même compte, pas de doublon');
  // Retrait du compte par la messagerie : accès révoqué chez Google.
  await new MailService({ web }).removeAccount(account.id);
  assert.deepEqual([web.list(), box.revoked], [[], ['gtok2']]);
});

// ───────────── Faux Outlook (Microsoft Graph) ─────────────

function fakeGraph() {
  const T = Date.UTC(2026, 9, 20, 9, 0, 0);
  const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
  const box = {
    access: 'mt1',
    refresh: 'r1',
    refuseRefresh: false,
    challenge: null,
    tokens: [],
    batches: [],
    sends: [],
    folders: [{ id: 'F-INBOX', displayName: 'Boîte de réception', unreadItemCount: 1, totalItemCount: 3 }, { id: 'F-SENT', displayName: 'Éléments envoyés', unreadItemCount: 0, totalItemCount: 1 }, { id: 'F-TRASH', displayName: 'Éléments supprimés', unreadItemCount: 0, totalItemCount: 0 }, { id: 'F-PERSO', displayName: 'Perso', unreadItemCount: 2, totalItemCount: 5 }],
    messages: [
      { id: 'o3', parentFolderId: 'F-INBOX', subject: 'Réunion', from: { emailAddress: { name: 'Lucas', address: 'lucas@exemple.fr' } }, toRecipients: [{ emailAddress: { name: 'Camille', address: 'camille@outlook.fr' } }], ccRecipients: [], receivedDateTime: iso(T + 3000), isRead: false, flag: { flagStatus: 'notFlagged' }, hasAttachments: true, bodyPreview: 'À 14 h', internetMessageId: '<o3@exemple.fr>', body: { contentType: 'text', content: 'À 14 h, salle B.' } },
      { id: 'o2', parentFolderId: 'F-INBOX', subject: 'Facture', from: { emailAddress: { name: '', address: 'factures@exemple.fr' } }, toRecipients: [], ccRecipients: [], receivedDateTime: iso(T + 2000), isRead: true, flag: { flagStatus: 'flagged' }, hasAttachments: false, bodyPreview: '', internetMessageId: '<o2@exemple.fr>', body: { contentType: 'text', content: 'Montant : 12 €' } },
      { id: 'o1', parentFolderId: 'F-INBOX', subject: 'Ancien', from: { emailAddress: { name: '', address: 'a@exemple.fr' } }, toRecipients: [], ccRecipients: [], receivedDateTime: iso(T + 1000), isRead: true, flag: { flagStatus: 'notFlagged' }, hasAttachments: false, bodyPreview: '', internetMessageId: '<o1@exemple.fr>', body: { contentType: 'text', content: 'Ancien' } },
    ],
  };
  const WELL = { inbox: 'F-INBOX', sentitems: 'F-SENT', deleteditems: 'F-TRASH', drafts: null, junkemail: null, archive: null };
  const one = (method, path, body) => {
    const m = /^\/me\/messages\/([^/?]+)(\/\w+)?/.exec(path);
    if (method === 'GET' && /^\/me\/mailFolders\/(\w+)\?/.test(path)) {
      const id = WELL[/^\/me\/mailFolders\/(\w+)/.exec(path)[1]];
      return id ? { status: 200, body: { id } } : { status: 404, body: { error: { message: 'introuvable' } } };
    }
    const msg = m && box.messages.find((x) => x.id === m[1]);
    if (!msg) return { status: 404, body: { error: { message: 'Message introuvable' } } };
    if (method === 'PATCH') return Object.assign(msg, body) && { status: 200, body: msg };
    if (method === 'POST' && m[2] === '/move') {
      msg.parentFolderId = WELL[body.destinationId] ?? body.destinationId;
      return { status: 201, body: msg };
    }
    if (method === 'DELETE') {
      box.messages = box.messages.filter((x) => x !== msg);
      return { status: 204 };
    }
    return { status: 400, body: { error: { message: 'non géré' } } };
  };
  const net = fakeNet((method, url, init) => {
    if (url.hostname === 'login.microsoftonline.com') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      box.tokens.push(form);
      if (form.grant_type === 'authorization_code') {
        const pkce = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
        if (form.code !== 'mcode' || pkce !== box.challenge || form.redirect_uri !== REDIRECT || form.client_id !== 'mid') return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS: code invalide' } };
        return { body: { access_token: box.access, refresh_token: box.refresh, expires_in: 3600 } };
      }
      if (box.refuseRefresh || form.refresh_token !== box.refresh) return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700084: jeton de renouvellement expiré' } };
      box.access = `mt${box.tokens.length}`;
      return { body: { access_token: box.access, expires_in: 3600 } };
    }
    if (init.headers.Authorization !== `Bearer ${box.access}`) return { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Jeton expiré' } } };
    const path = url.pathname.replace('/v1.0', '');
    const q = Object.fromEntries(url.searchParams);
    if (path === '/me') return { body: { displayName: 'Camille M.', mail: null, userPrincipalName: 'Camille@outlook.fr' } };
    // Identifiants stables quand un message change de dossier.
    assert.match(init.headers.Prefer, /IdType="ImmutableId"/);
    if (path === '/$batch') {
      const { requests } = JSON.parse(init.body);
      box.batches.push(requests);
      return { body: { responses: requests.map((r) => ({ id: r.id, ...one(r.method, r.url, r.body) })).reverse() } };
    }
    if (path === '/me/mailFolders') return { body: { value: box.folders } };
    const list = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(path);
    if (list) {
      box.lastQuery = q;
      let items = box.messages.filter((m) => m.parentFolderId === decodeURIComponent(list[1]));
      const lt = /receivedDateTime lt (\S+)/.exec(q.$filter ?? '')?.[1];
      if (lt) items = items.filter((m) => Date.parse(m.receivedDateTime) < Date.parse(lt));
      if (/isRead eq false/.test(q.$filter ?? '')) items = items.filter((m) => !m.isRead);
      const top = Number(q.$top);
      return { body: { value: items.slice(0, top), ...(items.length > top ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/mailFolders/${list[1]}/messages?$skip=${top}&page=2` } : {}) } };
    }
    if (path === '/me/messages' && q.$filter?.startsWith('internetMessageId')) {
      const id = /'(.*)'/.exec(q.$filter)[1];
      return { body: { value: box.messages.filter((m) => m.internetMessageId === id).map((m) => ({ id: m.id })) } };
    }
    if (path === '/me/messages' && q.$filter?.startsWith('receivedDateTime')) return { body: { value: [] } };
    const att = /^\/me\/messages\/(\w+)\/attachments$/.exec(path);
    if (att) return { body: { value: [{ name: 'ordre-du-jour.pdf', contentType: 'application/pdf', size: 3000, isInline: false }, { name: 'logo.png', contentType: 'image/png', size: 100, isInline: true }] } };
    const reply = /^\/me\/messages\/(\w+)\/createReply$/.exec(path);
    if (reply) {
      box.sends.push({ createReply: reply[1] });
      return { status: 201, body: { id: 'draft1' } };
    }
    if (path === '/me/messages/draft1' && method === 'PATCH') return box.sends.push({ patch: JSON.parse(init.body) }) && { body: { id: 'draft1' } };
    if (path === '/me/messages/draft1/send') return box.sends.push({ send: 'draft1' }) && { status: 202, body: '' };
    if (path === '/me/sendMail') return box.sends.push({ sendMail: JSON.parse(init.body) }) && { status: 202, body: '' };
    const m = /^\/me\/messages\/(\w+)$/.exec(path);
    if (m && method === 'GET') {
      box.lastPrefer = init.headers.Prefer;
      return { body: box.messages.find((x) => x.id === m[1]) };
    }
    return null;
  });
  return { box, net, T };
}

async function outlookAccount(now = () => Date.UTC(2026, 9, 24, 10, 0, 0), notifications = null) {
  const { box, net, T } = fakeGraph();
  const web = await new WebMail({ store: memoryStore(), net, clients: { microsoft: 'mid' }, notifications, now, crypto: webcrypto }).load();
  const { url, pending } = await web.begin('microsoft', { redirectUri: REDIRECT });
  box.challenge = new URL(url).searchParams.get('code_challenge');
  const account = await web.complete(pending, { code: 'mcode' });
  return { web, box, net, account, url: new URL(url), T };
}

test('Outlook : connexion (code + PKCE), dossiers, messages, lecture', async () => {
  const { web, box, url, account } = await outlookAccount();
  assert.deepEqual(Object.fromEntries(['response_type', 'code_challenge_method', 'client_id', 'scope'].map((k) => [k, url.searchParams.get(k)])), { response_type: 'code', code_challenge_method: 'S256', client_id: 'mid', scope: 'offline_access openid email profile Mail.ReadWrite Mail.Send User.Read' });
  assert.deepEqual([account.address, account.name, account.provider], ['camille@outlook.fr', 'Camille M.', 'microsoft']);
  assert.equal(box.tokens[0].grant_type, 'authorization_code');
  // Un code rejoué sans le bon vérificateur est refusé par Microsoft.
  await assert.rejects(web.complete({ provider: 'microsoft', redirectUri: REDIRECT, verifier: 'autre' }, { code: 'mcode' }), /code invalide/);

  const folders = await web.folders(account.id);
  assert.deepEqual(folders.map((f) => [f.id, f.name, f.role, f.unread]), [['F-INBOX', 'Réception', 'inbox', 1], ['F-SENT', 'Envoyés', 'sent', 0], ['F-TRASH', 'Corbeille', 'trash', 0], ['F-PERSO', 'Perso', null, null]]);
  const page = await web.messages(account.id, 'F-INBOX', { limit: 2 });
  assert.deepEqual(page.messages.map((m) => [m.subject, m.seen, m.flagged, m.attachments]), [['Réunion', false, false, true], ['Facture', true, true, false]]);
  // Graph : la propriété de tri ouvre le filtre.
  assert.match(box.lastQuery.$filter, /^receivedDateTime ge /);
  assert.equal(box.lastQuery.$orderby, 'receivedDateTime desc');
  assert.equal(page.more, true);
  await web.messages(account.id, 'F-INBOX', { filter: 'unread' });
  assert.equal(box.lastQuery.$filter, 'receivedDateTime ge 1970-01-01T00:00:00Z and isRead eq false');
  const full = await web.message(account.id, 'F-INBOX', page.messages[0].uid);
  assert.deepEqual({ text: full.text, attachments: full.attachments, messageId: full.messageId }, { text: 'À 14 h, salle B.', attachments: [{ name: 'ordre-du-jour.pdf', type: 'application/pdf', size: 3000 }], messageId: '<o3@exemple.fr>' });
  assert.match(box.lastPrefer, /outlook\.body-content-type="text"/);
});

test('Outlook : drapeaux, déplacement, corbeille, réponse et envoi groupés', async () => {
  const { web, box, account } = await outlookAccount();
  const [o3, o2] = (await web.messages(account.id, 'F-INBOX')).messages;
  await web.setFlags(account.id, 'F-INBOX', [o3.uid, o2.uid], { add: ['seen'], remove: ['flagged'] });
  assert.deepEqual(box.batches.at(-1).map((r) => [r.method, r.url, r.body]), [['PATCH', '/me/messages/o3', { isRead: true, flag: { flagStatus: 'notFlagged' } }], ['PATCH', '/me/messages/o2', { isRead: true, flag: { flagStatus: 'notFlagged' } }]]);
  assert.equal(await web.move(account.id, 'F-INBOX', [o2.uid], 'F-PERSO'), 'F-PERSO');
  assert.equal(await web.remove(account.id, 'F-PERSO', [o2.uid]), 'F-TRASH');
  assert.deepEqual(box.batches.at(-1)[0].body, { destinationId: 'deleteditems' });
  assert.equal(await web.remove(account.id, 'F-TRASH', [o2.uid]), null);
  assert.equal(box.messages.some((m) => m.id === 'o2'), false);
  await assert.rejects(web.move(account.id, 'F-INBOX', [uidOf(1, 'inconnu')], 'archive'), /introuvable/);

  // Réponse : brouillon de réponse d'Outlook (conversation gardée), puis envoi.
  await web.send(account.id, { to: ['lucas@exemple.fr'], subject: 'Re: Réunion', text: 'Bien noté', inReplyTo: '<o3@exemple.fr>' });
  assert.deepEqual(box.sends.slice(0, 3).map((x) => Object.keys(x)[0]), ['createReply', 'patch', 'send']);
  assert.deepEqual(box.sends[1].patch.body, { contentType: 'Text', content: 'Bien noté' });
  await web.send(account.id, { to: [{ name: 'Léa', address: 'lea@exemple.fr' }], bcc: ['cache@exemple.fr'], subject: 'Salut', text: 'Coucou' });
  assert.deepEqual(box.sends.at(-1).sendMail.message.toRecipients, [{ emailAddress: { address: 'lea@exemple.fr', name: 'Léa' } }]);
  assert.deepEqual(box.sends.at(-1).sendMail.message.bccRecipients, [{ emailAddress: { address: 'cache@exemple.fr' } }]);
  assert.equal(box.sends.at(-1).sendMail.saveToSentItems, true);
});

test('Outlook : jeton renouvelé seul, puis reconnexion quand le renouvellement est refusé', async () => {
  let now = Date.UTC(2026, 9, 24, 10, 0, 0);
  const notifications = new NotificationService({ now: () => now });
  const { web, box, account } = await outlookAccount(() => now, notifications);
  now += 3600_000;
  assert.equal((await web.folders(account.id))[0].id, 'F-INBOX');
  assert.equal(box.tokens.at(-1).grant_type, 'refresh_token');
  // Jeton refusé avant son échéance : un renouvellement, puis la requête est rejouée.
  box.access = 'revoque';
  box.tokens.push({});
  const refreshes = box.tokens.filter((t) => t.grant_type === 'refresh_token').length;
  assert.equal((await web.folders(account.id))[0].id, 'F-INBOX');
  assert.equal(box.tokens.filter((t) => t.grant_type === 'refresh_token').length, refreshes + 1);
  // 24 heures plus tard : renouvellement refusé, reconnexion demandée.
  box.refuseRefresh = true;
  now += 25 * 3600_000;
  await assert.rejects(web.folders(account.id), /Outlook expirée/);
  assert.equal(web.list()[0].expired, true);
  assert.equal(notifications.list().length, 1);
});

test('messagerie : comptes par Internet à côté d\'orion-server, autorisation des apps', async () => {
  const { web, account } = await gmailAccount();
  const events = [];
  const mail = new MailService({ web, events: { emit: (type, e) => events.push([type, e]) } });
  assert.equal(mail.server, false);
  assert.equal(mail.available, true);
  assert.deepEqual((await mail.accounts()).map((a) => a.address), ['camille@gmail.com']);
  const [m5] = (await mail.messages(account.id, 'INBOX')).messages;
  await mail.setFlags(account.id, 'INBOX', [m5.uid], { add: ['seen'] });
  assert.equal(await mail.move(account.id, 'INBOX', [m5.uid], 'archive'), 'ALL');
  await mail.send(account.id, { to: ['lea@exemple.fr'], subject: 'Test', text: 'Bonjour' });
  assert.deepEqual(events.map(([type]) => type), ['mail:change', 'mail:change', 'mail:sent']);
  await assert.rejects(mail.addAccount({ address: 'a@free.fr', password: 'x' }), /Orion installé/);
  await assert.rejects(mail.folders('inconnu'), /introuvable/);

  // Sans identifiant client ni orion-server : pas de messagerie ; avec un identifiant : Gmail proposé.
  const none = await bootKernel({ env: {}, clients: { google: '', microsoft: '' } });
  await settle();
  assert.equal(none.mail.available, false);
  none.shutdown();
  const kernel = await bootKernel({ env: {}, clients: { google: 'gid', microsoft: '' } });
  await settle();
  assert.deepEqual([kernel.mail.available, kernel.mail.web.configured('google'), kernel.mail.web.configured('microsoft')], [true, true, false]);
  await assert.rejects(kernel.mail.web.begin('microsoft', { redirectUri: REDIRECT }), /pas configuré/);
  kernel.shutdown();
});
