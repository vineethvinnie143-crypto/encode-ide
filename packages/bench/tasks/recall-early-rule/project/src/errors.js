// What a handler throws for a message it cannot take. The server answers it with code 422.
export class ProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProtocolError'
  }
}
