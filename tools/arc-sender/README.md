# ARC Sender

Tells Kailey about new ARC applications and emails approved readers their book.
Kit's free plan has no automations, so this Google Apps Script does both jobs.

It runs in Kailey's Google account, not on the website. Nothing in this folder
is deployed by Firebase.

## What it does

1. A reader applies on kaileybrown.com/arc and lands in Kit tagged
   `ARC Applicant: <Book>`.
2. Within about 15 minutes Kailey gets an email listing the new applications,
   each with an **Approve** and a **Decline** button.
3. A button opens a page showing the reader and the book, with one button to
   confirm. Opening the page changes nothing; only the confirm button acts.
   Mail apps and security scanners open links on their own, and this stops
   them from approving anyone.
4. **Approve** tags the reader `ARC Approved: <Book>`, emails them the EPUB
   from Kailey's Gmail straight away, and tags them `ARC Sent: <Book>`.
   **Decline** tags them `ARC Declined: <Book>`. The reader is told nothing.

A reader is never sent the same book twice. A declined reader can still be
approved later from the same email.

## Where it is installed

Set up on 2026-11-13 and tested end to end (a test reader was approved in Kit
and received the book by email).

- **Apps Script project:** "ARC Sender" in `kaileybrown.author@gmail.com`,
  script ID `1LeGSvQt8uMwb89ltIhp4KEAOtZWaWp89gv1O7xFb9cBkWpWdXMDbR01T`. It holds
  one file, `Code.gs`, identical to the copy here, and one trigger,
  `sendApprovedArcs`, every 10 minutes.
- **Kit key:** a V4 API key named "ARC sender", stored as the script property
  `KIT_API_KEY`.
- **Web app:** the same project deployed as a web app (Execute as: Me, Who has
  access: Anyone). Its `/exec` address is stored as the script property
  `WEB_APP_URL`; the buttons in the notification email point at it. Treat that
  address as private. The links are signed with a random key the script keeps
  in `ARC_LINK_SECRET`, so a link only works for the reader and book it was
  made for.
- **Drive folder:** "ARC Files" in Kailey's My Drive, holding the three EPUBs.
- **Kit form:** "ARC Application" (ID 10183976). Fields: email only. Confirmation
  email off, redirect after subscribe set to `https://kaileybrown.com/arc?applied=1`.
  Do not add required fields to this form: the website posts to it and only
  sends the fields listed in `public/js/arc.js`.

## How approval works day to day

**From the email (the normal way).** Open the "New ARC application" email, tap
Approve or Decline, then confirm on the page that opens.

**From Kit.** Open Subscribers, click the tag `ARC Applicant: <Book>`, and add
the tag `ARC Approved: <Book>` to the readers to approve. The timer sends those
within about 15 minutes. Removing the Approved tag before the email goes out
cancels it.

## One-time setup (about 10 minutes, on a computer)

Do all of this signed in to the Google account the emails should come from.

1. **Google Drive:** create a folder named exactly `ARC Files` and upload the
   three EPUBs with these exact names:
   - `12 Days of Awkward - Kailey Brown.epub`
   - `Somewhere Between Dreaming & You - Kailey Brown.epub`
   - `Landed On You - Kailey Brown.epub`
2. **Kit:** Settings, Developer, add a new **V4 API key** named `ARC sender`.
   Copy it.
3. **Apps Script:** go to https://script.google.com, New project, name it
   `ARC Sender`. Delete the sample code, paste in all of `Code.gs`, and save.
4. **Key:** Project Settings (gear icon), Script properties, Add script
   property. Property `KIT_API_KEY`, value the key from step 2. Save.
5. **Start it:** back in the Editor, pick `setup` in the function dropdown and
   click Run. Google asks for permission: choose the account, click Advanced,
   then "Go to ARC Sender (unsafe)", then Allow. That warning appears for every
   personal script; it is your own code running in your own account.
6. **Buttons:** click Deploy, New deployment, choose type **Web app**. Set
   Execute as **Me** and Who has access **Anyone**, then Deploy. Copy the web
   app URL (it ends in `/exec`) and save it as the script property
   `WEB_APP_URL`.
7. Run `setup` again. The execution log should say the Kit key works, list
   three files as found, say the buttons are on, and say the timer is on.

## Changing the script later

The timer always runs the newest saved code. The buttons run the **deployed**
version, so after editing `Code.gs` also do: Deploy, Manage deployments, edit
(pencil), Version: **New version**, Deploy. The web app URL stays the same.

## Testing

In the editor, run `preview` to see who would be emailed without sending
anything. For a live test, add `ARC Approved: 12 Days of Awkward` to a test
subscriber in Kit and wait up to 15 minutes.

## Adding a book

Upload its EPUB to the `ARC Files` folder, then in `Code.gs` set that book's
`fileName` (and its Amazon and Goodreads links once it is out). Readers approved
before the file existed are sent it on the next run.

## Turning it off

Run `stop` in the editor. Run `setup` to turn it back on.

## Notes

- Kit's tag lists lag two to three minutes behind a change. The script
  re-checks each reader's own record before sending, so it never acts on a
  stale list.
- Gmail allows roughly 100 recipients a day on a personal account. The script
  sends at most 40 per run and stops early if the daily allowance runs out.
  The notification emails to Kailey count against the same allowance, which is
  why new applications are grouped into one email per run.
- "Anyone" access on the web app is needed so the buttons work from any mail
  app without a Google sign-in. A visit without a valid signed link shows "This
  link is not valid" and nothing else.
- Tag IDs in `Code.gs` belong to Kailey's Kit account. If a tag is deleted and
  recreated in Kit, its ID changes and must be updated here.
