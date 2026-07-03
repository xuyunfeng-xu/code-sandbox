//  正确写法
import * as pyodideModule from "npm:pyodide@0.26.0";

console.log("[构建预热] 正在初始化 Pyodide 离线依赖池...");
const pyodide = await pyodideModule.loadPyodide();

// 💡 扩展动作 A：加载官方预编译的 C 扩展重度科学计算库
console.log("[构建预热] 正在预编译并固化 numpy, pandas");
await pyodide.loadPackage(["numpy", "pandas"]);

// 💡 扩展动作 B：通过内置的 micropip 安装纯 Python 库（如加密库或数据验证库）
console.log("[构建预热] 正在安装纯 Python 第三方库...");
// await pyodide.loadPackage("micropip");
// const micropip = pyodide.pyimport("micropip");
// 1. 可以在线安装（构建时容器能联网），或者把本地的 .whl 包转进去
// await micropip.install("pydantic");
// 2. 可以在线安装（构建时容器能联网），或者把本地的 .whl 包转进去
// await micropip.install("file:///app/packages/pydantic-2.6.1-py3-none-any.whl");

console.log("[构建预热] 所有第三方扩展依赖包已完美固化至本地缓存！");
Deno.exit(0);