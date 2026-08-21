// 烧制限流闸（拍板 2026-08-21：同时烧三本）：全局计数信号量。
// 起稿的并发预算（resolveBakeConcurrency）原先是每 job 独享的——三本同烧
// 就是三倍请求量直打厂商限流。这里把预算解释为「全部在跑 job 共享的总量」：
// 闸门套在烧制客户端之外，引擎（NovelBaker）零改动。
//
// 预算可以运行中调整（每个 job 启动时按当时的设置更新），只增不减：收缩会让
// 已在飞的请求把新预算吃穿，等待者永远排不到；扩容立即放行排队者。
export class BakeLimiter {
  constructor(budget = 1) {
    this.active = 0;
    this.budget = Math.max(1, Math.floor(budget) || 1);
    this.waiters = [];
  }

  updateBudget(next) {
    const value = Math.max(1, Math.floor(next) || 1);
    if (value <= this.budget) return;
    this.budget = value;
    this.#admit();
  }

  #admit() {
    while (this.active < this.budget && this.waiters.length) {
      const waiter = this.waiters.shift();
      if (waiter.aborted) continue;
      this.active += 1;
      waiter.resolve();
    }
  }

  async acquire(signal) {
    // 已中止的信号直接拒绝，不占名额：占用后放行会在 fetch 侧再失败一次，
    // 还把预算白占了一瞬。
    if (signal?.aborted) throw signal.reason ?? new Error("烧制已取消");
    if (this.active < this.budget) {
      this.active += 1;
      return;
    }
    const waiter = { resolve: null, reject: null, aborted: false };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    this.waiters.push(waiter);
    const onAbort = () => {
      // 取消的等待者直接出列失败：不留占位（#admit 会跳过已出列的 abort 项）。
      waiter.aborted = true;
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      waiter.reject(signal.reason ?? new Error("烧制已取消"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      await promise;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.#admit();
  }

  // 测试与观测用。
  stats() {
    return { active: this.active, budget: this.budget, waiting: this.waiters.length };
  }
}
