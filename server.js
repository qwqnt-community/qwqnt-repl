const { parentPort } = require('worker_threads');
const net = require('net');

let currentSocket = null;

parentPort.on('message', msg => {
    if (!currentSocket) return;
    currentSocket.write(JSON.stringify(msg) + '\n');
});

net.createServer(socket => {
    currentSocket = socket;

    let buffer = '';
    socket.on('data', chunk => {
        const lines = (buffer + chunk).split('\n');
        buffer = lines.pop();
        lines
            .filter(l => l.trim())
            .forEach(l => parentPort.postMessage(JSON.parse(l)));
    });

    socket.on('close', () =>
        currentSocket = null);
})
    .listen(1337, 'localhost');
