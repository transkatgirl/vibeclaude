export class InterruptHandler {
  lastSessionId = null;

  constructor(engine, cotHandler, messageHandler) {
    this.engine = engine;
    this.cotHandler = cotHandler;
    this.messageHandler = messageHandler;
  }

  onSessionCreated(sessionId) {
    if (this.lastSessionId !== null && sessionId !== this.lastSessionId) {
      this.cotHandler.end();
      this.messageHandler.end();
      this.engine.stopAll();
    }
    this.lastSessionId = sessionId;
  }

  onSessionError() {
    this.cotHandler.end();
    this.messageHandler.end();
    this.engine.stopAll();
  }

  onSessionDeleted() {
    this.cotHandler.end();
    this.messageHandler.end();
    this.engine.stopAll();
  }
}
