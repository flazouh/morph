export interface AwakePorts {
  /** Sleep, however this context sleeps. */
  readonly wait: (milliseconds: number) => Promise<void>
  /** Anything that counts as extension activity. What it answers is thrown away. */
  readonly ping: () => Promise<unknown>
}

/**
 * The longest a worker may go without asking Chrome anything. Chrome stops a service
 * worker that has been idle for thirty seconds, and only extension API calls count as
 * activity: a timer does not, and neither does `fetch`. Twenty seconds leaves room for a
 * slow ping to land before the worker is taken away.
 */
export const AWAKE_STEP_MS = 20_000

/**
 * A wait the worker lives through. Waiting on a reader is normal in a publish, above all
 * at sign-in, where the device code is polled for as long as the reader takes to
 * authorize. A plain timer through that wait is how a publish died mid-way: Chrome stopped
 * the worker, and the promise the panel was waiting on went with it. So a long wait is
 * taken in short steps with a ping after each, which is what keeps the worker at its post.
 */
export const waitAwake = async (ports: AwakePorts, milliseconds: number): Promise<void> => {
  let left = milliseconds
  while (left > 0) {
    const step = Math.min(AWAKE_STEP_MS, left)
    await ports.wait(step)
    left -= step
    await ports.ping().catch(() => undefined)
  }
}
