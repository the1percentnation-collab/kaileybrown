# ARC Sender

Emails an approved ARC reader their book automatically. Kit's free plan has no
automations, so this small Google Apps Script does the one job: when Kailey adds
the tag **ARC Approved: \<Book\>** to a reader in Kit, the reader is emailed the
EPUB as an attachment from Kailey's Gmail, and tagged **ARC Sent: \<Book\>**.

It runs in Kailey's Google account, not on the website. Nothing in this folder
is deployed by Firebase.

## How approval works day to day

1. Open Kit, go to Subscribers, click the tag `ARC Applicant: <Book>`.
2. Tick the readers to approve, choose Bulk actions, Add tag, `ARC Approved: <Book>`.
3. Within about 15 minutes each one is emailed the book. They then show under
   `ARC Sent: <Book>`.

Removing the Approved tag before the email goes out cancels it. A reader is
never sent the same book twice.

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
6. The execution log should say the Kit key works, list three files as found,
   and say the timer is on.

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
- Tag IDs in `Code.gs` belong to Kailey's Kit account. If a tag is deleted and
  recreated in Kit, its ID changes and must be updated here.
