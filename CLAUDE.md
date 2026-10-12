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

**Built so far: stage 2 of 4.** Shell, storage, standards, the boss's
identity, Crew and Jobs. There are no Day, Send, Board or Reports screens yet,
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
| IndexedDB | `notebuiltpro`, store `lists`, keyPath `listId` | nothing yet | yes |
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
  array shorter, unless it is a restore or a confirmed fresh start.

### Schema

- `PRO_SCHEMA_VERSION = 2`, in `index.html`. Absent reads as 1.
  - 1: settings alone.
  - 2: adds the roster and the jobs.
- `PRO_MIGRATIONS` is the ladder. Rung 2 converts nothing, because version 1
  never wrote those two keys and an absent store reads as empty. It exists so
  the number tells the builds apart. **The first rung that changes data is
  still unwritten and untested**: it must name the store it changed in
  `proSchemaDirty`, so the save that stamps the number writes that store
  first.
- `proApplySchema()` reads the number at load and again at every restore.
- **The stamp** is written in `saveSettings()` and nowhere else. `commit()`,
  the roster and jobs save, writes its data and then calls `saveSettings()`
  if the number on the phone is behind. Both are only reached from a tap.
  Startup reads and writes nothing: no localStorage key, no IndexedDB
  database. The database is opened on the first export or restore.
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
- Neither store has a record shape yet. Stages 3 and 4 define them.

### Backup file

`notebuilt-pro-backup-<YYYY-MM-DD>.json`, `BACKUP_VERSION = 1`:

```
{ app:"notebuilt-pro", kind:"backup", version:1, exportedAt, appVersion,
  settings, roster:[...], jobs:[...], crew:{ lists:[], reports:[] } }
```

`readBackup()` treats the file as untrusted: 5 MB cap, strict shape, the boss
checked by the crew component, the roster and jobs through `cleanRecords()`,
the whole file refused on any bad field. A file with no `crew` section leaves
the phone's lists and reports alone.

**This build still refuses any backup whose lists or reports are not empty.**
Those records have no shape yet. Stages 3 and 4 must replace that refusal with
a real check before they store or draw a restored record.

A restore replaces settings, roster and jobs together, crew and jobs first and
the stamped settings last. If a write fails, the ones already made are put
back. It asks first whenever there is anything on the phone to replace, and
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

- One file, `index.html`, about 2,470 lines. No build step, no framework.
- Script blocks, in order: version stamp, theme pre-paint, the crew component,
  the app, service-worker registration.
- `gate()` decides whether a gate owns the screen: `future`, `damaged`,
  `setup`, or none. A gate is not a view and has no history.
- Views: `home`, `crew`, `jobs`, `settings`, `support`, `privacy`, switched by
  `view`. Crew and Jobs are one renderer and one sheet (`renderRecords`,
  `openRecord`, `saveRecord`, `setArchived`), driven by the `KINDS` and `UI`
  tables.
- `render()` rebuilds `#app` from template strings. It has no storage side
  effects.
- Every piece of user content passes through `esc()`: the boss's name, and
  each worker's and job's name, note and address.
- Events are delegated: one listener each for click, input, keydown and
  change. No inline handlers. `[data-go]`, `[data-back]`, `[data-share-app]`,
  `[data-pay-tab]`, `[data-copy]` and `[data-help]` are attribute hooks;
  everything else is `data-action`.
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

`node test_pro.js` — 262 checks, all passing. It serves this folder on
`127.0.0.1:8708` and drives real headless Chrome over CDP on real time.
`--shots <dir>` also writes screenshots; `--bail` stops at the first failure.

It exercises behaviour in the browser, not source patterns, apart from the
first block of static checks (copies, markers, storage names, manifest).
Covered: cold open with empty storage, the name check in all three roles,
first run, restart, the schema stamp and a phone coming up from schema 1,
Crew and Jobs (add, edit, sort, archive, bring back, refusals, escaping),
damaged and newer stored data, export and restore round trip with crew and
jobs, 33 hostile backup files, back and the hash, share, the install banner
and each nudge trigger, the IndexedDB layout and its upgrade, 320px in both
themes on every screen and sheet, beginner mode reflow on ten screens at four
widths, and the service worker including a reload with the server gone.

Not covered:
- A real phone, for this stage. Stage 1 was checked on a device on Oct 12.
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
- Typed text surviving a back press. A worker or job is saved by the Save
  button; backing out of the sheet discards what was typed and not saved.

## Gotchas

- `test_pro.js` uses port 8708. A service worker left on a shared port serves
  the wrong app, so don't reuse it.
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
