/**
 * One restore-on-exit register for falsifiers that mutate files in this tree.
 *
 * Restoring must survive (a) files dirtied during the run that the harness did not author, (b) a
 * restore that FAILS (it must be reported and set a nonzero exit code, never exit 0 over a stranded
 * file), and (c) a driver killed by a signal while a child holds the mutation.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const jobs = []
let armed = false

const arm = () => {
  if (armed) return
  armed = true
  process.on('exit', () => {
    const problems = []
    while (jobs.length > 0) {
      // Attempt, then pop unconditionally: at exit there is no later call to retry with, so a job
      // kept on a failure would only spin. It is reported instead — see below.
      try { jobs[jobs.length - 1]() } catch (e) { problems.push(e.message) }
      jobs.pop()
    }
    if (problems.length > 0) {
      console.error(`FATAL: restore failed — this tree is left MUTATED, repair it before anything else:\n  ${problems.join('\n  ')}`)
      // A clean exit over a stranded file is the silent-green failure this whole harness exists to
      // prevent. Assignment inside an 'exit' listener does change the code (verified).
      process.exitCode = 1
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130))
}

/**
 * A file THIS process is about to mutate: snapshot its bytes now, put them back on every exit path.
 * Returns a restore-now-and-disarm function for the `finally` of the normal path.
 */
export const restoreFileOnExit = (path) => {
  const original = readFileSync(path, 'utf8')
  const job = () => { if (readFileSync(path, 'utf8') !== original) writeFileSync(path, original) }
  jobs.push(job)
  arm()
  return () => {
    // Restore FIRST, drop the entry only once it succeeded — a snapshot
    // popped ahead of a failed write leaves nothing in memory that knows how to undo the file.
    job()
    jobs.splice(jobs.indexOf(job), 1)
  }
}

/**
 * Files a GRANDCHILD mutates under src/ and is killed before writing back. Byte snapshots are no use
 * here because we do not author the mutation; git is the only oracle. Only paths that were clean when
 * this started are touched, so uncommitted work that predates the run is never at risk.
 */
export const restoreStraySrcOnExit = () => {
  const modified = () => {
    try {
      return new Set(
        execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' })
          .split('\n')
          // slice(0,2) is the status code. An untracked entry (`??`) is never harness leftover — the
          // harness only rewrites files that already exist — and `git checkout --` cannot take one
          // anyway, so including it would turn a new file into a hard failure plus a doomed revert.
          .filter((l) => l.length > 3 && !l.slice(0, 2).includes('?'))
          .map((l) => l.slice(3).trim())
          .filter(Boolean),
      )
    } catch { return null }
  }
  const cleanAtStart = modified()
  if (!cleanAtStart) return // no git at all (a `git archive` snapshot) — nothing to restore against
  jobs.push(() => {
    const now = modified()
    if (!now) throw new Error('`git status` failed at exit — cannot tell whether a source file was left mutated')
    const stray = [...now].filter((f) => !cleanAtStart.has(f))
    if (stray.length === 0) return
    // We did not author these bytes, so a harness mutation and an edit someone made DURING the run
    // are indistinguishable at this level. Park the current content in git's object store and print
    // the recovery command before reverting: loud and recoverable beats silently erased.
    // ponytail: `git hash-object -w` writes an UNREFERENCED loose object, so `git gc --prune=now`
    // can drop it. Recover-it-now affordance, not durable storage.
    const saved = stray.map((f) => {
      try { return `${f} -> git cat-file -p ${execFileSync('git', ['hash-object', '-w', f], { encoding: 'utf8' }).trim()}` }
      catch { return `${f} -> NOT BACKED UP` }
    })
    console.error(`\nreverting ${stray.length} source file(s) dirtied during this run (a harness killed mid-mutation, most likely).\nPrevious content preserved:\n  ${saved.join('\n  ')}`)
    execFileSync('git', ['checkout', '--', ...stray])
  })
  arm()
}
