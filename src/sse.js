export class SSEHub {
  constructor() {
    this.clients = new Set();
  }

  add(response) {
    this.clients.add(response);
    response.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    });
  }

  broadcast(event, payload = {}) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) client.write(message);
  }

  close() {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
