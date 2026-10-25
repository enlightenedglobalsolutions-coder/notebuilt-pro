#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Notebuilt Pro — the version stamp's tooltip and comment describe the date-only stamp
Run from the same folder as index.html:
    python3 fix_nbp_stamp_tooltip.py

Thread th_nbp_stamp_tooltip. Decided 2026-10-18 (docs/EGS-DECISIONS.md,
th_egs_deploy_stamp, egs-deploy.sh ffd9ccf): the stamp is the deploy's date
and time only, and each deploy tags its own commit with that same name.
Pro's live stamp, 2026.10.18-0950 (178f39a), predates that change, so its
tooltip ("Commit shown is the one before this build.") is still true of the
live build. Its next deploy switches to the date-only stamp and a tag, which
makes that tooltip wrong, so this fix ships IN that deploy, never after it.
Notebuilt shipped the same change as 2026.10.25-1103 (fix_nb_stamp_tooltip.py).

Changes versionStamp() only: its title becomes the same words as Notebuilt's,
and the comment above it says how the stamp and the tag work now.

Backs up first, exact-match anchors asserted ==1, EVERY inline script block
syntax-checked, atomic.

---------------------------------------------------------------------------
THIS IS THE TEMPLATE. Copy it; do not edit it in place.

All three guards — the never-clobber backup, the exactly-once anchor count
and the every-block syntax check — come from ONE import, platform/fixscript.py.
Until 2026-10-17 only the syntax check was imported; the backup and the
count were written out inline here, so a script based on an older script
instead of this template silently lost them. That happened on 2026-10-16
(seven scripts, one second, the pre-crew backup overwritten). Importing the
guards means a script cannot keep the syntax check and drop the backup.

The syntax check is the part that has historically been wrong, so it is
centralised rather than copy-pasted. The inherited version did:

    scripts = re.findall(r"<script>(.*?)</script>", working, re.S)
    node --check on scripts[0]

scripts[0] is the FIRST inline block, which in most EGS apps is the 39-char
`window.EGS_VERSION` stamp — so the check parsed a one-line string
assignment and could never fail. Proven 2026-08-15: a real unclosed brace
injected into Notebuilt's 283K app block, and the old check still reported
pass. "Check the largest block" is not the fix either — Stagger has blocks
of 218K AND 146K, and breaking the smaller one also slips through. A
browser parses every inline block; so does check_html().
---------------------------------------------------------------------------
"""
import shutil
import sys
from pathlib import Path

# The shared guards. One source of truth — if they cannot be imported, that is
# a hard stop, not a reason to continue without a backup or a syntax check.
sys.path.insert(0, "/Volumes/AI Storage/EGS/platform")
try:
    from fixscript import backup, apply_edits, EditError, check_html
except ImportError as e:
    print(f"❌ cannot import platform/fixscript.py ({e}) — refusing to edit unguarded.")
    sys.exit(1)

TARGET = Path("index.html")

# Refuse to write when the syntax check cannot actually run (no node).
# Mirrors egs-deploy.sh --allow-untracked: default is to refuse, and the
# override has to be typed on purpose.
ALLOW_UNVERIFIED = "--allow-unverified" in sys.argv


def fail(msg):
    print(f"❌ {msg}")
    sys.exit(1)


def main():
    if not TARGET.exists():
        fail(f"{TARGET} not found. Run this from the app's repo folder.")

    text = TARGET.read_text(encoding="utf-8")
    edits = []

    # ---- the edits ------------------------------------------------------
    # Exact strings, never regex. Each anchor must match EXACTLY once; the
    # count assertion in apply_edits is what makes a stale anchor an abort
    # instead of a silent no-op or a double edit. It raises before anything
    # is written.
    old = """function versionStamp(){
  /* The parenthetical SHA names the commit before this build, not this one:
     a commit cannot embed its own final hash. See egs-deploy.sh. */
  return '<div class="ver-stamp" title="Commit shown is the one before this build.">'+esc(window.EGS_VERSION||'dev build')+'</div>';
}
"""
    new = """function versionStamp(){
  /* The stamp is the deploy's date and time and nothing else, and egs-deploy.sh
     tags the commit it ships with that same name, so `git show <stamp>` is
     exactly the code running here. Until 2026-10-18 the stamp also carried a
     commit hash in brackets, which named the commit BEFORE the build, since a
     commit can't hold its own hash; the tag replaced it. Decided 2026-10-18,
     docs/EGS-DECISIONS.md (th_egs_deploy_stamp). */
  return '<div class="ver-stamp" title="The version you\\'re running. I keep the exact code for every version, filed under this name.">'+esc(window.EGS_VERSION||'dev build')+'</div>';
}
"""
    edits.append((old, new, "versionStamp(): tooltip and comment"))

    try:
        working = apply_edits(text, edits)
    except EditError as e:
        fail(str(e))

    # ---- guards ---------------------------------------------------------
    # Assert what this edit is FOR, and assert that what it must not disturb
    # is still byte-true. A guard that cannot fail is worth nothing — the
    # whole reason this template exists is a check that could never fail.
    # Mutation-test each one: break the thing on purpose, confirm it aborts.
    #
    TITLE = "title=\"The version you\\'re running. I keep the exact code for every version, filed under this name.\""
    if working.count(TITLE) != 1:
        fail("the new tooltip did not land exactly once.")
    for gone in ("cannot embed its own final hash", "Commit shown is the one before"):
        if gone in working:
            fail(f"the old wording is still there: {gone!r}")
    if working.count("function versionStamp(){") != 1 or working.count("versionStamp()") != text.count("versionStamp()"):
        fail("versionStamp() or its callers moved.")
    # nothing outside versionStamp() changed
    a, b = text.index("function versionStamp(){"), working.index("function versionStamp(){")
    if text[:a] != working[:b] or text[text.index("\n}\n", a):] != working[working.index("\n}\n", b):]:
        fail("something outside versionStamp() changed.")

    # ---- backup, then write --------------------------------------------
    # Tier 1: backup before any write, timestamped, automatic. int(time.time())
    # is second-granularity, and two fix-scripts chained back-to-back really do
    # land in the same second — observed 2026-08-15, where the second run's
    # backup silently overwrote the first. A backup that overwrites a backup is
    # not a backup, so never clobber: take the next free name instead. It
    # happened again 2026-10-16, to scripts that had copied an older script
    # rather than this template — which is why backup() is imported, not
    # written out here.
    backup_path = backup(TARGET)
    print(f"\U0001f5c4  Backup saved to {backup_path}")

    TARGET.write_text(working, encoding="utf-8")
    print(f"✏️  Applied {len(edits)} edit(s) to {TARGET}")

    # ---- syntax check: EVERY inline block, or restore -------------------
    ok, report = check_html(working)
    print(report)
    if not ok:
        if "node not found" in report and ALLOW_UNVERIFIED:
            print("⚠️  --allow-unverified given — the edit stands WITHOUT a syntax check.")
        else:
            shutil.copy2(backup_path, TARGET)
            fail("restored from backup — nothing was changed.")

    print("\n✅ the version tooltip says what the stamp is now: the version, its code kept under that name")


if __name__ == "__main__":
    main()
