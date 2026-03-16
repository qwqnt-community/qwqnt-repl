const net = require('node:net');
const repl = require('node:repl');
const vm = require('node:vm');
const { cursorTo, clearLine, moveCursor } = require('node:readline');

const historyPath = process.env.REPL_HISTORY;
const pendingRequests = new Map();
let nextId = 0;

const sock = net.connect(1337, 'localhost');

let buffer = '';
sock.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const { id, content, isError } = JSON.parse(line);
            const resolve = pendingRequests.get(id);
            if (resolve) {
                pendingRequests.delete(id);
                resolve({ content, isError });
            }
        } catch (e) { }
    }
});

function sendRequest(type, content) {
    const id = nextId++;
    return new Promise(resolve => {
        pendingRequests.set(id, resolve);
        sock.write(JSON.stringify({ id, type, content }) + '\n');
    });
}

function isRecoverableError(error) {
    if (error && error.name === 'SyntaxError')
        return /^(Unexpected end of input|Unexpected token)/.test(error.message);
    return false;
}

// ─── Custom Preview State ───
let completionPreview = null;   // gray suffix on the same line
let inputPreview = null;        // gray eval result on the next line
let previewGeneration = 0;      // monotonic counter to discard stale previews
let hasCreatedPreviewLine = false; // track if we've added a \n for the current input

/**
 * Heuristic: skip preview-eval for code that would mutate state.
 * We can't use V8's throwOnSideEffect, so we conservatively reject
 * declarations, assignments, delete, and increment/decrement.
 */
function isSafeForPreview(code) {
    if (/^\s*(var|let|const|function|class|import|export)\b/.test(code)) return false;
    if (/(?<![=!<>])=(?![=>])/.test(code)) return false;
    if (/\bdelete\b/.test(code)) return false;
    if (/\+\+|--/.test(code)) return false;
    if (/[()\[\]]/.test(code)) return false;
    return true;
}

// ─── Input Preview (eval result below current line) ───

function clearInputPreview(r) {
    if (inputPreview === null) return;
    const { rows: promptRows } = r._getDisplayPos(r._prompt + r.line);
    const { rows: cursorRows, cols: cursorCols } = r.getCursorPos();
    const rowsToBottom = promptRows - cursorRows;

    let seq = '';
    // Move to the line below the end of input
    if (rowsToBottom + 1 > 0) seq += `\x1b[${rowsToBottom + 1}B`;
    // Clear everything from the start of the preview line downwards
    seq += `\r\x1b[J`;
    // Move exactly back up to the cursor's original row
    if (rowsToBottom + 1 > 0) seq += `\x1b[${rowsToBottom + 1}A`;
    // Restore horizontal position
    seq += `\x1b[${cursorCols + 1}G`;

    r.output.write(seq);
    inputPreview = null;
}

function showInputPreview(r, text) {
    if (!text) return;
    // VERY STRICT TRUNCATION to prevent wrapping which breaks everything
    const maxCols = (r.columns || 80) - 5;
    if (text.length > maxCols) {
        text = text.slice(0, maxCols - 3) + '...';
    }
    inputPreview = text;

    const { rows: promptRows, cols: promptCols } = r._getDisplayPos(r._prompt + r.line);
    const { rows: cursorRows, cols: cursorCols } = r.getCursorPos();
    const rowsToBottom = promptRows - cursorRows;

    let seq = '';
    // 1. Move to the end of the total input area
    if (rowsToBottom > 0) seq += `\x1b[${rowsToBottom}B`;
    seq += `\x1b[${promptCols + 1}G`;

    // 2. Ensure we have a preview line and move to it
    if (!hasCreatedPreviewLine) {
        seq += `\n`; // This scrolls the terminal if we are at the bottom
        hasCreatedPreviewLine = true;
    } else {
        seq += `\x1b[1B`; // We know the line exists, just move down
    }

    // 3. Clear and write the preview
    seq += `\r\x1b[J\x1b[90m${text}\x1b[39m`;

    // 4. Move back up to the original cursor row
    seq += `\x1b[${rowsToBottom + 1}A`;

    // 5. Restore horizontal position
    seq += `\x1b[${cursorCols + 1}G`;

    r.output.write(seq);
}

// ─── Completion Preview (gray suffix on same line) ───

function clearCompletionPreview(r) {
    if (completionPreview === null) return;
    const displayPos = r._getDisplayPos(`${r.getPrompt()}${r.line}`);
    const cursorPos = r.line.length !== r.cursor ? r.getCursorPos() : displayPos;
    if (r.line.length !== r.cursor) {
        cursorTo(r.output, displayPos.cols);
        moveCursor(r.output, 0, displayPos.rows - cursorPos.rows);
    }
    clearLine(r.output, 1);
    if (r.line.length !== r.cursor) {
        cursorTo(r.output, cursorPos.cols);
        moveCursor(r.output, 0, cursorPos.rows - displayPos.rows);
    }
    completionPreview = null;
}

function showCompletionPreview(r, suffix) {
    if (!suffix || r.cursor !== r.line.length) return;
    completionPreview = suffix;
    r.output.write(`\x1b[90m${suffix}\x1b[39m`);
    moveCursor(r.output, -suffix.length, 0);
}

// ─── Combined clear ───
function clearAllPreviews(r) {
    clearInputPreview(r);
    clearCompletionPreview(r);
}

// ─── Request both previews (fired after each keypress) ───
function requestPreviews(r) {
    if (r.cursor !== r.line.length || r.line.trim() === '') return;

    const gen = ++previewGeneration;
    const line = r.line;
    const trimmedLine = line.trim();

    // 1) Completion preview (gray suffix)
    sendRequest('complete', line).then(({ content }) => {
        if (gen !== previewGeneration || r.line !== line) return;
        const [completions, completeOn] = content;
        if (!completions || completions.length === 0 || !completeOn) return;

        const filtered = completions.filter(Boolean);
        if (filtered.length > 0) {
            const firstSuggestion = filtered[0];
            if (firstSuggestion.length > completeOn.length) {
                const suffix = firstSuggestion.slice(completeOn.length);
                showCompletionPreview(r, suffix);
            }
        }
    }).catch(() => { });

    // 2) Input preview (eval result below)
    if (isSafeForPreview(trimmedLine)) {
        sendRequest('eval', { isReal: false, code: trimmedLine }).then(({ content: result, isError }) => {
            if (gen !== previewGeneration || r.line !== line) return;
            if (isError || !result) return;

            // Limit to one line, max 250 chars
            let displayResult = result.split('\n')[0];
            if (displayResult.length > 250) displayResult = displayResult.slice(0, 247) + '...';
            // Don't show if result equals the input expression
            if (displayResult === trimmedLine) return;
            // Don't show 'undefined'
            if (displayResult === 'undefined') return;

            showInputPreview(r, displayResult);
        }).catch(() => { });
    }
}

sock.on('connect', () => {
    const r = repl.start({
        prompt: 'QwQNT::main> ',
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        useColors: true,
        preview: false,  // disable built-in preview to prevent auto-apply on Enter
        writer: output => output || '',
        eval: (code, _context, _filename, callback) => {
            let cleanCode = code.trim();
            if (!cleanCode) return callback(null, '');

            // Multi-line syntax validation
            try {
                new vm.Script(code);
            } catch (e) {
                if (isRecoverableError(e)) {
                    return callback(new repl.Recoverable(e));
                }
            }

            sendRequest('eval', { isReal: true, code: cleanCode }).then(({ content, isError }) => {
                if (isError) {
                    r.output.write(content + '\n');
                    callback(null, undefined);
                } else {
                    callback(null, content);
                }
            }).catch(callback);
        },
        completer: (line, callback) => {
            sendRequest('complete', line).then(({ content }) => {
                callback(null, content);
            }).catch(() => callback(null, [[], line]));
        }
    });

    r.on('line', () => {
        hasCreatedPreviewLine = false;
    });

    // ─── Monkey-patch _ttyWrite for preview lifecycle ───
    const originalTtyWrite = r._ttyWrite.bind(r);

    r._ttyWrite = (d, key) => {
        key = key || {};

        if (key.name === 'tab') {
            clearAllPreviews(r);
            originalTtyWrite(d, key);
            setImmediate(() => requestPreviews(r));
            return;
        }

        if (key.name === 'return' || key.name === 'enter') {
            clearAllPreviews(r);
            originalTtyWrite(d, key);
            return;
        }

        if (key.name === 'escape') {
            clearAllPreviews(r);
            originalTtyWrite(d, key);
            return;
        }

        // Right arrow at end of line: accept completion preview
        if (key.name === 'right' && !key.ctrl && !key.meta &&
            r.cursor === r.line.length && completionPreview) {
            const preview = completionPreview;
            clearAllPreviews(r);
            r._insertString(preview);
            setImmediate(() => requestPreviews(r));
            return;
        }

        // All other keys
        clearAllPreviews(r);
        originalTtyWrite(d, key);
        setImmediate(() => requestPreviews(r));
    };

    if (historyPath) r.setupHistory(historyPath, err => {
        if (err) console.error('[REPL] History failed:', err);
    });

    r.on('exit', () => {
        sock.destroy();
        process.exit();
    });
});

sock.on('error', (err) => {
    console.error('[REPL Client] Connection error:', err.message);
    process.exit(1);
});

sock.on('close', () => {
    process.exit(0);
});
