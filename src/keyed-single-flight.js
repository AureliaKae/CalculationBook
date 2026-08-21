// 同键任务一次只跑一个：并发调用同键时，后到的直接跳过（skipped: true）。
// 用于「同一本书的身份能力补写」这类两个在飞任务各自 load→LLM→updateWorld、
// 最后写者赢会把先完成的一轮静默覆盖丢失的场景——跳过方拿到的是旧值，
// 但写盘只有一份，不会再互相踩踏。
export class KeyedSingleFlight {
  #inFlight = new Set();

  async run(key, task) {
    if (this.#inFlight.has(key)) return { skipped: true };
    this.#inFlight.add(key);
    try {
      return { skipped: false, value: await task() };
    } finally {
      this.#inFlight.delete(key);
    }
  }
}
