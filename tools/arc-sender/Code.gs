/**
 * ARC SENDER — emails an approved ARC reader their book, automatically.
 *
 * Runs in Kailey's Google account (Google Apps Script), every 10 minutes.
 *
 * How it works
 *   1. A reader applies on kaileybrown.com/arc and lands in Kit tagged
 *      "ARC Applicant: <Book>".
 *   2. Kailey approves them in Kit by adding the tag "ARC Approved: <Book>".
 *   3. This script sees the new tag, emails the reader the EPUB as an
 *      attachment from Kailey's Gmail, and adds the tag "ARC Sent: <Book>".
 *
 * Nothing is ever sent to a reader who does not have the Approved tag, and no
 * reader is sent the same book twice.
 *
 * One-time setup (see README.md next to this file for the click-by-click):
 *   - Google Drive folder named "ARC Files" holding the EPUB files below.
 *   - Script property KIT_API_KEY holding a Kit V4 API key.
 *   - Run setup() once and approve the permissions it asks for.
 *
 * To add a book: put its EPUB in the "ARC Files" folder and fill in its
 * fileName below. A book with fileName null is skipped, so approving readers
 * for an unreleased book is harmless: they are sent the file once it exists.
 */

const FOLDER_NAME = 'ARC Files';
const SENDER_NAME = 'Kailey Brown';
const MAX_SENDS_PER_RUN = 40;      // well under Gmail's daily limit
const KIT_API = 'https://api.kit.com/v4';

const BOOKS = [
  {
    title: 'Somewhere Between Dreaming & You',
    approvedTagId: 25809373, sentTagId: 25809378,
    fileName: 'Somewhere Between Dreaming & You - Kailey Brown.epub',
    amazon: 'https://www.amazon.com/dp/B0GQP3FZ6C',
    goodreads: 'https://www.goodreads.com/book/show/249129213-somewhere-between-dreaming-you'
  },
  {
    title: 'Landed On You',
    approvedTagId: 25809374, sentTagId: 25809379,
    fileName: 'Landed On You - Kailey Brown.epub',
    amazon: 'https://www.amazon.com/dp/B0H1JP3TPL',
    goodreads: 'https://www.goodreads.com/book/show/251557783-landed-on-you'
  },
  {
    title: '12 Days of Awkward',
    approvedTagId: 25809375, sentTagId: 25809380,
    fileName: '12 Days of Awkward - Kailey Brown.epub',
    amazon: 'https://www.amazon.com/dp/B0HBH1J6ZK',
    goodreads: 'https://www.goodreads.com/book/show/255891294'
  },
  // Unreleased: add the EPUB to the folder, then set fileName (and the review
  // links once the book is out).
  { title: 'Mafia Romance', approvedTagId: 25809376, sentTagId: 25809381, fileName: null, amazon: null, goodreads: null },
  { title: 'Copperridge Book 3', approvedTagId: 25809377, sentTagId: 25809382, fileName: null, amazon: null, goodreads: null }
];

/* ── The job the timer runs ─────────────────────────────────────────────── */

function sendApprovedArcs() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'Another run is still going; skipped.';
  try {
    return run_(false);
  } finally {
    lock.releaseLock();
  }
}

/** Shows who WOULD be emailed, without sending or tagging anything. */
function preview() {
  const report = run_(true);
  Logger.log(report);
  return report;
}

function run_(dryRun) {
  const props = PropertiesService.getScriptProperties();
  const lines = [];
  let sent = 0;

  for (const book of BOOKS) {
    if (!book.fileName) continue;                       // no file yet: skip

    const approved = kitTagSubscribers_(book.approvedTagId);
    if (!approved.length) continue;
    const alreadySent = {};
    kitTagSubscribers_(book.sentTagId).forEach(function (s) { alreadySent[s.id] = true; });

    const waiting = approved.filter(function (s) {
      // Two records of "already sent": the Kit tag Kailey can see, and this
      // script's own ledger, in case a tag could not be written after a send.
      return !alreadySent[s.id] && !props.getProperty(ledgerKey_(book, s));
    });
    if (!waiting.length) continue;

    let file = null;
    try {
      file = findFile_(book.fileName);
    } catch (e) {
      lines.push('SKIPPED ' + book.title + ': ' + e.message);
      continue;
    }

    for (const reader of waiting) {
      if (sent >= MAX_SENDS_PER_RUN || MailApp.getRemainingDailyQuota() < 1) {
        lines.push('Stopped early: send limit reached. The rest go out on the next run.');
        return lines.join('\n');
      }
      if (!reader.email_address) continue;

      // Kit's "who has this tag" lists run a few minutes behind. The reader's
      // own record is always current, so confirm on it before sending: still
      // approved (Kailey may have just removed the tag) and not already sent.
      const tagsNow = kitSubscriberTagIds_(reader.id);
      if (!tagsNow[book.approvedTagId] || tagsNow[book.sentTagId]) continue;

      if (dryRun) {
        lines.push('WOULD SEND ' + book.title + ' to ' + reader.email_address);
        sent++;
        continue;
      }

      const mail = buildEmail_(book, reader);
      GmailApp.sendEmail(reader.email_address, mail.subject, mail.text, {
        htmlBody: mail.html,
        attachments: [file.getBlob()],
        name: SENDER_NAME
      });
      // Ledger first: once this is written the reader can never be sent the
      // book again, even if the Kit call below fails.
      props.setProperty(ledgerKey_(book, reader), new Date().toISOString());
      sent++;
      try {
        kitTag_(book.sentTagId, reader.id);
        lines.push('SENT ' + book.title + ' to ' + reader.email_address);
      } catch (e) {
        lines.push('SENT ' + book.title + ' to ' + reader.email_address + ' (could not add the Sent tag in Kit: ' + e.message + ')');
      }
    }
  }

  const report = lines.length ? lines.join('\n') : 'Nothing to send.';
  if (lines.length) Logger.log(report);
  return report;
}

function ledgerKey_(book, reader) {
  return 'sent:' + book.sentTagId + ':' + reader.id;
}

/* ── The email ──────────────────────────────────────────────────────────── */

function buildEmail_(book, reader) {
  const first = firstName_(reader.first_name);
  const hello = first ? 'Hi ' + first + ',' : 'Hi,';
  const subject = 'Your ARC of ' + book.title + ' is here';
  const disclosure = 'I received an advance copy and am voluntarily leaving an honest review.';

  const reviewLines = [];
  if (book.amazon) reviewLines.push({ label: 'Amazon', url: book.amazon });
  if (book.goodreads) reviewLines.push({ label: 'Goodreads', url: book.goodreads });

  const text = [
    hello, '',
    'You\'re approved! Your copy of ' + book.title + ' is attached to this email.', '',
    'HOW TO READ IT ON YOUR KINDLE',
    '1. Download the attached file to your phone or computer.',
    '2. Go to amazon.com/sendtokindle and sign in to your Amazon account.',
    '3. Add the file. It shows up in your Kindle library a few minutes later.',
    'On a phone, you can also open the attachment, tap Share, and choose the Kindle app.', '',
    'WHEN YOU FINISH',
    'Please leave an honest review. It doesn\'t have to be positive, just genuine.',
    'Add this line to your review: "' + disclosure + '"'
  ].concat(reviewLines.map(function (r) { return r.label + ': ' + r.url; })).concat([
    '',
    'Please keep this copy to yourself, and skip the spoilers.', '',
    'Thank you for reading early. I hope you love it.', '',
    'Kailey'
  ]).join('\n');

  const esc = escapeHtml_;
  const html =
    '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.65;color:#1a1a1a;max-width:560px;">' +
    '<p>' + esc(hello) + '</p>' +
    '<p>You\'re approved! Your copy of <em>' + esc(book.title) + '</em> is attached to this email.</p>' +
    '<p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#E31837;margin:26px 0 6px;">How to read it on your Kindle</p>' +
    '<ol style="padding-left:20px;margin:0 0 10px;">' +
    '<li>Download the attached file to your phone or computer.</li>' +
    '<li>Go to <a href="https://www.amazon.com/sendtokindle" style="color:#1a1a1a;">amazon.com/sendtokindle</a> and sign in to your Amazon account.</li>' +
    '<li>Add the file. It shows up in your Kindle library a few minutes later.</li>' +
    '</ol>' +
    '<p>On a phone, you can also open the attachment, tap Share, and choose the Kindle app.</p>' +
    '<p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#E31837;margin:26px 0 6px;">When you finish</p>' +
    '<p>Please leave an honest review. It doesn\'t have to be positive, just genuine. Add this line to your review:</p>' +
    '<p style="border-left:2px solid #E31837;padding-left:14px;font-style:italic;">' + esc(disclosure) + '</p>' +
    (reviewLines.length
      ? '<p>' + reviewLines.map(function (r) {
          return '<a href="' + esc(r.url) + '" style="color:#1a1a1a;">Review on ' + esc(r.label) + '</a>';
        }).join(' &nbsp;|&nbsp; ') + '</p>'
      : '') +
    '<p>Please keep this copy to yourself, and skip the spoilers.</p>' +
    '<p>Thank you for reading early. I hope you love it.</p>' +
    '<p>Kailey</p>' +
    '</div>';

  return { subject: subject, text: text, html: html };
}

/** "Anthony Brown (test)" -> "Anthony". The form stores the full name. */
function firstName_(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-zÀ-ɏ'’-]{2,30}$/.test(first) ? first : '';
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Google Drive ───────────────────────────────────────────────────────── */

function findFile_(fileName) {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (!folders.hasNext()) throw new Error('No Google Drive folder named "' + FOLDER_NAME + '".');
  const files = folders.next().getFilesByName(fileName);
  if (!files.hasNext()) throw new Error('"' + fileName + '" is not in the "' + FOLDER_NAME + '" folder.');
  return files.next();
}

/* ── Kit ────────────────────────────────────────────────────────────────── */

function kitFetch_(method, path) {
  const key = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  if (!key) throw new Error('Script property KIT_API_KEY is not set.');
  const res = UrlFetchApp.fetch(KIT_API + path, {
    method: method,
    headers: { 'X-Kit-Api-Key': key, Accept: 'application/json' },
    contentType: 'application/json',
    payload: method === 'get' ? undefined : '{}',
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Kit answered ' + code + ' for ' + path.split('?')[0]);
  }
  const body = res.getContentText();
  return body ? JSON.parse(body) : {};
}

/** Every active subscriber carrying a tag, following Kit's pagination. */
function kitTagSubscribers_(tagId) {
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = kitFetch_('get', '/tags/' + tagId + '/subscribers?per_page=500' + (after ? '&after=' + encodeURIComponent(after) : ''));
    (data.subscribers || []).forEach(function (s) { out.push(s); });
    const p = data.pagination || {};
    if (!p.has_next_page || !p.end_cursor) break;
    after = p.end_cursor;
  }
  return out;
}

/** The tags currently on one subscriber, as { tagId: true }. Always current. */
function kitSubscriberTagIds_(subscriberId) {
  const data = kitFetch_('get', '/subscribers/' + subscriberId + '/tags?per_page=500');
  const ids = {};
  (data.tags || []).forEach(function (t) { ids[t.id] = true; });
  return ids;
}

function kitTag_(tagId, subscriberId) {
  kitFetch_('post', '/tags/' + tagId + '/subscribers/' + subscriberId);
}

/* ── One-time setup ─────────────────────────────────────────────────────── */

/**
 * Run this once from the Apps Script editor. It checks the key, the folder and
 * the files, then starts the 10-minute timer. Safe to run again.
 */
function setup() {
  const report = [];
  const account = kitFetch_('get', '/account');
  report.push('Kit key works. Account: ' + ((account.account && account.account.name) || 'ok'));

  BOOKS.forEach(function (book) {
    if (!book.fileName) { report.push('- ' + book.title + ': no file yet, will be skipped'); return; }
    try {
      const f = findFile_(book.fileName);
      report.push('- ' + book.title + ': file found (' + Math.round(f.getSize() / 1024) + ' KB)');
    } catch (e) {
      report.push('- ' + book.title + ': PROBLEM, ' + e.message);
    }
  });

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendApprovedArcs') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendApprovedArcs').timeBased().everyMinutes(10).create();
  report.push('Timer is on: checking Kit every 10 minutes.');
  report.push('Emails left today on this Gmail account: ' + MailApp.getRemainingDailyQuota());

  const text = report.join('\n');
  Logger.log(text);
  return text;
}

/** Turns the timer off. Nothing is sent until setup() is run again. */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendApprovedArcs') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Timer is off.');
}
