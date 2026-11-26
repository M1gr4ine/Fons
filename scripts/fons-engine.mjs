import fs from "node:fs";
import crypto from "node:crypto";
import {
  completeAcknowledgedIdeas, computeDebounce, lookupConversation, readJson, readPoolData, withPoolWrite, writeJsonAtomic,
} from "./fons-store.mjs";

const MAX_STOP_CONTINUES = 2;
const MAX_TOOL_EVENTS = 64;
const ACK_TAG = "\\[FONS_ACK[:：][ \\t]*[a-f0-9]{8}(?:(?:[ \\t]*[,，][ \\t]*|[ \\t]+)[a-f0-9]{8})*\\]";
const ACK_LINE = new RegExp("^[ \\t]*" + ACK_TAG + "(?:[ \\t]*[,，]?[ \\t]*" + ACK_TAG + ")*[ \\t]*$");
const ACK_TOKEN = /\b[a-f0-9]{8}\b/g;

export function extractAckTokensFromText(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  const tokens = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ACK_LINE.test(lines[i])) break;
    for (const token of lines[i].match(ACK_TOKEN)) tokens.add(token);
  }
  return tokens;
}

function deliveryTimestamp(ui, id) {
  return Math.max(Date.now(), (ui.reopened?.[id] ?? 0) + 1, (ui.retracted?.[id]?.ts ?? 0) + 1);
}

function newAckToken() {
  return crypto.randomBytes(4).toString("hex");
}

function deliveryGeneration({ id, status }, state) {
  const recorded = state.generations?.[id] ?? 0;
  const previous = state.delivered?.[id]?.generation ?? 0;
  if (status === "delivered") return Math.max(1, recorded, previous);
  return Math.max(recorded, previous) + 1;
}

function createDelivery(item, { state, ui }, turnId, ackToken) {
  return {
    text: item.text,
    generation: deliveryGeneration(item, state),
    deliveryUid: crypto.randomUUID(),
    ackToken,
    attempt: 1,
    deliveredAt: deliveryTimestamp(ui, item.id),
    firstTurnId: turnId,
    lastTurnId: turnId,
  };
}

function recordDelivery(item, data, event, policy) {
  const { state, ui } = data;
  const turnId = event.turnId ?? null;
  if (item.status !== "delivered") return createDelivery(item, data, turnId, newAckToken());

  const previous = state.delivered[item.id];
  let generation = previous;
  if (!previous.generation) generation = { ...createDelivery(item, data, turnId, previous.ackToken), ...previous };
  const attempt = previous.attempt ?? 1;
  const next = { ...generation, attempt: attempt + 1, lastTurnId: turnId };
  if (policy.rotateTokenOnStopRetry) {
    next.ackToken = newAckToken();
    next.deliveredAt = deliveryTimestamp(ui, item.id);
  }
  return next;
}

function markDelivered(items, data, event, policy) {
  if (!items.length) return [];
  const { state, ui } = data;
  state.delivered ??= {};
  state.generations ??= {};
  return items.map((item) => {
    const { id, text, note, attachments } = item;
    const record = recordDelivery(item, data, event, policy);
    state.delivered[id] = record;
    state.generations[id] = record.generation;
    return { id, text, note, attachments, ackToken: record.ackToken, readded: Boolean(ui.retracted?.[id]) };
  });
}

function unnotified(ui, state) {
  return Object.entries(ui.retracted ?? {}).filter(([id, entry]) => (state.retractNotified?.[id] ?? -1) < entry.ts);
}

function collectRetractions(state, retracted) {
  if (!retracted.length) return [];
  state.retractNotified ??= {};
  for (const [id, entry] of retracted) state.retractNotified[id] = entry.ts;
  return retracted.map(([, entry]) => entry.text);
}

function clearRetractionMarker({ paths, state }) {
  if (!fs.existsSync(paths.retractMarker)) return;
  fs.rmSync(paths.retractMarker, { force: true });
  if (unnotified(readJson(paths.ui), state).length) fs.closeSync(fs.openSync(paths.retractMarker, "a"));
}

function syncPendingLedger(state, pendingAt, deliveries = []) {
  const deliveredIds = new Set(deliveries.map(({ id }) => id));
  const next = Object.fromEntries(Object.entries(pendingAt).filter(([id]) => !deliveredIds.has(id)));
  if (Object.keys(next).length) state.pendingAt = next;
  else delete state.pendingAt;
}

function selectBatch(policy, batch) {
  if (!policy.limitBatch) return { items: batch.items, retractions: batch.retractions };
  return policy.limitBatch(batch);
}

function handleDelivery(data, event, policy, { ready, pendingAt }) {
  const { state, ui } = data;
  const acknowledged = acknowledgedIds(data, consumeAcknowledgment(state, event));
  const batch = selectBatch(policy, { kind: "delivery", items: ready, retractions: unnotified(ui, state), ui });
  // Allocate every new token before writing confirmed ACKs back into the inbox.
  const deliveries = markDelivered(batch.items, data, event, policy);
  settleAcknowledged(data, acknowledged);
  const sendAckHint = deliveries.length > 0 && policy.ackHintPolicy === "once" && !state.ackHintSent;
  if (sendAckHint) state.ackHintSent = true;
  syncPendingLedger(state, pendingAt, deliveries);
  return { kind: "delivery", deliveries, sendAckHint, retractions: collectRetractions(state, batch.retractions) };
}

function acknowledgedIds({ state, items }, tokens) {
  return new Set(
    items.filter(({ id, status }) => status === "delivered" && tokens.has(state.delivered[id].ackToken))
      .map(({ id }) => id),
  );
}

function settleAcknowledged(data, ids) {
  if (!ids.size) return;
  const { state } = data;
  if (!completeAcknowledgedIdeas(data, ids)) {
    state.acknowledged ??= {};
    for (const id of ids) state.acknowledged[id] = { at: state.delivered[id].deliveredAt };
  }
  state.generations ??= {};
  for (const id of ids) {
    state.generations[id] = deliveryGeneration({ id, status: "delivered" }, state);
    delete state.delivered[id];
  }
}

function consumeMessageAcknowledgment(state, { message, tokens }) {
  if (!Object.keys(state.delivered ?? {}).length) return new Set();
  const previous = state.lastAckedStopMessage;
  if (previous?.promptId === message.promptId && previous?.digest === message.digest) return new Set();
  state.lastAckedStopMessage = message;
  return tokens;
}

function consumeAcknowledgment(state, { ackTokens, acknowledgment }) {
  if (!acknowledgment) return ackTokens ?? new Set();
  if (acknowledgment.message) return consumeMessageAcknowledgment(state, acknowledgment);
  const { cursor, previousCursorKey, tokens } = acknowledgment;
  const previous = state.lastAckedStopCursor;
  if (JSON.stringify(previous ?? null) !== previousCursorKey) return new Set();
  if (previous?.transcriptPath === cursor.transcriptPath &&
      (previous.fileId !== cursor.fileId || previous.byteOffset >= cursor.byteOffset)) return new Set();
  state.lastAckedStopCursor = cursor;
  return tokens;
}

function canDeliverAtStop(item, timing, policy) {
  if (item.status === "delivered") return true;
  if (item.status !== "buffering") return false;
  const pending = timing.byId.get(item.id);
  return !pending?.editingHold && (policy.earlyDeliverBufferingOnStop || pending?.remainingMs === 0);
}

function reserveTurnlessContinuation({ state, ui }, items, { continuationActive }) {
  const signature = items.map(({ id }) => {
    const withdrawal = ui.retracted?.[id];
    return withdrawal ? id + "@" + withdrawal.ts : id;
  }).sort().join(",");
  const previousCount = state.stopCount ?? 0;
  const count = continuationActive ? previousCount : 0;
  if (count >= MAX_STOP_CONTINUES || (continuationActive && state.lastStopSig === signature)) return false;
  state.lastStopSig = signature;
  state.stopCount = count + 1;
  return true;
}

function turnStopSignature({ state, ui }, items, withdrawals) {
  const signatures = new Map(items.map((item) => {
    const withdrawnAt = ui.retracted?.[item.id]?.ts ?? 0;
    return [item.id, [item.id, deliveryGeneration(item, state), withdrawnAt].join("@")];
  }));
  for (const [id, { ts }] of withdrawals) {
    if (!signatures.has(id)) signatures.set(id, [id, state.generations?.[id] ?? 0, ts].join("@"));
  }
  return [...signatures.values()].sort().join(",");
}

function reserveTurnContinuation(data, items, withdrawals, { turnId, continuationActive }) {
  const { state } = data;
  const sameTurn = state.lastStopTurnId === turnId;
  const previousCount = state.stopCount ?? 0;
  const count = sameTurn ? previousCount : 0;
  const signature = turnStopSignature(data, items, withdrawals);
  if (count >= MAX_STOP_CONTINUES) return false;
  if (count > 0 && continuationActive && state.lastStopSig === signature) return false;
  state.lastStopTurnId = turnId;
  state.lastStopSig = signature;
  state.stopCount = count + 1;
  return true;
}

function reserveContinuation(data, items, pendingRetractions, event) {
  if (event.turnId !== undefined) {
    if (!items.length && !pendingRetractions.length) return false;
    return reserveTurnContinuation(data, items, pendingRetractions, event);
  }
  return items.length > 0 && reserveTurnlessContinuation(data, items, event);
}

function handleStop(data, event, policy, timing) {
  const { state, ui } = data;
  const acknowledged = acknowledgedIds(data, consumeAcknowledgment(state, event));
  if (event.settleOnly) {
    if (acknowledged.size) {
      settleAcknowledged(data, acknowledged);
      syncPendingLedger(state, timing.pendingAt);
    }
    return { kind: "allow" };
  }
  const open = data.items.filter((item) => !acknowledged.has(item.id) && canDeliverAtStop(item, timing, policy));
  const remaining = [...new Map(open.map((item) => [item.id, item])).values()];
  const batch = selectBatch(policy, { kind: "stop", items: remaining, retractions: unnotified(ui, state), ui });
  const shouldContinue = reserveContinuation(data, batch.items, batch.retractions, event);
  // Allocate every new token before writing confirmed ACKs back into the inbox.
  const deliveries = shouldContinue ? markDelivered(batch.items, data, event, policy) : [];
  settleAcknowledged(data, acknowledged);
  syncPendingLedger(state, timing.pendingAt, deliveries);
  if (!shouldContinue) return { kind: "allow" };

  if (policy.ackHintPolicy === "once") state.ackHintSent = true;
  return { kind: "continue", deliveries, retractions: collectRetractions(state, batch.retractions) };
}

function claimToolEvent(state, key) {
  if (!key) return true;
  const events = Object.keys(state.seenToolEvents ?? {});
  if (events.includes(key)) return false;
  const recent = [...events, key].slice(-MAX_TOOL_EVENTS);
  state.seenToolEvents = Object.fromEntries(recent.map((event) => [event, true]));
  return true;
}

function applyPoolEvent(data, event, policy, prepareDeliveries) {
  const before = JSON.stringify(data.state);
  if (!claimToolEvent(data.state, event.toolEventKey)) return { kind: "allow" };
  if (event.rememberPromptId) data.state.lastPromptId = event.rememberPromptId;
  const timing = computeDebounce({ ...data, appData: data.appData });
  const result = event.kind === "stop" ? handleStop(data, event, policy, timing) : handleDelivery(data, event, policy, timing);
  // Prepare the selected delivery before publishing it in the ledger.
  if (result.deliveries?.length) prepareDeliveries?.(result.deliveries);
  if (JSON.stringify(data.state) !== before) writeJsonAtomic(data.paths.state, data.state);
  if (event.kind === "delivery" || result.kind === "continue") clearRetractionMarker(data);
  return result;
}

function sameTranscriptPath(left, right) {
  if (process.platform === "win32") return left?.toLowerCase() === right?.toLowerCase();
  return left === right;
}

export function executePoolEvent(context, event, policy, prepareDeliveries) {
  return withPoolWrite(context, () => {
    // An authorized re-anchor is published under this same pool lock.
    if (event.transcriptPath && !sameTranscriptPath(lookupConversation(context)?.transcriptPath, event.transcriptPath)) {
      return { kind: "allow" };
    }
    return applyPoolEvent({ ...readPoolData(context), appData: context.appData }, event, policy, prepareDeliveries);
  });
}
