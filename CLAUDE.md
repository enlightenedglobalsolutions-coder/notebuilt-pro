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

**Built so far: stage 1 of 4.** Shell, storage, standards and the boss's
identity. There are no Crew, Jobs, Day, Send, Board or Reports screens yet.
Home says so. A `#report=` link is stripped from the address and answered with
a sheet saying this build can't read reports; nothing is decoded.

## Storage

Names are permanent (Tier 1 rule 9). Never rename them.

| Where | Name | Holds | In a backup |
| --- | --- | --- | --- |
| localStorage | `notebuiltpro.settings` | `{schemaVersion, boss:{id, name}}` | yes |
| localStorage | `notebuiltpro.roster` | reserved for stage 2; never written yet | yes |
| localStorage | `notebuiltpro.jobs` | reserved for stage 2; never written yet | yes |
| localStorage | `<key>__bak` | the previous value of that key | no |
| IndexedDB | `notebuiltpro`, stores `lists` and `reports` (both keyPath `listId`) | nothing yet | yes |
| localStorage | `notebuiltpro.theme`, `.beginner`, `.lastView`, `.installPromptDismissed`, `.backupNudgeSnoozeUntil`, `.lastBackupAt` | things about this phone | no |

- **Schema.** `PRO_SCHEMA_VERSION = 1`, in `index.html`. Absent reads as 1.
  `proApplySchema()` reads the number at load and again at every restore.
  `PRO_MIGRATIONS` is the ladder and is empty: version 1 is the first shape.
  A future change to anything written to localStorage adds a rung there, and a
  rung that changes a store names it in `proSchemaDirty` so the same save that
  stamps the number writes that store first.
- **The stamp** is written in `saveSettings()` and nowhere else, and that
  function is only reached from a tap. Startup reads and writes nothing: no
  localStorage key, no IndexedDB database. The database is opened on the first
  export or restore.
- **Newer data.** A stored `schemaVersion` above 1 shows a gate that says so,
  and `saveSettings()` refuses to write. The data is left exactly as found.
- **Backup before write.** `saveStore()` copies the current value to
  `<key>__bak` before every write. `loadStore()` heals from that copy when the
  main one is missing or fails its check. If both fail, the key is marked
  unreadable and is not written over; the damaged gate offers Restore or a
  confirmed Start fresh.
- **Empty over real.** `saveStore()` refuses to write settings with no ID over
  settings that have one, unless the caller is a restore.
- **IndexedDB store layout** is versioned by `IDB_VERSION` (1) in
  `idbOpen()`'s `onupgradeneeded`. The keyPaths were chosen before the screens
  that use them exist. Changing them before the pilot means a version bump
  there; after the pilot it means a migration.
- **The harness key** `notebuiltpro.selfcheck.marker`, left by the self-check
  page this app replaced, is never read and is removed by the first ordinary
  settings save.

### Backup file

`notebuilt-pro-backup-<YYYY-MM-DD>.json`, `BACKUP_VERSION = 1`:

```
{ app:"notebuilt-pro", kind:"backup", version:1, exportedAt, appVersion,
  settings, roster:[], jobs:[], crew:{ lists:[], reports:[] } }
```

`readBackup()` treats the file as untrusted: 5 MB cap, strict shape, the ID
and name judged by the crew component, the whole file refused on any bad
field. Unknown keys are dropped. A file with no `crew` section leaves the
phone's crew data alone.

**Stage 1 refuses any backup whose roster, jobs, lists or reports are not
empty.** Those records have no shape yet, so there is nothing to check them
against. The stage that adds each one must replace that refusal with a real
check before it stores or draws a restored record.

Restoring over an existing name and ID asks first. Restoring onto an empty
phone does not, because nothing is replaced.

## Boss identity

- The ID is minted once, by `EGSCrew.newId()`, on the tap that saves the first
  name. Renaming keeps it. A restore replaces it with the file's.
- `nameCheck(name, others)` runs while typing, on first run and in the
  Settings sheet. It validates through `EGSCrew.validate()` and measures
  through `EGSCrew.measure()`; nothing about limits or ids is re-implemented.
- **What "leaves no room" means here.** One name alone can never fill a link,
  so the check counts all three names. Until the job and worker names are
  known, it stands in for them with the typed name reversed and shuffled:
  same script, same bytes, no repeats for the compressor to find. It warns
  `tight` when a 200-character task will not fit beside the three names, and
  `none` when a one-letter task will not. Both are warnings; the name still
  saves. A caller that knows the real job and worker names passes them as
  `others`. The stand-in rule is a choice made in this build, not something
  the spec defines.
- Measured in real Chrome: a 40-character Chinese name warns `tight`. A
  40-character Cyrillic name sits within a few characters of the line, so no
  test depends on it. `none` is only reached with three unrelated names in
  dense scripts, which needs `others`.

## Structure

- One file, `index.html`, about 2,190 lines. No build step, no framework.
- Script blocks, in order: version stamp, theme pre-paint, the crew component,
  the app, service-worker registration.
- `gate()` decides whether a gate owns the screen: `future`, `damaged`,
  `setup`, or none. A gate is not a view and has no history.
- Views: `home`, `settings`, `support`, `privacy`, switched by `view`.
  `render()` rebuilds `#app` from template strings. It has no storage side
  effects.
- Every piece of user content passes through `esc()`. The only one today is
  the boss's name.
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

`node test_pro.js` — 162 checks, all passing. It serves this folder on
`127.0.0.1:8708` and drives real headless Chrome over CDP on real time.
`--shots <dir>` also writes screenshots.

It exercises behaviour in the browser, not source patterns, apart from the
first block of static checks (copies, markers, storage names, manifest).
Covered: cold open with empty storage, the name check, first run, restart,
the schema stamp, rename, damaged and newer stored data, export and restore
round trip, thirteen hostile backup files, back and the hash, share, banners,
320px in both themes, beginner mode reflow at four widths, and the service
worker including a reload with the server gone.

Not covered:
- A real phone. Nothing here has been checked on a device.
- The install prompt itself (`beforeinstallprompt` does not fire headless) and
  the iOS wording of that banner.
- An update arriving while the app is open (the refresh banner and the
  automatic reload).
- `navigator.storage.persist()` being granted.
- A rung in `PRO_MIGRATIONS`, since there is none yet. The first rung needs
  its own test, including the store-before-stamp order.
- Storage that refuses writes (quota, private mode).
- Contrast, beyond the version stamp. The colour tokens are Notebuilt's and
  were measured there.

## Gotchas

- `test_pro.js` uses port 8708. A service worker left on a shared port serves
  the wrong app, so don't reuse it.
- A cold open restores the last screen from `notebuiltpro.lastView`. Tests
  that need Home load `#/home`.
- The beginner-mode test ignores `.rule`: that hairline exists to give up the
  marker's width so nothing else moves. Markers are hosted only in a
  `.sec-head` or as a sheet's `.help-corner`.
- `PAYMENT_CONFIG` has only the Interac address. The other tabs say they are
  not set up, rather than linking nowhere.
- Editing: nobody's data is at stake until the pilot, so direct edits are
  fine. From the first real crew list, use fix-scripts.
