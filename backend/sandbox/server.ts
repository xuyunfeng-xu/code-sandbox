// server.ts
import { PythonWorkerPool } from "./python_pool.ts";

const API_KEY = Deno.env.get("SANDBOX_API_KEY") || "InternalSecretToken123456";
const POOL_SIZE = 1;
const LOG_FILE = "./app.log";

const pythonPool = new PythonWorkerPool(POOL_SIZE, API_KEY);
await pythonPool.init();

const logFileHandle = await Deno.open(LOG_FILE, { write: true, create: true, append: true });
const textEncoder = new TextEncoder();

function logRequest(data: Record<string, unknown>) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n";
    console.log(line.trimEnd());
    logFileHandle.write(textEncoder.encode(line));
}

Deno.serve({ port: 8126, hostname: "0.0.0.0" }, async (req: Request) => {
    const startTime = Date.now();
    let language = "unknown";
    let codeBytes = 0;
    let requestId = "";

    try {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/execute") {
            return new Response(JSON.stringify({ success: false, stderr: "Not Found" }), { status: 404 });
        }

        const authHeader = req.headers.get("Authorization");
        if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
            logRequest({ requestId, method: req.method, language, status: 401, success: false, duration_ms: Date.now() - startTime, error: "Unauthorized", code_bytes: 0 });
            return new Response(JSON.stringify({ success: false, stderr: "Unauthorized" }), { status: 401 });
        }

        const payload = await req.json().catch(() => null);
        if (!payload) {
            logRequest({ requestId, method: req.method, language, status: 400, success: false, duration_ms: Date.now() - startTime, error: "Empty payload", code_bytes: 0 });
            return new Response(JSON.stringify({ success: false, stderr: "Payload Body can not be empty" }), { status: 400 });
        }

        requestId = payload.requestId || "";
        language = payload.language || "unknown";
        codeBytes = typeof payload.code === "string" ? new TextEncoder().encode(payload.code).byteLength : 0;

        logRequest({ event: "request_received", requestId, method: req.method, path: url.pathname, language, code_bytes: codeBytes, payload });

        if (language !== "javascript" && language !== "python") {
            logRequest({ requestId, method: req.method, language, status: 400, success: false, duration_ms: Date.now() - startTime, error: "Invalid language", code_bytes: codeBytes });
            return new Response(JSON.stringify({ success: false, stderr: "Field `language` must be \"javascript\" or \"python\"" }), { status: 400 });
        }

        if (payload.language === "javascript") {
            const jsRes = await executeLightweightJs(payload.code, payload.inputs, payload.timeoutMs || 3000);
            logRequest({ requestId, method: req.method, language, status: 200, success: jsRes.success, duration_ms: Date.now() - startTime, error: jsRes.stderr || null, code_bytes: codeBytes });
            return new Response(JSON.stringify(jsRes));
        }

        const result = await pythonPool.dispatch(payload);
        logRequest({ requestId, method: req.method, language, status: 200, success: result.success, duration_ms: Date.now() - startTime, error: result.stderr || null, code_bytes: codeBytes });
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });

    } catch (e: any) {
        logRequest({ requestId, method: req.method, language, status: 500, success: false, duration_ms: Date.now() - startTime, error: e.message, code_bytes: codeBytes });
        return new Response(JSON.stringify({ success: false, stderr: "Sandbox Gateway Error: " + e.message }), { status: 500 });
    }
});

console.log("[Sandbox Gateway] listening on :8126");

function executeLightweightJs(code: string, inputs: any, timeout: number): Promise<any> {
    return new Promise((resolve) => {
        const inlineJs = `
            const inputs = ${JSON.stringify(inputs)};
            const code = ${JSON.stringify(code)};
            try {
                eval(code);
                if (typeof main !== "function") { throw new Error("Function main(inputs) is not defined"); }
                const result = main(inputs);
                postMessage({ success: true, outputs: result, stderr: null, stdout: "" });
            } catch(e) {
                postMessage({ success: false, outputs: null, stderr: e.message, stdout: "" });
            }
        `;
        const worker = new Worker("data:application/typescript," + encodeURIComponent(inlineJs), {
            type: "module", deno: { permissions: "none" }
        });
        const t = setTimeout(() => { worker.terminate(); resolve({ success: false, outputs: null, stderr: "JS Execution Timeout", stdout: "" }); }, timeout);
        worker.onmessage = (m) => { clearTimeout(t); worker.terminate(); resolve(m.data); };
        worker.onerror = (e) => { clearTimeout(t); worker.terminate(); resolve({ success: false, outputs: null, stderr: e.message || "JS Worker Error", stdout: "" }); };
    });
}