// 交互请求优先:玩家等待的请求(回合生成、开场、草稿)在跑时,
// 烧制等后台流量让路。烧制与普通回合共用快模型槽位,不拦会让烧制
// 并发占满限流配额,回合要么极慢要么 429 超时失败。
// 门是模块级全局:烧制客户端与故事客户端是不同实例,必须共享这一份。

let interactiveCount = 0;
const waiters = new Set();

export function enterInteractive() {
  interactiveCount += 1;
}

export function exitInteractive() {
  interactiveCount = Math.max(0, interactiveCount - 1);
  if (interactiveCount === 0) {
    for (const waiter of waiters) waiter();
    waiters.clear();
  }
}

export function interactiveActive() {
  return interactiveCount > 0;
}

// 后台流量开工前调用:交互请求在途时挂起,直到全部结束或信号中止。
// 信号中止也放行(调用方随后会因同一信号失败),避免取消烧制后还挂在这里。
export function waitForInteractiveIdle({ signal } = {}) {
  if (interactiveCount === 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    // 唤醒与中止走同一个释放函数:resolve 幂等(第二次调用是空操作),
    // 双重注销(Set delete/removeEventListener)同样幂等,无需分支。
    const release = () => {
      waiters.delete(release);
      signal?.removeEventListener("abort", release);
      resolve();
    };
    waiters.add(release);
    signal?.addEventListener("abort", release, { once: true });
  });
}
