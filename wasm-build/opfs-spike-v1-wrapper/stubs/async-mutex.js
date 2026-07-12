// Minimal faithful stub of `async-mutex`'s Mutex for the wrapper-validation harness.
// Serializes callbacks via a promise chain (the wrapper relies on this to avoid
// concurrent wa-sqlite calls). Implements the surface the wrapper uses:
// runExclusive(cb), acquire() -> release, and a mutable `.name`.
export class Mutex {
  #tail = Promise.resolve();
  name = "";

  runExclusive(cb) {
    const run = this.#tail.then(cb, cb);
    // Keep the chain alive regardless of cb success/failure, without swallowing.
    this.#tail = run.then(() => {}, () => {});
    return run;
  }

  acquire() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const prev = this.#tail;
    this.#tail = gate;
    // Resolve with a release fn once the previous holder is done.
    return prev.then(() => release);
  }
}
export default { Mutex };
