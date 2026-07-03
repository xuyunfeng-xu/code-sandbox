// python_runner.ts
import * as pyodideModule from "npm:pyodide@0.26.0";

/**
 * 💡 核心设计：整个文件的代码其实是运行在独立的常驻 Web Worker 内部的！
 * 它长驻在子线程的事件循环中，通过监听 message 信号，持续不断地洗 Python 代码。
 */
self.onmessage = async (msg) => {
    // 1. 拦截初始化就绪信号
    if (msg.data.type === "INIT") {
        try {
            console.log(`[Python 计算子线程] 开始初始化底层 WebAssembly 虚拟机...`);
            // 原生拉起 Wasm CPython 编译器
            const pyodide = await pyodideModule.loadPyodide();

            // 离线预装和固化低代码常用的核心科学计算包（瞬间完成，直接命中 Deno 镜像层本地缓存）
            await pyodide.loadPackage(["numpy", "pandas"]);
            console.log(`[Python 计算子线程] CPython 虚拟机完全就绪，成功上锁。`);

            // 反向通知主线程：我已经全量预热完毕，可以开始接工作流的单子了
            postMessage({ type: "READY" });

            // 2. 核心执行状态监听循环
            self.onmessage = async (runMsg) => {
                if (runMsg.data.type === "EXECUTE") {
                    const { code, inputs } = runMsg.data.payload;
                    const stdoutLogs = [];

                    try {
                        // 精准映射变量至 Python 全局作用域
                        pyodide.globals.clear();
                        pyodide.globals.set("input", pyodide.toPy(inputs));
                        // 劫持打桩 Python 标准控制台输出
                        pyodide.setStdout({ batched: (str) => stdoutLogs.push(str) });
                        await pyodide.runPythonAsync(`
                        from typing import TypedDict, Any
                        import json
                        # (可选) 如果希望用户能用 .params 访问，提供一个包装类
                        class Args(dict):
                            """让 dict 支持点号访问，兼容 JS 用户的习惯"""
                            def __getattr__(self, key):
                                try:
                                    return self[key]
                                except KeyError:
                                    raise AttributeError(f"'Args' object has no attribute '{key}'")
                            def __setattr__(self, key, value):
                                self[key] = value
                        # 定义 Output 类型
                        class Output(TypedDict):
                            pass`);
                        pyodide.globals.set("__inputs_json__", JSON.stringify(inputs));
                        await pyodide.runPythonAsync(`args = Args(json.loads(__inputs_json__))`);

                        // 注入并编译用户原始代码（隔离由于多行字符串带来的缩进雷区）
                        const rawUserCode = code;
                        pyodide.runPython(rawUserCode);

                        // 工业级完美兼容：自动识别并收割带 main 或者是裸写表达式的多场景数据
                        let finalData = null;
                        if (rawUserCode.includes("async def main")) {
                            const pyResultString = await pyodide.runPythonAsync("json.dumps(await main(args))");
                            finalData = pyResultString ? JSON.parse(pyResultString) : null;
                        } else if (rawUserCode.includes("def main")) {
                            const pyResultString = await pyodide.runPythonAsync("json.dumps(main(args))");
                            finalData = pyResultString ? JSON.parse(pyResultString) : null;
                        } else {
                            const pyResultObj = pyodide.runPython(rawUserCode);
                            if (pyResultObj !== undefined) {
                                finalData = pyResultObj && typeof pyResultObj.toJS === "function" ? pyResultObj.toJS() : pyResultObj;
                            } else {
                                const globals = pyodide.globals;
                                if (globals.has("result")) {
                                    const resObj = globals.get("result");
                                    finalData = resObj && typeof resObj.toJS === "function" ? resObj.toJS() : resObj;
                                }
                            }
                        }

                        // 🛑 核心安全清理：彻底擦除当前的全局变量内存，防止上一次低代码请求的数据污染下一次
                        pyodide.globals.clear();

                        // 体面传回执行成功结果
                        postMessage({ type: "RESULT", success: true, outputs: finalData, stderr: null, stdout: stdoutLogs.join('\n') });
                    } catch(err) {
                        pyodide.globals.clear(); // 报错也必须强制擦除变量堆
                        postMessage({ type: "RESULT", success: false, outputs: null, stderr: err.message, stdout: stdoutLogs.join('\n') });
                    }
                }
            };

        } catch (initErr) {
            postMessage({ type: "INIT_FAILED", stderr: initErr.message });
        }
    }
};