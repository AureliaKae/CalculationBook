import { Component } from "react";

/* 全站唯一的错误边界：渲染层任何未捕获异常此前会卸掉整棵 React 树 =
   静默白屏。这里兜住，给一句人话与「重新打开」——稿面丢了但书与进度
   都在盘上，重载即回到续玩点。 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 主进程日志可见（devtools 关着也能在终端/日志里找线索）。
    console.error("[render] 界面崩了：", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app boundary">
        <main className="map-stage">
          <div className="map-empty">
            <p className="imp-head">这一页算破了</p>
            <p className="cf-detail">
              界面出了差错，稿面没能画完。书库、进度与设置都在本机盘上，
              一并无损——点下面重开即可回到上次进度处。
            </p>
            <div className="imp-acts">
              <button
                type="button"
                className="pen-submit"
                onClick={() => window.location.reload()}
              >
                重新打开
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }
}
