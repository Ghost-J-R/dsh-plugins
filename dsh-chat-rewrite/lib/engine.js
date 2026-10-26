/**
 * Chat-rewrite engine — tail-truncate a DSH v4 session log at a frame boundary.
 *
 * A DSH log is a plain concatenation of independently decodable Zstandard
 * frames, and every append writes exactly one frame for one contiguous batch
 * of events. A frame boundary is therefore an event boundary, so deleting from
 * the end needs no sequence renumbering, no cross-reference remap and no
 * assistant-stream rebuild:
 *
 *   frames wholly inside the kept prefix  -> copied byte for byte
 *   the frame straddling the cut          -> decompressed, prefix lines kept, recompressed
 *   every later frame                     -> dropped
 *
 * Verified on DSH 0.2.1-rc.3: truncated logs are accepted by the running Host
 * (read and write open), and the projection cache refolds itself because the
 * log got shorter.
 */

import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic, little endian. */
const ZSTD_MAGIC = 0xfd2fb528
/** Session format this engine rewrites; older generations are left to DSH. */
export const SUPPORTED_VERSION = 4

/**
 * Walk the concatenated Zstandard frames of one session log.
 * @param {Buffer} buffer - the whole artifact.
 * @returns {Array<{start: number, end: number}>} frame byte ranges in file order.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`bad frame magic at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn block header at byte ${offset}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decode one session log into its header and logical events.
 * @param {Buffer} buffer - the whole artifact.
 * @returns {{
 *   header: object,
 *   headerLine: string,
 *   frames: Array<{start: number, end: number}>,
 *   bodyFrames: string[][],
 *   events: object[],
 *   version: number,
 * }} the decoded log; `bodyFrames[i]` holds the raw event lines of frame i+1.
 */
export function decodeSessionLog(buffer) {
  const frames = scanZstdFrames(buffer)
  const plain = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
  const headerLine = plain[0].split('\n')[0]
  if (plain[0] !== `${headerLine}\n`) throw new Error('first frame is not exactly one header line')
  const header = JSON.parse(headerLine)
  const bodyFrames = plain.slice(1).map((text) => text.split('\n').filter((line) => line !== ''))
  const events = bodyFrames.flat().map((line) => JSON.parse(line))
  /**
   * Index of the LAST `session/end-seed {inherited:true}` marker, which defines
   * a forked (seeded) session's inherited cut. It must survive any truncation:
   * removing it turns the artifact into "a seeded session without its marker",
   * which the format reader refuses.
   */
  let seededCut
  for (const [index, event] of events.entries()) {
    if (event.type === 'session/end-seed' && event.data?.inherited === true) seededCut = index
  }
  return { header, headerLine, frames, bodyFrames, events, version: header.version, seededCut }
}

/**
 * One frame, checksummed exactly like the Host writer (`ZSTD_c_checksumFlag`).
 * @param {string} text - plaintext for the frame.
 * @returns {Buffer} the compressed frame.
 */
function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** Index of every `agent/inbox/spliced` insertion, keyed by inserted message id. */
function spliceIndexById(events) {
  const index = new Map()
  for (const [position, event] of events.entries()) {
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data?.inserted ?? []) {
      if (typeof message?.id === 'string') index.set(message.id, position)
    }
  }
  return index
}

/**
 * List every human round the editor can rewind to.
 *
 * A round anchor is the FIRST human-authored message inside its turn
 * (`user/message` with `source.kind === 'user'`). Injected context messages
 * (runtime-context, skill-catalog, goal, subagent notices…) and answers to the
 * model's own questions (`user-question-reply`) are not human rounds.
 *
 * @param {object} log - result of {@link decodeSessionLog}.
 * @returns {Array<{
 *   turn: number, promptSeq: number,
 *   cutBefore: number, cutAfter: number,
 *   preview: string, answered: boolean, lastTurn: boolean,
 *   rewindable: boolean, reason?: string,
 * }>} anchors in log order.
 */
export function planAnchors(log) {
  const { events } = log
  const spliceIndex = spliceIndexById(events)
  const anchors = []
  let turn = null
  let turnStart = -1
  let closed = true
  for (const [position, event] of events.entries()) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      turnStart = position
      closed = false
      continue
    }
    if (event.type === 'turn/end') {
      closed = true
      continue
    }
    if (turn === null || closed) continue
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    if (anchors.length > 0 && anchors.at(-1).turn === turn) continue

    const messageId = String(event.data.id ?? '')
    const splice = spliceIndex.get(messageId)
    // "Rewind to before this round" also drops the queued-input splice that
    // delivered it, so no dangling pending message survives in the prefix.
    const cutBefore = splice === undefined ? turnStart : Math.min(turnStart, splice)
    let answered = false
    for (let later = position + 1; later < events.length; later++) {
      const candidate = events[later]
      if (candidate.type === 'turn/end') break
      if (candidate.type === 'assistant/message' && candidate.data?.turn === turn) {
        answered = true
        break
      }
    }
    const preview = (event.data.content ?? [])
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
    // Rounds at or below the fork's inherited cut belong to the parent's copied
    // history. They are still deletable: cutting there re-seeds the fork so it
    // inherits less (see buildTruncated). `inherited` only drives a UI badge.
    const floor = log.seededCut === undefined ? 1 : log.seededCut + 1
    const cutAfter = position + 1
    const inherited = cutBefore < floor || cutAfter < floor
    // The first round has no earlier round to return to; emptying a session is
    // a different operation, so the panel keeps it out of reach.
    const rewindable = turn > 1 && cutBefore > 0
    anchors.push({
      turn,
      promptSeq: event.seq,
      cutBefore,
      cutAfter,
      preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
      answered,
      lastTurn: false,
      inherited,
      rewindable,
      deletable: true,
      ...rewindable ? {} : { reason: 'first-round' },
    })
  }
  const last = anchors.at(-1)
  if (last !== undefined) last.lastTurn = true
  return anchors
}

/**
 * Build the truncated artifact: prefix frames verbatim, one straddling frame
 * recompressed, everything after dropped.
 *
 * A forked (seeded) session is handled in one of two ways:
 *  - cutting AFTER its inherited marker keeps that marker in place;
 *  - cutting at or before it re-seeds the fork: the kept prefix is followed by
 *    a fresh `session/end-seed {inherited:true}` at the new cut, which is how a
 *    fork legitimately declares that it inherits less of its parent. The marker
 *    is the cut coordinate, so this keeps the artifact self-consistent.
 *
 * @param {object} log - result of {@link decodeSessionLog}.
 * @param {Buffer} buffer - the original artifact bytes.
 * @param {number} cutIndex - number of leading events to keep.
 * @returns {{bytes: Buffer, copied: number, recompressed: number, dropped: number, reseeded: boolean}} the new artifact.
 */
export function buildTruncated(log, buffer, cutIndex) {
  if (!Number.isSafeInteger(cutIndex) || cutIndex < 1 || cutIndex > log.events.length) {
    throw new Error(`cut index ${cutIndex} is outside 1..${log.events.length}`)
  }
  const reseeded = log.seededCut !== undefined && cutIndex <= log.seededCut
  // The header never changes, so its original frame is copied byte for byte.
  // Re-compressing it would spend CPU to produce a different, equally valid
  // encoding of identical plaintext.
  const headerFrame = log.frames[0]
  const chunks = [buffer.subarray(headerFrame.start, headerFrame.end)]
  let consumed = 0
  let copied = 0
  let recompressed = 0
  let dropped = 0
  for (const [i, lines] of log.bodyFrames.entries()) {
    const start = consumed
    const end = consumed + lines.length
    consumed = end
    const frame = log.frames[i + 1]
    if (end <= cutIndex) {
      chunks.push(buffer.subarray(frame.start, frame.end))
      copied++
      continue
    }
    if (start >= cutIndex) {
      dropped += lines.length
      continue
    }
    const keep = lines.slice(0, cutIndex - start)
    chunks.push(compressFrame(`${keep.join('\n')}\n`))
    recompressed++
    dropped += lines.length - keep.length
  }
  if (reseeded) {
    const marker = { type: 'session/end-seed', seq: cutIndex, time: Date.now(), data: { inherited: true } }
    chunks.push(compressFrame(`${JSON.stringify(marker)}\n`))
  }
  return { bytes: Buffer.concat(chunks), copied, recompressed, dropped, reseeded }
}

/**
 * Independently re-read a produced artifact and assert the invariants the Host
 * reader enforces: header-only first frame, whole records only, dense `seq`, and
 * a surviving inherited marker for a seeded session.
 * @param {Buffer} buffer - the produced artifact.
 * @param {number} expectedEvents - exact logical event count expected.
 * @param {object} [source] - the original decoded log, when the seeded-marker
 *   invariant must be compared against it.
 * @returns {{frames: number, events: number, version: number}} verified shape.
 */
export function verifyArtifact(buffer, expectedEvents, source) {
  const log = decodeSessionLog(buffer)
  if (log.events.length !== expectedEvents) {
    throw new Error(`truncated artifact holds ${log.events.length} events, expected ${expectedEvents}`)
  }
  for (const [index, event] of log.events.entries()) {
    if (event.seq !== index) throw new Error(`truncated artifact is not dense: seq ${event.seq} at index ${index}`)
  }
  if (source?.seededCut !== undefined && log.seededCut === undefined) {
    throw new Error('truncated artifact lost the inherited seed marker')
  }
  if (log.header.isSeeded === true && log.seededCut === undefined) {
    throw new Error('truncated artifact is seeded but carries no inherited seed marker')
  }
  return { frames: log.frames.length, events: log.events.length, version: log.version }
}

/**
 * Resolve the human round that owns one assistant message, so a delete button
 * rendered on that message can target the round it belongs to.
 * @param {object} log - result of {@link decodeSessionLog}.
 * @param {string} messageId - durable assistant message id.
 * @returns {object|undefined} the owning anchor, or undefined when unknown.
 */
export function findRoundByMessage(log, messageId) {
  const anchors = planAnchors(log)
  let turn
  for (const event of log.events) {
    if (event.type !== 'assistant/message') continue
    if (String(event.data?.message?.id ?? '') !== messageId) continue
    turn = event.data?.turn
    break
  }
  if (turn === undefined) return undefined
  return anchors.find((anchor) => anchor.turn === turn)
}

/**
 * Human-readable digest of one artifact for the panel header.
 * @param {object} log - result of {@link decodeSessionLog}.
 * @returns {{version: number, events: number, turns: number, title: string}} summary facts.
 */
export function summarize(log) {
  let title = ''
  let turns = 0
  for (const event of log.events) {
    if (event.type === 'turn/start') turns++
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return { version: log.version, events: log.events.length, turns, title }
}
