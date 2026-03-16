const { app } = require("electron");
const { resolve } = require("node:path");
const { Worker } = require("node:worker_threads");
const util = require("node:util");
const { exec } = require('child_process');
const { name } = require('./package.json');
const { mkdirSync } = require('node:fs');
const vm = require("node:vm");

const storagePath = resolve(qwqnt.framework.paths.data, name);
mkdirSync(storagePath, { recursive: true });
const historyPath = resolve(storagePath, 'history');

app.whenReady().then(() => {
    // 为 REPL 创建一个专用且持久的执行上下文
    const replContext = vm.createContext({
        ...global,
        qwqnt: global.qwqnt,
        process: process,
        console: console,
        require: require,
        module: module,
        __filename: __filename,
        __dirname: __dirname,
    });

    // 允许异步执行
    replContext.global = replContext;

    const worker = new Worker(resolve(__dirname, 'server.js'));

    worker.on('message', async msg => {
        const { id, type, content } = msg;

        if (type === 'eval') {
            const { isReal, code } = content;
            if (isReal) console.log(`[REPL Exec] ${code}`);

            try {
                // 使用 vm 运行代码，确保作用域持久
                const result = vm.runInContext(code, replContext);
                let inspected;
                if (isReal) {
                    inspected = util.inspect(result, { colors: true, depth: 2 });
                } else {
                    // Preview mode: compact, no colors, single line
                    inspected = util.inspect(result, {
                        colors: false, depth: 1,
                        breakLength: Infinity, compact: true
                    }).split('\n')[0];
                }
                worker.postMessage({ id, type, content: inspected, isError: false });
            } catch (e) {
                if (isReal) {
                    worker.postMessage({
                        id, type,
                        content: util.inspect(e, { colors: true }),
                        isError: true
                    });
                } else {
                    // Preview mode: suppress errors
                    worker.postMessage({ id, type, content: '', isError: false });
                }
            }
        } else if (type === 'complete') {
            try {
                // Find the word fragment at the cursor
                const match = content.match(/([a-zA-Z0-9_$.]*)$/);
                const fullPath = match ? match[0] : "";

                let obj = vm.runInContext('this', replContext);
                let prefix = "";
                let objPath = "";

                if (fullPath.endsWith('.')) {
                    objPath = fullPath.slice(0, -1);
                    prefix = "";
                } else if (fullPath.includes('.')) {
                    const parts = fullPath.split('.');
                    prefix = parts.pop();
                    objPath = parts.join('.');
                } else {
                    prefix = fullPath;
                    objPath = "";
                }

                if (objPath) {
                    try {
                        obj = vm.runInContext(objPath, replContext);
                    } catch {
                        obj = null;
                    }
                }

                if (obj !== null && obj !== undefined) {
                    let keys = [];
                    try {
                        // 深入原型链获取所有属性（包括 Object.prototype）
                        const allProps = new Set();
                        let currentObj = obj;
                        while (currentObj) {
                            Object.getOwnPropertyNames(currentObj).forEach(k => allProps.add(k));
                            try {
                                Object.getOwnPropertySymbols(currentObj).forEach(() => { }); // skip symbols
                            } catch { }
                            currentObj = Object.getPrototypeOf(currentObj);
                            // Don't break at Object.prototype — include its properties too
                        }
                        keys = Array.from(allProps).filter(k => k.startsWith(prefix));
                    } catch (e) { }

                    // Return the standard [completions, completed_string] format
                    worker.postMessage({ id, type, content: [keys, prefix] });
                } else {
                    worker.postMessage({ id, type, content: [[], prefix] });
                }
            } catch (e) {
                worker.postMessage({ id, type, content: [[], ""] });
            }
        }
    });

    const command = `node '${resolve(__dirname, 'client.js')}'`;
    exec(`start powershell -Command "$env:REPL_HISTORY='${historyPath}'; ${command}"`, () => void 0);
});
