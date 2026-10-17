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
- **A permanent ID is 64 bits, 11 characters, and that length is permanent.**
  The crew component accepts no other. See "Schema 4" below for the one time
  IDs were changed, before any real list existed.
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

- `PRO_SCHEMA_VERSION = 4`, in `index.html`. Absent reads as 1.
  - 1: settings alone.
  - 2: adds the roster and the jobs.
  - 3: adds lists, in IndexedDB.
  - 4: permanent IDs are 64 bits. Versions 1 to 3 held 128-bit ones.
- `PRO_MIGRATIONS` is the ladder. Rungs 2 and 3 convert nothing, because the
  version before never wrote what they add and an absent store reads as
  empty. They exist so the number tells the builds apart: a stage 2 build
  that opens stage 3 data shows its newer-version gate instead of exporting a
  backup it believes has no lists in it.
- **Schema 4 is the first rung that changes data, and its function is
  empty on purpose.** A store is judged as it is read, before any rung runs,
  and the judge accepts one ID length. So the conversion happens at the read:
  - `shortId()` turns a 128-bit ID into its own first 64 bits. The short ID
    follows from the long one, so localStorage, IndexedDB and a backup file
    are converted separately, in any order, and agree. Nothing has to be
    remembered between them, and it is safe to run twice.
  - `loadStore()` takes a `lift`. Each copy of settings is lifted by its own
    `schemaVersion`, which is written in the same `setItem` as the boss's
    ID, so the two cannot disagree.
  - **The roster and the jobs are always lifted, whatever the number says.**
    They carry no number, and the stamp is a separate write in another key,
    so it can get ahead of them: the stage 3 build, still open in another
    tab, saves the crew without touching settings. Keying their conversion
    to the stamp turned such a crew from convertible into unreadable (the
    Aug 15 Notebuilt finding again; caught before commit, Oct 14).
  - A store whose copy on the phone still holds a long ID is named in
    `proSchemaDirty` at load. The next save writes it, straight after the
    number (`flushMigrated()`); one that will not go down stays named and
    is tried again by the save after. `write.roster()` / `write.jobs()`
    take a store off that list when they write it, so it is written once
    and its `__bak` is the long-ID original.
  - **The number goes down first, then the data.** The stage 3 build reads
    the crew and jobs with no gate but the number, and a 64-bit ID fails
    its check: it quietly falls back to the `__bak` copy, and its next save
    writes that stale crew over the real one (seen in the test, before the
    fix). So short IDs under a number below 4 must never be on the phone.
    `commit()` stamps first and writes nothing if the stamp will not go
    down; `saveSettings()` is `stamp()` then `flushMigrated()`. The one
    exception is restore, whose writes and rollback run in one go with
    nothing awaited between them. This reverses the order used through
    stage 3; the platform rule is in `EGS-DECISIONS.md` ("A schema number
    governs only the data written in the same call").
  - **Where a number says 4 about the ID beside it, a long ID gets no help.**
    Settings stamped 4 with a long boss ID are damaged; a backup file that
    says schema 4 and holds a long ID is refused. A file is one write, so
    its number cannot have got ahead of its contents.
  - A route or a remembered last view spelled with a long job ID is not a
    route, and lands on Home.
- `proApplySchema()` reads the number at load and again at every restore.
- **The stamp** is written in `stamp()` and nowhere else. `commit()` (the
  roster and jobs save) stamps before its data when the number is behind;
  `listPut()` (a list save, in IndexedDB, which no older build can open)
  writes its list and then calls `saveSettings()` if the number is behind or
  a store is still waiting to be written short (`stampDue()`). All of
  them are only reached from a tap. Startup writes nothing to localStorage.
  On the first-run screen it does not touch IndexedDB either; once there is a
  name, the first render opens the database to read the lists, which creates
  it if it was not there.
- **Newer data.** A stored `schemaVersion` above 4 shows a gate that says so,
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

`IDB_VERSION = 3`, laddered in `idbOpen()`'s `onupgradeneeded`.

- `lists`, keyed by `listId`: one record is the boss's full list for one
  job's day, with its sent map. Every worker's slice shares that `listId`.
- `reports`, keyed by `listId` and `workerId` together: one record per worker
  per list, so two workers' reports never share a record.
- Version 1 keyed `reports` by `listId` alone and never wrote to it. The
  upgrade counts the old store first. Empty, it is dropped and remade. If it
  holds anything, the upgrade aborts, nothing is touched, and export fails
  loudly.
- Version 3 goes with schema 4. Every list holding a 128-bit ID is put back
  under its short `listId`, with short IDs inside (`liftList()`), in the one
  upgrade transaction. Its `queue` is dropped: those links were format
  version 2 and nothing opens them now. `sent` is kept. If two lists would
  land on one short `listId`, the add fails, the upgrade aborts, and the
  database stays at version 2 untouched. A list with no long ID is not
  rewritten.
- The database is only opened once there is a name, so localStorage and
  IndexedDB are converted at different moments. That is safe because both
  reach the same short IDs.
- `reports` has no record shape yet. Stage 4 defines it. The version 3 step
  does not touch `reports`: it is empty in every build so far.

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
- **Inside the tap, or not at all.** `sendPart()` calls `navigator.share`
  (or, with no share sheet, `navigator.clipboard.writeText`) before its first
  await, through `shareStart()` / `clipWrite()`, which turn a throw into a
  rejection. Only a share that resolves ticks. A share that is closed, refused
  or throws, and a copy that fails, tick nothing; the row says why
  (`sendNote`, in memory, dropped by a tick or a `rev` change). A refused
  share or a failed copy shows the text with a Copy button, since the tap is
  spent by then. Test gates: share and copy are called synchronously in the
  handler, a real tap still holds activation at the call, and a rejected
  share (`NotAllowedError`, or a throw) leaves the worker unticked.
- **Copy link is a first-class control**, on every part row beside Send,
  always shown. It is `sendPart(wid, n, true)`: the same send, written down
  the same way, copied (the line and the link) inside the tap instead of
  shared, and never ticked. The pilot cannot depend on `navigator.share`: on
  the boss's Android phone, in Chrome and in the installed app, it resolved
  with no picker shown (Oct 17).
- **TEMPORARY: the share sheet test**, a closed `<details>` at the foot of
  Send (`probeHtml`, `shareProbe`, `PROBES`). Three buttons share a bare short
  URL, the full link as a bare URL, and the full text as Send does, and print
  the length, `canShare` and how the promise settled, with its time. It writes
  and ticks nothing. Remove it, and its tests, once the cause is known.
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
- Measured with 128-bit IDs: ten ordinary tasks (about 45 characters each)
  with short names came to about 670 characters, one part, and an eleventh
  would split. With 64-bit IDs the same list is about 620, and an eleventh
  fits. Eight 200-character Cyrillic tasks go as eight parts.

### Backup file

`notebuilt-pro-backup-<YYYY-MM-DD>.json`, `BACKUP_VERSION = 1`:

```
{ app:"notebuilt-pro", kind:"backup", version:1, exportedAt, appVersion,
  settings, roster:[...], jobs:[...], crew:{ lists:[...], reports:[] } }
```

A file whose settings say schema 3 or less holds 128-bit IDs. `readBackup()`
shortens them the same way the phone's own were, then checks everything as
usual. A file that says schema 4 is checked as it stands. `BACKUP_VERSION`
did not move: the file's shape is the same, and the schema number in its
settings already says which IDs it holds.

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

- One file, `index.html`, about 3,480 lines. No build step, no framework.
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

`node test_pro.js` — 533 checks, all passing. It serves this folder on
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
beginner mode reflow on fourteen screens at four widths, the service
worker including a reload with the server gone, and a phone holding 128-bit
IDs (schema 3, database version 2) coming through to schema 4: opening
without a write, the crew, jobs and list intact under short IDs, the first
save in either order, a send that decodes, an old backup restored,
a migration interrupted partway (storage refuses the jobs write) and one
the stamp got ahead of (a stage 3 tab saved the crew after it), each
opening with nothing refused and finished by the next save, long IDs refused
where a number written with them says 4, two lists that would collide, and
the real stage 3 build (served from git at `/stage3/` on the same origin)
opened on every state this build can leave: it stops at its newer-version
screen, or finds its own shape untouched, and writes nothing.

The third refusal cannot be reached with today's limits, so its test makes
the component say it and checks what the app then shows.

Not covered:
- A real phone, for this stage. Stages 1 and 2 were checked on a device.
- **A stage 3 tab that was already open when this build stamped 4.** It
  read the crew at its own load and never reads it again, so it holds the
  old crew in memory, and its next crew save writes that over whatever this
  build saved since. This build reads what it wrote (long IDs are
  converted), but an edit made here in between is lost. Two open tabs of
  the same build have always worked this way: whoever saves last wins. It
  is not new with schema 4 and is not handled. Close other copies of the
  app before updating.
- **The real share sheet, and a real text message.** The test replaces
  `navigator.share`. On a live Android phone (Oct 17) Send showed no sheet
  and still ticked, in Chrome and in the installed app: share resolved
  without a picker. Why is not yet known (thread `th_nbp_share_gesture`). Whether a link arrives whole and tappable is a phone
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
- A restore that fails halfway on a phone still waiting to write its short
  IDs. The rollback puts `proSchemaDirty` back; nothing tests it.
- Storage that refuses writes (quota, private mode), including the restore
  rollback path. The one exception is the interrupted schema 4 migration.
- Contrast, beyond the version stamp. The colour tokens are Notebuilt's and
  were measured there.
- Typed text surviving a reload. An update that reloads the page, or the
  phone killing the app, still drops text typed into a sheet and not saved.

## Gotchas

- The old-tab checks serve `index.html` from `STAGE3_REV` (`3568279`, the
  stage 3 build as it went live) by `git show`, so they need this folder's
  git history; without it they print SKIP. They can go once no stage 3
  build is left running anywhere.
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
- An 11-character string of the right alphabet is not always a valid ID: the
  last character carries four bits, so it is one of sixteen
  (`AEIMQUYcgkosw048`). The component decides.
- **Shorter IDs moved the name warnings.** A 40-character Cyrillic name used
  to warn `tight` and now does not. Names alone no longer fill a link, so
  `none` needs three 40-character names in 4-byte characters and is right at
  the line (the test's fixed fixture measures just over).
- `shortId()`, the `lift*` functions and the `LONG_ID_RE` they share are the
  only code that knows the old length. They can go when no stage 3 phone or
  backup is left to convert. Nothing else may use them.
- `PAYMENT_CONFIG` has only the Interac address. The other tabs say they are
  not set up, rather than linking nowhere.
- Editing: nobody's data is at stake until the pilot, so direct edits are
  fine. From the first real crew list, use fix-scripts.
