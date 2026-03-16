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
replContext.global = replContext;

let worker;
app.whenReady().then(() => {
    worker = new Worker(resolve(__dirname, 'server.js'))
    worker.on('message', msg => {
        if (msg.type === 'eval') onEval(msg);
        else if (msg.type === 'complete') onComplete(msg);
    });

    const command = `node '${resolve(__dirname, 'client.js')}'`;
    exec(`start powershell -Command "$env:REPL_HISTORY='${historyPath}'; ${command}"`, () => void 0);
});

function onEval({ id, type, content }) {
    const { isReal, code } = content;
    if (isReal) console.log(`[REPL EXEC] ${code}`);
    let postContent = '';
    let postError = false;

    try {
        const result = vm.runInContext(code, replContext);
        let inspected = util.inspect(result, isReal
            ? { colors: true, depth: 2 }
            : { colors: false, depth: 1, breakLength: Infinity, compact: true });
        if (!isReal) inspected = inspected.split('\n')[0];
        postContent = inspected;
    } catch (e) {
        if (isReal) {
            postContent = util.inspect(e, { colors: true });
            postError = true;
        }
    }

    worker.postMessage({ id, type, content: postContent, isError: postError });
}

function onComplete({ id, type, content }) {
    try {
        // Find the word fragment at the cursor
        const fullPath = (content.match(/([a-zA-Z0-9_$.]*)$/) || [""])[0];

        let obj = vm.runInContext('this', replContext);

        const lastDot = fullPath.lastIndexOf('.');
        const prefix = lastDot !== -1 ? fullPath.slice(lastDot + 1) : fullPath;
        const objPath = lastDot !== -1 ? fullPath.slice(0, lastDot) : "";

        if (objPath) {
            try {
                obj = vm.runInContext(objPath, replContext);
            } catch {
                obj = null;
            }
        }

        let keys = [];
        if (obj !== null && obj !== undefined) {
            // Deeply traverse the prototype chain 
            // to get all properties (including Object.prototype)
            const allProps = new Set();
            let currentObj = obj;
            while (currentObj) {
                Object.getOwnPropertyNames(currentObj).forEach(k => allProps.add(k));
                currentObj = Object.getPrototypeOf(currentObj);
            }
            keys = Array.from(allProps).filter(k => k.startsWith(prefix));
        }
        // Return the standard [completions, completed_string] format
        worker.postMessage({ id, type, content: [keys, prefix] });
    } catch (e) {
        worker.postMessage({ id, type, content: [[], ""] });
    }
}
