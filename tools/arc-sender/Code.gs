/**
 * ARC SENDER — tells Kailey about new ARC applications and emails approved
 * readers their book.
 *
 * Runs in Kailey's Google account (Google Apps Script), every 10 minutes.
 *
 * How it works
 *   1. A reader applies on kaileybrown.com/arc and lands in Kit tagged
 *      "ARC Applicant: <Book>".
 *   2. This script emails Kailey the new applications. Each one has an
 *      Approve and a Decline button.
 *   3. Approve opens a page with one confirm button. Confirming tags the
 *      reader "ARC Approved: <Book>", emails them the EPUB from Kailey's Gmail
 *      straight away, and tags them "ARC Sent: <Book>".
 *      Decline tags them "ARC Declined: <Book>". The reader is told nothing.
 *   4. Kailey can also approve the old way, by adding "ARC Approved: <Book>"
 *      in Kit. The 10-minute timer sends those.
 *
 * Nothing is ever sent to a reader who has not been approved, and no reader is
 * sent the same book twice.
 *
 * One-time setup (see README.md next to this file for the click-by-click):
 *   - Google Drive folder named "ARC Files" holding the EPUB files below.
 *   - Script property KIT_API_KEY holding a Kit V4 API key.
 *   - Deploy as a web app (Execute as: Me, Who has access: Anyone) and save
 *     its URL in the script property WEB_APP_URL. The buttons need it.
 *   - Run setup() once and approve the permissions it asks for.
 *
 * To add a book: put its EPUB in the "ARC Files" folder and fill in its
 * fileName below. A book with fileName null is skipped, so approving readers
 * for an unreleased book is harmless: they are sent the file once it exists.
 *
 * After changing this file, update the web app: Deploy, Manage deployments,
 * edit, Version: New version. The timer always runs the latest code, but the
 * buttons run the deployed version.
 */

const FOLDER_NAME = 'ARC Files';
const SENDER_NAME = 'Kailey Brown';
const NOTIFY_EMAIL = 'kaileybrown.author@gmail.com';   // where applications are announced
const MAX_SENDS_PER_RUN = 40;      // well under Gmail's daily limit
const MAX_PER_NOTICE = 25;         // applications listed in one notification email
const KIT_API = 'https://api.kit.com/v4';

const BOOKS = [
  {
    title: 'Somewhere Between Dreaming & You',
    applicantTagId: 25808851, approvedTagId: 25809373, sentTagId: 25809378, declinedTagId: 25838405,
    fileName: 'Somewhere Between Dreaming & You - Kailey Brown.epub',
    amazon: 'https://www.amazon.com/dp/B0GQP3FZ6C',
    goodreads: 'https://www.goodreads.com/book/show/249129213-somewhere-between-dreaming-you'
  },
  {
    title: 'Landed On You',
    applicantTagId: 25808852, approvedTagId: 25809374, sentTagId: 25809379, declinedTagId: 25838406,
    fileName: 'Landed On You - Kailey Brown.epub',
    amazon: 'https://www.amazon.com/dp/B0H1JP3TPL',
    goodreads: 'https://www.goodreads.com/book/show/251557783-landed-on-you'
  },
  {
    title: '12 Days of Awkward',
    applicantTagId: 25808853, approvedTagId: 25809375, sentTagId: 25809380, declinedTagId: 25838407,
    fileName: '12 Days of Awkward - Kailey Brown.epub',
    amazon: 'https://www.amazon.com/dp/B0HBH1J6ZK',
    goodreads: 'https://www.goodreads.com/book/show/255891294'
  },
  // Unreleased: add the EPUB to the folder, then set fileName (and the review
  // links once the book is out).
  { title: 'Mafia Romance', applicantTagId: 25808854, approvedTagId: 25809376, sentTagId: 25809381, declinedTagId: 25838408, fileName: null, amazon: null, goodreads: null },
  { title: 'Copperridge Book 3', applicantTagId: 25808855, approvedTagId: 25809377, sentTagId: 25809382, declinedTagId: 25838409, fileName: null, amazon: null, goodreads: null }
];

/* ── The job the timer runs ─────────────────────────────────────────────── */

/**
 * Sends books to readers approved in Kit, then tells Kailey about new
 * applications. Returns only a short status: details go to the log, because
 * anything returned here could be read by a visitor to the web app.
 */
function sendApprovedArcs() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'Another run is still going; skipped.';
  try {
    const report = run_(false);
    try {
      const notice = notifyNewApplicants_();
      if (notice) Logger.log(notice);
    } catch (e) {
      Logger.log('PROBLEM telling Kailey about new applications: ' + e.message);
    }
    return report === 'Nothing to send.' ? report : 'Done. See the log.';
  } finally {
    lock.releaseLock();
  }
}

/** Logs who WOULD be emailed a book, without sending or tagging anything. */
function preview() {
  Logger.log(run_(true));
  return 'See the log.';
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

      lines.push(deliver_(book, reader, file, props));
      sent++;
    }
  }

  const report = lines.length ? lines.join('\n') : 'Nothing to send.';
  if (lines.length) Logger.log(report);
  return report;
}

/** Emails one reader one book, records it, and tags them Sent in Kit. */
function deliver_(book, reader, file, props) {
  const mail = buildEmail_(book, reader);
  GmailApp.sendEmail(reader.email_address, mail.subject, mail.text, {
    htmlBody: mail.html,
    attachments: [file.getBlob()],
    name: SENDER_NAME
  });
  // Ledger first: once this is written the reader can never be sent the book
  // again, even if the Kit call below fails.
  props.setProperty(ledgerKey_(book, reader), new Date().toISOString());
  try {
    kitTag_(book.sentTagId, reader.id);
    return 'SENT ' + book.title + ' to ' + reader.email_address;
  } catch (e) {
    return 'SENT ' + book.title + ' to ' + reader.email_address + ' (could not add the Sent tag in Kit: ' + e.message + ')';
  }
}

function ledgerKey_(book, reader) {
  return 'sent:' + book.sentTagId + ':' + reader.id;
}

/* ── The email to the reader ────────────────────────────────────────────── */

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

/* ── Telling Kailey about new applications ──────────────────────────────── */

/**
 * Emails Kailey one message listing every application she has not been told
 * about yet, each with Approve and Decline buttons. One message per run, not
 * one per reader: notices to herself count against Gmail's daily limit too.
 */
function notifyNewApplicants_() {
  const props = PropertiesService.getScriptProperties();
  if (MailApp.getRemainingDailyQuota() < 3) return 'Notice skipped: Gmail daily limit nearly reached.';

  const pending = [];
  const settled = [];
  for (const book of BOOKS) {
    for (const reader of kitTagSubscribers_(book.applicantTagId)) {
      if (pending.length >= MAX_PER_NOTICE) break;
      const key = 'notified:' + book.applicantTagId + ':' + reader.id;
      if (props.getProperty(key)) continue;
      if (!reader.email_address) continue;

      // The list lags; the reader's own record is current.
      const tagsNow = kitSubscriberTagIds_(reader.id);
      if (!tagsNow[book.applicantTagId]) continue;
      if (tagsNow[book.approvedTagId] || tagsNow[book.sentTagId] || tagsNow[book.declinedTagId]) {
        settled.push(key);               // already handled in Kit: nothing to ask
        continue;
      }
      pending.push({ book: book, reader: reader, key: key });
    }
  }

  settled.forEach(function (k) { props.setProperty(k, 'settled'); });
  if (!pending.length) return '';

  const base = webAppUrl_();
  const esc = escapeHtml_;
  const subject = pending.length === 1
    ? 'New ARC application: ' + (pending[0].reader.first_name || pending[0].reader.email_address) + ' for ' + pending[0].book.title
    : pending.length + ' new ARC applications';

  const textBlocks = [];
  const htmlBlocks = [];
  pending.forEach(function (p) {
    const name = p.reader.first_name || '(no name given)';
    const platforms = (p.reader.fields && p.reader.fields.arc_review_platforms) || 'not stated';
    const approve = base ? decisionUrl_(base, 'approve', p.reader.id, p.book) : '';
    const decline = base ? decisionUrl_(base, 'decline', p.reader.id, p.book) : '';

    textBlocks.push([
      name + ' <' + p.reader.email_address + '>',
      'Book: ' + p.book.title,
      'Will review on: ' + platforms
    ].concat(base ? ['Approve: ' + approve, 'Decline: ' + decline] : []).join('\n'));

    htmlBlocks.push(
      '<div style="border:1px solid #d9d9d9;padding:18px 20px;margin:0 0 16px;">' +
      '<p style="margin:0 0 4px;font-size:18px;color:#000;">' + esc(name) + '</p>' +
      '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:#6e6e6e;">' + esc(p.reader.email_address) + '</p>' +
      '<p style="margin:0 0 4px;"><strong>Book:</strong> ' + esc(p.book.title) + '</p>' +
      '<p style="margin:0 0 16px;"><strong>Will review on:</strong> ' + esc(platforms) + '</p>' +
      (base
        ? '<a href="' + esc(approve) + '" style="display:inline-block;background:#E31837;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.08em;padding:12px 22px;margin:0 8px 8px 0;">APPROVE</a>' +
          '<a href="' + esc(decline) + '" style="display:inline-block;border:1px solid #1a1a1a;color:#1a1a1a;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.08em;padding:11px 22px;margin:0 8px 8px 0;">DECLINE</a>'
        : '<p style="margin:0;color:#6e6e6e;">To approve, add the tag "ARC Approved: ' + esc(p.book.title) + '" to this reader in Kit.</p>') +
      '</div>');
  });

  const foot = base
    ? 'Each button opens a page where you confirm. Approving emails the reader their book right away. Declining sends them nothing.'
    : 'The approve buttons are not set up yet (WEB_APP_URL is missing), so approve these in Kit for now.';

  GmailApp.sendEmail(NOTIFY_EMAIL, subject, textBlocks.join('\n\n') + '\n\n' + foot, {
    htmlBody:
      '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#1a1a1a;max-width:560px;">' +
      '<p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#E31837;margin:0 0 14px;">' +
      (pending.length === 1 ? 'New ARC application' : pending.length + ' new ARC applications') + '</p>' +
      htmlBlocks.join('') +
      '<p style="font-size:14px;color:#6e6e6e;">' + esc(foot) + '</p>' +
      '</div>',
    name: 'ARC Team'
  });

  pending.forEach(function (p) { props.setProperty(p.key, new Date().toISOString()); });
  return 'Told Kailey about ' + pending.length + ' new application(s).';
}

/* ── The Approve / Decline links ────────────────────────────────────────── */

function webAppUrl_() {
  const saved = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (saved && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(saved.trim())) return saved.trim();
  return '';
}

/** A private random key, made once, that signs the links so they cannot be forged. */
function linkSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('ARC_LINK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('ARC_LINK_SECRET', secret);
  }
  return secret;
}

/** One signature covers a reader and a book, whichever button is pressed. */
function sign_(subscriberId, book) {
  const bytes = Utilities.computeHmacSha256Signature(subscriberId + '|' + book.sentTagId, linkSecret_());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function decisionUrl_(base, action, subscriberId, book) {
  return base + '?a=' + action + '&s=' + subscriberId + '&b=' + book.sentTagId + '&k=' + sign_(subscriberId, book);
}

function bookBySentTag_(id) {
  const n = Number(id);
  for (const book of BOOKS) { if (book.sentTagId === n) return book; }
  return null;
}

/** Checks a link's signature. Returns the book, or null if the link is not ours. */
function verify_(subscriberId, sentTagId, sig) {
  if (!/^\d{1,15}$/.test(String(subscriberId || ''))) return null;
  const book = bookBySentTag_(sentTagId);
  if (!book || !sig) return null;
  const want = sign_(String(subscriberId), book);
  const got = String(sig);
  if (want.length !== got.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0 ? book : null;
}

/**
 * The page a button in the notification email opens.
 *
 * Opening the page changes nothing. Mail apps and security scanners open
 * links in emails on their own; if a visit alone approved a reader, a scanner
 * could approve everyone. The reader is only approved or declined when the
 * button on this page is pressed.
 */
function doGet(e) {
  const q = (e && e.parameter) || {};
  const book = verify_(q.s, q.b, q.k);
  if (!book) return page_('This link is not valid', '<p>It may have been copied incorrectly. Open the newest notification email and try again, or approve the reader in Kit.</p>');

  let reader, tags;
  try {
    reader = kitSubscriber_(q.s);
    tags = kitSubscriberTagIds_(q.s);
  } catch (err) {
    return page_('Could not reach Kit', '<p>Please try the link again in a minute.</p>');
  }

  const esc = escapeHtml_;
  const platforms = (reader.fields && reader.fields.arc_review_platforms) || 'not stated';
  const details =
    '<p class="name">' + esc(reader.first_name || '(no name given)') + '</p>' +
    '<p class="mail">' + esc(reader.email_address) + '</p>' +
    '<p><strong>Book:</strong> ' + esc(book.title) + '</p>' +
    '<p><strong>Will review on:</strong> ' + esc(platforms) + '</p>';

  if (tags[book.sentTagId]) {
    return page_('Already sent', details + '<p class="state">This reader has already been sent ' + esc(book.title) + '. Nothing more to do.</p>');
  }

  const state = tags[book.declinedTagId] ? '<p class="state">You declined this application earlier. You can still approve it.</p>'
    : tags[book.approvedTagId] ? '<p class="state">Already approved. The book is on its way or waiting for its file.</p>'
    : '';
  const wantDecline = q.a === 'decline';
  const call = function (action) {
    return 'decide(\'' + action + '\')';
  };
  const buttons =
    '<div id="buttons">' +
    '<button class="' + (wantDecline ? 'quiet' : 'go') + '" onclick="' + call('approve') + '">Approve and send the book</button>' +
    '<button class="' + (wantDecline ? 'go' : 'quiet') + '" onclick="' + call('decline') + '">Decline</button>' +
    '</div><p id="result" class="state"></p>' +
    '<script>' +
    'function decide(a){var b=document.getElementById("buttons"),r=document.getElementById("result");' +
    'b.style.display="none";r.textContent=a==="approve"?"Approving and sending the book...":"Declining...";' +
    'google.script.run.withSuccessHandler(function(m){r.textContent=m;})' +
    '.withFailureHandler(function(){r.textContent="Something went wrong. Nothing was changed. Please try again.";b.style.display="";})' +
    '.arcDecision({a:a,s:' + JSON.stringify(String(q.s)) + ',b:' + JSON.stringify(String(q.b)) + ',k:' + JSON.stringify(String(q.k)) + '});}' +
    '</script>';

  return page_(wantDecline ? 'Decline this application?' : 'Approve this application?', details + state + buttons);
}

function page_(heading, bodyHtml) {
  const html =
    '<!DOCTYPE html><html><head><base target="_top"><style>' +
    'body{font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#1a1a1a;margin:0;padding:28px 20px;background:#fff;}' +
    '.wrap{max-width:460px;margin:0 auto;}' +
    '.label{font-family:Arial,sans-serif;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#E31837;margin:0 0 10px;}' +
    'h1{font-weight:500;font-size:28px;line-height:1.15;margin:0 0 22px;color:#000;}' +
    '.name{font-size:20px;color:#000;margin:0;}.mail{font-family:Arial,sans-serif;font-size:14px;color:#6e6e6e;margin:0 0 14px;}' +
    'p{margin:0 0 8px;}.state{margin-top:18px;color:#6e6e6e;}' +
    '#buttons{margin-top:26px;}' +
    'button{display:block;width:100%;padding:16px;margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;border-radius:0;}' +
    '.go{background:#E31837;color:#fff;border:1px solid #E31837;}.quiet{background:#fff;color:#1a1a1a;border:1px solid #1a1a1a;}' +
    '</style></head><body><div class="wrap"><p class="label">Kailey Brown ARC Team</p><h1>' + escapeHtml_(heading) + '</h1>' +
    bodyHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('ARC application')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called by the button on the page. Does nothing unless the request carries a
 * valid signature for that reader and book, so it is safe to be public.
 * Returns the sentence shown on the page.
 */
function arcDecision(req) {
  req = req || {};
  const book = verify_(req.s, req.b, req.k);
  if (!book) return 'This link is not valid. Nothing was changed.';
  const action = req.a === 'decline' ? 'decline' : 'approve';
  const props = PropertiesService.getScriptProperties();

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);            // never overlap the timer's own sending
  } catch (e) {
    return 'The sender is busy right now. Nothing was changed. Please try again in a minute.';
  }
  try {
    const reader = kitSubscriber_(req.s);
    const tags = kitSubscriberTagIds_(req.s);
    const already = tags[book.sentTagId] || props.getProperty(ledgerKey_(book, reader));

    if (action === 'decline') {
      if (already) return 'This reader was already sent ' + book.title + ', so it cannot be declined now.';
      kitTag_(book.declinedTagId, reader.id);
      if (tags[book.approvedTagId]) kitUntag_(book.approvedTagId, reader.id);
      Logger.log('DECLINED ' + reader.email_address + ' for ' + book.title);
      return 'Declined. Nothing was sent to the reader.';
    }

    if (already) return 'This reader was already sent ' + book.title + '. Nothing more to do.';
    kitTag_(book.approvedTagId, reader.id);
    if (tags[book.declinedTagId]) kitUntag_(book.declinedTagId, reader.id);

    if (!book.fileName) {
      Logger.log('APPROVED ' + reader.email_address + ' for ' + book.title + ' (no file yet)');
      return 'Approved. ' + book.title + ' has no file yet, so the reader will be sent it automatically once the file is added.';
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      return 'Approved. Gmail\'s daily sending limit has been reached, so the book will go out automatically tomorrow.';
    }
    let file;
    try {
      file = findFile_(book.fileName);
    } catch (e) {
      Logger.log('APPROVED ' + reader.email_address + ' for ' + book.title + ' but ' + e.message);
      return 'Approved, but the book file could not be found in Google Drive. It will be sent automatically once the file is back in the "' + FOLDER_NAME + '" folder.';
    }
    Logger.log(deliver_(book, reader, file, props));
    return 'Approved. ' + book.title + ' has been emailed to ' + reader.email_address + '.';
  } catch (e) {
    Logger.log('PROBLEM with a decision: ' + e.message);
    return 'Something went wrong talking to Kit. Please try again in a minute.';
  } finally {
    lock.releaseLock();
  }
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
  const options = {
    method: method,
    headers: { 'X-Kit-Api-Key': key, Accept: 'application/json' },
    muteHttpExceptions: true
  };
  if (method === 'post') {
    options.contentType = 'application/json';
    options.payload = '{}';
  }
  const res = UrlFetchApp.fetch(KIT_API + path, options);
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

/** One subscriber's record: id, first_name, email_address, fields. */
function kitSubscriber_(subscriberId) {
  const data = kitFetch_('get', '/subscribers/' + subscriberId);
  if (!data.subscriber || !data.subscriber.email_address) throw new Error('Kit has no such subscriber.');
  return data.subscriber;
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

function kitUntag_(tagId, subscriberId) {
  kitFetch_('delete', '/tags/' + tagId + '/subscribers/' + subscriberId);
}

/* ── One-time setup ─────────────────────────────────────────────────────── */

/**
 * Run this once from the Apps Script editor. It checks the key, the folder,
 * the files and the buttons, then starts the 10-minute timer. Safe to run
 * again.
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

  linkSecret_();
  report.push(webAppUrl_()
    ? 'Approve and Decline buttons: on.'
    : 'Approve and Decline buttons: PROBLEM, script property WEB_APP_URL is missing or is not a /exec web app address. New applications will still be announced, without buttons.');
  report.push('New applications are announced to: ' + NOTIFY_EMAIL);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendApprovedArcs') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendApprovedArcs').timeBased().everyMinutes(10).create();
  report.push('Timer is on: checking Kit every 10 minutes.');
  report.push('Emails left today on this Gmail account: ' + MailApp.getRemainingDailyQuota());

  const text = report.join('\n');
  Logger.log(text);
  return 'See the log.';
}

/** Turns the timer off. Nothing is sent until setup() is run again. */
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendApprovedArcs') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Timer is off.');
}
