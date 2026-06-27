<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

/**
 * Minimal RFC 6455 frame encode/decode for the control-plane WebSocket. Only the
 * text/close/ping/pong opcodes the dev tool needs; no extensions, no
 * fragmentation reassembly beyond a single client message at a time (sufficient
 * for a localhost control channel with one UI client).
 */
final class WebSocketFrame
{
    public const OP_CONTINUATION = 0x0;
    public const OP_TEXT = 0x1;
    public const OP_BINARY = 0x2;
    public const OP_CLOSE = 0x8;
    public const OP_PING = 0x9;
    public const OP_PONG = 0xA;

    /** Encode a server->client text frame (server frames are never masked). */
    public static function encodeText(string $payload): string
    {
        return self::encode(self::OP_TEXT, $payload);
    }

    public static function encode(int $opcode, string $payload): string
    {
        $len = strlen($payload);
        $frame = chr(0x80 | $opcode); // FIN + opcode

        if ($len <= 125) {
            $frame .= chr($len);
        } elseif ($len <= 0xFFFF) {
            $frame .= chr(126) . pack('n', $len);
        } else {
            $frame .= chr(127) . pack('J', $len);
        }
        return $frame . $payload;
    }

    /**
     * Decode one frame from a buffer. Returns the decoded frame and the number of
     * bytes consumed, or null if the buffer doesn't yet hold a complete frame.
     *
     * @return array{opcode:int,payload:string,consumed:int}|null
     */
    public static function decode(string $buffer): ?array
    {
        $len = strlen($buffer);
        if ($len < 2) {
            return null;
        }

        $b0 = ord($buffer[0]);
        $b1 = ord($buffer[1]);
        $opcode = $b0 & 0x0F;
        $masked = ($b1 & 0x80) !== 0;
        $payloadLen = $b1 & 0x7F;
        $offset = 2;

        if ($payloadLen === 126) {
            if ($len < $offset + 2) {
                return null;
            }
            $payloadLen = unpack('n', substr($buffer, $offset, 2))[1];
            $offset += 2;
        } elseif ($payloadLen === 127) {
            if ($len < $offset + 8) {
                return null;
            }
            $payloadLen = unpack('J', substr($buffer, $offset, 8))[1];
            $offset += 8;
        }

        $maskKey = '';
        if ($masked) {
            if ($len < $offset + 4) {
                return null;
            }
            $maskKey = substr($buffer, $offset, 4);
            $offset += 4;
        }

        if ($len < $offset + $payloadLen) {
            return null; // wait for more bytes
        }

        $payload = substr($buffer, $offset, $payloadLen);
        if ($masked) {
            $unmasked = '';
            for ($i = 0; $i < $payloadLen; $i++) {
                $unmasked .= $payload[$i] ^ $maskKey[$i % 4];
            }
            $payload = $unmasked;
        }

        return ['opcode' => $opcode, 'payload' => $payload, 'consumed' => $offset + $payloadLen];
    }

    /** Compute the Sec-WebSocket-Accept value for the handshake. */
    public static function acceptKey(string $clientKey): string
    {
        return base64_encode(sha1($clientKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
    }
}
