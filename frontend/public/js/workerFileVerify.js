// worker-file-verify.js — separate file, never concatenated into app.js.
// Spawned by file-verify.js; terminated immediately after posting the result.

self.onmessage = async ({ data: { file } }) => {
    const MB   = 1024 * 1024
    const size = file.size

    // Build 8-byte little-endian file size buffer.
    // Written as two 32-bit LE integers (lo, hi) — avoids BigInt for compatibility.
    const sizeBuffer = new ArrayBuffer(8)
    const sizeView   = new DataView(sizeBuffer)
    sizeView.setUint32(0, size >>> 0,               true)  // low 32 bits
    sizeView.setUint32(4, Math.floor(size / 2**32), true)  // high 32 bits

    // Three 1 MB chunk slices — clamp to file bounds for small files.
    const midOffset = Math.floor(size / 2)
    const endOffset = Math.max(0, size - MB)

    const [headBuf, midBuf, tailBuf] = await Promise.all([
        file.slice(0,         Math.min(MB, size)).arrayBuffer(),
        file.slice(midOffset, Math.min(midOffset + MB, size)).arrayBuffer(),
        file.slice(endOffset, size).arrayBuffer(),
    ])

    // Concatenate: sizeBuffer + headBuf + midBuf + tailBuf
    const total    = sizeBuffer.byteLength + headBuf.byteLength
                   + midBuf.byteLength     + tailBuf.byteLength
    const combined = new Uint8Array(total)
    let   offset   = 0

    combined.set(new Uint8Array(sizeBuffer), offset); offset += sizeBuffer.byteLength
    combined.set(new Uint8Array(headBuf),    offset); offset += headBuf.byteLength
    combined.set(new Uint8Array(midBuf),     offset); offset += midBuf.byteLength
    combined.set(new Uint8Array(tailBuf),    offset)

    const hashBuffer = await crypto.subtle.digest('SHA-256', combined)
    const hex = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

    self.postMessage({ hex })
}