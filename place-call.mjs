// Runs detached from the hook: starts the agent, places the outbound call, follows it, texts the summary, cleans up.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentDispatchClient, RoomServiceClient, TrackType } from 'livekit-server-sdk';
import { AGENT_NAME, bridgeToken, chert, config, demoEvent, HOME, loadSecrets, log, readJson, resultPath, STATE } from './lib.mjs';

loadSecrets();
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
rmSync(process.argv[2], { force: true });
const settings = config();
const { projectId } = settings;
const phone = settings.phone ?? process.env.FACETIME_ME_PHONE;
let lineId = settings.lineId ?? null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['ended', 'failed', 'rejected']);
const lk = process.env.LIVEKIT_URL.replace(/^wss:/, 'https:'), key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
const rooms = new RoomServiceClient(lk, key, secret), dispatch = new AgentDispatchClient(lk, key, secret);

const room = job.room ?? `cc-${randomBytes(5).toString('hex')}`, bridgeIdentity = `chert-bridge-${room}`;
const WARM = join(STATE, 'warm-worker.json');
let worker = null, callId = null;

async function agentReady() {
  for (let i = 0; i < 80; i++) {
    const people = await rooms.listParticipants(room).catch(() => []);
    for (const person of people) {
      if (person.identity === bridgeIdentity) continue;
      const audio = person.tracks.some(t => t.type === TrackType.AUDIO && !t.muted), video = person.tracks.some(t => t.type === TrackType.VIDEO);
      if (audio && video) return person.identity;
    }
    await sleep(250);
  }
  throw new Error('the agent never published its audio and video');
}

function summaryText(call, result, failure) {
  const what = job.summary;
  if (failure) return `Claude Code tried to FaceTime you but the call failed.\n${what}\nReason: ${failure}`;
  if (!result?.answered) return `Missed call from Claude Code.\n${what}`;
  const fix = result.fix ?? {};
  const seconds = call?.duration_seconds != null ? ` (${call.duration_seconds}s call)` : '';
  if (fix.status === 'fixed') return `${what}\nYou said yes on the call${seconds}, and it's fixed.\n${(fix.summary ?? '').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 220) ?? ''}`.trim();
  if (fix.status === 'failed') return `${what}\nYou said yes on the call${seconds}, but the fix didn't work.\n${(fix.summary ?? '').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 220) ?? ''}`.trim();
  if (result.outcome === 'declined') return `${what}\nYou passed on the fix${seconds}, so nothing was changed.`;
  return `${what}\nWe talked${seconds}. Nothing was changed.`;
}

async function sendSummary(call, result, failure) {
  // An approval is answered on the call or falls back to the terminal; a text afterwards adds nothing.
  if (job.approval) return;
  const text = summaryText(call, result, failure);
  try {
    await chert('POST', '/shared-messages', { line_id: lineId, recipient: phone, text }, { idempotencyKey: `summary-${room}` });
    log(`${room} summary queued`);
    demoEvent('summary-sent');
  } catch (error) {
    log(`${room} summary failed: ${error.message}`);
    demoEvent('summary-failed');
  }
}

/** Finds the line to call from and proves it is usable before anything rings. Throws a plain reason if not. */
async function preflight() {
  if (!phone) throw new Error('no phone number: run facetime-me --setup, or add "phone" to config.json');
  const { items = [] } = await chert('GET', '/lines');
  const usable = items.filter(line => line.active !== false && !/released|expired|inactive|disabled/i.test(String(line.status ?? '')));
  if (lineId) {
    if (!items.some(line => line.id === lineId)) throw new Error(`line ${lineId} is no longer on project ${projectId}`);
  } else if (usable.length === 1) {
    lineId = usable[0].id;
  } else {
    throw new Error(usable.length ? `project ${projectId} has ${usable.length} lines: set "lineId" in config.json` : `project ${projectId} has no active Chert line (billing or line assignment)`);
  }
}

/** When Chert cannot ring, the alert still reaches the phone as a push, so a real problem is never silent. */
async function pushFallback(reason) {
  let topic = '';
  try { topic = readFileSync(join(homedir(), '.claude', 'ntfy_topic'), 'utf8').trim(); } catch { return; }
  if (!topic || job.demo) return;
  await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST', body: `${job.summary}\n(FaceTime unavailable: ${reason})`,
    headers: { Title: 'Claude Code needs you', Priority: 'high', Tags: 'telephone_receiver' }, signal: AbortSignal.timeout(10000),
  }).then(() => log(`${room} pushed to phone instead`)).catch(error => log(`${room} push failed: ${error.message}`));
}

async function main() {
  await preflight();
  await rooms.createRoom({ name: room, emptyTimeout: 300, maxParticipants: 4 });
  const warmPid = Number(readJson(WARM, {}).pid);
  let warm = false;
  try { if (warmPid) { process.kill(warmPid, 0); warm = true; } } catch { /* it has gone */ }
  if (warm) {
    worker = { kill: signal => { try { process.kill(warmPid, signal); } catch { /* already gone */ } } };
  } else {
    const logFd = openSync(join(STATE, 'worker.log'), 'a');
    worker = spawn(process.execPath, [join(HOME, 'agent.mjs'), 'start'], { cwd: HOME, stdio: ['ignore', logFd, logFd] });
    closeSync(logFd);
  }
  await dispatch.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify({ ...job, room, bridgeIdentity }) });
  const agentIdentity = await agentReady();
  log(`${room} agent ready`);

  const created = await chert('POST', '/calls', {
    direction: 'outbound', mode: 'customer_managed', line_id: lineId, destination: phone, destination_type: 'phone',
    media: { audio: true, video: true }, livekit_url: process.env.LIVEKIT_URL,
    participant_token: bridgeToken(room, bridgeIdentity), remote_participant_identity: agentIdentity,
  }, { idempotencyKey: `call-${room}` });
  callId = created.id;
  log(`${room} call ${callId} allocated (project ${projectId})`);
  demoEvent('ringing');
  await rooms.updateRoomMetadata(room, JSON.stringify({ chert_call: callId }));

  let signalled = false, call = created;
  const deadline = Date.now() + 6 * 60000;
  while (Date.now() < deadline) {
    await sleep(500);
    call = await chert('GET', `/calls/${callId}`).catch(() => call);
    if (TERMINAL.has(call.status)) break;
    const ready = call.status === 'active' && call.facetime_call_events?.some(e => e.event_type === 'bridge_ready' && e.source === 'worker');
    if (ready && !signalled) {
      signalled = true;
      await rooms.updateRoomMetadata(room, JSON.stringify({ chert_call: callId, chert_bridge_ready: true, at: new Date().toISOString() }));
      log(`${room} bridge_ready`);
      demoEvent('answered');
    }
  }
  if (!TERMINAL.has(call.status)) await chert('POST', `/calls/${callId}/end`, {}).catch(() => {});
  log(`${room} call ended: status=${call.status} reason=${call.terminal_reason ?? 'none'} seconds=${call.duration_seconds ?? 'n/a'}`);

  // A fix can outlive a hang-up; wait for its outcome so the text is true.
  for (let i = 0; i < 400 && readJson(resultPath(room), {}).fix?.status === 'running'; i++) await sleep(500);
  const failedBefore = call.status !== 'ended' && !readJson(resultPath(room), {}).answered ? (call.terminal_reason ?? call.status) : null;
  await sendSummary(call, readJson(resultPath(room), null), call.status === 'rejected' || call.status === 'failed' ? failedBefore : null);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  log(`${room} failed: ${error.message}`);
  demoEvent(`call-failed ${error.message}`);
  // Nothing rang, so this error has not been reported to the developer: let a repeat try again.
  if (!callId && job.dedupeKey) {
    const statePath = join(STATE, 'state.json'), state = readJson(statePath, {});
    if (state.seen) delete state.seen[job.dedupeKey];
    delete state.lastCallAt;
    (await import('./lib.mjs')).writeJson(statePath, state);
  }
  // Chert refused the key: remember it so approvals skip straight to the terminal until `facetime-me --key`.
  if ([401, 403].includes(error.status)) writeFileSync(join(STATE, 'key-invalid'), `${new Date().toISOString()} ${error.message}\n`);
  if (callId) await sendSummary(null, readJson(resultPath(room), null), error.message).catch(() => {});
  else if (!job.approval) await pushFallback(error.message).catch(() => {});
} finally {
  worker?.kill('SIGTERM');
  await rooms.deleteRoom(room).catch(() => {});
  rmSync(WARM, { force: true });
  rmSync(join(STATE, 'call.lock'), { recursive: true, force: true });
  demoEvent('call-done');
}
process.exit(exitCode);
