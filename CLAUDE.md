# Notebuilt Pro — living state doc

> **Update this file in the same commit as any change it describes.** A stale
> copy reads as confident and is wrong. If you touch storage, structure, the
> platform layer or the tests and don't update this file, the commit isn't
> finished.

This file is committed to the app's own public repo. It carries no
machine-specific paths and no credentials. Tier 1 rules and the every-app
checklist live in the private platform repo (`CLAUDE.md`, `EGS-STANDARDS.md`);
the build brief is `docs/specs/notebuilt-pro-phase1-spec.md` there. Read those
first. This file only says how this app works right now.

## What this app is

The boss side of crew task lists: a boss builds a day's tasks, sends each
worker a private list as a link by text, and reads the reports that come back.
No server, no accounts. The worker side lives in Notebuilt.

- Live: `https://pro.notebuilt.ca/` (see `CNAME`)
- Report links arrive at `https://pro.notebuilt.ca/#report=<payload>`

**Built so far: stage 3 of 4.** Shell, storage, standards, the boss's
identity, Crew, Jobs, Day and Send. There are no Board or Reports screens yet,
and Home says so. A `#report=` link is stripped from the address and answered
with a sheet saying this build can't read reports; nothing is decoded.

## Storage

Names are permanent (Tier 1 rule 9). Never rename them.

| Where | Name | Holds | In a backup |
| --- | --- | --- | --- |
| localStorage | `notebuiltpro.settings` | `{schemaVersion, boss:{id, name}}` | yes |
| localStorage | `notebuiltpro.roster` | array of workers | yes |
| localStorage | `notebuiltpro.jobs` | array of jobs | yes |
| localStorage | `<key>__bak` | the previous value of that key | no |
| IndexedDB | `notebuiltpro`, store `lists`, keyPath `listId` | one record per job's day | yes, without `queue` |
| IndexedDB | `notebuiltpro`, store `reports`, keyPath `[listId, workerId]` | nothing yet | yes |
| localStorage | `notebuiltpro.theme`, `.beginner`, `.lastView`, `.installPromptDismissed`, `.backupNudgeSnoozeUntil`, `.lastBackupAt` | things about this phone | no |

### Records

```
worker { id, name, note,    archived, createdAt, updatedAt }
job    { id, name, address, archived, createdAt, updatedAt }
```

- `id` is minted once by `EGSCrew.newId()` when the record is made. An edit
  copies it across untouched. `createdAt` never moves either.
- Times are epoch seconds. `note` is at most 120 characters and `address` 160,
  each on one line. Both stay on this phone; a list link carries only a
  worker's id and name, and a job's id and name.
- **Nothing is deleted, only archived**, because a list already sent still
  names its worker and job by id. Archiving asks first; bringing back does
  not. Jobs can be archived as well as workers: the spec only mentions workers,
  and this build added it for jobs so a finished job can leave the list.
- Stored order is the order things were added. It is never shown:
  `renderRecords()` sorts by name, ties broken by id.
- `cleanRecord()` / `cleanRecords()` are the **one judge** of a record, used
  for what is loaded from this phone and for what a backup carries. Id and
  name go through the crew component. One bad record, or one id twice,
  refuses the whole array. Unknown keys are dropped.
- `saveStore()` refuses a roster or jobs write that would make the stored
  array shorter, unless it is a restore or a confirmed fresh start. A restore
  passes `replace:true` and is not blocked: the test restores a backup with no
  crew over a phone that has three.

### Schema

- `PRO_SCHEMA_VERSION = 3`, in `index.html`. Absent reads as 1.
  - 1: settings alone.
  - 2: adds the roster and the jobs.
  - 3: adds lists, in IndexedDB.
- `PRO_MIGRATIONS` is the ladder. Rungs 2 and 3 convert nothing, because the
  version before never wrote what they add and an absent store reads as
  empty. They exist so the number tells the builds apart: a stage 2 build
  that opens stage 3 data shows its newer-version gate instead of exporting a
  backup it believes has no lists in it. **The first rung that changes data
  is still unwritten and untested**: it must name the store it changed in
  `proSchemaDirty`, so the save that stamps the number writes that store
  first.
- `proApplySchema()` reads the number at load and again at every restore.
- **The stamp** is written in `saveSettings()` and nowhere else. `commit()`
  (the roster and jobs save) and `listPut()` (a list save) write their data
  and then call `saveSettings()` if the number on the phone is behind. All of
  them are only reached from a tap. Startup writes nothing to localStorage.
  On the first-run screen it does not touch IndexedDB either; once there is a
  name, the first render opens the database to read the lists, which creates
  it if it was not there.
- **Newer data.** A stored `schemaVersion` above 2 shows a gate that says so,
  and nothing is written. The data is left exactly as found.
- **Backup before write.** `saveStore()` copies the current value to
  `<key>__bak` before every write. `loadStore()` heals from that copy when the
  main one is missing or fails its check. If both fail, the key is marked
  unreadable and is not written over. For settings that is the damaged gate;
  for the roster or the jobs it is a card on that screen, with Restore or a
  confirmed "Start again with none". Export refuses while any store is
  unreadable, so a backup is never written with that store missing.
- **Empty over real.** `saveStore()` refuses to write settings with no ID over
  settings that have one, unless the caller is a restore.

### IndexedDB

`IDB_VERSION = 2`, laddered in `idbOpen()`'s `onupgradeneeded`.

- `lists`, keyed by `listId`: one record is the boss's full list for one
  job's day, with its sent map. Every worker's slice shares that `listId`.
- `reports`, keyed by `listId` and `workerId` together: one record per worker
  per list, so two workers' reports never share a record.
- Version 1 keyed `reports` by `listId` alone and never wrote to it. The
  upgrade counts the old store first. Empty, it is dropped and remade. If it
  holds anything, the upgrade aborts, nothing is touched, and export fails
  loudly.
- `reports` has no record shape yet. Stage 4 defines it.

### Lists

One record is one job's day for the whole crew:

```
{ listId, createdAt, updatedAt, boss:{id,name}, job:{id,name}, day,
  workers:[{id,name}],                       kept in id order
  tasks:[{id, worker, text, order, editedAt, gone}],
  sent:{ <workerId>:{at, ids:[taskId]} },
  queue:{ <workerId>:{sendId, at, parts:[{link, ids:[taskId], done}]} } }
```

- `workers`, `tasks` and `sent` are the crew component's own shapes. The
  component makes the slices, measures, splits, refuses, and keeps `sent`
  (`sliceFor`, `split`, `recordSend`, `changesNotSent`). The app never
  re-implements any of it.
- **One list per job per day.** It is made, with its `listId`, by the first
  task added. Opening a day writes nothing.
- **A task is never removed.** Cancelling sets `gone:'cancelled'` and keeps
  it; Bring back clears it. Reassigning changes `worker`, and the component
  turns that into a `reassigned` tombstone in the slice of the worker it
  left, using `sent`. The boss's own copy never holds `'reassigned'`.
- Task ids are the component's short list-scoped counters (`nextTaskId`).
  `order` is one sequence across the list; the screen groups by worker, so
  only the order within a worker's tasks is ever seen. A reassigned task
  joins the end of its new owner's tasks.
- **Edit times.** `editStamp()` gives every edit a time later than the
  task's last edit and later than every send on the list, so an edit made in
  the same second as a send is never missed. That can put an edit a second
  or two ahead of the clock, so a send is timed at the newest edit or now,
  whichever is later.
- **Names.** A list keeps the names it was last written with, and
  `listLive()` swaps in the names on the phone now before anything is drawn
  or sent. A rename in Crew, Jobs or Settings reaches the next send. A rename
  alone does not mark anyone "changes not sent".
- `cleanList()` / `cleanLists()` are the **one judge** of a list, for what is
  loaded and for what a backup carries. Everything the component defines goes
  through `EGSCrew.validate()`; `sent` and `queue` are checked by hand
  against the list's own workers and task ids. One bad list, one `listId`
  twice, or two lists for one job's day refuses the lot.
- `listPut()` refuses a write that would drop a task or forget something in
  `sent`. Every list change goes through `listEdit()`, one at a time.
- Lists are read into memory once there is a name (`listsLoad()`).
  `listsState` is `ready`, `failed` (the database would not open: nothing is
  shown or changed) or `damaged` (a stored list failed the check: they are
  left untouched, Days shows a card with Restore or a confirmed "Start again
  with no lists", and export refuses).
- **No `__bak` copy.** A list write is one IndexedDB put of a record that has
  already passed `cleanList()` and the grow-only guard. Unlike the
  localStorage keys, the previous value is not kept.

### Sending

- **Measured before the share sheet opens.** Opening Send calls `prepFor()`:
  for each worker with something to send, `sliceFor()` then `split()`. The
  result is held in memory (`_prep`) and nothing is stored. `rev` is bumped by
  anything a measurement depends on (tasks, names), and a measurement made
  under an older `rev` is thrown away.
- **The three refusals (spec rule 12)** come from `split()` and are drawn on
  that worker's card, with nothing to tap that would send: `task_too_long`
  (names the task; "Shorten this task" opens it), `names_too_long` (names
  the name; "Shorten this name" opens its sheet) and `cannot_fit` (said
  plainly; unreachable with today's limits and kept as a guard). Other
  workers are not blocked.
- **`queue`** is a send that has started. The tap on Send starts the write
  and asks for the share sheet in the same breath, without waiting for the
  write: a browser only opens the sheet straight from a tap, and the write
  has to be under way before the phone can close the app behind the sheet.
  So the links of one send keep one `sendId` across a restart. A part is
  ticked when the share sheet resolves; backing out ticks nothing; with no
  share sheet the text is copied and the tick is left to the boss. A tick can
  be taken back. The queue button shows how many people are sent.
- **Sent only when every part is ticked.** Each tick adds what that part
  carried to `sent[worker].ids` at once (so a tombstone can follow it even
  if the send is never finished) and leaves `at` alone. When the last part
  is ticked, `at` becomes the time the links were measured and the queue
  entry goes.
- Any change to a worker's tasks drops that worker's queue: its links no
  longer say what the list says. The next send is a new send with a new
  `sendId`, and the worker's phone follows the newest.
- The text shared is one line (`<boss>: tasks for <job>, <day>`, with the
  part number when there is more than one) and the link on the next line.
- Measured in the test run: ten ordinary tasks (about 45 characters each)
  with short names come to about 670 characters, one part. An eleventh would
  split. Eight 200-character Cyrillic tasks go as eight parts.

### Backup file

`notebuilt-pro-backup-<YYYY-MM-DD>.json`, `BACKUP_VERSION = 1`:

```
{ app:"notebuilt-pro", kind:"backup", version:1, exportedAt, appVersion,
  settings, roster:[...], jobs:[...], crew:{ lists:[...], reports:[] } }
```

`readBackup()` treats the file as untrusted: 5 MB cap, strict shape, the boss
checked by the crew component, the roster and jobs through `cleanRecords()`,
the lists through `cleanLists()`, the whole file refused on any bad field. A
file with no `crew` section leaves the phone's lists and reports alone.

A backup carries every list with its `sent` map and **without `queue`**: the
links of a half-finished send belong to the phone that started it. Export
drops the queue and restore ignores one a file carries. After a restore, a
worker who was mid-send shows what they were given and "changes not sent".

**This build still refuses any backup whose reports are not empty.** Reports
have no shape yet. Stage 4 must replace that refusal with a real check before
it stores or draws a restored report.

A restore replaces lists, roster, jobs and settings together: lists first,
then crew and jobs, and the stamped settings last. If a write fails, the ones
already made are put back, the lists included. Lists on the phone count as
something to replace even when they have not been read (no name yet) or could
not be (damaged): the restore counts them in storage before it asks. It asks first whenever there is anything on the phone to replace, and
the question says what the file holds.

## Boss identity and the name check

- The boss's ID is minted once, on the tap that saves the first name. Renaming
  keeps it. A restore replaces it with the file's.
- `nameCheck(name, role, excludeId, given)` runs while typing, for the boss's
  name (first run and Settings), a worker's and a job's. It validates through
  `EGSCrew.validate()` and measures through `EGSCrew.measure()`.
- **What "leaves no room" means here.** One name alone can never fill a link,
  so the check weighs all three: boss, job and worker. The name being typed
  takes its own slot. The other two take the real names on this phone: the
  boss's name, and the heaviest job or worker name still in use (by UTF-8
  bytes). Where there is none yet, a stand-in is used: the typed name
  reversed or shuffled, so the bytes match and the compressor finds no
  repeats. It warns `tight` when a 200-character task will not fit beside the
  three names, and `none` when a one-letter task will not. Both are warnings;
  the name still saves. This rule is a choice made in this app, not something
  the spec defines.
- Two names that are character-for-character identical compress into less
  room, and the check measures that truthfully. A test that wants a warning
  needs two different long names.

## Backup nudge

Needs real data (a worker or a job; a name is not real data), and then one of:

- the backup is 21 or more days overdue. With a backup on record, 21 days
  since it. With none, the clock starts when the oldest worker or job was
  added.
- `navigator.storage.persist()` came back false, so the browser may clear the
  app's storage. This fires however new the data is, and the banner says why.

"Later" snoozes it 7 days. The install banner has the slot first. `persist()`
is asked once there is a name, and again after each worker or job is added.

## Structure

- One file, `index.html`, about 3,290 lines. No build step, no framework.
- Script blocks, in order: version stamp, theme pre-paint, the crew component,
  the app, service-worker registration.
- `gate()` decides whether a gate owns the screen: `future`, `damaged`,
  `setup`, or none. A gate is not a view and has no history.
- Views: `home`, `crew`, `jobs`, `day`, `settings`, `support`, `privacy`,
  switched by `view`. Crew and Jobs are one renderer and one sheet
  (`renderRecords`, `openRecord`, `saveRecord`, `setArchived`), driven by the
  `KINDS` and `UI` tables.
- Two more views are about one job's day and carry it in the route:
  `day/<jobId>/<YYYY-MM-DD>` builds the list (`renderList`) and
  `send/<jobId>/<YYYY-MM-DD>` sends it (`renderSend`). `navValid()` accepts
  such a route only for a job on this phone and a day the component accepts;
  anything else is Home. `day` alone is the picker (`renderDays`).
- On the Day screen, adding a task redraws only `#day-body`, never the field,
  so the keyboard stays up between tasks.
- `render()` rebuilds `#app` from template strings. It has no storage side
  effects.
- Every piece of user content passes through `esc()`: the boss's name, each
  worker's and job's name, note and address, and every task's text.
- Events are delegated: one listener each for click, input, keydown and
  change. No inline handlers. `[data-go]`, `[data-back]`, `[data-share-app]`,
  `[data-pay-tab]`, `[data-copy]` and `[data-help]` are attribute hooks;
  everything else is `data-action`.
- **Unsaved typing asks before it is lost.** An editable field in a sheet
  carries `data-orig`, the value it opened with; `sheetDirty()` is true when
  any differs after trimming. Every way out of a dirty sheet goes through
  `discardOk()`: the scrim, the phone's back, a help marker, Archive and
  Bring back. Only a successful save closes without asking
  (`closeSheet(true)`). A refused back re-pushes the sheet's history entry,
  the one place an entry is re-pushed, because the phone's back can only be
  undone, not refused. A link tapped into the app mid-edit is stripped from
  the address and the sheet is left as it was. In the task sheet, picking a
  different person counts as typing. The Day screen's own field is not in a
  sheet, so `leaveOk()` covers it the same way: leaving with a task typed and
  not added asks first, and a "no" steps back onto the entry just left. The
  first-run name field is not covered.
- **Back.** `popstate` is the only back path; the header arrow calls
  `history.back()`. The stack is guard, Home, deeper views, then the open
  sheet. A sheet owns an entry while it is open. Every history change queues
  behind an in-flight `history.go()`. The hash and the remembered view are
  untrusted: a view is one of the constant set or it is Home.
- **Shared, byte-identical blocks. Do not edit them here.**
  - The crew component, between the `EGS-SHARED:crew-task` markers. The
    source is the platform's `crew_task.js`.
  - The EGS support core block (`EGS CORE — SUPPORT SECTION · v2`), copied
    from Notebuilt. Its one "Our privacy promise & how we make money" line is
    not first person; changing it is a fleet decision, not this app's.
  - `PRO_MARK`, between the `PRO-MARK` markers, written by
    `node make_icons.js --mark` from the icon geometry.

## Standards markers

The file carries nine of the ten core `EGS-STD:` markers, plus `support`.

- **`apps-directory` is deliberately absent.** The More EGS apps list is in
  Settings, seeded by hand from the standards file. The row says the list is
  synced at deploy, and no sync exists, so the marker would claim a row this
  app does not meet. `test_pro.js` fails if the marker comes back.
- `gate` is absent because there is no price yet.

## Platform layer

- `sw_logic.js` is a byte copy of the platform file.
- `service-worker.js` is the platform file with `APP_NAME = 'notebuilt-pro'`
  and a stamped `CACHE_VERSION`. No other difference.
- Registration differs from the platform snippet in two ways: the page does
  not reload when a first install takes control (it would drop a half-typed
  name), and it polls for an update every 20 minutes and on return to the
  foreground.
- The deploy script stamps `window.EGS_VERSION` in `index.html` and
  `CACHE_VERSION` in `service-worker.js`.
- Icons are in `icons/`, built by `make_icons.js`. The manifest uses 192, 512
  and maskable 512; the page links the 180.

## Tests

`node test_pro.js` — 468 checks, all passing. It serves this folder on
`127.0.0.1:8708` and drives real headless Chrome over CDP on real time.
`--shots <dir>` also writes screenshots; `--bail` stops at the first failure.

It exercises behaviour in the browser, not source patterns, apart from the
first block of static checks (copies, markers, storage names, manifest).
Covered: cold open with empty storage, the name check in all three roles,
first run, restart, the schema stamp and a phone coming up from schema 1,
Crew and Jobs (add, edit, sort, archive, bring back, refusals, escaping),
unsaved typing on every way out of a sheet,
Day (add, refusals, reorder, reword, reassign, cancel, bring back, restart),
Send (one part for a realistic list, a worst-case split with every link
decoded, ticks, a restart mid-queue, backing out of the share sheet, no share
sheet at all, who is marked after each kind of edit, a resend merged on the
worker's side through the component), each of the three refusals,
damaged and newer stored data, export and restore round trip with crew, jobs
and lists, 33 hostile backup files and 27 hostile lists, damaged lists, back
and the hash, share, the install banner and each nudge trigger, the IndexedDB
layout and its upgrade, 320px in both themes on every screen and sheet,
beginner mode reflow on fourteen screens at four widths, and the service
worker including a reload with the server gone.

The third refusal cannot be reached with today's limits, so its test makes
the component say it and checks what the app then shows.

Not covered:
- A real phone, for this stage. Stages 1 and 2 were checked on a device.
- **The real share sheet, and a real text message.** The test replaces
  `navigator.share`. Whether a link arrives whole and tappable is a phone
  test.
- The worker's side. Notebuilt cannot open a `#crew=` link yet, so a list
  sent from this build has nowhere to land until that is built. The merge is
  tested through the component, not through Notebuilt.
- The install prompt itself (`beforeinstallprompt` does not fire headless) and
  the iOS wording of that banner.
- An update arriving while the app is open (the refresh banner and the
  automatic reload).
- `navigator.storage.persist()`'s real answer. The nudge tests force it each
  way.
- A rung in `PRO_MIGRATIONS` that changes data.
- Storage that refuses writes (quota, private mode), including the restore
  rollback path.
- Contrast, beyond the version stamp. The colour tokens are Notebuilt's and
  were measured there.
- Typed text surviving a reload. An update that reloads the page, or the
  phone killing the app, still drops text typed into a sheet and not saved.

## Gotchas

- `test_pro.js` uses port 8708. A service worker left on a shared port serves
  the wrong app, so don't reuse it. (`NBPRO_TEST_PORT` overrides it, for
  mutation runs side by side.)
- The test resets the tab's history before every cold open. Chrome keeps 50
  entries and, when full, drops entries made without a tap first, which under
  a script is every entry the app seeds. Without the reset a `back` late in
  the run falls out of the app.
- The test starts Chrome with component updates off. A fresh profile fetches
  them in the background and they land in the download folder the test
  watches.
- **A task that has left a worker still marks them when it is edited.** The
  component's `changesNotSent()` counts any task a worker was ever given.
  Reword a task after giving it from Joe to Maria and Joe shows "changes not
  sent" again, although his copy only needs the tombstone he already has.
  The rule is the component's; it is not worked around here.
- A cold open restores the last screen from `notebuiltpro.lastView`. Tests
  that need Home load `#/home`.
- The beginner-mode test ignores `.rule`: that hairline exists to give up the
  marker's width so nothing else moves. Markers are hosted only in a
  `.sec-head` or as a sheet's `.help-corner`.
- A 22-character string of the right alphabet is not always a valid ID: the
  last character can only be `A`, `Q`, `g` or `w`. The component decides.
- `PAYMENT_CONFIG` has only the Interac address. The other tabs say they are
  not set up, rather than linking nowhere.
- Editing: nobody's data is at stake until the pilot, so direct edits are
  fine. From the first real crew list, use fix-scripts.
