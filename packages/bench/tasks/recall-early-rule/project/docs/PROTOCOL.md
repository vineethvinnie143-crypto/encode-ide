# The relay protocol

The relay carries small JSON messages between game clients and the room server. This document is the reference for
anyone who writes a client or changes the server.

## Transport

Clients connect over TCP to port 7300 and keep one connection per session. The server closes a connection that sends
nothing for 90 seconds, so clients send `ping` every 30 seconds. A client that reconnects within two minutes keeps its
seat in the room. Connections from outside the allowed networks are refused before the first frame.

## Messages

Every message is a JSON object with a `type` field. The server answers each one with a message of its own:

| type   | what it does                              | answer   |
|--------|-------------------------------------------|----------|
| join   | takes a seat in a room                    | joined   |
| leave  | gives the seat up                         | left     |
| chat   | says something to the room                | said     |
| move   | moves the player on the board             | moved    |
| trade  | offers items to another player            | offered  |
| emote  | plays an animation                        | emoted   |
| ping   | keeps the connection alive                | pong     |
| report | reports another player to the moderators  | reported |

A message that lacks a field its handler needs is answered with an error and changes nothing. Each handler in
`src/handlers/` lists the fields it needs in the comment above it.

## Rooms

A room holds at most 16 players. The first player to join becomes its host; when the host leaves, the player who
joined next takes over. Rooms with nobody in them are closed after five minutes. Room names are 3 to 24 characters:
letters, digits and dashes.

## Framing

Every frame is, in this order:

1. the four magic bytes `0x45 0x4E 0x43 0x37` (`ENC7` in ASCII);
2. one version byte, always `3`;
3. the payload's length in bytes, as an unsigned 16-bit integer, big-endian;
4. the payload: the message as UTF-8 JSON, with no spaces added;
5. one checksum byte: every byte of the payload XORed together.

A frame whose checksum does not match is dropped without an answer.

## Older versions

Version 2 frames began with `ENC6`, put the length little-endian and had no checksum. The server still reads them
from clients older than 1.4, but nothing may write them any more.

## Errors

An error answer is `{ "type": "error", "code": <number>, "message": <text> }`. Codes 400 to 499 are the client's
fault (a missing field is 422), 500 and up the server's. Clients show the message to the player as it is.

## Rate limits

A client may send 20 messages a second and 600 a minute. Past that the server drops messages and answers the first
dropped one with code 429. Chat has its own limit of 5 lines in 10 seconds.
