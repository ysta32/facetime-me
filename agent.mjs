// The agent on the call: speaks through OpenAI Realtime, publishes the mascot as its camera,
// and drives the mascot from what is actually happening on the call.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cli, defineAgent, llm, ServerOptions, tokenize, tts, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { LocalVideoTrack, TrackPublishOptions, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { z } from 'zod';
import { AGENT_NAME, chert, config, demoEvent, loadSecrets, resultPath, writeJson } from './lib.mjs';
import { personaFor, personaLines } from './personas.mjs';
import { NO, TAG_MODEL, YES, instructionsFor, tagsFor } from './prompt.mjs';
import { FPS, HEIGHT, Mascot, WIDTH } from './mascot.mjs';
import { loadFrames } from './bake.mjs';
import { FixStream } from './activity.mjs';
import { testCounts } from './scene.mjs';

loadSecrets();

// ElevenLabs "Will": young, relaxed, friendly. Change it with "elevenVoice" in config.json or in the preview.
export const ELEVEN_DEFAULT_VOICE = 'bIHbv24MWmeRgasZH58o';

const NUDGE_MS = 15000, SILENCE_MS = 20000, CALL_CAP_MS = 4 * 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default defineAgent({
  // Load the mascot frames once per worker process, before any call arrives, so answering is instant.
  prewarm: async proc => { proc.userData.frames = loadFrames(); },
  entry: async ctx => {
    const job = (() => { try { return JSON.parse(ctx.job.metadata || '{}'); } catch { return {}; } })();
    const settings = config(), persona = personaFor(settings);
    // An inbound FaceTime (chert dev) carries no script from place-call.mjs: give it a plain chat one.
    if (!job.lines) Object.assign(job, { inbound: true, canFix: false, look: 'idle', lines: {} });
    job.lines = personaLines(persona, job);
    job.room ??= ctx.room.name;
    const started = Date.now();
    const result = { room: ctx.room.name, answered: false, fix: job.canFix ? { status: 'not_offered_yet' } : null, timeline: [], agentSaid: [], userSaid: [] };
    const save = () => writeJson(resultPath(job.room), result);
    const mascot = new Mascot({ frames: ctx.proc?.userData?.frames, theme: settings.theme, onChange: (look, file) => { result.timeline.push({ atMs: Date.now() - started, look, file }); save(); } });
    mascot.footer(job.project ?? '');
    let lastTests = null;

    await ctx.connect();

    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    const pushFrame = () => source.captureFrame(new VideoFrame(mascot.render(), WIDTH, HEIGHT, VideoBufferType.RGBA));
    pushFrame();
    await ctx.room.localParticipant.publishTrack(track, new TrackPublishOptions({
      source: TrackSource.SOURCE_CAMERA, simulcast: false, videoEncoding: { maxBitrate: BigInt(2_500_000), maxFramerate: FPS },
    }));
    const videoTimer = setInterval(pushFrame, 1000 / FPS);

    // Which part of the conversation we are in, plus the live speaking state, decides the look.
    let askedAt = Infinity; const heard = [];
    let fixLook = 'thinking', phase = 'ringing', agentState = 'initializing', userSpeaking = false, lastReplyAsked = false, ended = false, silenceTimer = null, processing = false, processingTimer = null;
    const refresh = () => {
      if (phase === 'fixing') return mascot.play(fixLook);
      if (phase === 'wrapup') return undefined;
      if (phase === 'greet') return undefined;
      if (phase === 'explain') return mascot.play(job.look ?? 'error');
      if (phase === 'ask') return mascot.play('waiting');
      if (userSpeaking || agentState === 'thinking' || processing) return mascot.play('thinking');
      if (agentState === 'speaking') return mascot.play(lastReplyAsked ? 'waiting' : 'idle');
      if (phase === 'open' && lastReplyAsked) return mascot.play('waiting');
      return mascot.play('idle');
    };
    const setPhase = next => { phase = next; refresh(); };

    const clearSilence = () => { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = null; };
    // Quiet after a question: first a gentle "let me know", and only after a longer wait does it give up.
    let nudged = false;
    const armSilence = () => {
      clearSilence();
      if (ended || phase !== 'open' || !(job.canFix || job.approval)) return;
      silenceTimer = nudged || !job.lines.nudge
        ? setTimeout(() => wrapUp(job.lines.noAnswer, 'no_answer').catch(() => {}), SILENCE_MS)
        : setTimeout(() => { nudged = true; void sayRaw(job.lines.nudge, 'none'); }, NUDGE_MS);
    };

    // With an ElevenLabs key, the Realtime model only writes text and ElevenLabs speaks it ("elevenModel",
    // Flash by default). v3/v4 have no streaming socket, so they speak sentence by sentence over HTTP.
    const eleven = Boolean(process.env.ELEVENLABS_API_KEY) && settings.tts !== 'openai';
    const elevenModel = settings.elevenModel || 'eleven_flash_v2_5';
    const speed = Number(settings.speed) || 1.1;
    let voiceTts = null;
    const session = new voice.AgentSession({
      ...(eleven ? { tts: (() => {
        voiceTts = new elevenlabs.TTS({
          apiKey: process.env.ELEVENLABS_API_KEY, voiceId: settings.elevenVoice || ELEVEN_DEFAULT_VOICE, model: elevenModel,
          voiceSettings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true, speed: Math.min(1.2, Math.max(0.7, speed)) },
        });
        return TAG_MODEL.test(elevenModel) ? new tts.StreamAdapter(voiceTts, new tokenize.basic.SentenceTokenizer({ minSentenceLength: 12, streamContextLength: 6 })) : voiceTts;
      })() } : {}),
      llm: new realtime.RealtimeModel({
        model: 'gpt-realtime', ...(eleven ? { modalities: ['text'] } : { voice: settings.voice ?? persona.voice, speed: Math.min(1.5, Math.max(0.8, speed)) }), inputAudioTranscription: { model: 'gpt-4o-mini-transcribe' },
        // Semantic turn detection, eager so replies start fast; noise reduction for phone audio. The yes-check
        // in heardYes() is what stops noise from approving anything, so eagerness can stay high.
        turnDetection: { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: true },
        inputAudioNoiseReduction: { type: 'near_field' },
      }),
    });

    // ElevenLabs reads a fixed line straight out, word for word, with no model turn in between.
    const say = (text, toolChoice = 'none') => { if (job.demo) demoEvent(`said ${JSON.stringify(text)}`); return sayRaw(text, toolChoice); };
    // Scripted lines are known before the call connects, so ElevenLabs voices them up front: a cached line
    // starts playing with no TTS round trip (v4 takes ~0.6 s to first audio).
    const voiced = new Map();
    const prevoice = text => {
      if (!voiceTts || !text || voiced.has(text)) return;
      const frames = (async () => { const out = []; for await (const chunk of voiceTts.synthesize(text)) out.push(chunk.frame); return out; })();
      frames.catch(() => voiced.delete(text));
      voiced.set(text, frames);
    };
    const cachedAudio = text => voiced.has(text) && new ReadableStream({
      async start(controller) { try { for (const frame of await voiced.get(text)) controller.enqueue(frame); } catch { /* falls back below */ } controller.close(); },
    });
    const sayRaw = (text, toolChoice) => eleven ? session.say(text, { allowInterruptions: false, ...(voiced.has(text) ? { audio: cachedAudio(text) } : {}) }) : session.generateReply({
      // Phrased so the model reads it as its own line to the developer, not a question put to it.
      instructions: `Speak this line to the developer now, word for word, as your own words. It is not addressed to you, so do not answer or react to it, and add nothing: "${text}"`, allowInterruptions: false, toolChoice,
    });
    const speak = (instructions) => session.generateReply({ instructions, allowInterruptions: false, toolChoice: 'none' });
    if (voiceTts) {
      const asks = job.canFix || job.approval;
      for (const text of [job.lines.hello, job.lines.explain && asks ? `${job.lines.explain} ${job.lines.ask}` : job.lines.explain,
        job.lines.approved, job.lines.denied, job.lines.bye, job.lines.noAnswer, job.lines.nudge, job.lines.fixed, 'On it.',
        ...(job.stages ?? []).flatMap(stage => [stage.line, stage.ack])]) prevoice(typeof text === 'string' ? text : null);
    }

    const hangUp = async () => {
      const callId = (() => { try { return JSON.parse(ctx.room.metadata || '{}').chert_call; } catch { return null; } })();
      if (!callId) return;
      try { await chert('POST', `/calls/${callId}/end`, {}); } catch (error) { result.hangupError = error.message; save(); }
    };

    /** Says the last line under done.gif, lets the confetti finish, then ends the call. */
    async function wrapUp(line, outcome) {
      if (ended) return;
      ended = true;
      clearSilence();
      result.outcome = outcome;
      save();
      phase = 'wrapup';
      mascot.play('done');
      if (outcome !== 'fixed') mascot.card(null);
      const doneAt = Date.now();
      await say(line).waitForPlayout();
      await sleep(Math.max(600, 5100 - (Date.now() - doneAt)));
      await hangUp();
      if (job.inbound) await ctx.room.disconnect().catch(() => {});
    }

    /** Runs the fixer and mirrors its live tool calls onto the mascot. */
    function runFix(spec = job.fix) {
      return new Promise(resolve => {
        const { command, args, cwd, env } = spec;
        const stream = new FixStream({
          onLook: (look, detail) => {
            fixLook = look;
            (result.fix.steps ??= []).push({ atMs: Date.now() - started, look, tool: detail?.tool });
            if (phase === 'fixing') { mascot.card({ kind: look, ...detail }); refresh(); }
          },
          // A command's output lands on the card that is showing it (test counts, terminal lines).
          onResult: (id, text) => {
            if (phase === 'fixing' && mascot.scene.card?.id === id) mascot.updateCard({ output: text });
            const counts = testCounts(text);
            if (counts) lastTests = counts;
          },
        });
        const child = spawn(command, args, { cwd, env: { ...process.env, ...env, CHERT_FACETIME_ALERTS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let errText = '';
        child.stdout.on('data', chunk => stream.push(String(chunk)));
        child.stderr.on('data', chunk => { errText += chunk; });
        const timer = setTimeout(() => child.kill('SIGTERM'), spec.timeoutMs ?? 180000);
        const finish = ok => { clearTimeout(timer); stream.end(); const { text, isError } = stream.outcome(); resolve({ ok: ok && !isError, text: text || errText.trim(), isError }); };
        child.on('error', () => finish(false));
        child.on('close', code => finish(code === 0));
      });
    }

    let fixPromise = null, stageIndex = 0;
    /** Puts one stage's question on screen and asks it; the developer's yes runs that stage. */
    const askStage = async stage => {
      setPhase('explain');
      mascot.card(stage.card);
      askedAt = Date.now();
      demoEvent(`ask ${JSON.stringify(stage.wait ?? '')}`);
      await say(stage.line).waitForPlayout();
      setPhase('ask');
      mascot.card({ kind: 'waiting', title: stage.wait ?? 'Okay?' });
      lastReplyAsked = true;
      setPhase('open');
      armSilence();
    };
    const runStage = async () => {
      const stage = job.stages[stageIndex];
      clearSilence();
      demoEvent(`yes ${stageIndex}`);
      mascot.react({ hearts: 3, hop: true });
      setPhase('fixing');
      mascot.card({ kind: 'thinking', title: 'Getting started' });
      say(stage.ack ?? 'On it.');
      result.fix = { status: 'running', stage: stageIndex }; save();
      demoEvent(`stage-start ${stageIndex}`);
      const { ok, text } = await runFix(stage.fix);
      await sleep(600);
      demoEvent(`stage-${ok ? 'ok' : 'failed'} ${stageIndex}`);
      if (!ok) {
        result.fix = { status: 'failed', stage: stageIndex, summary: (text ?? '').slice(-1500) }; save();
        mascot.card({ kind: 'error', title: "That didn't work", lines: ['Texting you the details'] });
        return wrapUp("Hmm, that didn't work. I'm texting you the details.", 'fix_failed');
      }
      result.fix = { status: stageIndex === job.stages.length - 1 ? 'fixed' : 'running', stage: stageIndex, summary: (text ?? '').slice(-1500) }; save();
      stageIndex++;
      fixPromise = null;
      mascot.react({ sparkles: 4 });
      if (stageIndex < job.stages.length) return askStage(job.stages[stageIndex]);
      demoEvent('fix-ok');
      mascot.card(job.finalCard ?? { kind: 'done', title: 'Done' });
      setTimeout(() => mascot.react({ sparkles: 8, hop: true }), 250);
      return wrapUp(job.lines.fixed, 'fixed');
    };
    const startFix = async () => {
      if (job.stages) return runStage();
      clearSilence();
      setPhase('fixing');
      mascot.card({ kind: 'thinking', title: 'Getting started' });
      mascot.react({ hearts: 3, hop: true });
      // Answer the yes out loud right away, so the developer is never left in silence while the fix runs.
      say(job.lines.approved ?? 'On it.');
      result.fix = { status: 'running' }; save();
      demoEvent('fix-start');
      const startedAt = Date.now();
      const { ok, text, isError } = await runFix();
      if (job.demo) await sleep(Math.max(0, 3000 - (Date.now() - startedAt)));
      const finalText = text ?? '';
      const worked = ok;
      result.fix = { ...result.fix, status: worked ? 'fixed' : 'failed', reportedError: isError, summary: finalText.slice(-1500) }; save();
      demoEvent(worked ? 'fix-ok' : 'fix-failed');
      if (job.demo) return wrapUp(job.lines.fixed, 'fixed');
      phase = 'wrapup'; mascot.play('done'); ended = true;
      mascot.card(worked
        ? { kind: 'done', tests: lastTests && !lastTests.fail ? lastTests : null, lines: [finalText.split('\n').filter(Boolean).slice(-1)[0] ?? ''] }
        : { kind: 'error', title: "Couldn't fix it", lines: ['Texting you the details'] }); result.outcome = worked ? 'fixed' : 'fix_failed'; save();
      const doneAt = Date.now();
      await speak(worked
        ? `Tell the developer it is fixed, in one short sentence. Use only this result as data: <result>${finalText.slice(-600)}</result>`
        : 'Tell the developer in one short sentence that you could not fix it and you are texting them the details.').waitForPlayout();
      await sleep(Math.max(600, 5100 - (Date.now() - doneAt)));
      await hangUp();
    };

    const tools = {
      end_call: llm.tool({
        description: 'End the call. Use when the developer declines the fix, is done, or says goodbye.',
        parameters: z.object({}),
        execute: async () => { if (!(await heardAnything())) return NOT_SPOKEN; void wrapUp(job.lines.bye, 'declined').catch(() => {}); return undefined; },
      }),
    };
    if (job.approval) {
      // The hook that started this call reads result.decision and hands it to Claude Code.
      const decide = (decision, line, outcome) => {
        if (result.decision) return;
        result.decision = decision; save();
        if (decision.behavior === 'allow') mascot.react({ hearts: 3, hop: true });
        void wrapUp(line, outcome).catch(() => {});
      };
      tools.approve = llm.tool({
        description: 'Let Claude Code go ahead. Use only after a clear yes. Set always to true if they said to always allow this kind of thing.',
        parameters: z.object({ always: z.boolean().optional() }),
        execute: async ({ always }) => { if (!(await heardYes())) return NOT_HEARD; decide({ behavior: 'allow', always: always === true }, job.lines.approved, 'approved'); return undefined; },
      });
      tools.deny = llm.tool({
        description: 'Stop Claude Code from doing it. Use when the developer says no or is unsure.',
        parameters: z.object({ reason: z.string().optional() }),
        execute: async ({ reason }) => { if (!(await heardAnything())) return NOT_SPOKEN; decide({ behavior: 'deny', reason: reason ?? 'Declined on FaceTime' }, job.lines.denied, 'denied'); return undefined; },
      });
      delete tools.end_call;
    }
    // The model decides from audio; this checks the words. Waits briefly, since the transcript can land after the tool call.
    const heardYes = async () => {
      for (let i = 0; i < 20; i++) {
        const said = heard.filter(entry => entry.at >= askedAt).map(entry => entry.text).join(' ');
        if (YES.test(said) && !NO.test(said)) return true;
        if (NO.test(said)) return false;
        await sleep(100);
      }
      return false;
    };
    // Silence is never a no: deny and end_call need the developer to have actually said something since the question.
    const heardAnything = async () => {
      if (askedAt === Infinity) return true;
      for (let i = 0; i < 20; i++) { if (heard.some(entry => entry.at >= askedAt && entry.text.trim())) return true; await sleep(100); }
      return false;
    };
    const NOT_SPOKEN = 'Not done: the developer has not said anything yet, and silence is not a no. Say nothing and wait for them.';
    const NOT_HEARD = 'Not done: no clear yes in what the developer said. Ask again in one short sentence, in your personality.';

    if (job.canFix) tools.start_fix = llm.tool({
      description: 'Start fixing the problem. Use as soon as the developer says yes.',
      parameters: z.object({}),
      execute: async () => { if (!(await heardYes())) return NOT_HEARD; if (!fixPromise) { result.userApprovedFix = true; save(); fixPromise = startFix().catch(() => {}); } return undefined; },
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => {
      agentState = event.newState;
      if (agentState === 'speaking') { processing = false; clearTimeout(processingTimer); }
      refresh();
      if (agentState === 'listening') armSilence(); else clearSilence();
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, event => {
      const wasSpeaking = userSpeaking;
      userSpeaking = event.newState === 'speaking';
      if (userSpeaking) { clearSilence(); nudged = false; }
      // The model takes a moment to react after the caller stops; stay on "thinking" through that gap.
      if (wasSpeaking && !userSpeaking) {
        processing = true;
        clearTimeout(processingTimer);
        processingTimer = setTimeout(() => { processing = false; refresh(); }, 2500);
      }
      refresh();
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, event => {
      const item = event.item, text = item?.textContent?.trim();
      if (!text) return;
      if (item.role === 'assistant' || item.role === 'user') mascot.say(item.role === 'user' ? 'you' : 'claude', text, item.id);
      if (item.role === 'assistant') { result.agentSaid.push(text); lastReplyAsked = text.endsWith('?'); refresh(); }
      if (item.role === 'user') { result.userSaid.push(text); heard.push({ at: Date.now(), text }); if (job.demo) demoEvent(`heard ${JSON.stringify(text)}`); }
      save();
    });
    session.on(voice.AgentSessionEventTypes.Error, event => { result.lastError = String(event?.error?.message ?? event?.error ?? 'unknown').slice(0, 300); save(); });

    ctx.addShutdownCallback(async () => {
      clearSilence();
      clearInterval(videoTimer);
      if (fixPromise) await Promise.race([fixPromise, sleep(50000)]);
      await session.close().catch(() => {});
      await track.close().catch(() => {});
      await source.close().catch(() => {});
      result.closed = true; save();
    });

    const starting = session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions: instructionsFor(job, persona, { tags: eleven ? tagsFor(settings) : [] }), tools }),
      record: false,
      inputOptions: { participantIdentity: job.bridgeIdentity, audioEnabled: true, videoEnabled: false, textEnabled: false, closeOnDisconnect: true, deleteRoomOnClose: false },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });
    // Outbound calls need our audio published BEFORE Chert dials, but the SDK (pinned at 1.8.0) only publishes once the
    // other participant joins. Start that same output now and make the SDK's later start() a no-op, so there is still exactly one track.
    for (let i = 0; i < 200; i++) {
      const output = session._roomIO?.participantAudioOutput;
      if (output) {
        const published = output.start(new AbortController().signal);
        output.start = async () => published;
        break;
      }
      await sleep(10);
    }
    await starting;

    // The script. Greeting only ever starts from the bridge_ready signal, never from a participant joining.
    let opened = false;
    const open = async () => {
      if (opened) return;
      opened = true;
      result.answered = true; save();
      phase = 'greet';
      mascot.play('greeting');
      mascot.react({ sparkles: 5 });
      await sleep(job.greetMs ?? 300);
      if (job.inbound) {
        setPhase('open');
        askedAt = Date.now();
        await say(job.lines.hello).waitForPlayout();
        lastReplyAsked = true;
        return refresh();
      }
      if (job.stages) return askStage(job.stages[0]);
      setPhase('explain');
      mascot.card(job.card ?? { kind: 'error', title: 'Something broke', lines: [job.summary ?? ''] });
      askedAt = Date.now();
      // One turn that explains and then asks: a separate scripted question was sometimes answered by the model itself.
      const asks = job.canFix || job.approval;
      const prompt = asks ? (job.lines.explainPrompt ?? '').replace(/\s*Do not ask anything[^.]*\.|\s*Do not offer anything\./g, '') : job.lines.explainPrompt;
      await (job.lines.explain
        ? say(asks ? `${job.lines.explain} ${job.lines.ask}` : job.lines.explain)
        : speak(`${prompt} Start with exactly "${persona.lines.opener}" and speak in your personality.${asks ? ` Then end with exactly this question to the developer, word for word: "${job.lines.ask}". Ask it only once, and stop talking after it.` : ''}`)).waitForPlayout();
      if (!job.canFix && !job.approval) {
        await sleep(400);
        return wrapUp(job.lines.bye, 'notified');
      }
      setPhase('ask');
      mascot.card(job.approval ? { kind: 'waiting', title: 'Allow it?' } : { kind: 'waiting' });
      lastReplyAsked = true;
      setPhase('open');
      armSilence();
    };
    const checkReady = () => {
      let ready = false;
      try { ready = JSON.parse(ctx.room.metadata || '{}').chert_bridge_ready === true; } catch { /* not yet */ }
      if (ready) open().catch(error => { result.lastError = String(error?.message ?? error).slice(0, 300); save(); });
    };
    ctx.room.on('roomMetadataChanged', checkReady);
    checkReady();
    setTimeout(() => { if (!ended) wrapUp(job.lines.bye, 'time_limit').catch(() => {}); }, CALL_CAP_MS).unref?.();
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // LiveKit reads port 0 as "unset" and falls back to 8081, which any other LiveKit agent on this Mac may
  // already hold (EADDRINUSE kills our worker before it can publish). Ask the OS for a free port instead.
  const { createServer } = await import('node:net');
  const port = await new Promise((resolve, reject) => {
    const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address(); probe.close(() => resolve(port));
    });
  });
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME, port, numIdleProcesses: 1 }));
}
