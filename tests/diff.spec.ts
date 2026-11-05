import { describe, expect, it } from 'vitest'
import { parsePlanDiff, PLAN_DIFF_LIMITS } from '../src/core/diff.ts'

/** A git-style diff with two files, a rename and a hunk whose removed line itself starts with `---`. */
const DIFF = [
  'diff --git a/Source/SkillRotateAPI.cpp b/Source/SkillRotateAPI.cpp',
  'index 1111111..2222222 100644',
  '--- a/Source/SkillRotateAPI.cpp',
  '+++ b/Source/SkillRotateAPI.cpp',
  '@@ -326,6 +326,7 @@ void USkillRotateAPI::RotateToTarget(AActor* Actor, const FVector& Target)',
  ' \t// Rotating the actor directly rolls the facing back on the server.',
  '-\tActor->SetActorRotation(Delta.Rotation());',
  '+\t// Route through the Mover like the joystick path already does.',
  '+\tUSunMoverAPI::SetRotation(Actor, Delta.Rotation());',
  ' \tTransformFragment->SetTransform(NewTransform);',
  ' \t// unchanged',
  ' \t// unchanged',
  ' \t// unchanged',
  '@@ -400,2 +402,3 @@ void USkillRotateAPI::RotateToCamera(AActor* Actor)',
  '-\t// --- old header text in a removed line',
  '+\t// +++ new header text in an added line',
  '+\tActor->SetActorRotation(Delta.Rotation());',
  ' return;',
  'diff --git a/Source/OldName.h b/Source/NewName.h',
  'similarity index 90%',
  'rename from Source/OldName.h',
  'rename to Source/NewName.h',
  '--- a/Source/OldName.h',
  '+++ b/Source/NewName.h',
  '@@ -10,2 +10,2 @@',
  ' class USunMoveMode',
  '-{',
  '+{ // moved',
].join('\n')

describe('parsePlanDiff', () => {
  it('keeps each file, hunk and line as a unified diff writes it, with the totals a card summarizes', () => {
    const parsed = parsePlanDiff(DIFF, '//sun/mainline@12345')
    expect('problem' in parsed).toBe(false)
    if ('problem' in parsed) return
    expect(parsed.diff.base).toBe('//sun/mainline@12345')
    expect(parsed.diff.files).toHaveLength(2)
    expect(parsed.diff.files.map(file => [file.path, file.status])).toEqual([
      ['Source/SkillRotateAPI.cpp', 'modified'], ['Source/NewName.h', 'renamed']])
    expect(parsed.diff.files[1]).toMatchObject({ oldPath: 'Source/OldName.h' })
    const first = parsed.diff.files[0]!
    expect(first.hunks).toHaveLength(2)
    expect(first.hunks[0]).toMatchObject({ oldStart: 326, oldLines: 6, newStart: 326, newLines: 7,
      section: 'void USkillRotateAPI::RotateToTarget(AActor* Actor, const FVector& Target)' })
    // A removed line that starts with `---` is content, not a file header.
    expect(first.hunks[1]!.lines.map(line => [line.kind, line.text])).toEqual([
      ['del', '\t// --- old header text in a removed line'],
      ['add', '\t// +++ new header text in an added line'],
      ['add', '\tActor->SetActorRotation(Delta.Rotation());'],
      ['same', 'return;'],
    ])
    expect([first.added, first.removed]).toEqual([4, 2])
    expect([parsed.diff.added, parsed.diff.removed]).toEqual([5, 3])
  })
  it('reads an added file, a deleted file and a binary change without inventing hunks', () => {
    const parsed = parsePlanDiff([
      'diff --git a/new.cpp b/new.cpp',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.cpp',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/gone.cpp b/gone.cpp',
      'deleted file mode 100644',
      '--- a/gone.cpp',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-gone',
      'diff --git a/icon.uasset b/icon.uasset',
      'Binary files a/icon.uasset and b/icon.uasset differ',
    ].join('\n'))
    if ('problem' in parsed) throw new Error(parsed.problem)
    expect(parsed.diff.files.map(file => [file.path, file.status, file.added, file.removed, file.binary ?? false])).toEqual([
      ['new.cpp', 'added', 2, 0, false], ['gone.cpp', 'deleted', 0, 1, false], ['icon.uasset', 'modified', 0, 0, true]])
  })
  it('reads a plain diff -u with timestamps after the paths, and skips a no-newline marker', () => {
    const parsed = parsePlanDiff([
      '--- a/notes.md\t2026-11-05 10:00:00.000000000 +0800',
      '+++ b/notes.md\t2026-11-05 10:01:00.000000000 +0800',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
    ].join('\n'))
    if ('problem' in parsed) throw new Error(parsed.problem)
    expect(parsed.diff.files).toHaveLength(1)
    expect(parsed.diff.files[0]!.path).toBe('notes.md')
    expect(parsed.diff.files[0]!.hunks[0]!.lines.map(line => [line.kind, line.text])).toEqual([['del', 'old'], ['add', 'new']])
  })
  it('unquotes a git path with a space and non-ASCII escapes', () => {
    const octal = String.raw`\346\226\207\344\273\266`
    const parsed = parsePlanDiff([
      `diff --git "a/Content/${octal} One.h" "b/Content/${octal} One.h"`,
      `--- "a/Content/${octal} One.h"`,
      `+++ "b/Content/${octal} One.h"`,
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n'))
    if ('problem' in parsed) throw new Error(parsed.problem)
    expect(parsed.diff.files[0]!.path).toBe('Content/文件 One.h')
  })
  it('refuses what a person must not see as a half-rendered diff', () => {
    expect(parsePlanDiff('  ')).toEqual({ problem: 'the diff is empty' })
    expect(parsePlanDiff('no changes here')).toEqual({ problem: 'it has no ---/+++ file headers' })
    expect(parsePlanDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n one')).toEqual({ problem: 'the diff ends in the middle of a hunk' })
    expect(parsePlanDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n-b\n-c')).toEqual({ problem: 'hunk at line 6 has more lines than its header counts' })
    expect(parsePlanDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\nXnot a hunk line')).toEqual({ problem: 'line 4 is not a hunk line: "Xnot a hunk line"' })
    expect(parsePlanDiff(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b`, 'x'.repeat(PLAN_DIFF_LIMITS.base + 1))).toEqual({
      problem: `the base label is longer than ${PLAN_DIFF_LIMITS.base} characters` })
  })
  it('refuses a diff past the size this panel can carry instead of truncating it', () => {
    const huge = `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${'a'.repeat(PLAN_DIFF_LIMITS.chars)}\n+b`
    expect(parsePlanDiff(huge)).toMatchObject({ problem: expect.stringContaining('characters; the limit is') })
  })
})
