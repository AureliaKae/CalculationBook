// 未定义引用安全网:抓「引用了未定义标识符」这类要到运行时才炸的
// ReferenceError。本仓两次线上事故(createEngine/targetState 残留引用)都藏在
// 测试覆盖不到的接线路径里,node --check 只验语法不解析标识符。
// 这里只开运行时安全相关的最小规则集,风格类规则一概不开——接入 npm test
// 之后,未定义引用永远过不了测试。
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

// 会抓真事故的规则:未定义引用、重复声明、常量重赋值、重复键/参数、死代码、
// TDZ 式先用后定义。不含任何风格偏好。
const SAFETY_RULES = {
  "no-undef": "error",
  "no-redeclare": "error",
  "no-const-assign": "error",
  "no-dupe-args": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  // 先用后定义:只抓类声明的真 TDZ(运行时崩溃);变量级引用在
  // 闭包/回调里是常态(done 引用下一行定义的 timer 等),开着只会误报。
  "no-use-before-define": ["error", { functions: false, classes: true, variables: false }],
};

export default [
  {
    ignores: ["dist/**", "release/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.js", "test/**/*.js", "scripts/**/*.js", "fixtures/**/*.js", "electron/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: SAFETY_RULES,
  },
  {
    files: ["renderer/src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      ...SAFETY_RULES,
      // hooks 纪律（拍板 2026-08-21 三轮加固）：只对渲染层开——引擎侧
      // 刻意保持最小安全规则集不受影响。存量违例同轮修净，此后回归自动拦。
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
