// python_pool.ts
interface PendingTask {
    payload: any;
    resolve: (value: any) => void;
}

export class PythonWorkerPool {
    private poolSize: number;
    private apiKey: string;
    private taskQueue: PendingTask[] = [];
    private idleWorkers: Worker[] = [];
    private dataUrl: string;

    constructor(poolSize: number, apiKey: string) {
        this.poolSize = poolSize;
        this.apiKey = apiKey;

        // 💡 动态读取同目录下的计算核心文件源码，并转化为内联 Data URL
        const pythonRunnerSource = Deno.readTextFileSync("./python_runner.ts");
        this.dataUrl = "data:application/javascript," + encodeURIComponent(pythonRunnerSource);
    }

    /**
     * 初始化常驻线程池，等待所有隔离 Wasm 虚拟机在后台全部编译预热完毕
     */
    public async init(): Promise<void> {
        console.log(`[Python 线程池] 正在初始化具有 ${this.poolSize} 个隔离实例的常驻内存池...`);
        for (let i = 0; i < this.poolSize; i++) {
            const worker = this.createResidentWorker();
            await this.waitForWorkerReady(worker);
            this.idleWorkers.push(worker);
        }
        console.log(`[Python 线程池] 全量预热完毕，物理内存已锁定。`);
    }

    /**
     * 外部核心分发入口：有闲置线程则立刻执行；否则自动进入不占内存的 FIFO 等待队列
     */
    public dispatch(payload: any): Promise<any> {
        return new Promise((resolve) => {
            if (this.idleWorkers.length > 0) {
                const worker = this.idleWorkers.pop()!;
                this.executeTaskOnWorker(worker, payload, resolve);
            } else {
                // 🛡️ 并发安全防御伞：高并发请求在此排队，Deno 物理内存绝不暴涨！
                this.taskQueue.push({ payload, resolve });
            }
        });
    }

    private createResidentWorker(): Worker {
        // 权限大闸：锁死写文件、网络连接、系统进程派生与环境变量
        const worker = new Worker(this.dataUrl, {
            type: "module",
            deno: {
                permissions: {
                    read: ["/app/.deno_cache", "/app"],
                    write: false,
                    net: false,
                    env: false,
                    run: false
                }
            }
        });
        worker.postMessage({ type: "INIT" });
        return worker;
    }

    private waitForWorkerReady(worker: Worker): Promise<void> {
        return new Promise((resolve, reject) => {
            const handler = (msg: MessageEvent) => {
                if (msg.data.type === "READY") {
                    worker.removeEventListener("message", handler);
                    resolve();
                } else if (msg.data.type === "INIT_FAILED") {
                    worker.removeEventListener("message", handler);
                    reject(new Error(msg.data.error));
                }
            };
            worker.addEventListener("message", handler);
        });
    }

    private executeTaskOnWorker(worker: Worker, payload: any, resolve: (val: any) => void) {
        const timeout = payload.timeoutMs || 4000;

        // 1. 超时看门狗：物理强杀死循环代码节点
        const timer = setTimeout(() => {
            worker.terminate(); // 强杀卡死的 Worker 线程
            resolve({ success: false, data: null, error: "Python Execution Timeout (Max Limit Exceeded)", stdout: "" });

            console.warn("[池化自愈] 发现死循环节点，已物理抹杀。正在动态克隆新实例进行补位...");
            this.reseedWorkerPool();
        }, timeout);

        // 2. 正常执行完毕的结果收割回调
        const messageHandler = (e: MessageEvent) => {
            if (e.data.type === "RESULT") {
                clearTimeout(timer);
                worker.removeEventListener("message", messageHandler);

                resolve(e.data); // 吐给外层 Java 应用结果

                this.idleWorkers.push(worker); // 释放线程回归常驻内存池
                this.processNextQueueTask();    // 自动消化队列中的下一笔排队低代码请求
            }
        };

        worker.addEventListener("message", messageHandler);
        worker.postMessage({ type: "EXECUTE", payload });
    }

    private processNextQueueTask() {
        if (this.taskQueue.length > 0 && this.idleWorkers.length > 0) {
            const { payload, resolve } = this.taskQueue.shift()!;
            const worker = this.idleWorkers.pop()!;
            this.executeTaskOnWorker(worker, payload, resolve);
        }
    }

    private async reseedWorkerPool() {
        try {
            const newWorker = this.createResidentWorker();
            await this.waitForWorkerReady(newWorker);
            this.idleWorkers.push(newWorker);
            this.processNextQueueTask(); // 激活触发排队任务
        } catch (err: any) {
            console.error("[池化自愈失败] 无法克隆补位沙箱实例: ", err.message);
        }
    }
}